import type { LiveWork, LiveWorkStore } from "./work.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { LiveFrameRequests, needsCurrentFrame } from "./visual.js";
import { LiveTurnTiming } from "./timing.js";
import { explicitTextTransform, literalReading, localDialogue, stripCompanionAddress, suppliedStatementRepeat } from "./dialogue.js";
import type {
  HarnessAdapter,
  LiveContext,
  LiveEvent,
  LiveMessage,
  LiveProvider,
  PersonaProfile,
  ProviderChunk,
  ReplyInput,
  LiveSessionHooks,
} from "./types.js";
export function isBackchannel(text: string) {
  return /^(嗯+|啊+|哦+|对+|好+|是的|没错|明白|好的)[，。！？,.!?\s]*$/.test(
    text.trim(),
  );
}
export function hasSpeechContent(text: string) {
  const clean = text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
  if (!clean || /^(?:the|a|an|and|um|uh)$/i.test(clean)) return false;
  if (/^[a-z]$/i.test(clean)) return false;
  return true;
}
function speechCharacters(text: string) { return text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, ""); }
/** Pronoun/preposition fragments are not complete conversational requests. */
export function isIncompleteSpeech(text: string) {
  return /^(?:我|你|他|她|它|被|把|的|了|我们|你们|他们)$/.test(speechCharacters(text));
}
function isSpeechStop(text: string) {
  return /^(?:停|停止|停一下|停止说话|停止朗读|别说了)[，。！？,.!?\s]*$/.test(text.trim());
}
export function recognitionDiffers(a: string, b: string) {
  const clean = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/[零〇一二两三四五六七八九]/g, c => String(({ 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 } as Record<string, number>)[c]));
  return !!a.trim() && !!b.trim() && clean(a) !== clean(b);
}
export function needsHarness(text: string, companionName = "小伴") {
  const request = stripCompanionAddress(text, companionName);
  if (literalReading(request) !== undefined || explicitTextTransform(request) || suppliedStatementRepeat(request)) return false;
  return (
    text.length > 240 ||
    /(用更强|用大模型|交给.*(?:DSH|dsh|Codex|codex|宿主)|(?:制作|生成|写|修改|执行|运行|搜索|检索|打开|发送|删除).{0,15}(?:文件|文档|方案|代码|脚本|报告|邮件|会议纪要|行动项|笔记|表格|PPT)|复杂推理|深入分析)/.test(
      text,
    )
  );
}
export function isLikelyEcho(transcript: string, spoken: string): boolean {
  const clean = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  // ASR commonly writes 三 as 3. This representation-only map is deliberately
  // not a money/date parser; do not infer abbreviated quantities such as 三万五.
  const digits = (s: string) => clean(s).replace(/[零〇一二两三四五六七八九]/g, c => String(({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 } as Record<string, number>)[c]));
  const a = digits(transcript), b = digits(spoken);
  if (!a || !b || /^(?:停|停止|别说了|不对|等等|更正)/.test(a)) return false;
  // Streaming recognition often starts with a single echoed character (e.g. “收”).
  // Waiting for two characters used to interrupt our own speech before the final echo match.
  if (b.includes(a)) return true;
  if (a.length < 8) return false;
  // Similar wording must not swallow an actual changed amount or weekday.
  if (JSON.stringify(a.match(/[0-9十百千万亿]+/g) ?? []) !== JSON.stringify(b.match(/[0-9十百千万亿]+/g) ?? [])) return false;
  // Allow minor ASR substitutions across punctuation, without classifying short control words as echo.
  let row = new Uint16Array(b.length + 1);
  for (const char of a) {
    const next = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++)
      next[j] =
        char === b[j - 1] ? row[j - 1]! + 1 : Math.max(row[j]!, next[j - 1]!);
    row = next;
  }
  return row[b.length]! / a.length >= 0.88;
}
export function unfinished(text: string) {
  return /(?:因为|如果|然后|但是|那个|就是说)[，,\s]*$/.test(text) ||
    /^(?:请|帮我)?(?:详细)?(?:介绍|解释|说说|讲讲)[。！!，,\s]*$/.test(text);
}
export function endpointSilence(text: string) {
  if (unfinished(text)) return 1200;
  // Natural pauses between fields of an arrangement are not separate questions.
  // Explicit questions/confirmation endings retain the faster endpoint.
  const arranging = /更正|改为|改成|调整为|方案|预算|安排/.test(text);
  const complete = /[？?]|(?:请|麻烦)?(?:简短)?确认[。！!\s]*$|多少|几点|什么时候|哪天|给谁|叫什么|如何|怎么/.test(text);
  return arranging && !complete ? 1100 : 450;
}
export function spokenPhrase(text: string): string {
  const spoken = text
    .replace(
      /(?:https?:\/\/|\/(?:Users|tmp|private|home|api)\/|[A-Z]:\\)[^\s，。！？；]+/g,
      "屏幕上的地址",
    )
    .replace(
      /[A-Za-z0-9_-]+\.(?:md|txt|csv|json|pdf|docx|pptx|xlsx)\b/g,
      "这个文件",
    )
    .replace(/[*#`]/g, "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u20E3]/gu, "")
    .trim();
  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : "";
}
export class PhraseBuffer {
  private text = "";
  private static readonly words = new Intl.Segmenter(undefined, { granularity: "word" });
  private clauseBreak(index: number): boolean {
    return !(/[,:：]/.test(this.text[index] ?? "") && /\d/.test(this.text[index - 1] ?? "") &&
      (!this.text[index + 1] || /\d/.test(this.text[index + 1]!)));
  }
  flushPause(): string[] {
    const boundary = [...this.text.matchAll(/[，,]/g)].filter(match => match.index >= 6 && this.clauseBreak(match.index)).at(-1);
    if (!boundary) return [];
    const phrase = this.text.slice(0, boundary.index + 1);
    this.text = this.text.slice(boundary.index + 1);
    return [phrase];
  }
  add(delta: string, final = false): string[] {
    this.text += delta;
    const out: string[] = [];
    while (this.text.length) {
      const limit = 192;
      // A brief prefix such as “好的，” must not hide later complete phrases.
      // A comma is normally one speaker's continuing sentence. Restarting TTS
      // there can give each tiny clause a different timbre and prosody.
      const boundary = [...this.text.matchAll(/[。！？!?；;\n]|\.(?=\s)/g)].find(match => match.index >= 6 && match.index < limit);
      const addressToken =
        /(?:https?:\/\/|\/(?:Users|tmp|private|home|api)\/|[A-Z]:\\|[A-Za-z0-9_-]{20,})[^\s，。！？；]*$/.exec(
          this.text,
        );
      const clause = [...this.text.slice(0, limit).matchAll(/[，,：:\s]/g)]
        .filter(match => match.index >= 48 && this.clauseBreak(match.index)).at(-1);
      // Preserve ordinary sentences and never restart a voice inside a word,
      // decimal or surrogate pair. Long unpunctuated replies remain bounded at
      // a real word boundary; protected address tokens stay intact for redaction.
      const wordEnd = this.text.length >= limit && !clause
        ? [...PhraseBuffer.words.segment(this.text)].map(part => part.index + part.segment.length)
          .filter(end => end <= limit && (final || end < this.text.length) &&
            !(/[\d.,:：/\-]/.test(this.text[end - 1] ?? "") && /[\d.,:：/\-]/.test(this.text[end] ?? ""))).at(-1) ?? 0
        : 0;
      let length =
        boundary && boundary.index >= 6
          ? boundary.index + 1
          : this.text.length >= limit &&
              !(addressToken && addressToken.index < limit && !final)
            ? clause ? clause.index + 1 : wordEnd
            : 0;
      // Keep a complete address together so spokenPhrase can redact it once;
      // splitting it would expose an unrecognized path/token suffix to TTS.
      const crossing = length ? [...this.text.matchAll(/(?:https?:\/\/|\/(?:Users|tmp|private|home|api)\/|[A-Z]:\\|[A-Za-z0-9_-]{20,})[^\s，。！？；]*/g)]
        .find(token => token.index < length && token.index + token[0].length > length) : undefined;
      if (crossing) length = crossing.index + crossing[0].length;
      if (!length) break;
      out.push(this.text.slice(0, length));
      this.text = this.text.slice(length);
    }
    if (final && this.text.trim()) {
      out.push(this.text);
      this.text = "";
    }
    return out;
  }
}
type PartialRecognition = {
  inputId: number;
  id: string; epoch: number; contextGeneration: number; directVersion: number;
  pending: Buffer[]; pendingBytes: number; ended: boolean; limited: boolean;
  finalized: boolean; used: boolean;
};
export class LiveSession {
  readonly id = randomUUID();
  private seq = 0;
  private turnId = "";
  private current?: AbortController;
  private history: LiveMessage[] = [];
  private jobs = new Set<Promise<void>>();
  private closed = false;
  private recognition = new AbortController();
  private audioTail = Promise.resolve();
  private pendingFrames = 0;
  private pendingAudioBytes = 0;
  private finalizationTail = Promise.resolve();
  private pendingFinalizations = 0;
  private streamingTail = Promise.resolve();
  private partialInFlight = false;
  private streamingFinals = 0;
  private partial?: PartialRecognition;
  private directInputVersion = 0;
  private inputCancellationVersion = 0;
  private inputStage = "idle";
  private inputStageStarted = performance.now();
  private inputOrdinal = 0;
  private processedAudioFrames = 0;
  private voicedAudioFrames = 0;
  private maxInputRms = 0;
  private lastInputHealthAt = performance.now();
  private inputCounts: Record<string, number> = {};
  private inputDecision(inputId: number | undefined, status: string) {
    if (!inputId || this.closed) return;
    this.inputCounts[status] = Math.min(Number.MAX_SAFE_INTEGER, (this.inputCounts[status] ?? 0) + 1);
    this.event("input_status", { inputId, status });
  }
  inputDiagnostics() { return { stage: this.inputStage, stageElapsedMs: performance.now() - this.inputStageStarted, pendingFrames: this.pendingFrames, pendingAudioMs: this.pendingAudioBytes / 32, audioBudgetMs: 2000, packetLimit: 200, pendingFinalizations: this.pendingFinalizations, partialPendingMs: (this.partial?.pendingBytes ?? 0) / 32, partialLimited: this.partial?.limited ?? false, streamingFinals: this.streamingFinals, processedAudioFrames: this.processedAudioFrames, voicedAudioFrames: this.voicedAudioFrames, maxInputRms: this.maxInputRms, utteranceBufferedMs: this.utteranceMs, utteranceVoicedMs: this.voicedMs, utteranceSilenceMs: this.silenceMs, inputOutcomes: { ...this.inputCounts } }; }
  private stage(name: string) { this.inputStage = name; this.inputStageStarted = performance.now(); }
  private vadId() { return `${this.id}:vad:${this.contextGeneration}`; }
  private queueStreaming<T>(run: () => Promise<T>): Promise<T> {
    const job = this.streamingTail.then(run);
    const settled = job.then(() => {}, () => {});
    this.streamingTail = settled;
    this.jobs.add(settled); void settled.finally(() => this.jobs.delete(settled));
    return job;
  }
  private retirePartial() {
    const partial = this.partial; this.partial = undefined;
    if (!partial) return;
    partial.ended = true; partial.pending = []; partial.pendingBytes = 0;
    if (partial.used) void this.queueStreaming(() => this.local.resetRecognition(partial.id)).catch(() => {});
  }
  private pumpPartial(partial: PartialRecognition) {
    if (this.partial !== partial || partial.ended || partial.limited || this.partialInFlight || !partial.pendingBytes) return;
    const pcm = Buffer.concat(partial.pending); partial.pending = []; partial.pendingBytes = 0;
    this.partialInFlight = true;
    const job = this.queueStreaming(async () => {
      if (this.closed || partial.ended || partial.contextGeneration !== this.contextGeneration || partial.directVersion !== this.directInputVersion) return;
      partial.used = true;
      const text = await this.local.recognize(partial.id, pcm.toString("base64"), false, this.recognition.signal);
      if (this.closed || partial.ended || this.partial !== partial || partial.epoch !== this.utteranceEpoch || partial.contextGeneration !== this.contextGeneration || partial.directVersion !== this.directInputVersion || this.utteranceStopped || this.utteranceInputCancellationVersion !== this.inputCancellationVersion) return;
      this.transcript = text;
      if (text !== this.previousTranscript) { this.previousTranscript = text; this.event("transcript", { text, final: false }); }
      if (this.source === "user" && isSpeechStop(text)) {
        this.utteranceStopped = true; this.interrupt(); this.event("notice", { code: "speech_stopped_task_unchanged" }); return;
      }
      const reference = this.utteranceEchoReference || this.currentSpokenText || this.lastAnswer;
      if (this.source === "user" && (this.speaking || this.playbackActive) && speechCharacters(text).length >= 2 && hasSpeechContent(text) && !isIncompleteSpeech(text) && !isBackchannel(text) && !isLikelyEcho(text, reference)) this.interrupt(false);
    }).catch(() => { partial.limited = true; partial.pending = []; partial.pendingBytes = 0; });
    void job.finally(() => { this.partialInFlight = false; if (this.partial) this.pumpPartial(this.partial); });
  }
  private offerPartial(pcm: Buffer) {
    const partial = this.partial;
    if (!partial || partial.ended || partial.limited) return;
    if (partial.pendingBytes + pcm.length > 64000) { partial.limited = true; partial.pending = []; partial.pendingBytes = 0; return; }
    partial.pending.push(pcm); partial.pendingBytes += pcm.length; this.pumpPartial(partial);
  }
  private inputPcm: Buffer[] = [];
  private asrPcm: Buffer[] = [];
  private asrSamples = 0;
  private closePromise?: Promise<void>;
  private credits = new Map<number, number>();
  private creditWake?: () => void;
  private utteranceMs = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private transcript = "";
  private previousTranscript = "";
  private source: "user" | "ambient" = "user";
  private lastSpoken = 0;
  private speaking = false;
  private playbackActive = false;
  private lastUserAt = 0;
  private openingInvitationUntil = 0;
  inviteOpening() { if (this.persona.participation === "addressed") this.openingInvitationUntil = Date.now() + 30000; }
  private utteranceEchoReference = "";
  private utteranceDuringPlayback = false;
  private utteranceStopped = false;
  private earlyControlChecks = 0;
  private earlyControlAtMs = 0;
  private utterancePreRollBytes = 0;
  private controlProbe?: Promise<void>;
  private utteranceEpoch = 0;
  private explicitInputVersion = 0;
  private utteranceInputVersion = 0;
  private utteranceDirectInputVersion = 0;
  private utteranceInputCancellationVersion = 0;
  private noiseFloor = 0.0002;
  private preRoll: Buffer[] = [];
  private lastAnswer = "";
  private currentSpokenText = "";
  private turnVersion = 0;
  private loadPromise?: Promise<void>;
  private persistTail: Promise<void> = Promise.resolve();
  private contextGeneration = 0;
  private lastContext?: LiveContext;
  private checkingContext = false;
  recheckContext() {
    if (this.closed || this.checkingContext || !this.lastContext || !this.hooks) return;
    this.checkingContext = true;
    const context = this.lastContext;
    void this.hooks.validate(context).catch(() => { if (!this.closed && context === this.lastContext) this.invalidateContext(); }).finally(() => { this.checkingContext = false; });
  }
  private frames = new LiveFrameRequests((requestId) => this.event("vision_request", { requestId, maxAgeMs: 2000 }));
  acceptFrame(frame: unknown) { this.frames.accept(frame); }
  notifyWork(workItemId: string) { this.event("work_updated", { workItemId }); }
  async taskInput(query: string): Promise<ReplyInput> {
    if (!query.trim() || query.length > 4000) throw new Error("invalid_text");
    if (this.persona.publicScene) throw new Error("public_harness_not_available");
    await this.load();
    let context = await this.context(query, this.persona);
    await this.hooks?.validate(context);
    const history: LiveMessage[] = this.hooks?.filterHistory ? await this.hooks.filterHistory(this.history) : [];
    for (const message of this.hooks?.filterHistory ? [] : this.history) { try { await this.hooks?.validateHistory([message]); history.push(message); } catch {} }
    if (this.hooks?.bindHistory) context = await this.hooks.bindHistory(context, history, false);
    return { sessionId: this.id, query, persona: structuredClone(this.persona), context, history };
  }
  constructor(
    readonly device: string,
    public persona: PersonaProfile,
    private provider: LiveProvider,
    private local: LiveProvider,
    private harness: HarnessAdapter | undefined,
    private context: (query: string, p: PersonaProfile) => Promise<LiveContext>,
    private emit: (event: LiveEvent) => void,
    private stateDir: string,
    private work?: LiveWorkStore,
    private audioAcknowledgements = false,
    private hooks?: LiveSessionHooks,
    private allowAutomaticHarnessFallback = false,
    private delegateTask?: (input: ReplyInput, requestId: string) => Promise<unknown>,
    private cancelTask?: () => Promise<{ state: string }>,
  ) {}
  private event(
    type: string,
    data: Record<string, unknown> = {},
    turnId = this.turnId,
  ) {
    if (!this.closed)
      this.emit({
        ...data,
        version: 1,
        sessionId: this.id,
        turnId,
        seq: ++this.seq,
        at: Date.now(),
        type,
      });
  }
  acknowledgeAudio(sequence: number) {
    this.credits.delete(sequence);
    this.creditWake?.();
  }
  private async sendAudio(
    chunk: Extract<ProviderChunk, { type: "audio" }>,
    controller: AbortController,
    valid: () => boolean,
    turnId: string,
  ) {
    while (
      this.audioAcknowledgements &&
      valid() &&
      (this.credits.size >= 20 ||
        [...this.credits.values()].reduce((a, b) => a + b, 0) >= 2000)
    ) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", finish);
          reject(new Error("audio_ack_timeout"));
        }, 15000);
        this.creditWake = finish;
        controller.signal.addEventListener("abort", finish, { once: true });
      });
      this.creditWake = undefined;
    }
    if (!valid()) return;
    if (this.audioAcknowledgements)
      this.credits.set(
        this.seq + 1,
        (Buffer.from(chunk.pcm, "base64").length / chunk.sampleRate / 2) * 1000,
      );
    this.event("audio", chunk, turnId);
  }
  private load(): Promise<void> {
    return (this.loadPromise ??= (async () => {
      try {
        const data = JSON.parse(await fs.readFile(this.file(), "utf8"));
        if (Array.isArray(data.history))
          this.history = data.history
            .slice(-200)
            .filter(
              (m: LiveMessage) =>
                ["user", "assistant"].includes(m.role) &&
                typeof m.content === "string",
            );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          this.event("notice", { code: "history_unavailable" });
      }
    })());
  }
  setPersona(persona: PersonaProfile) {
    const oldVad = this.vadId();
    this.retirePartial();
    this.frames.clear();
    this.interrupt();
    this.contextGeneration++;
    this.inputPcm = []; this.asrPcm = []; this.asrSamples = 0; this.preRoll = [];
    this.utteranceMs = 0; this.voicedMs = 0; this.silenceMs = 0;
    this.transcript = ""; this.previousTranscript = ""; this.utteranceEchoReference = ""; this.utteranceStopped = false;
    void this.queueStreaming(() => this.local.resetRecognition(oldVad)).catch(() => {});
    this.persona = persona;
  }
  private file() {
    return path.join(
      this.stateDir,
      "live",
      "conversations",
      this.device + ".json",
    );
  }
  private save(): Promise<void> {
    const pending = this.persistTail.then(async () => {
      const file = this.file();
      const history = structuredClone(this.history.slice(-200));
      const write = async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + "." + randomUUID();
      try {
        await fs.writeFile(
          tmp,
          JSON.stringify({
            history,
            updatedAt: Date.now(),
          }),
          { mode: 0o600, flag: "wx" },
        );
        await fs.rename(tmp, file);
      } finally {
        await fs.rm(tmp, { force: true });
      }
      };
      if (this.hooks) await this.hooks.persist(file, history, write); else await write();
    });
    this.persistTail = pending.catch(() => {});
    return pending;
  }
  interrupt(cancelPendingInput = true) {
    if (cancelPendingInput) this.inputCancellationVersion++;
    this.frames.clear();
    this.current?.abort();
    this.credits.clear();
    this.creditWake?.();
    this.current = undefined;
    this.turnVersion++;
    this.speaking = false;
    this.event("interrupted", {
      taskCancelled: false,
      cancelSupported: this.harness?.cancelSupported ?? false,
    });
  }
  invalidateContext() {
    this.openingInvitationUntil = 0;
    const oldVad = this.vadId();
    this.retirePartial();
    this.lastContext = undefined;
    this.frames.clear();
    this.contextGeneration++;
    this.interrupt();
    this.history = [];
    this.lastAnswer = "";
    this.currentSpokenText = "";
    this.inputPcm = []; this.asrPcm = []; this.asrSamples = 0; this.preRoll = [];
    this.utteranceMs = 0; this.voicedMs = 0; this.silenceMs = 0;
    this.transcript = ""; this.previousTranscript = ""; this.utteranceEchoReference = "";
    this.utteranceStopped = false;
    this.earlyControlChecks = 0; this.earlyControlAtMs = 0; this.utterancePreRollBytes = 0;
    void this.queueStreaming(() => this.local.resetRecognition(oldVad)).catch(() => {});
    this.event("context_invalidated", { clearAnswer: true });
  }
  async text(
    query: string,
    source: "user" | "ambient" | "voice" = "user",
    pcm?: string,
    inputId?: number,
  ) {
    if (this.closed) return;
    if (!query.trim()) { this.inputDecision(inputId, "no_transcript"); return; }
    if (query.length > 4000) { this.inputDecision(inputId, "too_long"); return; }
    const timing = new LiveTurnTiming(source === "user" ? "text" : source === "voice" ? "voice-transcript" : "ambient-transcript");
    const addressed =
      query.includes(this.persona.name) || /ClawSense|搭子/i.test(query);
    if (source === "voice" && needsHarness(query, this.persona.name) && !addressed) {
      this.inputDecision(inputId, "address_required");
      this.event("notice", { code: "address_companion_for_harness_task" });
      return;
    }
    const command = query
      .replace(
        new RegExp(
          "^" +
            this.persona.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "[，,\\s]*",
        ),
        "",
      )
      .replace(/[，。！？,.!?\s]+$/g, "");
    if (
      source !== "ambient" &&
      /^(?:请|帮我|我想|我要|麻烦你|你)?(?:先)?(?:停止感知|停止采集|停止录音|不要录音(?:了)?|别录(?:音)?了|全部停止)$/.test(command)
    ) {
      this.interrupt();
      this.event("client_control", { command: "stop_sensing" });
      this.inputDecision(inputId, "control_handled");
      return;
    }
    if (
      source !== "ambient" &&
      /^(?:请|帮我|我想|我要|麻烦你|你)?(?:先)?(?:停止朗读|停止说话|停止播放|别说了|别说话|不要说了|停一下|停止|停)$/.test(
        command,
      )
    ) {
      this.interrupt();
      this.event("notice", { code: "speech_stopped_task_unchanged" });
      this.inputDecision(inputId, "control_handled");
      return;
    }
    if (
      source !== "ambient" &&
      /^(?:请|帮我|我想|我要|麻烦你|你)?(?:先)?(?:取消|停止)(?:当前|这个)?任务(?:吧)?$/.test(command)
    ) {
      this.interrupt();
      if (source === "voice" && !addressed || this.persona.publicScene) { this.inputDecision(inputId, "address_required"); this.event("notice", { code: "address_companion_for_harness_task" }); return; }
      if (this.cancelTask) {
        const result = await this.cancelTask();
        this.event("notice", { code: result.state === "cancelled" ? "task_cancelled" : result.state === "no_active_task" ? "no_active_task" : "task_cancel_unconfirmed" });
      } else this.event("notice", { code: "task_cancel_unavailable" });
      this.inputDecision(inputId, "control_handled");
      return;
    }
    const awaitingAddress = source === "voice" && !addressed && (this.persona.participation === "quiet" || (Date.now() > this.openingInvitationUntil && Date.now() - Math.max(this.lastUserAt, this.lastSpoken) > 30000));
    if (awaitingAddress) source = "ambient";
    if (source === "ambient") {
      if (
        this.persona.participation !== "active" ||
        Date.now() - this.lastSpoken < this.persona.cooldownMs ||
        this.speaking
      ) { this.inputDecision(inputId, awaitingAddress ? "address_required" : "ambient_ignored"); return; }
      // Only explicit suggestions/requests for participation are eligible; never route ambient input to tools.
      if (!/(有什么建议|你觉得呢|有没有更好|提醒一下)/.test(query)) { this.inputDecision(inputId, "ambient_ignored"); return; }
    }
    // Acknowledgments do not start a new answer, including when playback ended
    // while the final recognizer was still working.
    if ((source === "voice" || this.speaking || this.playbackActive) && isBackchannel(query)) { this.inputDecision(inputId, "backchannel_ignored"); return; }
    if (source === "voice" && isIncompleteSpeech(query)) { this.inputDecision(inputId, "fragment_ignored"); return; }
    if (source !== "ambient") { this.openingInvitationUntil = 0; this.lastUserAt = Date.now(); this.explicitInputVersion++; }
    if (source === "user") this.directInputVersion++;
    this.interrupt(false);
    const version = this.turnVersion;
    await this.load();
    if (this.closed || version !== this.turnVersion) { this.inputDecision(inputId, "superseded"); return; }
    const retained: LiveMessage[] = this.hooks?.filterHistory ? await timing.measure("historyFilter", () => this.hooks!.filterHistory!(this.history)) : [];
    for (const message of this.hooks?.filterHistory ? [] : this.history) {
      try { await this.hooks?.validateHistory([message]); retained.push(message); } catch { /* stale history is not reused */ }
    }
    if (this.closed || version !== this.turnVersion) { this.inputDecision(inputId, "superseded"); return; }
    this.history = retained;
    const controller = (this.current = new AbortController());
    this.turnId = randomUUID();
    const turnId = this.turnId;
    this.currentSpokenText = "";
    this.history.push({
      role: "user",
      content: query,
      turnId,
      publicScene: this.persona.publicScene,
      at: Date.now(),
    });
    await timing.measure("inputCheckpoint", () => this.save());
    timing.mark("inputPrepared");
    if (controller.signal.aborted) { this.inputDecision(inputId, "superseded"); return; }
    this.inputDecision(inputId, "accepted");
    const job = this.answer(
      query,
      source,
      pcm,
      controller,
      version,
      turnId,
      false,
      timing,
    ).catch(() => {
      if (!controller.signal.aborted && version === this.turnVersion)
        this.event("error", { code: "live_processing_failed" }, turnId);
    });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }
  private async answer(
    query: string,
    source: "user" | "ambient" | "voice",
    pcm: string | undefined,
    controller: AbortController,
    version: number,
    turnId: string,
    forceHarness = false,
    timing = new LiveTurnTiming(source === "user" ? "text" : source === "voice" ? "voice-transcript" : "ambient-transcript"),
  ) {
    let replaced = false;
    const valid = () =>
      !replaced &&
      !controller.signal.aborted &&
      version === this.turnVersion &&
      !this.closed;
    const event = (type: string, data: Record<string, unknown>) => {
      if (valid()) this.event(type, data, turnId);
    };
    let work: LiveWork | undefined;
    let currentContext: LiveContext | undefined;
    const contextGeneration = this.contextGeneration;
    const taskMode = localDialogue({ sessionId: this.id, query, persona: this.persona, context: { scene: {}, confirmed: [], work: [] }, history: [] }).mode;
    const selfContained = this.provider === this.local && !forceHarness && !needsHarness(query, this.persona.name) &&
      ["literal-reading", "text-transform", "statement-repeat", "general-question", "realtime-unavailable"].includes(taskMode);
    let answer = "",
      nativeAudio = false;
    const startedAt = Date.now();
    let firstTextAt: number | undefined, firstAudioAt: number | undefined;
    const speechQueue: string[] = [];
    let speechWake: (() => void) | undefined;
    let producerWake: (() => void) | undefined;
    let producerDone = false;
    let speechError: unknown;
    let phraseTimer: ReturnType<typeof setTimeout> | undefined;
    const phrases = new PhraseBuffer();
    const consumer = (async () => {
      try {
        while (valid()) {
          const phrase = speechQueue.shift();
          if (speechQueue.length <= 8) producerWake?.();
          if (!phrase) {
            if (producerDone) break;
            await new Promise<void>((resolve) => {
              const done = () => {
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              speechWake = done;
              controller.signal.addEventListener("abort", done, { once: true });
            });
            speechWake = undefined;
            continue;
          }
          const spoken = spokenPhrase(phrase);
          // Emoji/formatting can form their own trailing phrase. Sending these
          // alone to an autoregressive voice model can generate unwanted audio.
          if (!spoken) continue;
          timing.mark("firstPhraseReady");
          this.currentSpokenText += spoken;
          timing.mark("firstTtsStarted");
          let firstSynthesisPacket = true;
          for await (const chunk of this.provider.synthesize(
            spoken,
            this.persona,
            controller.signal,
            (stage, values) => timing.provider(stage, values),
          )) {
            if (!valid()) break;
            if (chunk.type === "audio" && firstSynthesisPacket) { timing.mark("firstTtsPacket"); firstSynthesisPacket = false; }
            if (currentContext) await timing.measure("sourceValidation", async () => this.hooks?.validate(currentContext!));
            if (chunk.type === "audio") {
              firstAudioAt ??= Date.now();
              this.speaking = true;
              this.lastSpoken = Date.now();
              await this.sendAudio(chunk, controller, valid, turnId);
              timing.mark("firstHostAudio");
            }
          }
        }
      } catch (e) {
        speechError = e;
        producerWake?.();
      }
    })();
    try {
      const contextStartedAt = Date.now();
      // These local paths consume only this question. Keep its source receipt
      // and live checks, without fetching or binding unrelated private history.
      let ctx: LiveContext = await timing.measure("contextBuild", () => selfContained
        ? Promise.resolve({ scene: {}, confirmed: [], work: [] }) : this.context(query, this.persona));
      await timing.measure("sourceValidation", async () => this.hooks?.validate(ctx));
      const utterance = await timing.measure("recordUser", async () => this.hooks?.recordUser?.(query, Date.now(), this.persona.publicScene));
      const additions: LiveMessage[] = utterance?.contextSnapshotId ? [{ role: "user", content: query, contextSnapshotId: utterance.contextSnapshotId, publicScene: this.persona.publicScene }] : [];
      if (needsCurrentFrame(query, this.persona.name)) {
        if (!this.local.describeFrame) throw new Error("local_vision_not_configured");
        const frame = await this.frames.request(controller.signal);
        const observedFrames = [frame];
        if (/(?:变化|移动|动作)/.test(query) && this.local.describeFrames) { await new Promise<void>(resolve => setTimeout(resolve, 600)); if (!valid()) return; observedFrames.push(await this.frames.request(controller.signal)); }
        const description = await timing.measure("visualModel", () => observedFrames.length > 1 && this.local.describeFrames ? this.local.describeFrames(observedFrames, query, controller.signal) : this.local.describeFrame!(frame, query, controller.signal));
        if (!valid()) return;
        if (!description.trim()) throw new Error("current_frame_unreadable");
        let visual: LiveContext | undefined;
        for (const observed of observedFrames) { visual = await this.hooks?.recordVisual?.(observed, description, this.persona.publicScene); if (visual?.contextSnapshotId) additions.push({ role: "user", content: "本次画面", contextSnapshotId: visual.contextSnapshotId, publicScene: this.persona.publicScene }); }
        ctx = { ...ctx, scene: { ...(ctx.scene as object), currentFrame: (visual?.scene as any)?.currentFrame ?? { description, capturedAt: frame.capturedAt, ageAtReceiveMs: frame.ageMs } } };
        event("vision_observed", { capturedAt: frame.capturedAt, capturedTimes: observedFrames.map(f=>f.capturedAt), ageAtReceiveMs: frame.ageMs, description, coverage: observedFrames.length > 1 ? "two-frames-not-complete-motion" : "single-frame" });
      }
      // Earlier turns with changed or deleted sources cannot override the latest confirmed memory.
      const readable: LiveMessage[] = this.hooks?.filterHistory ? await timing.measure("historyFilter", () => this.hooks!.filterHistory!(this.history)) : [];
      for (const message of this.hooks?.filterHistory ? [] : this.history) {
        try { await this.hooks?.validateHistory([message]); readable.push(message); } catch { /* omit unavailable history */ }
      }
      this.history = readable;
      if (this.hooks?.bindHistory) ctx = await timing.measure("historyBinding", () => this.hooks!.bindHistory!(ctx, selfContained ? additions : [...this.history, ...additions], this.persona.publicScene));
      currentContext = ctx;
      this.lastContext = ctx;
      const currentMessage = this.history.find((m) => m.turnId === turnId && m.role === "user");
      if (currentMessage) currentMessage.contextSnapshotId = ctx.contextSnapshotId;
      const contextMs = Date.now() - contextStartedAt;
      timing.mark("contextReady");
      if (!valid()) return;
      const input: ReplyInput = {
        sessionId: this.id,
        query,
        audio: pcm,
        observeMetrics: (stage, values) => timing.provider(stage, values),
        persona: this.persona,
        context: ctx,
        history: (selfContained ? [] : this.history)
          .filter(
            (m) =>
              m.turnId !== turnId &&
              (!this.persona.publicScene || m.publicScene === true),
          )
          .map(({ role, content, interrupted }) => ({
            role,
            content,
            interrupted,
          })),
      };
      const routed =
        source !== "ambient" && (forceHarness || needsHarness(query, this.persona.name));
      // This DSH grant can read private project materials through its own tools.
      // Public speech requires a separately constrained execution identity, not only a filtered prompt.
      if (routed && this.persona.publicScene) {
        event("configuration_required", { code: "public_harness_not_available" });
        return;
      }
      if (routed && !this.harness?.routes().length) {
        event("configuration_required", { code: "configure_harness_model" });
        return;
      }
      if (routed) await this.hooks?.authorizeExternal(ctx, this.history);
      if (routed && this.work && !this.delegateTask) {
        work = await this.work.begin(this.device, query, ctx);
        input.context.work = {
          briefing: ctx.work,
          assignedWorkItemId: work.workItemId,
          authenticatedAgent: "live-dsh",
        };
      }
      if (!valid()) {
        if (work) await this.work!.fail(work, "aborted_before_dispatch");
        return;
      }
      event("turn_started", {
        contextSnapshotId: ctx.contextSnapshotId,
        workItemId: work?.workItemId,
        query,
        route: routed ? "harness" : "local",
        cancelSupported: routed && this.harness?.cancelSupported,
        publicScene: this.persona.publicScene,
      });
      const delegated = routed && this.delegateTask;
      if (delegated) await this.delegateTask!(input, randomUUID());
      const reply = delegated
        ? (async function* (): AsyncIterable<ProviderChunk> { yield { type: "text", text: "工作已排队，你可以继续交流。完成后请在工作与成果中复核。" }; })()
        : routed ? this.harness!.reply(input, controller.signal)
        : this.provider.reply(input, controller.signal);
      for await (const chunk of reply) {
        await timing.measure("sourceValidation", async () => this.hooks?.validate(ctx));
        if (chunk.type === "text") {
          answer += chunk.text;
          if (this.provider !== this.local && !routed) this.currentSpokenText = answer;
          if (!valid()) continue;
          if (
            !routed &&
            answer.length < 120 &&
            /无法(?:完成|处理)|需要更强.{0,6}模型|超出.{0,6}能力/.test(answer)
          )
            throw new Error("local_capability_exceeded");
          this.lastAnswer = answer;
          firstTextAt ??= Date.now();
          timing.mark("firstText");
          event("text_delta", { text: chunk.text });
          if (this.provider === this.local || routed) {
            clearTimeout(phraseTimer);
            speechQueue.push(...phrases.add(chunk.text));
            // Coalesce normal streamed clauses, but do not hide the first
            // completed clause behind a stalled language-model continuation.
            phraseTimer = setTimeout(() => {
              if (valid() && !producerDone) { speechQueue.push(...phrases.flushPause()); speechWake?.(); }
            }, 180);
            while (speechQueue.length > 16 && valid() && !speechError)
              await new Promise<void>((resolve) => {
                const wake = () => {
                  controller.signal.removeEventListener("abort", wake);
                  resolve();
                };
                producerWake = wake;
                controller.signal.addEventListener("abort", wake, {
                  once: true,
                });
              });
            producerWake = undefined;
            speechWake?.();
          }
        } else if (valid()) {
          nativeAudio = true;
          firstAudioAt ??= Date.now();
          this.speaking = true;
          this.lastSpoken = Date.now();
          await this.sendAudio(chunk, controller, valid, turnId);
          timing.mark("firstHostAudio");
        }
      }
      if (valid() && !nativeAudio) {
        speechQueue.push(...phrases.add("", true));
        if (this.provider !== this.local && !routed) speechQueue.push(answer);
      }
      producerDone = true;
      speechWake?.();
      await consumer;
      if (speechError && valid()) {
        event("notice", { code: "speech_failed_text_preserved" });
      }
      if (work && answer.trim()) {
        await this.hooks?.validate(ctx);
        await this.work!.complete(work, answer);
        this.event("work_updated", { workItemId: work.workItemId }, turnId);
      }
      if (answer.trim() && contextGeneration === this.contextGeneration) {
        const index = this.history.findIndex(
          (m) => m.turnId === turnId && m.role === "user",
        );
        if (index >= 0)
          this.history.splice(index + 1, 0, {
            role: "assistant",
            content: answer,
            interrupted: !valid(),
            turnId,
            publicScene: input.persona.publicScene,
            contextSnapshotId: ctx.contextSnapshotId,
            at: Date.now(),
          });
        this.history = this.history.slice(-200);
        await timing.measure("outputCheckpoint", () => this.save());
      }
      if (valid()) {
        this.lastAnswer = answer;
        this.speaking = false;
        event("completed", {
          workItemId: work?.workItemId,
          contextMs,
          promptChars: JSON.stringify(ctx).length,
          answer,
          firstTextMs: firstTextAt ? firstTextAt - startedAt : null,
          firstAudioMs: firstAudioAt ? firstAudioAt - startedAt : null,
          durationMs: Date.now() - startedAt,
          timings: timing.snapshot(),
        });
      }
    } catch (e) {
      const code = (e as Error).message;
      if (/live_context_changed|context_unavailable|context_access_revoked|live_authorization_revoked/.test(code)) this.invalidateContext();
      const explicit =
        source === "user" ||
        (source === "voice" &&
          (query.includes(this.persona.name) || /ClawSense|搭子/i.test(query)));
      if (
        !forceHarness &&
        !needsHarness(query, this.persona.name) &&
        explicit &&
        valid() &&
        this.harness?.routes().length &&
        /^(model_|worker_|local_capability_exceeded)/.test(code)
      ) {
        if (!this.allowAutomaticHarnessFallback) {
          event("configuration_required", { code: "local_harness_fallback_requires_choice" });
          return;
        }
        event("notice", { code: "local_unavailable_using_authorized_harness" });
        replaced = true;
        speechQueue.length = 0;
        producerDone = true;
        speechWake?.();
        await consumer;
        await this.answer(
          query,
          source,
          pcm,
          controller,
          version,
          turnId,
          true,
          timing,
        );
        return;
      }
      if (work) await this.work?.fail(work, (e as Error).message);
      if (valid() && code === "configure_stronger_harness_model")
        this.event("configuration_required", { code }, turnId);
      else if (valid())
        event("error", {
          code: (e as Error).message
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .slice(0, 100),
          answerPreserved: !!answer,
          timings: timing.snapshot(),
        });
    } finally {
      clearTimeout(phraseTimer);
      producerDone = true;
      speechWake?.();
      await consumer;
      if (valid()) {
        this.current = undefined;
        this.speaking = false;
      }
    }
  }
  playback(active: boolean) {
    this.playbackActive = active;
    this.lastSpoken = Date.now();
  }
  audio(pcm: Buffer, source: "user" | "ambient") {
    if (!pcm.length || pcm.length > 32000 || pcm.length % 2 || this.closed)
      throw new Error("invalid_audio_frame");
    // Bound actual audio duration, not arbitrary packet count: the previous
    // 50-packet gate meant either one second or fifty seconds of queued audio.
    // Two seconds tolerate a short decoder stall; a packet cap also bounds tiny-frame floods.
    if (this.pendingAudioBytes + pcm.length > 64000 || this.pendingFrames >= 200) throw new Error("audio_backpressure");
    this.pendingFrames++; this.pendingAudioBytes += pcm.length;
    const echoReference = this.speaking || this.playbackActive || Date.now() - this.lastSpoken < 1500 ? (this.currentSpokenText || this.lastAnswer) : "";
    const inputGeneration = this.contextGeneration;
    this.audioTail = this.audioTail
      .then(() => inputGeneration === this.contextGeneration ? this.processAudio(pcm, source, echoReference) : undefined)
      .catch(() => this.event("error", { code: "audio_processing_failed" }))
      .finally(() => { this.pendingFrames--; this.pendingAudioBytes -= pcm.length; this.stage("idle"); });
  }
  private async processAudio(pcm: Buffer, source: "user" | "ambient", echoReference: string) {
    if (this.closed) return;
    const inputGeneration = this.contextGeneration;
    let power = 0;
    for (let i = 0; i < pcm.length; i += 2)
      power += (pcm.readInt16LE(i) / 32768) ** 2;
    const rms = Math.sqrt(power / Math.max(1, pcm.length / 2));
    this.processedAudioFrames++; this.maxInputRms = Math.max(this.maxInputRms, rms);
    // Communication DSP can attenuate valid speech far below the legacy MIC threshold.
    // Track quiet frames while retaining a minimum floor; RMS still does not establish intent.
    const threshold = Math.max(0.0015, Math.min(0.008, this.noiseFloor * 3));
    this.stage("vad");
    const voiced = this.local.voiceActivity ? await this.local.voiceActivity(this.vadId(), pcm.toString("base64"), this.recognition.signal) : rms >= threshold,
      ms = pcm.length / 32;
    if (this.closed || inputGeneration !== this.contextGeneration) return;
    if (voiced) this.voicedAudioFrames++;
    if (performance.now() - this.lastInputHealthAt >= 1000) {
      this.lastInputHealthAt = performance.now();
      this.event("input_health", { diagnostics: this.inputDiagnostics() });
    }
    if (!voiced) this.noiseFloor = this.noiseFloor * 0.97 + rms * 0.03;
    if (!voiced && !this.voicedMs) { this.preRoll.push(pcm); while (this.preRoll.reduce((n,b)=>n+b.length,0) > 9600) this.preRoll.shift(); return; }
    if (!this.voicedMs && this.preRoll.length) {
      this.utterancePreRollBytes = this.preRoll.reduce((n,b)=>n+b.length,0);
      this.inputPcm.push(...this.preRoll); this.asrPcm.push(...this.preRoll);
      this.asrSamples += this.preRoll.reduce((n,b)=>n+b.length/2,0); this.preRoll = [];
    }
    if (echoReference.length > this.utteranceEchoReference.length) this.utteranceEchoReference = echoReference;
    if (!this.voicedMs) {
      this.source = source; this.utteranceEpoch++; this.utteranceInputVersion = this.explicitInputVersion; this.utteranceDirectInputVersion = this.directInputVersion; this.utteranceInputCancellationVersion = this.inputCancellationVersion; this.controlProbe = undefined;
      this.utteranceDuringPlayback = this.speaking || this.playbackActive;
      this.partial = { inputId: ++this.inputOrdinal, id: `${this.id}:utterance:${this.utteranceEpoch}`, epoch: this.utteranceEpoch, contextGeneration: this.contextGeneration, directVersion: this.directInputVersion, pending: [], pendingBytes: 0, ended: false, limited: false, finalized: false, used: false };
    }
    if (voiced) {
      this.voicedMs += ms;
      this.silenceMs = 0;
    } else this.silenceMs += ms;
    this.utteranceMs += ms;
    this.inputPcm.push(pcm);
    this.asrPcm.push(pcm);
    this.asrSamples += pcm.length / 2;
    const controlTrim = Math.max(0, this.utterancePreRollBytes - 2560); // Keep 80ms onset context.
    if (this.source === "user" && !this.utteranceStopped && this.utteranceInputVersion === this.explicitInputVersion && (this.speaking || this.playbackActive) && !this.controlProbe && this.earlyControlChecks < 6 && this.voicedMs >= 64 && this.inputPcm.reduce((n,b)=>n+b.length,0) - controlTrim >= 5120 && this.utteranceMs - this.earlyControlAtMs >= 32 && this.local.finalRecognition) {
      this.earlyControlAtMs = this.utteranceMs;
      this.earlyControlChecks++;
      const epoch = this.utteranceEpoch, contextGeneration = this.contextGeneration, inputVersion = this.utteranceInputVersion;
      // Several bounded prefixes beat a single premature guess. Padding gives
      // the short-command recognizer a trailing boundary; it is never saved as
      // recording data and only exact stop phrases can trigger early control.
      const controlAudio = Buffer.concat([Buffer.concat(this.inputPcm).subarray(controlTrim), Buffer.alloc(3200)]);
      const probe = this.local.finalRecognition(controlAudio.toString("base64"), this.recognition.signal).then(value => {
        if (this.closed || epoch !== this.utteranceEpoch || contextGeneration !== this.contextGeneration) return;
        const control = value.trim();
        if (isSpeechStop(control)) {
          this.utteranceStopped = true;
          if (inputVersion === this.explicitInputVersion) { this.transcript = control; this.interrupt(); this.event("transcript", { text: control, final: false }); this.event("notice", { code: "speech_stopped_task_unchanged" }); }
        }
      }).catch(() => { /* The normal streaming/final recognizer still handles the utterance. */ });
      this.controlProbe = probe; this.jobs.add(probe); void probe.finally(() => { this.jobs.delete(probe); if (this.controlProbe === probe) this.controlProbe = undefined; });
    }
    if (this.silenceMs >= 1000 && this.voicedMs < 160) {
      this.inputDecision(this.partial?.inputId, this.utteranceStopped ? "control_handled" : "too_short");
      this.inputPcm = [];
      this.asrPcm = [];
      this.asrSamples = 0;
      this.voicedMs = 0;
      this.silenceMs = 0;
      this.utteranceMs = 0;
      this.transcript = "";
      this.previousTranscript = "";
      this.utteranceEchoReference = "";
      this.utteranceDuringPlayback = false;
      this.utteranceStopped = false;
      this.earlyControlChecks = 0; this.earlyControlAtMs = 0; this.utterancePreRollBytes = 0;
      this.utteranceEpoch++; this.controlProbe = undefined;
      this.retirePartial();
      return;
    }
    if (this.utteranceMs > 20000) this.silenceMs = 1500;
    const final =
      this.voicedMs >= 160 &&
      this.silenceMs >= endpointSilence(this.transcript);
    if (this.asrSamples < 2560 && !final) return;
    const chunk = Buffer.concat(this.asrPcm);
    this.asrPcm = [];
    this.asrSamples = 0;
    if (!final) { this.offerPartial(chunk); return; }
    const obsolete = this.utteranceDirectInputVersion !== this.directInputVersion || (!this.utteranceStopped && this.utteranceInputCancellationVersion !== this.inputCancellationVersion);
    const partial = this.partial!;
    partial.ended = true; partial.pending = []; partial.pendingBytes = 0; this.partial = undefined;
    const initialText = this.transcript.trim(),
      audio = Buffer.concat(this.inputPcm).toString("base64"),
      origin = this.source,
      stopped = this.utteranceStopped,
      reference = this.utteranceEchoReference || this.currentSpokenText || this.lastAnswer,
      echoEligible = !!this.utteranceEchoReference || this.speaking || this.playbackActive || Date.now() - this.lastSpoken < 1500,
      duringPlayback = this.utteranceDuringPlayback,
      endpointSilenceMs = this.silenceMs, bufferedAudioMs = this.utteranceMs,
      directVersion = this.directInputVersion, cancellationVersion = this.inputCancellationVersion, explicitVersion = this.explicitInputVersion;
    this.inputPcm = [];
    this.utteranceMs = 0;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.transcript = "";
    this.previousTranscript = "";
    this.utteranceEchoReference = "";
    this.utteranceDuringPlayback = false;
    this.utteranceStopped = false;
    this.earlyControlChecks = 0; this.earlyControlAtMs = 0; this.utterancePreRollBytes = 0;
    this.utteranceEpoch++; this.controlProbe = undefined;
    this.stage("endpoint-captured");
    if (obsolete) { this.inputDecision(partial.inputId, "superseded"); if (partial.used) void this.queueStreaming(() => this.local.resetRecognition(partial.id)).catch(() => {}); return; }
    if (this.pendingFinalizations >= 2) {
      if (partial.used) void this.queueStreaming(() => this.local.resetRecognition(partial.id)).catch(() => {});
      this.interrupt();
      this.event("error", { code: "audio_backpressure", inputDiagnostics: { ...this.inputDiagnostics(), reason: "final-recognition-capacity" } });
      return;
    }
    this.pendingFinalizations++;
    this.inputDecision(partial.inputId, "recognizing");
    // Whole-utterance rechecking and history I/O are not capture work. Keep them
    // ordered and bounded without holding the realtime frame queue behind them.
    const queuedAt = performance.now();
    const validInput = () => !this.closed && inputGeneration === this.contextGeneration && directVersion === this.directInputVersion && cancellationVersion === this.inputCancellationVersion;
    let onlineTranscript = "", checkedTranscript = "", compared = false;
    const compareRecognition = () => {
      if (compared || !validInput() || !recognitionDiffers(onlineTranscript, checkedTranscript)) return;
      compared = true;
      this.inputCounts.recognition_difference = Math.min(Number.MAX_SAFE_INTEGER, (this.inputCounts.recognition_difference ?? 0) + 1);
      // Ephemeral alternatives for the authenticated client only: never promote
      // them to facts, write them into history, or wait for them on the fast path.
      this.event("recognition_comparison", { inputId: partial.inputId, selected: checkedTranscript.slice(0,400), alternative: onlineTranscript.slice(0,400) });
    };
    let streamingFinalCallMs = 0;
    let streamingResult: Promise<string>;
    if (this.streamingFinals < 2) {
      this.streamingFinals++;
      streamingResult = this.queueStreaming(async () => {
        try {
          if (!validInput() || partial.finalized) return "";
          await this.local.resetRecognition(partial.id);
          partial.used = false;
          if (!validInput() || partial.finalized) return "";
          const began = performance.now();
          partial.used = true;
          const result = await this.local.recognize(partial.id, audio, true, this.recognition.signal);
          streamingFinalCallMs = performance.now() - began;
          return result;
        } finally { if (partial.used) { await this.local.resetRecognition(partial.id).catch(() => {}); partial.used = false; } }
      }).finally(() => { this.streamingFinals--; });
    } else {
      partial.limited = true;
      streamingResult = Promise.resolve("");
      if (partial.used) void this.queueStreaming(() => this.local.resetRecognition(partial.id)).catch(() => {});
    }
    // A safe stop may win the race with a slower full-utterance recheck.
    void streamingResult.then(text => {
      onlineTranscript = text.trim(); compareRecognition();
      if (origin === "user" && validInput() && explicitVersion === this.explicitInputVersion && !partial.finalized && isSpeechStop(text)) {
        partial.finalized = true; this.interrupt(); this.event("transcript", { text: "停", final: true }); this.event("notice", { code: "speech_stopped_task_unchanged" });
        this.inputDecision(partial.inputId, "control_handled");
      }
    }).catch(() => {});
    const job = this.finalizationTail.then(async () => {
      if (!validInput()) { if (!partial.finalized) this.inputDecision(partial.inputId, "superseded"); return; }
      let text = stopped ? "停" : "", finalRecheckMs = 0;
      const finalQueueMs = performance.now() - queuedAt;
      if (!stopped && this.local.finalRecognition) {
        const began = performance.now();
        const checked = await this.local.finalRecognition(audio, this.recognition.signal);
        finalRecheckMs = performance.now() - began;
        if (checked.trim()) { text = checked.trim(); checkedTranscript = text; }
      }
      if (!text && !stopped) text = (await streamingResult.catch(() => "")).trim();
      const uncertainInterruption = !stopped && origin === "user" && duringPlayback &&
        speechCharacters(text).length === 1 && !isSpeechStop(text) && !isBackchannel(text) && !isIncompleteSpeech(text) && !isLikelyEcho(text, reference);
      if (uncertainInterruption) {
        // Only a short ambiguous interruption waits briefly for the independent
        // recognizer. Never reinterpret “银” as “停” or send it to a new topic.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const alternate = await Promise.race([streamingResult.catch(() => ""), new Promise<string>(resolve => { timer = setTimeout(() => resolve(""), 250); })]);
        clearTimeout(timer);
        if (isSpeechStop(alternate)) text = alternate.trim();
      }
      if (!validInput()) { if (!partial.finalized) this.inputDecision(partial.inputId, "superseded"); return; }
      if (stopped) text = "停";
      if (!text && hasSpeechContent(initialText)) { this.inputDecision(partial.inputId, "no_transcript"); this.event("error", { code: "audio_processing_failed" }); return; }
      partial.finalized = true;
      this.event("transcript", { text, final: true });
      compareRecognition();
      this.event("input_timing", { endpoint: "host-final-transcript", streamingFinalCallMs, finalRecheckMs, finalQueueMs, endpointSilenceMs, bufferedAudioMs, partialCoverageLimited: partial.limited, includesCaptureOrNetworkDelay: false });
      if (stopped) this.inputDecision(partial.inputId, "control_handled");
      else if (!hasSpeechContent(text)) this.inputDecision(partial.inputId, "no_transcript");
      else if (echoEligible && isLikelyEcho(text, reference)) this.inputDecision(partial.inputId, "echo_ignored");
      else if (uncertainInterruption && !isSpeechStop(text)) {
        this.interrupt();
        this.inputDecision(partial.inputId, "interruption_unclear");
        this.event("notice", { code: "unclear_interruption_paused" });
      }
      else await this.text(text, origin === "user" ? "voice" : "ambient", audio, partial.inputId);
    }).catch(() => { if (validInput()) { this.inputDecision(partial.inputId, "processing_failed"); this.event("error", { code: "audio_processing_failed" }); } }).finally(() => { partial.finalized = true; this.pendingFinalizations--; });
    this.finalizationTail = job;
    this.jobs.add(job); void job.finally(() => this.jobs.delete(job));
  }
  close(): Promise<void> {
    return (this.closePromise ??= (async () => {
      this.interrupt();
      this.closed = true;
      this.frames.clear();
      this.recognition.abort();
      await this.audioTail;
      this.retirePartial();
      await Promise.allSettled([...this.jobs]);
      await this.streamingTail;
      await this.local.resetRecognition(this.vadId()).catch(() => {});
      await this.persistTail;
    })());
  }
}
