import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { json, readJson } from "../http.js";
import type { OpenClawPluginApi } from "../openclaw-types.js";
import type { UnifiedContextStore } from "../context-store.js";
import { liveContextHooks } from "./context.js";
import { PersonaStore } from "./persona.js";
import { needsCurrentFrame } from "./visual.js";
import type { LiveConfig, LiveContext, LiveMessage, LiveProvider, PersonaProfile, LiveSessionHooks } from "./types.js";

export function validateUpstreamConfig(config: LiveConfig["upstream"]) {
  if (!config) return;
  const url = new URL(config.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash || url.username || url.password || !path.isAbsolute(config.tokenFile)) throw new Error("invalid_upstream_config");
  if (config.maxSessionMs !== undefined && (!Number.isInteger(config.maxSessionMs) || config.maxSessionMs < 30000 || config.maxSessionMs > 3600000)) throw new Error("invalid_upstream_duration");
}

/** Pipecat owns media, endpointing and playback. This boundary owns evidence and
 * model access only. It never instantiates LiveSession or a second state writer. */
export class UpstreamConversation {
  readonly id = randomUUID();
  history: LiveMessage[] = [];
  context?: LiveContext;
  responseId = "";
  answer = "";
  private responses = new Map<string, { text: string; context?: LiveContext; heard: boolean; epoch: number }>();
  private current?: AbortController;
  private speech = new Set<AbortController>();
  private epoch = 0;
  private persistence: Promise<void> = Promise.resolve();
  closed = false;
  constructor(readonly device: string, readonly persona: PersonaProfile, private provider: LiveProvider,
    private hooks: LiveSessionHooks, private getContext: (query: string) => Promise<LiveContext>, private authorized: () => Promise<boolean>, private file?: string) {}
  async restore() {
    await this.check();
    if (!this.file) return;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error("upstream_history_unavailable");
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.history) || value.history.length > 40 || value.history.some((m: any) => !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || m.content.length > 12000 || typeof m.contextSnapshotId !== "string" || typeof m.publicScene !== "boolean")) throw new Error("upstream_history_unavailable");
      this.history = await this.hooks.filterHistory?.(value.history) ?? [];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private save() {
    if (!this.file || !this.hooks.persist) return Promise.resolve();
    const file = this.file, history = structuredClone(this.history.slice(-40));
    const job = this.persistence.then(() => this.hooks.persist!(file, history, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID() + ".tmp";
      try { await fs.writeFile(temporary, JSON.stringify({ version: 1, history }), { mode: 0o600, flag: "wx" }); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    }));
    this.persistence = job.catch(() => {}); return job;
  }
  async check() {
    if (this.closed || !(await this.authorized())) throw new Error("upstream_authorization_revoked");
    if (this.context) await this.hooks.validate(this.context);
  }
  interrupt() { this.epoch++; this.current?.abort(); this.current = undefined; for (const controller of this.speech) controller.abort(); }
  async close() { this.closed = true; this.interrupt(); this.history = []; this.context = undefined; this.responses.clear(); await this.persistence; }
  async *reply(query: string, frame?: { jpeg: string; capturedAt: number; ageMs: number; timestampBasis?: "device-capture" | "server-receive" }, signal?: AbortSignal) {
    this.interrupt(); const epoch = this.epoch;
    const controller = this.current = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
    const valid = async () => { await this.check(); if (controller.signal.aborted || epoch !== this.epoch) throw new Error("aborted"); };
    this.responseId = randomUUID(); this.answer = "";
    const responseId = this.responseId, response = { text: "", context: undefined as LiveContext | undefined, heard: false, epoch };
    this.responses.set(responseId, response);
    while (this.responses.size > 24) this.responses.delete(this.responses.keys().next().value!);
    await valid();
    this.history = await this.hooks.filterHistory?.(this.history) ?? [];
    let context = await this.getContext(query);
    const observation = await this.hooks.recordUser?.(query, Date.now(), this.persona.publicScene);
    const added: LiveMessage[] = observation?.contextSnapshotId ? [{ role: "user", content: query, contextSnapshotId: observation.contextSnapshotId, publicScene: this.persona.publicScene }] : [];
    if (needsCurrentFrame(query, this.persona.name)) {
      if (!frame || !Number.isFinite(frame.ageMs) || frame.ageMs < 0 || frame.ageMs > 2000 || !Number.isFinite(frame.capturedAt) || !frame.jpeg || frame.jpeg.length > 1500000) throw new Error("current_frame_unavailable");
      if (!this.provider.describeFrame) throw new Error("local_vision_not_configured");
      const current = { ...frame, receivedAt: Date.now(), requestId: this.responseId };
      const description = await this.provider.describeFrame(current, query, controller.signal);
      await valid();
      if (!description.trim()) throw new Error("current_frame_unreadable");
      const visual = await this.hooks.recordVisual?.(current, description, this.persona.publicScene);
      if (visual?.contextSnapshotId) added.push({ role: "user", content: "本次画面", contextSnapshotId: visual.contextSnapshotId, publicScene: this.persona.publicScene });
      context = { ...context, scene: { ...(context.scene as object), currentFrame: (visual?.scene as any)?.currentFrame ?? { description, capturedAt: frame.capturedAt, timestampBasis: frame.timestampBasis } } };
    }
    this.context = await this.hooks.bindHistory?.(context, [...this.history, ...added], this.persona.publicScene) ?? context;
    response.context = this.context;
    await valid();
    const inputHistory = this.history.filter(m => !this.persona.publicScene || m.publicScene === true).slice(-20);
    this.history.push({ role: "user", content: query, turnId: responseId, contextSnapshotId: this.context.contextSnapshotId, publicScene: this.persona.publicScene, at: Date.now() });
    await this.save(); await valid();
    yield { type: "response", responseId };
    for await (const chunk of this.provider.reply({ sessionId: this.id, query, persona: this.persona, context: this.context, history: inputHistory }, controller.signal)) {
      await valid();
      if (chunk.type === "text") { this.answer += chunk.text; response.text += chunk.text; yield chunk; }
    }
    } finally { signal?.removeEventListener("abort", abort); controller.abort(); }
  }
  async *speak(text: string, responseId: string, signal: AbortSignal) {
    const epoch = this.epoch;
    await this.check();
    // A trusted upstream renderer may normalize punctuation/Markdown. Authorize
    // its response lease, not raw-string equality with the unrendered answer.
    if (!responseId || responseId !== this.responseId || this.responses.get(responseId)?.epoch !== epoch || !this.answer) throw new Error("upstream_stale_speech");
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.speech.add(controller);
    try { for await (const chunk of this.provider.synthesize(text, this.persona, controller.signal)) {
      await this.check();
      if (controller.signal.aborted || epoch !== this.epoch) throw new Error("aborted");
      yield chunk;
    } } finally { signal.removeEventListener("abort", abort); controller.abort(); this.speech.delete(controller); }
  }
  async commitHeard(text: string, responseId: string, interrupted: boolean) {
    await this.check();
    const response = this.responses.get(responseId);
    const canonical = (s: string) => s.replace(/([。！？.!?])\s+/g, "$1").trim();
    if (!response?.context || text.length > 12000 || !canonical(response.text).startsWith(canonical(text)) || (!interrupted && canonical(response.text) !== canonical(text))) throw new Error("upstream_invalid_playback_receipt");
    await this.hooks.validate(response.context);
    if (response.heard) return;
    const index = this.history.findIndex(m => m.role === "user" && m.turnId === responseId);
    if (index < 0) throw new Error("upstream_stale_playback_receipt");
    if (text) this.history.splice(index + 1, 0, { role: "assistant", content: interrupted ? text : response.text, interrupted, turnId: responseId, contextSnapshotId: response.context.contextSnapshotId, publicScene: this.persona.publicScene });
    response.heard = true;
    this.history = this.history.slice(-40);
    await this.save();
  }
}

