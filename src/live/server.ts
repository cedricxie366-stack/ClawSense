import type { LiveWorkStore } from "./work.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { json, readJson, methodNotAllowed } from "../http.js";
import type { OpenClawPluginApi } from "../openclaw-types.js";
import { PersonaStore, PERSONAS } from "./persona.js";
import { LiveSession, needsHarness } from "./session.js";
import { liveContextHooks } from "./context.js";
import { registerUpstreamLive, validateUpstreamConfig } from "./upstream.js";
import type { UnifiedContextStore } from "../context-store.js";
import { LocalLiveProvider, MiniCpmProvider } from "./local-provider.js";
import { DshAdapter } from "./dsh-adapter.js";
import { LiveRequestStore } from "./requests.js";
import { readLiveHistory } from "./history.js";
import { LiveExecutionQueue } from "./execution.js";
import { CodexAdapter } from "./codex-adapter.js";
import type {
  LiveConfig,
  LiveContext,
  LiveProvider,
  PersonaProfile,
} from "./types.js";
export function parseLiveConfig(raw: unknown): LiveConfig | undefined {
  if (raw === undefined || raw === null) return;
  const c = raw as LiveConfig;
  if (c.enabled !== true) return;
  if (
    !c.python ||
    !c.worker ||
    !c.llmModel ||
    !c.ttsModel ||
    !c.asrDir ||
    !Number.isInteger(c.port) ||
    c.port < 1024 ||
    c.port > 65535 ||
    !["127.0.0.1", "0.0.0.0"].includes(c.host)
  )
    throw new Error("invalid_live_config");
  if (c.projectId !== undefined && (typeof c.projectId !== "string" || !c.projectId.trim() || c.projectId === "*" || c.projectId.length > 200 || /[\u0000-\u001f]/.test(c.projectId))) throw new Error("invalid_live_project");
  if (c.allowAutomaticHarnessFallback !== undefined && typeof c.allowAutomaticHarnessFallback !== "boolean") throw new Error("invalid_live_fallback_policy");
  if (c.asrRecheckDir !== undefined && (typeof c.asrRecheckDir !== "string" || !c.asrRecheckDir.trim())) throw new Error("invalid_live_recheck_config");
  if (c.asrFinalLanguage !== undefined && !["zh", "en", "auto"].includes(c.asrFinalLanguage)) throw new Error("invalid_live_asr_language");
  for (const field of [c.vadModel, c.visionModel]) if (field !== undefined && (typeof field !== "string" || !field.trim())) throw new Error("invalid_live_model_config");
  if (
    c.dsh &&
    (!c.dsh.command ||
      !Array.isArray(c.dsh.args) ||
      !c.dsh.cwd ||
      !c.dsh.home ||
      !Array.isArray(c.dsh.routes) ||
      c.dsh.routes.some((r) => !r.id || !r.provider || !r.model))
  )
    throw new Error("invalid_live_dsh_config");
  if (c.native && (!c.native.python || !c.native.model))
    throw new Error("invalid_live_native_config");
  if (c.codex && (!c.codex.command || !c.codex.cwd)) throw new Error("invalid_live_codex_config");
  if (c.codex?.proxyUrl) { const url = new URL(c.codex.proxyUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_live_codex_proxy"); }
  validateUpstreamConfig(c.upstream);
  return c;
}
export function registerLive(options: {
  contextStore?: UnifiedContextStore;
  authorizeCapture?: (deviceId: string, projectId: string) => Promise<void>;
  api: OpenClawPluginApi;
  config?: LiveConfig;
  publicBaseUrl: () => string;
  authenticate: (
    authorization?: string,
  ) => Promise<{ ok: boolean; device?: { deviceId: string } }>;
  context: (
    deviceId: string,
    query: string,
    persona: PersonaProfile,
  ) => Promise<LiveContext>;
  work?: LiveWorkStore;
  providers?: { local: LiveProvider; native?: LiveProvider };
}) {
  const { api, config: cfg } = options;
  if (!cfg) return;
  const root = api.runtime.state.resolveStateDir();
  const store = new PersonaStore(root),
    local = options.providers?.local ?? new LocalLiveProvider(cfg);
  const native =
    options.providers?.native ??
    (cfg.native ? new MiniCpmProvider(cfg, local) : undefined);
  const harness = cfg.dsh ? new DshAdapter(cfg.dsh) : undefined;
  const sessions = new Map<string, LiveSession>();
  const execution = options.work ? new LiveExecutionQueue(root, options.work, { ...(harness ? { "live-dsh": harness } : {}), ...(cfg.codex ? { "live-codex": new CodexAdapter(cfg.codex) } : {}) }, options.contextStore, (device, workItemId) => { for (const session of sessions.values()) if (session.device === device) session.notifyWork(workItemId); }, cfg.projectId ?? "live") : undefined;
  const receipts = new LiveRequestStore(root);
  const authorizeOwnedProcessing = async (deviceId: string) => {
    if (options.authorizeCapture) return options.authorizeCapture(deviceId, cfg.projectId ?? "live");
    if (!options.contextStore) return;
    const policy = await options.contextStore.devicePolicy(deviceId);
    if (policy.processingLocation === "local-only") throw new Error("phone_local_processing_required");
    if (!policy.projectIds.includes(cfg.projectId ?? "live")) throw new Error("live_project_not_authorized");
  };
  options.contextStore?.registerPurgeObserver(() => { for (const session of sessions.values()) session.invalidateContext(); });
  options.contextStore?.registerChangeObserver(() => { for (const session of sessions.values()) session.recheckContext(); });
  const activeDevices = new Set<string>();
  const stopUpstream = registerUpstreamLive({ api, config: cfg, store: options.contextStore, personas: store, local, activeDevices,
    authorize: authorizeOwnedProcessing, authenticate: options.authenticate, context: options.context, idle: () => scheduleCooldown() });
  const visualDevices = new Set<string>();
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let preparations = 0;
  const scheduleCooldown = () => {
    if (activeDevices.size || preparations || stopping) return;
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = undefined;
      if (!activeDevices.size && !preparations && !stopping) void Promise.resolve(local.cooldown?.())
        .then(() => { if (!activeDevices.size && !preparations && !stopping) return local.releaseVisual?.(); })
        .catch(() => {});
    }, 60000);
    cooldownTimer.unref();
  };
  let server: http.Server | undefined;
  let wss: WebSocketServer | undefined;
  let probe:
    | Promise<Awaited<ReturnType<LiveProvider["capabilities"]>>>
    | undefined;
  let nativeProbe:
    | Promise<Awaited<ReturnType<LiveProvider["capabilities"]>>>
    | undefined;
  const capabilities = async (includeNative: boolean) => {
    // Share in-flight probes, never a process-lifetime readiness result. Workers
    // may have exited or had their working sets evicted during an idle period.
    const current = probe ??= local.capabilities();
    const currentNative = includeNative && native ? (nativeProbe ??= native.capabilities()) : undefined;
    try { return { local: await current, native: await currentNative }; }
    finally {
      if (probe === current) probe = undefined;
      if (nativeProbe === currentNative) nativeProbe = undefined;
    }
  };
  api.registerHttpRoute({
    path: "/api/clawsense/live-prepare",
    auth: "plugin",
    async handler(req, res) {
      if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return; }
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const auth = await options.authenticate(authorization);
      if (!auth.ok || !auth.device) { json(res, 401, { ok: false, error: "unauthorized" }); return; }
      const body = await readJson(req, res, 1024);
      if (!body) return;
      if (stopping || preparations >= 4) { json(res, 503, { ok: false, error: "preparation_busy" }); return; }
      preparations++;
      clearTimeout(cooldownTimer); cooldownTimer = undefined;
      const started = performance.now();
      try {
        await authorizeOwnedProcessing(auth.device.deviceId);
        const persona = await store.read(auth.device.deviceId);
        const vision = body.vision === true
          ? Promise.resolve(local.preloadVisual?.()).then(() => undefined, error => error as Error) : undefined;
        // Queue each worker's warmup while the others are still loading instead
        // of making every fast worker wait for the slowest model to load first.
        const probing = capabilities(false);
        const warming = Promise.resolve(local.prepare?.(persona)).then(() => undefined, error => error as Error);
        const caps = await probing;
        const loadedAt = performance.now();
        if (!caps.local.ready) throw new Error("local_models_unavailable");
        const warmError = await warming;
        if (warmError) throw warmError;
        if (vision) { const error = await vision; if (error) throw error; }
        await authorizeOwnedProcessing(auth.device.deviceId);
        if (!(await options.authenticate(authorization)).ok) { json(res, 401, { ok: false, error: "unauthorized" }); return; }
        json(res, 200, { ok: true, ready: true, preparationMs: performance.now() - started, capabilitiesMs: loadedAt - started, finalWarmupMs: performance.now() - loadedAt, initialization: caps.local.initialization, mediaStarted: false });
      } catch (error) {
        const code = (error as Error).message;
        json(res, 503, { ok: false, error: ["phone_local_processing_required", "live_project_not_authorized"].includes(code) ? code : "local_models_unavailable" });
      } finally { preparations--; scheduleCooldown(); }
    },
  });
  api.registerHttpRoute({
    path: "/api/clawsense/live",
    auth: "plugin",
    async handler(req, res) {
      const auth = await options.authenticate(
        typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : undefined,
      );
      if (!auth.ok || !auth.device) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (req.method === "PUT") {
        const body = await readJson(req, res, 16384);
        if (!body) return;
        try {
          const persona = await store.write(auth.device.deviceId, body.persona);
          for (const session of sessions.values())
            if (session.device === auth.device.deviceId)
              session.setPersona(persona);
          json(res, 200, { ok: true, persona });
        } catch {
          json(res, 400, { ok: false, error: "invalid_persona" });
        }
        return;
      }
      if (req.method !== "GET") {
        methodNotAllowed(res, ["GET", "PUT"]);
        return;
      }
      const url = new URL(options.publicBaseUrl());
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.port = String(cfg.port);
      url.pathname = "/live";
      url.search = "";
      // No device secrets in URLs. LAN access must be explicitly configured on this isolated service.
      json(res, 200, {
        ok: true,
        enabled: true,
        preparationSupported: true,
        websocketUrl: url.toString(),
        persona: await store.read(auth.device.deviceId),
        presets: PERSONAS,
        harness: {
          routes: harness?.routes() ?? [],
          cancelSupported: harness?.cancelSupported ?? false,
        },
        cloudVoice: { configured: false, extensionVersion: 1 },
      });
    },
  });
  api.registerHttpRoute({
    path: "/api/clawsense/live-history",
    auth: "plugin",
    async handler(req, res) {
      if (req.method !== "GET") { methodNotAllowed(res, ["GET"]); return; }
      const auth = await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined);
      if (!auth.ok || !auth.device) { json(res, 401, { ok: false, error: "unauthorized" }); return; }
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const time = (key: string) => { const raw = url.searchParams.get(key); if (!raw) return undefined; const n = Number(raw); if (!Number.isFinite(n) || n < 0) throw new Error("invalid_range"); return n; };
        const deliver = async () => {
          const result = await readLiveHistory(root, auth.device!.deviceId, options.contextStore, cfg.projectId ?? "live", { startAt: time("startAt"), endAt: time("endAt"), query: url.searchParams.get("query")?.slice(0, 200), publicScene: (await store.read(auth.device!.deviceId)).publicScene });
          if (!(await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined)).ok) { json(res, 401, { ok: false }); return; }
          json(res, 200, { ok: true, ...result });
        };
        if (options.contextStore) await options.contextStore.consistent(deliver); else await deliver();
      } catch { json(res, 400, { ok: false, error: "history_unavailable" }); }
    },
  });
  api.registerHttpRoute({
    path: "/api/clawsense/live-result",
    auth: "plugin",
    async handler(req, res) {
      if (req.method !== "GET") {
        methodNotAllowed(res, ["GET"]);
        return;
      }
      const auth = await options.authenticate(
        typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : undefined,
      );
      if (!auth.ok || !auth.device) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (!options.work) {
        json(res, 200, { ok: true, results: [] });
        return;
      }
      try {
        const id = new URL(req.url ?? "/", "http://localhost").searchParams.get(
          "workItemId",
        );
        const deliver = async () => {
        const results = id
            ? [await options.work!.read(auth.device!.deviceId, id)]
            : await options.work!.list(auth.device!.deviceId);
        const stillAuthorized = await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined);
        if (!stillAuthorized.ok) { json(res, 401, { ok: false, error: "unauthorized" }); return; }
        json(res, 200, {
          ok: true,
          results,
        });
        };
        if (options.contextStore) await options.contextStore.consistent(deliver); else await deliver();
      } catch {
        json(res, 404, { ok: false, error: "result_not_available" });
      }
    },
  });
  api.registerService({
    id: "clawsense-live",
    async start() {
      stopping = false;
      await execution?.recover();
      server = http.createServer((_req, res) => {
        json(res, 404, { ok: false });
      });
      wss = new WebSocketServer({ noServer: true, maxPayload: 320 * 1024 });
      server.on("upgrade", (req, socket, head) => {
        void (async () => {
          const url = new URL(req.url ?? "/", "http://localhost");
          const origin = req.headers.origin;
          if (
            url.pathname !== "/live" ||
            (origin && origin !== options.publicBaseUrl())
          ) {
            socket.destroy();
            return;
          }
          const auth = await options.authenticate(
            typeof req.headers.authorization === "string"
              ? req.headers.authorization
              : undefined,
          );
          if (
            !auth.ok ||
            !auth.device ||
            activeDevices.size >= 4 ||
            activeDevices.has(auth.device.deviceId)
          ) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          if (socket.destroyed) return;
          const deviceId = auth.device.deviceId;
          clearTimeout(cooldownTimer); cooldownTimer = undefined;
          activeDevices.add(deviceId);
          wss!.handleUpgrade(req, socket, head, (ws) => {
            let session: LiveSession | undefined,
              initialized = false,
              initStarted = false,
              alive = true;
            let conversationEpoch = 0;
            let playbackVersion = 0;
            let incomingAudio = Promise.resolve();
            let pendingIngressBytes = 0, pendingIngressFrames = 0;
            const initTimer = setTimeout(
              () => ws.close(1008, "initialization_timeout"),
              180000,
            );
            const heartbeat = setInterval(() => {
              if (!alive) {
                ws.terminate();
                return;
              }
              alive = false;
              ws.ping();
              void options
                .authenticate(
                  typeof req.headers.authorization === "string"
                    ? req.headers.authorization
                    : undefined,
                )
                .then((auth) => {
                  if (!auth.ok) ws.close(1008, "authorization_revoked");
                })
                .catch(() => ws.close(1011, "authorization_unavailable"));
            }, 15000);
            ws.on("pong", () => {
              alive = true;
            });
            const send = (data: unknown) => {
              if ((data as any)?.type === "vision_request") visualDevices.add(deviceId);
              if (ws.readyState === WebSocket.OPEN) {
                if (ws.bufferedAmount > 2 * 1024 * 1024) {
                  ws.close(1013, "output_backpressure");
                  return;
                }
                ws.send(JSON.stringify(data));
                if ((data as any)?.type === "error" && (data as any)?.code === "audio_backpressure") ws.close(1013, "audio_backpressure");
              }
            };
            ws.on("message", (raw, binary) => {
              void (async () => {
                // Reserve order before asynchronous auth/receipt I/O. A stop arriving
                // later must also suppress text that has not reached LiveSession yet.
                const msg = binary ? undefined : JSON.parse(raw.toString());
                const conversation = msg?.type === "text" && !(execution && typeof msg.text === "string" && needsHarness(msg.text, session?.persona.name) && msg.source !== "ambient");
                if (conversation || ["interrupt", "close", "persona"].includes(msg?.type)) conversationEpoch++;
                const epoch = conversationEpoch;
                const playbackEpoch = msg?.type === "playback" ? ++playbackVersion : 0;
                if (binary) {
                  const bytes = (raw as Buffer).length;
                  if (!bytes || bytes > 32000 || bytes % 2) throw new Error("invalid_audio_frame");
                  if (pendingIngressBytes + bytes > 64000 || pendingIngressFrames >= 200) throw new Error("audio_backpressure");
                  pendingIngressBytes += bytes; pendingIngressFrames++;
                  // Reserve PCM order before any asynchronous credential/policy
                  // read. A slow check must not swap adjacent speech packets.
                  const ordered = incomingAudio.then(async () => {
                    if (epoch !== conversationEpoch || ws.readyState !== WebSocket.OPEN) return;
                    if (!(await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined)).ok) { ws.close(1008, "authorization_revoked"); return; }
                    if (!initialized || !session) throw new Error("hello_required");
                    await authorizeOwnedProcessing(deviceId);
                    if (epoch !== conversationEpoch || ws.readyState !== WebSocket.OPEN) return;
                    session.audio(Buffer.from(raw as Buffer), "user");
                  });
                  incomingAudio = ordered.catch(() => {});
                  try { await ordered; }
                  finally { pendingIngressBytes -= bytes; pendingIngressFrames--; }
                  return;
                }
                if (!(await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined)).ok) { ws.close(1008, "authorization_revoked"); return; }
                if (msg.type === "hello") {
                  if (initStarted) throw new Error("already_initialized");
                  await authorizeOwnedProcessing(deviceId);
                  initStarted = true;
                  send({ type: "initializing", stage: "loading_models" });
                  const preparingVision = msg.vision === true
                    ? Promise.resolve(local.preloadVisual?.()).then(() => undefined, error => error as Error) : undefined;
                  const initializationStarted = performance.now();
                  const persona = await store.read(deviceId);
                  const probing = capabilities(msg.provider === "native");
                  const warmingLocal = msg.provider !== "native" || !native
                    ? Promise.resolve(local.prepare?.(persona)).then(() => undefined, error => error as Error) : undefined;
                  const caps = await probing;
                  if (ws.readyState !== WebSocket.OPEN) return;
                  const nativeReady =
                    msg.provider === "native" &&
                    caps.native?.ready &&
                    (caps.local.recognitionReady ?? caps.local.ready);
                  if (!caps.local.ready && !nativeReady) {
                    send({
                      type: "configuration_required",
                      code: "local_models_unavailable",
                      detail: caps.local.reason,
                    });
                    probe = undefined;
                    nativeProbe = undefined;
                    ws.close(1011, "models_unavailable");
                    return;
                  }
                  const selected: LiveProvider = nativeReady && native ? native : local;
                  const warmupStarted = performance.now();
                  send({ type: "initializing", stage: "warming_voice" });
                  if (msg.vision === true) visualDevices.add(deviceId);
                  if (warmingLocal) { const error = await warmingLocal; if (error) throw error; }
                  else await selected.prepare?.(persona, { vision: msg.vision === true });
                  if (preparingVision) { const error = await preparingVision; if (error) throw error; }
                  if (ws.readyState !== WebSocket.OPEN) return;
                  await authorizeOwnedProcessing(deviceId);
                  if (!(await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined)).ok) { ws.close(1008, "authorization_revoked"); return; }
                  session = new LiveSession(
                    deviceId,
                    persona,
                    selected,
                    local,
                    harness,
                    (q, p) => options.context(deviceId, q, p),
                    send,
                    root,
                    options.work,
                    true,
                    options.contextStore ? liveContextHooks(options.contextStore, deviceId, cfg.projectId ?? "live", async () => {
                      if (!(await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined)).ok) return false;
                      try { await authorizeOwnedProcessing(deviceId); return true; } catch { return false; }
                    }) : undefined,
                    cfg.allowAutomaticHarnessFallback === true,
                    execution ? async (input, requestId) => execution.submit(deviceId, requestId, input, /(?:交给|用|让)\s*codex/i.test(input.query) ? "live-codex" : "live-dsh") : undefined,
                    execution ? () => execution.cancelLatest(deviceId) : undefined,
                  );
                  sessions.set(session.id, session);
                  // Only an explicit client entry invites the opening voice
                  // turn; passive connections and ambient input remain gated.
                  if (msg.invited === true) session.inviteOpening();
                  if (execution && options.contextStore) execution.bind(deviceId, liveContextHooks(options.contextStore, deviceId, cfg.projectId ?? "live", async () => (await options.authenticate(typeof req.headers.authorization === "string" ? req.headers.authorization : undefined)).ok));
                  initialized = true;
                  clearTimeout(initTimer);
                  send({
                    type: "ready",
                    version: 1,
                    sessionId: session.id,
                    seq: 0,
                    selected:
                      selected === local ? "local-cascade" : "minicpm-o",
                    capabilities: caps,
                    modelWarmupMs: performance.now() - warmupStarted,
                    initializationMs: performance.now() - initializationStarted,
                    persona: session.persona,
                    notice:
                      msg.provider === "native" && selected === local
                        ? "native_unavailable_using_local"
                        : undefined,
                  });
                  return;
                }
                if (!session || !initialized) throw new Error("hello_required");
                if (!["interrupt", "close", "playback", "audio_ack", "task_cancel"].includes(msg.type)) await authorizeOwnedProcessing(deviceId);
                if (msg.type === "text") {
                  if (conversation && epoch !== conversationEpoch) return;
                  if (typeof msg.text !== "string")
                    throw new Error("invalid_text");
                  if (execution && needsHarness(msg.text, session.persona.name) && msg.source !== "ambient") {
                    const result = await execution.submit(deviceId, typeof msg.requestId === "string" ? msg.requestId : randomUUID(), await session.taskInput(msg.text), msg.agent === "codex" ? "live-codex" : "live-dsh");
                    send({ type: result.replayed ? "request_replayed" : "task_queued", ...result });
                    return;
                  }
                  if (typeof msg.requestId === "string") {
                    const receipt = await receipts.claim(deviceId, msg.requestId, msg.text);
                    if (conversation && epoch !== conversationEpoch) return;
                    if (!receipt.fresh) {
                      send({ type: "request_replayed", requestId: msg.requestId, state: receipt.state, notice: "execution_not_repeated_check_work_results" });
                      return;
                    }
                  }
                  await session.text(
                    msg.text,
                    msg.source === "ambient" ? "ambient" : "user",
                  );
                } else if (msg.type === "task_cancel" || msg.type === "task_resume") {
                  if (!execution || typeof msg.workItemId !== "string") throw new Error("invalid_task_request");
                  send({ type: "task_updated", ...(msg.type === "task_cancel" ? await execution.cancel(deviceId, msg.workItemId) : await execution.resume(deviceId, msg.workItemId)) });
                } else if (msg.type === "frame") session.acceptFrame(msg);
                else if (msg.type === "interrupt") session.interrupt();
                else if (msg.type === "audio_ack") {
                  if (!Number.isInteger(msg.seq) || msg.seq <= 0)
                    throw new Error("invalid_audio_ack");
                  session.acknowledgeAudio(msg.seq);
                } else if (msg.type === "playback") {
                  // A delayed inactive report must not overwrite a newer active
                  // report and disable spoken-stop detection during playback.
                  if (playbackEpoch === playbackVersion) session.playback(msg.active === true);
                }
                else if (msg.type === "persona") {
                  session.setPersona(await store.write(deviceId, msg.persona));
                  send({ type: "persona_saved", persona: session.persona });
                } else if (msg.type === "close") ws.close(1000);
                else throw new Error("unknown_event");
              })().catch((e) => {
                send({
                  type: "error",
                  code: String(e.message)
                    .replace(/[^a-zA-Z0-9_-]/g, "_")
                    .slice(0, 80),
                  ...(e.message === "audio_backpressure" ? { inputDiagnostics: { ...session?.inputDiagnostics(), pendingIngressMs: pendingIngressBytes / 32, pendingIngressFrames } } : {}),
                });
                if (e.message === "audio_backpressure")
                  { api.logger?.warn("ClawSense Live audio input exceeded its processing budget " + JSON.stringify(session?.inputDiagnostics())); ws.close(1013, "audio_backpressure"); }
                if (["phone_local_processing_required", "live_project_not_authorized", "live_metadata_unavailable"].includes(e.message)) ws.close(1008, "processing_not_authorized");
              });
            });
            ws.on("error", () => ws.terminate());
            ws.on("close", () => {
              clearTimeout(initTimer);
              clearInterval(heartbeat);
              activeDevices.delete(deviceId);
              visualDevices.delete(deviceId);
              if (session) {
                const closing = session;
                void closing.close().finally(() => sessions.delete(closing.id));
              }
              if (!visualDevices.size) void local.releaseVisual?.();
              scheduleCooldown();
            });
          });
        })().catch(() => socket.destroy());
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(cfg.port, cfg.host, () => {
          server!.off("error", reject);
          resolve();
        });
      });
    },
    async stop() {
      await stopUpstream();
      stopping = true;
      clearTimeout(cooldownTimer); cooldownTimer = undefined;
      for (const ws of wss?.clients ?? []) ws.terminate();
      await Promise.allSettled([...sessions.values()].map((s) => s.close()));
      sessions.clear();
      await execution?.close();
      await Promise.all([local.close(), native?.close(), harness?.close()]);
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      wss?.close();
      server = undefined;
      wss = undefined;
      probe = undefined;
      nativeProbe = undefined;
    },
  });
}
