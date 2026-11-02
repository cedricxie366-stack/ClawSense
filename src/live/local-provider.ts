import { ProcessRpc } from "./process-rpc.js";
import { recallLiveFact } from "./recall.js";
import { createHash } from "node:crypto";
import { answerSimpleArithmetic } from "./arithmetic.js";
import { localDialogue } from "./dialogue.js";
// These workers run MLX, not PyTorch/TF. Avoid importing unused model backends
// through Transformers; the native adapter keeps its own environment.
const MLX_ENV = { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", USE_TORCH: "0", USE_TF: "0" };
import {
  personaPrompt,
  type LiveConfig,
  type LiveProvider,
  type PersonaProfile,
  type ProviderCapabilities,
  type ProviderChunk,
  type ReplyInput,
  type ProviderMetrics,
} from "./types.js";
/** Voice randomness belongs to the selected voice/style, not preceding requests. */
export function liveVoiceProfile(persona: Pick<PersonaProfile, "voice" | "style">) {
  const seed = createHash("sha256")
    .update(JSON.stringify([persona.voice.toLowerCase(), persona.style]))
    .digest().readUInt32LE(0);
  return { voice: persona.voice, style: persona.style, seed };
}
/** Repeated caption loops are not evidence of repeated objects. Reject instead of storing them. */
export function reliableVisualDescription(text: string): boolean {
  if (!text.trim()) return false;
  if (text.length < 80) return true;
  const parts = text.split(/[，,、。；;\n]/u).map(s => s.trim()).filter(s => s.length >= 4);
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part, (counts.get(part) ?? 0) + 1);
  if ([...counts.values()].some(n => n >= 4 && n * 2 >= parts.length)) return false;
  return !/(.{4,30})(?:[，,、\s]?\1){3,}/u.test(text);
}
export class LocalLiveProvider implements LiveProvider {
  private asr: ProcessRpc;
  private llm: ProcessRpc;
  private tts: ProcessRpc;
  private recheck?: ProcessRpc;
  private vad?: ProcessRpc;
  private visionConfig?: { python: string; worker: string; model: string };
  private visionWorker?: ProcessRpc;
  private visionTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private shutdown = new AbortController();
  private usedModels = false;
  private visionParked = true;
  private recognitionWarmAt = 0;
  private recognitionWarming?: Promise<void>;
  private streamingUsedAt = 0;
  private preparationTail: Promise<void> = Promise.resolve();
  private preparedVoice?: string;
  private serializePreparation(run: () => Promise<void>) {
    const job = this.preparationTail.then(run);
    this.preparationTail = job.catch(() => {});
    return job;
  }
  // Low-memory experiments can compare the previous per-modality parking policy.
  // The normal Live path keeps bounded model weights resident until the session ends.
  private readonly parkBetweenModalities = process.env.CLAWSENSE_PARK_BETWEEN_MODALITIES === "1";
  private readonly keepVisionResident = process.env.CLAWSENSE_KEEP_VISION_RESIDENT === "1";
  private warmRecognition(forPlayback = false): Promise<void> {
    if (this.recognitionWarming) return this.recognitionWarming;
    if (Date.now() - this.recognitionWarmAt < (forPlayback ? 2000 : 15000)) return Promise.resolve();
    // A typed reply may start long after the last ASR use. Warm the small control
    // shape alongside synthesis, before a spoken stop arrives. Do not enqueue
    // full streaming warmups for every spoken phrase or accumulate probe jobs.
    const job = Promise.all([
      ...(!forPlayback && Date.now() - this.streamingUsedAt >= 15000 ? [this.asr.call("probe")] : []),
      ...(this.recheck ? [this.recheck.call("probe", { control: true })] : []),
    ]).then(() => { this.recognitionWarmAt = Date.now(); });
    this.recognitionWarming = job;
    void job.finally(() => { if (this.recognitionWarming === job) this.recognitionWarming = undefined; }).catch(() => {});
    return job;
  }
  private analysisTail: Promise<void> = Promise.resolve();
  private async claimAnalysis() {
    const previous = this.analysisTail; let release!: () => void;
    this.analysisTail = new Promise<void>(resolve => { release = resolve; });
    await previous; return release;
  }
  private idleVisual() {
    const job = this.visionTail.then(() => this.visionWorker && !this.visionParked ? this.parkVision(this.visionWorker) : undefined);
    this.visionTail = job.catch(() => {}); return job;
  }
  private async parkVision(worker: ProcessRpc) {
    if (this.visionParked) return;
    await worker.call("idle"); this.visionParked = true;
  }
  voiceActivity?: (sessionId: string, pcm: string, signal: AbortSignal) => Promise<boolean>;
  constructor(cfg: LiveConfig) {
    if (cfg.vadModel) { this.vad = new ProcessRpc(cfg.python, [cfg.worker, "--role", "vad", "--model", cfg.vadModel], { HF_HUB_OFFLINE: "1" }); this.voiceActivity = async (sessionId, pcm, signal) => (await this.vad!.call("audio", { sessionId, pcm }, signal))[0]?.voiced === true; }
    if (cfg.visionModel) this.visionConfig = { python: cfg.python, worker: cfg.worker, model: cfg.visionModel };
    if (cfg.asrRecheckDir) this.recheck = new ProcessRpc(cfg.python, [cfg.worker, "--role", "final-asr", "--model", cfg.asrRecheckDir], { HF_HUB_OFFLINE: "1", CLAWSENSE_ASR_LANGUAGE: cfg.asrFinalLanguage ?? "zh" });
    this.asr = new ProcessRpc(cfg.python, [
      cfg.worker,
      "--role",
      "asr",
      "--model",
      cfg.asrDir,
    ], { HF_HUB_OFFLINE: "1" });
    this.llm = new ProcessRpc(cfg.python, [
      cfg.worker,
      "--role",
      "llm",
      "--model",
      cfg.llmModel,
    ], MLX_ENV);
    this.tts = new ProcessRpc(cfg.python, [
      cfg.worker,
      "--role",
      "tts",
      "--model",
      cfg.ttsModel,
    ], MLX_ENV);
  }
  async capabilities(): Promise<ProviderCapabilities> {
    this.usedModels = true;
    const probes = await Promise.allSettled([
      this.asr.call("probe", { warmup: false }),
      this.llm.call("probe", { warmup: false }),
      this.tts.call("probe", { warmup: false }),
      ...(this.recheck ? [this.recheck.call("probe", { warmup: false })] : []),
      ...(this.vad ? [this.vad.call("probe")] : []),
    ]);
    const voice =
      probes[2]?.status === "fulfilled" ? probes[2].value[0] : undefined;
    const failed = probes.find((p) => p.status === "rejected");
    const roles = ["asr","llm","tts",...(this.recheck ? ["final-asr"] : []),...(this.vad ? ["vad"] : [])];
    const initialization = Object.fromEntries(probes.flatMap((result,i) => {
      const value = result.status === "fulfilled" ? result.value[0] : undefined;
      return value && Number.isFinite(value.modelLoadMs) && Number.isFinite(value.probeMs)
        ? [[roles[i]!, {modelLoadMs: value.modelLoadMs as number, probeMs: value.probeMs as number}]] : [];
    }));
    return {
      id: "local-cascade",
      ready: !failed,
      recognitionReady: probes[0]?.status === "fulfilled",
      local: true,
      streamingInput: true,
      streamingText: true,
      streamingAudio: true,
      fullDuplex: false,
      voices: voice?.voices ?? [],
      styleControl: voice?.styleControl === true,
      initialization,
      reason:
        failed?.status === "rejected"
          ? (failed.reason as Error).message
          : undefined,
    };
  }
  async cooldown() {
    return this.serializePreparation(async () => {
      if (!this.usedModels || this.closed) return;
      this.preparedVoice = undefined;
      const release = await this.claimAnalysis();
      try { await Promise.all([this.llm.call("idle"), this.tts.call("idle"), this.idleVisual()]); }
      finally { release(); }
    });
  }
  async prepare(persona: PersonaProfile, options?: { vision: boolean }) {
    return this.serializePreparation(async () => {
      if (this.closed) throw new Error("aborted");
      const key = () => JSON.stringify([liveVoiceProfile(persona), this.llm.processGeneration, this.tts.processGeneration]);
      if (this.preparedVoice === key()) { await this.warmRecognition(); return; }
      await Promise.all([
        (async () => {
          const release = await this.claimAnalysis();
          try {
            // Camera consent is not a request for visual analysis. Eagerly loading
            // and parking VLM here delayed every voice-only opening with camera on.
            if (this.parkBetweenModalities) await this.idleVisual();
            // Readiness needs one real model step, not a full memory prompt.
            // Long speculative prefill competes with voice startup and is wasted
            // on reading, translation and general questions with other prompts.
            await this.llm.call("probe");
          } finally { release(); }
        })(),
        this.tts.call("probe", liveVoiceProfile(persona)),
        this.warmRecognition(),
      ]);
      this.preparedVoice = key();
    });
  }
  private withVision<T>(operation: (worker: ProcessRpc) => Promise<T>): Promise<T> {
    const cfg = this.visionConfig;
    if (!cfg) return Promise.reject(new Error("local_vision_not_configured"));
    const job = this.visionTail.then(() => {
      if (this.closed) throw new Error("aborted");
      this.visionWorker ??= new ProcessRpc(cfg.python, [cfg.worker, "--role", "vision", "--model", cfg.model], MLX_ENV);
      this.visionParked = false;
      return operation(this.visionWorker);
    });
    this.visionTail = job.catch(() => {}); return job;
  }
  releaseVisual(): Promise<void> {
    const job = this.visionTail.then(async () => { const worker = this.visionWorker; this.visionWorker = undefined; this.visionParked = true; await worker?.close(); });
    this.visionTail = job.catch(() => {}); return job;
  }
  async preloadVisual() {
    if (!this.visionConfig) return;
    // Only when the client enabled vision. Prepare weights alongside voice,
    // without capturing an image or running visual analysis. Last visual
    // connection still releases this one bounded worker.
    await this.withVision(worker => worker.call("probe", { warmup: false }));
  }
  async *reply(
    input: ReplyInput,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    if (/^(?:小伴[，,\s]*)?(?:请)?(?:读全文|朗读全文|再读一遍)[。！!\s]*$/.test(input.query.trim())) {
      const previous = input.history.filter(m => m.role === "assistant").at(-1)?.content;
      if (!signal.aborted) yield { type: "text", text: previous ?? "当前没有可以继续朗读的获准回答。" }; return;
    }
    const dialogue = localDialogue(input);
    if (dialogue.mode === "literal-reading" && dialogue.immediate !== undefined) { if (!signal.aborted) yield { type: "text", text: dialogue.immediate }; return; }
    const transform = dialogue.mode === "text-transform" || dialogue.mode === "statement-repeat";
    const currentFrame = (input.context.scene as any)?.currentFrame;
    if (!transform && currentFrame?.description) { if (!signal.aborted) yield { type: "text", text: currentFrame.description }; return; }
    if (dialogue.immediate !== undefined) { if (!signal.aborted) yield { type: "text", text: dialogue.immediate }; return; }
    if (!transform && !/[？?]|什么时候|多少|几点|如何|怎么/.test(input.query) && /小[\p{Script=Han}]{1,2}希望.{0,25}收到(?:方案|报价|合同|材料)/u.test(input.query)) { if (!signal.aborted) yield { type: "text", text: "收到，这条信息已记在本次对话里。" }; return; }
    const recalled = transform ? undefined : answerSimpleArithmetic(input.query) ?? recallLiveFact(input);
    if (recalled && !signal.aborted) { yield { type: "text", text: recalled }; return; }
    const preparing = performance.now();
    const release = await this.claimAnalysis();
    let submitted = false, exhausted = false;
    try {
    if (this.closed || signal.aborted) throw new Error("aborted");
    const parked = performance.now();
    if (this.parkBetweenModalities) await this.idleVisual();
    input.observeMetrics?.("llm", { analysisWaitMs: parked - preparing, parkVisualMs: performance.now() - parked });
    if (signal.aborted) throw new Error("aborted");
    submitted = true;
    for await (const item of this.llm.stream(
      "generate",
      {
        messages: dialogue.messages,
      },
      signal,
    )) {
      if (item.type === "text" && typeof item.text === "string")
        yield { type: "text", text: item.text };
      else if (item.type === "model_metrics") input.observeMetrics?.("llm", item);
    }
    exhausted = true;
    } finally {
      // Cancelling an RPC stops delivery before native computation necessarily
      // exits. Drain its ordered worker queue before giving vision the lease.
      try { if (submitted && !exhausted && !this.closed) await this.llm.call("barrier").catch(() => {}); }
      finally { release(); }
    }
  }
  async *synthesize(
    text: string,
    persona: PersonaProfile,
    signal: AbortSignal,
    observeMetrics?: ProviderMetrics,
  ): AsyncIterable<ProviderChunk> {
    void this.warmRecognition(true).catch(() => {});
    for await (const item of this.tts.stream(
      "speak",
      { text, ...liveVoiceProfile(persona) },
      signal,
    )) {
      if (item.type === "audio")
        yield { type: "audio", pcm: item.pcm, sampleRate: item.sampleRate };
      else if (item.type === "model_metrics") observeMetrics?.("tts", item);
    }
  }
  async recognize(
    sessionId: string,
    pcm: string,
    final: boolean,
    signal: AbortSignal,
  ) {
    this.streamingUsedAt = Date.now();
    const result = await this.asr.call(
      "audio",
      { sessionId, pcm, final },
      signal,
    );
    return String(result[0]?.text ?? "");
  }
  async resetRecognition(sessionId: string) {
    await this.asr.call("reset", { sessionId });
    await this.vad?.call("reset", { sessionId });
  }
  async finalRecognition(pcm: string, signal: AbortSignal) {
    if (!this.recheck) return "";
    this.recognitionWarmAt = Date.now();
    const result = await this.recheck.call("transcribe", { pcm }, signal);
    return String(result[0]?.text ?? "");
  }
  async describeFrame(frame: import("./types.js").LiveFrame, query: string, signal: AbortSignal) {
    return this.describeFrames([frame], query, signal);
  }
  async describeFrames(frames: import("./types.js").LiveFrame[], query: string, signal: AbortSignal) {
    if (frames.length === 1 && /变化|移动|动作/.test(query)) {
      if (signal.aborted) throw new Error("aborted");
      return "目前只有本次的一张照片，无法判断物体是否移动或发生了什么变化。";
    }
    const release = await this.claimAnalysis();
    try {
    if (this.closed || signal.aborted) throw new Error("aborted");
    if (this.parkBetweenModalities) await this.llm.call("idle");
    return await this.withVision(async worker => {
      if (this.closed || signal.aborted) throw new Error("aborted");
      let completed = false;
      try { const result = await worker.call("describe", { images: frames.map(frame => frame.jpeg), capturedTimes: frames.map(frame => frame.capturedAt), query }, AbortSignal.any([signal, this.shutdown.signal])); completed = true; const description = String(result[0]?.text ?? ""); if (!reliableVisualDescription(description)) throw new Error("current_frame_unreadable"); return description; }
      finally {
        if (!this.keepVisionResident || this.parkBetweenModalities) await this.parkVision(worker);
        else if (!completed && !this.closed) await worker.call("barrier").catch(() => {});
      }
    });
    } finally { release(); }
  }
  async close() {
    this.closed = true;
    this.shutdown.abort();
    await Promise.all([this.asr.close(), this.llm.close(), this.tts.close(), this.recheck?.close(), this.vad?.close(), this.releaseVisual()]);
  }
}
/** Native audio adapter. Its runner advertises actual capabilities; no guessed full-duplex claim. */
export class MiniCpmProvider implements LiveProvider {
  private worker: ProcessRpc;
  constructor(
    cfg: LiveConfig,
    private fallback: LiveProvider,
  ) {
    if (!cfg.native) throw new Error("native_not_configured");
    this.worker = new ProcessRpc(
      cfg.native.python,
      [cfg.worker, "--role", "native", "--model", cfg.native.model],
      { CLAWSENSE_VOICE_REFERENCE: cfg.native.referenceAudio ?? "" },
    );
  }
  async capabilities(): Promise<ProviderCapabilities> {
    try {
      const probe = (await this.worker.call("probe"))[0]!;
      return {
        ...probe,
        id: "minicpm-o",
        local: true,
      } as unknown as ProviderCapabilities;
    } catch (e) {
      return {
        id: "minicpm-o",
        ready: false,
        local: true,
        streamingInput: false,
        streamingText: true,
        streamingAudio: true,
        fullDuplex: false,
        voices: [],
        styleControl: false,
        reason: (e as Error).message,
      };
    }
  }
  async *reply(
    input: ReplyInput,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    for await (const item of this.worker.stream(
      "generate",
      {
        query: input.query,
        pcm: input.audio,
        history: input.history.slice(-20),
        system:
          personaPrompt(input.persona) +
          "\n现场资料：" +
          JSON.stringify({ scene: input.context.scene, confirmed: input.context.confirmed, work: input.context.work }).slice(0, 12000),
      },
      signal,
    )) {
      if (item.type === "text") yield { type: "text", text: item.text };
      else if (item.type === "audio")
        yield { type: "audio", pcm: item.pcm, sampleRate: item.sampleRate };
    }
  }
  async *synthesize(
    text: string,
    persona: PersonaProfile,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    for await (const item of this.worker.stream(
      "speak",
      { text, system: personaPrompt(persona) },
      signal,
    )) {
      if (item.type === "audio")
        yield { type: "audio", pcm: item.pcm, sampleRate: item.sampleRate };
    }
  }
  recognize(id: string, pcm: string, final: boolean, signal: AbortSignal) {
    return this.fallback.recognize(id, pcm, final, signal);
  }
  resetRecognition(id: string) {
    return this.fallback.resetRecognition(id);
  }
  close() {
    return this.worker.close();
  }
}