export function registerUpstreamLive(options: {
  api: OpenClawPluginApi; config: LiveConfig; store?: UnifiedContextStore; personas: PersonaStore; local: LiveProvider;
  activeDevices: Set<string>; authorize: (device: string) => Promise<void>;
  authenticate: (authorization?: string) => Promise<{ok:boolean;device?:{deviceId:string}}>;
  context: (device: string, query: string, persona: PersonaProfile) => Promise<LiveContext>;
  idle: () => void;
}) {
  const cfg = options.config.upstream;
  if (!cfg) return () => {};
  validateUpstreamConfig(cfg);
  const sessions = new Map<string, { conversation: UpstreamConversation; authorization: string; expiresAt: number }>();
  let disposed = false;
  const secret = async () => {
    const stat = await fs.lstat(cfg.tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 1024) throw new Error("upstream_token_unavailable");
    const value = (await fs.readFile(cfg.tokenFile, "utf8")).trim();
    if (value.length < 32) throw new Error("upstream_token_unavailable"); return value;
  };
  const close = async (id: string) => { const s = sessions.get(id); if (s) { sessions.delete(id); await s.conversation.close(); options.activeDevices.delete(s.conversation.device); options.idle(); } };
  const timer = setInterval(() => { for (const [id, s] of sessions) if (Date.now() > s.expiresAt) void close(id); }, 1000); timer.unref();
  const auth = async (authorization?: string) => { if (disposed) throw new Error("upstream_stopped"); const result = await options.authenticate(authorization); if (!result.ok || !result.device) throw new Error("unauthorized"); await options.authorize(result.device.deviceId); return result.device.deviceId; };
  options.api.registerHttpRoute({ path: "/api/clawsense/live-upstream/offer", auth: "plugin", async handler(req, res) {
    try {
      if (!["POST", "PATCH"].includes(req.method ?? "")) { json(res, 405, { error: "method_not_allowed" }); return; }
      const authorization = req.headers.authorization;
      const deviceId = await auth(authorization);
      const body = await readJson(req, res, 160000); if (!body) return;
      const response = await fetch(new URL("api/offer", cfg.url), { method: req.method, headers: { "content-type": "application/json", "x-clawsense-bridge": await secret(), "x-clawsense-device": deviceId, authorization: authorization! }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const value = await response.text();
      res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(value);
    } catch { if (!res.headersSent) json(res, 503, { error: "upstream_connection_unavailable" }); else res.end(); }
  } });
  options.api.registerHttpRoute({ path: "/api/clawsense/live-upstream/model", auth: "plugin", async handler(req, res) {
    const controller = new AbortController(); res.on("close", () => controller.abort());
    try {
      if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return; }
      const expected = Buffer.from(await secret()), supplied = Buffer.from(String(req.headers["x-clawsense-bridge"] ?? ""));
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { json(res, 401, { error: "unauthorized" }); return; }
      const authorization = req.headers.authorization!;
      const body = await readJson(req, res, 2000000) as any; if (!body) return;
      // Teardown must remain available after processing permission is revoked.
      // It can only release the exact original session and reveals no content.
      if (body.op === "close") {
        const entry = sessions.get(body.sessionId);
        if (entry && entry.authorization !== authorization) throw new Error("unauthorized");
        await close(body.sessionId); json(res, 200, { ok: true }); return;
      }
      const device = await auth(authorization);
      if (body.op === "open") {
        if (!options.store || options.activeDevices.has(device) || sessions.size >= 2) throw new Error("upstream_device_busy");
        // Reserve before the first await: two simultaneous offers must not acquire
        // independent media/memory owners for one paired device.
        options.activeDevices.add(device);
        try {
        const personaRevision = options.personas.revision(device);
        const authorized = async () => { try { return await auth(authorization) === device && options.personas.revision(device) === personaRevision; } catch { return false; } };
        const persona = await options.personas.read(device);
        if (options.personas.revision(device) !== personaRevision) throw new Error("upstream_persona_changed_retry");
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(device)) throw new Error("invalid_device_id");
        const conversation = new UpstreamConversation(device, persona, options.local, liveContextHooks(options.store, device, options.config.projectId ?? "live", authorized), q => options.context(device, q, persona), authorized,
          path.join(options.api.runtime.state.resolveStateDir(), "plugins", "clawsense", "unified", "checkpoints", "upstream", device + ".json"));
        await conversation.restore();
        sessions.set(conversation.id, { conversation, authorization, expiresAt: Date.now() + (cfg.maxSessionMs ?? 120000) });
        json(res, 200, { sessionId: conversation.id, persona, maxSessionMs: cfg.maxSessionMs ?? 120000 }); return;
        } catch (error) { options.activeDevices.delete(device); options.idle(); throw error; }
      }
      const entry = sessions.get(body.sessionId);
      if (!entry || entry.conversation.device !== device || entry.authorization !== authorization || entry.expiresAt <= Date.now()) throw new Error("upstream_session_unavailable");
      const session = entry.conversation;
      await session.check();
      if (body.op === "check") { json(res, 200, { ok: true }); return; }
      if (body.op === "prepare") { const caps = await options.local.capabilities(); if (!caps.ready) throw new Error("models_unavailable"); await options.local.prepare?.(session.persona); if (body.vision === true) await options.local.preloadVisual?.(); json(res, 200, { ok: true }); return; }
      if (body.op === "heard") { await session.commitHeard(String(body.text ?? ""), String(body.responseId ?? ""), body.interrupted === true); json(res, 200, { ok: true }); return; }
      if (body.op === "asr") {
        if (typeof body.pcm !== "string" || body.pcm.length > 900000 || !options.local.finalRecognition) throw new Error("invalid_audio");
        const text = await options.local.finalRecognition(body.pcm, controller.signal); await session.check(); json(res, 200, { text }); return;
      }
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 12000) throw new Error("invalid_text");
      const stream = body.op === "reply" ? session.reply(body.text, body.frame, controller.signal) : body.op === "tts" ? session.speak(body.text, body.responseId, controller.signal) : undefined;
      if (!stream) throw new Error("unknown_operation");
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      for await (const chunk of stream) { if (controller.signal.aborted) break; res.write(JSON.stringify(chunk) + "\n"); }
      res.end();
    } catch (error) {
      const code = String((error as Error).message).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 90);
      if (!res.headersSent) json(res, 409, { error: code }); else { res.write(JSON.stringify({ type: "error", code }) + "\n"); res.end(); }
    }
  } });
  return async () => { disposed = true; clearInterval(timer); await Promise.all([...sessions.keys()].map(close)); };
}
