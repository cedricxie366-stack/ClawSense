import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import plugin from "../index.js";
import { AgentAccessStore } from "./agent-access.js";
import { json, methodNotAllowed, parseBearerToken, readJson, unauthorized } from "./http.js";
import { handleMcpHttpRequest } from "./mcp-server.js";
import type { AgentToolResult, AnyAgentTool, HttpRoute, OpenClawPluginApi } from "./openclaw-types.js";
import { runWithAgentIdentity } from "./tool-context.js";
import { renderCompanionUi } from "./companion-ui.js";
import { normalizeDigitalScopes, type DigitalScope } from "./digital-access.js";
import { normalizeContextScopes, normalizeContextCapabilities, type ContextScope, type ContextMutation } from "./context-access.js";
import { withRequestProcessing } from "./processing-context.js";
import { contextFor } from "./context-store.js";
import { sanitizeAgentResponse, sanitizeContextValue } from "./context-response.js";

export type StandaloneRuntimeOptions = {
  stateDir: string;
  host?: string;
  port?: number;
  pluginConfig?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  adminToken?: string;
};
export type StandaloneAddress = { host: string; port: number; baseUrl: string };
type Service = Parameters<OpenClawPluginApi["registerService"]>[0];
type Identity = { actor: string; admin: boolean; browser?: boolean; digitalScopes?: DigitalScope[]; contextScopes?: ContextScope[]; contextCapabilities?: ContextMutation[]; processingLocation?: "local-only" | "owned-devices" | "selected-external"; liveCheck?: () => Promise<boolean> };
const BROWSER_COOKIE = "clawsense_browser_session";
const AGENT_READ_PATHS = new Set([
  "/api/clawsense/evidence", "/api/clawsense/artifacts", "/api/clawsense/library", "/plugins/clawsense/library",
  "/api/clawsense/context", "/api/clawsense/followups",
]);

/** Runs the existing data plane without an OpenClaw executable or global state. */
export function createStandaloneRuntime(options: StandaloneRuntimeOptions) {
  if (options.pluginConfig?.companionUrl !== undefined || options.pluginConfig?.companionTokenFile !== undefined) {
    throw new Error("standalone_cannot_proxy_companion");
  }
  if (!options.stateDir?.trim()) throw new Error("state_directory_required");
  const requestedStateDir = path.resolve(options.stateDir);
  if (requestedStateDir === path.parse(requestedStateDir).root) throw new Error("invalid_state_directory");
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 18790;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("invalid_port");
  const configuredPublicUrl = validatePublicUrl(options.pluginConfig?.publicBaseUrl);
  if ((host === "0.0.0.0" || host === "::") && !configuredPublicUrl) throw new Error("wildcard_bind_requires_public_base_url");
  if (options.adminToken !== undefined) validateToken(options.adminToken);

  const tools = new Map<string, AnyAgentTool>();
  const routes = new Map<string, HttpRoute>();
  const activeTools = new Set<Promise<AgentToolResult>>();
  const activeRequests = new Set<Promise<void>>();
  const browserCodes = new Map<string, { origin: string; expiresAt: number }>();
  const browserSessions = new Map<string, { origin: string; expiresAt: number }>();
  const listenerId = randomUUID();
  let stateDir = requestedStateDir;
  let server: http.Server | undefined;
  let services: Service[] = [];
  let startedServices: Service[] = [];
  let access: AgentAccessStore;
  let adminToken = "";
  let lockOwned = false;
  let ready = false;
  let stopping = false;
  let startPromise: Promise<StandaloneAddress> | undefined;
  let stopPromise: Promise<void> | undefined;
  const allowedAuthorities = new Set<string>();
  const allowedOrigins = new Set<string>();
  const listTools = () => [...tools.values()].map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: publicSchema(tool.parameters),
  }));

  async function invokeTool(name: string, args: Record<string, unknown>, actor = "local-owner", permissions?: { owner: boolean; digitalScopes?: DigitalScope[]; contextScopes?: ContextScope[]; contextCapabilities?: ContextMutation[]; processingLocation?: Identity["processingLocation"]; liveCheck?: () => Promise<boolean> }): Promise<AgentToolResult> {
    if (!ready || stopping) throw new RuntimeError(503, "runtime_not_ready");
    const tool = tools.get(name);
    if (!tool) throw new RuntimeError(404, "unknown_tool");
    if (tool.ownerOnly && permissions && !permissions.owner) throw new RuntimeError(403, "owner_confirmation_required");
    if (!isObject(args)) throw new RuntimeError(400, "invalid_tool_arguments");
    const params = { ...args };
    delete params._actor;
    if (!Value.Check(tool.parameters as TSchema, params)) throw new RuntimeError(400, "invalid_tool_arguments");
    const context = contextFor(stateDir);
    const readVersion = context && CONTEXT_READ_TOOLS.has(name) ? await context.workspace() : undefined;
    const pending = Promise.resolve().then(() => runWithAgentIdentity(actor, () => withRequestProcessing(stateDir, async () => tool.execute(randomUUID(), params)), permissions));
    activeTools.add(pending);
    try {
      const result = await pending;
      if (permissions?.liveCheck && !(await permissions.liveCheck())) throw new RuntimeError(403, "agent_access_revoked");
      if (context && readVersion) {
        const after = await context.workspace();
        // Analysis may finish while an immutable original is read; it does not replace its bytes.
        const analysisSensitive = name !== "clawsense_artifact_get" && name !== "clawsense_digital_artifact_get";
        if ((analysisSensitive && after.contextSequence !== readVersion.contextSequence) || after.policyEpoch !== readVersion.policyEpoch || after.deletionEpoch !== readVersion.deletionEpoch) throw new RuntimeError(409, "context_changed_retry");
      }
      return permissions?.owner === false ? sanitizeAgentResponse(result) : result;
    }
    finally { activeTools.delete(pending); }
  }

  async function authenticate(req: IncomingMessage): Promise<Identity | null> {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      const session = browserSessions.get(readBrowserCookie(req) ?? "");
      if (!session || session.expiresAt <= Date.now() || !isLocalBrowserRequest(req, session.origin)) return null;
      return { actor: "local-owner", admin: true, browser: true };
    }
    if (constantTimeEqual(token, adminToken)) return { actor: "local-owner", admin: true };
    const grant = await access.authenticate(token);
    return grant ? { actor: grant.agentId, admin: false, digitalScopes: grant.digitalScopes ?? [], contextScopes: grant.contextScopes, contextCapabilities: grant.contextCapabilities, processingLocation: grant.contextProcessingLocation ?? "selected-external", liveCheck: async () => Boolean(await access.authenticate(token)) } : null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("x-clawsense-listener", listenerId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (!validRequestOrigin(req, allowedAuthorities, allowedOrigins)) {
      json(res, 403, { ok: false, error: "untrusted_request_origin" }); return;
    }
    if (!ready || stopping) { json(res, 503, { ok: false, error: "runtime_not_ready" }); return; }
    const url = new URL(req.url ?? "/", "http://clawsense.local");
    if (url.pathname === "/favicon.ico") {
      if (req.method !== "GET") { methodNotAllowed(res, ["GET"]); return; }
      res.statusCode = 204; res.end(); return;
    }
    for (const entries of [browserCodes, browserSessions]) {
      for (const [key, value] of entries) if (value.expiresAt <= Date.now()) entries.delete(key);
    }
    if (url.pathname === "/app") {
      if (req.method !== "GET") { methodNotAllowed(res, ["GET"]); return; }
      const nonce = randomBytes(18).toString("base64");
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-security-policy", "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.end(renderCompanionUi(nonce));
      return;
    }
    if (url.pathname === "/api/clawsense/browser-login/redeem") {
      if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return; }
      if (!isLocalBrowserRequest(req, requestOrigin(req), true)) {
        json(res, 403, { ok: false, error: "same_origin_local_browser_required" }); return;
      }
      const body = await readJson(req, res, 4096);
      if (!body) return;
      const code = typeof body.code === "string" ? body.code : "";
      const grant = browserCodes.get(code);
      if (!grant || grant.expiresAt <= Date.now() || grant.origin !== requestOrigin(req)) {
        unauthorized(res); return;
      }
      browserCodes.delete(code);
      const sessionToken = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + 60 * 60 * 1000;
      const previous = readBrowserCookie(req);
      if (previous) browserSessions.delete(previous);
      browserSessions.set(sessionToken, { origin: grant.origin, expiresAt });
      res.setHeader("set-cookie", browserCookie(sessionToken, 3600));
      json(res, 200, { ok: true, expiresAt }); return;
    }
    const identity = await authenticate(req);
    if (url.pathname === "/api/clawsense/shutdown") {
      if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return; }
      if (!identity?.admin || identity.browser) { unauthorized(res); return; }
      if (!isLoopbackRequest(req)) { json(res, 403, { ok: false, error: "local_admin_required" }); return; }
      json(res, 200, { ok: true, stopping: true });
      // Finish this handler first: cleanup waits for every handler, including this one.
      setImmediate(() => {
        void stop().catch(() => { process.stderr.write("ClawSense shutdown failed; inspect the state lock before restarting.\n"); });
      });
      return;
    }
    if (url.pathname === "/api/clawsense/browser-login") {
      if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return; }
      if (!identity?.admin || identity.browser) { unauthorized(res); return; }
      if (!isLoopbackRequest(req)) { json(res, 403, { ok: false, error: "local_browser_required" }); return; }
      if (browserCodes.size >= 32) { json(res, 429, { ok: false, error: "too_many_login_codes" }); return; }
      const code = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + 60_000;
      browserCodes.set(code, { origin: requestOrigin(req), expiresAt });
      json(res, 200, { ok: true, code, expiresAt }); return;
    }
    if (url.pathname === "/api/clawsense/browser-logout") {
      if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return; }
      if (!isLocalBrowserRequest(req, requestOrigin(req), true)) {
        json(res, 403, { ok: false, error: "same_origin_local_browser_required" }); return;
      }
      browserSessions.delete(readBrowserCookie(req) ?? "");
      res.setHeader("set-cookie", browserCookie("", 0));
      json(res, 200, { ok: true }); return;
    }
    if (url.pathname === "/mcp") {
      if (!identity) { unauthorized(res); return; }
      await handleMcpHttpRequest(req, res, {
        listTools: async () => listTools(),
        callTool: (name, args) => invokeTool(name, args, identity.actor, { owner: identity.admin, digitalScopes: identity.digitalScopes, contextScopes: identity.contextScopes, contextCapabilities: identity.contextCapabilities, processingLocation: identity.processingLocation, liveCheck: identity.liveCheck }),
      });
      return;
    }
    if (url.pathname === "/api/clawsense/agent/tools") {
      if (!identity) { unauthorized(res); return; }
      if (req.method !== "GET") { methodNotAllowed(res, ["GET"]); return; }
      json(res, 200, { ok: true, tools: listTools() }); return;
    }
    if (url.pathname === "/api/clawsense/agent/call") {
      if (!identity) { unauthorized(res); return; }
      if (req.method !== "POST") { methodNotAllowed(res, ["POST"]); return; }
      const body = await readJson(req, res, 1024 * 1024);
      if (!body) return;
      if (typeof body.name !== "string" || !isObject(body.arguments)) {
        json(res, 400, { ok: false, error: "invalid_tool_call" }); return;
      }
      json(res, 200, { ok: true, result: await invokeTool(body.name, body.arguments, identity.actor, { owner: identity.admin, digitalScopes: identity.digitalScopes, contextScopes: identity.contextScopes, contextCapabilities: identity.contextCapabilities, processingLocation: identity.processingLocation, liveCheck: identity.liveCheck }) }); return;
    }
    if (url.pathname === "/api/clawsense/agent/grants") {
      if (!identity) { unauthorized(res); return; }
      if (!identity.admin) { json(res, 403, { ok: false, error: "admin_required" }); return; }
      if (req.method === "GET") {
        json(res, 200, { ok: true, grants: await access.list() });
      } else if (req.method === "POST") {
        const body = await readJson(req, res, 4096);
        if (!body) return;
        if (typeof body.agentId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(body.agentId) ||
          ["local-owner", "openclaw"].includes(body.agentId)) {
          json(res, 400, { ok: false, error: "invalid_agent_id" }); return;
        }
        let scopes: DigitalScope[];
        try { scopes = normalizeDigitalScopes(body.digitalScopes); }
        catch { json(res, 400, { ok: false, error: "invalid_digital_scopes" }); return; }
        let contextScopes: ContextScope[] | undefined;
        try { contextScopes = normalizeContextScopes(body.contextScopes); } catch { json(res, 400, { ok: false, error: "invalid_context_scopes" }); return; }
        let capabilities: ContextMutation[] | undefined;
        try { capabilities = normalizeContextCapabilities(body.contextCapabilities); } catch { json(res, 400, { ok: false, error: "invalid_context_capabilities" }); return; }
        if (body.contextProcessingLocation !== undefined && (typeof body.contextProcessingLocation !== "string" || !["local-only", "owned-devices", "selected-external"].includes(body.contextProcessingLocation))) { json(res, 400, { ok: false, error: "invalid_processing_location" }); return; }
        json(res, 201, { ok: true, ...await access.issue(body.agentId, scopes, contextScopes, capabilities, body.contextProcessingLocation as Identity["processingLocation"]) });
      } else if (req.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) { json(res, 400, { ok: false, error: "grant_id_required" }); return; }
        json(res, 200, { ok: true, revoked: await access.revoke(id) });
      } else { methodNotAllowed(res, ["GET", "POST", "DELETE"]); }
      return;
    }
    const route = routes.get(url.pathname);
    if (!route) { json(res, 404, { ok: false, error: "not_found" }); return; }
    const protectedRoute = route.auth === "gateway" || route.path === "/plugins/clawsense/library";
    if (protectedRoute && !identity) { unauthorized(res); return; }
    if (identity && !identity.admin && !(AGENT_READ_PATHS.has(route.path) && req.method === "GET")) {
      json(res, 403, { ok: false, error: "agent_scope_denied" }); return;
    }
    const context = contextFor(stateDir);
    const epoch = protectedRoute && context ? await context.workspace() : undefined;
    const buffered = protectedRoute && identity ? bufferReadResponse(res) : undefined;
    const targetResponse = buffered?.response ?? res;
    const handler = () => withRequestProcessing(stateDir, async () => route.handler(req, targetResponse));
    if (identity) await runWithAgentIdentity(identity.actor, handler, { owner: identity.admin, digitalScopes: identity.digitalScopes, contextScopes: identity.contextScopes, contextCapabilities: identity.contextCapabilities, processingLocation: identity.processingLocation, liveCheck: identity.liveCheck });
    else await handler();
    if (buffered) {
      if (identity?.liveCheck && !(await identity.liveCheck())) { clearUnsentHeaders(res); json(res, 403, { ok: false, error: "agent_access_revoked" }); return; }
      const current = context && epoch ? await context.workspace() : undefined;
      if (current && epoch && (current.policyEpoch !== epoch.policyEpoch || current.deletionEpoch !== epoch.deletionEpoch || current.contextSequence !== epoch.contextSequence)) { clearUnsentHeaders(res); json(res, 409, { ok: false, error: "context_changed_retry" }); return; }
      buffered.flush(identity?.admin === false);
    }
    if (!res.writableEnded) json(res, 404, { ok: false, error: "not_found" });
  }

  async function cleanup(): Promise<void> {
    ready = false;
    browserCodes.clear();
    browserSessions.clear();
    // In-flight ingest and tools finish before background services stop and state unlocks.
    if (server) {
      const activeServer = server;
      await new Promise<void>((resolve, reject) => {
        activeServer.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
        activeServer.closeIdleConnections();
      });
      server = undefined;
    }
    // A disconnected client can close its socket while its handler is still committing evidence.
    await Promise.allSettled([...activeRequests]);
    await Promise.allSettled([...activeTools]);
    const stoppingServices = [...startedServices].reverse();
    const stopResults = await Promise.allSettled(stoppingServices.map((service) => service.stop()));
    startedServices = stoppingServices.filter((_service, index) => stopResults[index]?.status === "rejected");
    if (stopResults.some((result) => result.status === "rejected")) {
      // Do not unlock if a service cannot confirm that its writers stopped.
      throw new Error("service_shutdown_failed_state_remains_locked");
    }
    if (lockOwned) {
      await fs.rm(path.join(stateDir, ".standalone.lock"), { recursive: true });
      lockOwned = false;
    }
  }

  async function boot(): Promise<StandaloneAddress> {
    stopping = false;
    await fs.mkdir(requestedStateDir, { recursive: true, mode: 0o700 });
    stateDir = await fs.realpath(requestedStateDir);
    await fs.chmod(stateDir, 0o700);
    const lockDir = path.join(stateDir, ".standalone.lock");
    try { await fs.mkdir(lockDir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("state_directory_locked: another runtime may be running; inspect .standalone.lock before removing a stale lock");
      }
      throw error;
    }
    lockOwned = true;
    try {
      await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
      adminToken = options.adminToken ?? await loadOrCreateAdminToken(path.join(stateDir, "standalone-admin-token"));
      access = new AgentAccessStore({ stateDir });
      server = http.createServer((req, res) => {
        const pending = handle(req, res).catch((error: unknown) => {
          if (res.writableEnded || res.destroyed) return;
          if (res.headersSent) { res.destroy(); return; }
          clearUnsentHeaders(res);
          json(res, error instanceof RuntimeError ? error.status : 500, {
            ok: false, error: error instanceof RuntimeError ? error.message : "internal_error",
          });
        });
        activeRequests.add(pending);
        void pending.finally(() => activeRequests.delete(pending));
      });
      server.requestTimeout = 35_000;
      server.headersTimeout = 15_000;
      server.keepAliveTimeout = 5000;
      await new Promise<void>((resolve, reject) => {
        const activeServer = server!;
        activeServer.once("error", reject);
        activeServer.listen(requestedPort, host, () => { activeServer.off("error", reject); resolve(); });
      });
      const bound = server.address();
      if (!bound || typeof bound === "string") throw new Error("invalid_listen_address");
      const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
      const localUrl = new URL("http://" + formatHost(localHost) + ":" + bound.port);
      const publicUrl = configuredPublicUrl ?? localUrl;
      const address = { host, port: bound.port, baseUrl: publicUrl.origin };
      allowedAuthorities.clear();
      allowedOrigins.clear();
      for (const candidate of [localUrl, publicUrl, new URL("http://localhost:" + bound.port),
        new URL("http://127.0.0.1:" + bound.port), new URL("http://[::1]:" + bound.port)]) {
        allowedAuthorities.add(candidate.host.toLowerCase());
        allowedOrigins.add(candidate.origin);
      }
      if (host === "0.0.0.0" || host === "::") await verifyLoopbackListener(localUrl, listenerId);
      tools.clear(); routes.clear(); services = [];
      plugin.register({
        pluginConfig: { ...options.pluginConfig, publicBaseUrl: publicUrl.origin, gatewayPort: bound.port },
        config: { ...options.runtimeConfig, clawsenseStandalone: true },
        // Existing diagnostics can include setup payloads or captured content; expose authenticated status instead.
        logger: { info() {}, warn() {}, error() {} },
        runtime: {
          state: { resolveStateDir: () => stateDir },
          stt: { async transcribeAudioFile() { throw new Error("runtime_stt_unavailable_in_standalone"); } },
          system: { async requestHeartbeatNow() {} },
        },
        registerTool(candidate) {
          const tool = typeof candidate === "function" ? candidate({ sandboxed: false }) : candidate;
          if (tool) tools.set(tool.name, tool);
        },
        registerHttpRoute(route) { routes.set(route.path, route); },
        registerCli() {},
        registerService(service) { services.push(service); },
      });
      for (const service of services) { startedServices.push(service); await service.start(); }
      ready = true;
      return address;
    } catch (error) { await cleanup(); throw error; }
  }

  function stop(): Promise<void> {
    if (!stopPromise) {
      stopPromise = (async () => {
        await startPromise?.catch(() => {});
        stopping = true;
        await cleanup();
        startPromise = undefined;
      })().finally(() => { stopPromise = undefined; });
    }
    return stopPromise;
  }

  return {
    tools,
    get adminTokenFile() { return path.join(stateDir, "standalone-admin-token"); },
    start(): Promise<StandaloneAddress> {
      if (stopPromise) return Promise.reject(new Error("runtime_stopping"));
      if (!startPromise) startPromise = boot().catch((error) => { startPromise = undefined; throw error; });
      return startPromise;
    },
    stop,
    invokeTool,
  };
}

/** Do not send an asynchronously assembled read until authorization/version checks finish. */
const CONTEXT_READ_TOOLS = new Set([
  "clawsense_status", "clawsense_context", "clawsense_artifact_get", "clawsense_sessions_list", "clawsense_session_get", "clawsense_session_evidence", "clawsense_work_get", "clawsense_work_export", "clawsense_briefing",
  "clawsense_workspace", "clawsense_context_list", "clawsense_people", "clawsense_legacy_annotations", "clawsense_context_snapshot", "clawsense_context_snapshot_get", "clawsense_analysis_history", "clawsense_selected_results", "clawsense_deletion_status", "clawsense_context_export", "clawsense_disclosure_receipts",
  "clawsense_digital_query", "clawsense_digital_artifact_get",
]);
function clearUnsentHeaders(response: ServerResponse): void {
  for (const header of response.getHeaderNames()) response.removeHeader(header);
}
function bufferReadResponse(response: ServerResponse): { response: ServerResponse; flush(sanitize?: boolean): void } {
  const chunks: Buffer[] = []; let ended = false, size = 0;
  const append = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
    size += bytes.length; if (size > 64 * 1024 * 1024) throw new RuntimeError(413, "context_response_too_large"); chunks.push(bytes);
  };
  const proxy = new Proxy(response, { get(target, property) {
    if (property === "writableEnded") return ended;
    if (property === "headersSent") return false;
    if (property === "end") return (chunk?: unknown, encoding?: unknown) => { append(chunk, encoding); ended = true; return proxy; };
    if (property === "write") return (chunk?: unknown, encoding?: unknown) => { append(chunk, encoding); return true; };
    if (property === "writeHead") return (status: number, messageOrHeaders?: unknown, headers?: Record<string, string>) => { target.statusCode = status; const values = typeof messageOrHeaders === "object" ? messageOrHeaders as Record<string, string> : headers; if (values) for (const [key, value] of Object.entries(values)) target.setHeader(key, value); return proxy; };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  }, set(target, property, value) { return Reflect.set(target, property, value, target); } });
  return { response: proxy, flush(sanitize) { if (!ended) { json(response, 404, { ok: false, error: "not_found" }); return; } let body = Buffer.concat(chunks); if (sanitize && String(response.getHeader("content-type")).startsWith("application/json")) { body = Buffer.from(JSON.stringify(sanitizeContextValue(JSON.parse(body.toString())))); response.removeHeader("content-length"); } response.end(body); } };
}

class RuntimeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function verifyLoopbackListener(url: URL, expectedId: string): Promise<void> {
  // Probe without credentials: a more-specific socket can shadow a wildcard
  // listener even though listen() succeeded, sending local clients elsewhere.
  await new Promise<void>((resolve, reject) => {
    const request = http.get(new URL("/favicon.ico", url), (response) => {
      response.resume();
      if (response.headers["x-clawsense-listener"] === expectedId) resolve();
      else reject(new Error("companion_port_shadowed_on_loopback_choose_another_port"));
    });
    request.setTimeout(2000, () => request.destroy(new Error("companion_loopback_probe_timed_out")));
    request.once("error", reject);
  });
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validateToken(token: string): void {
  if (token.length < 16 || token.length > 512 || /\s/.test(token)) throw new Error("invalid_admin_token");
}
async function loadOrCreateAdminToken(file: string): Promise<string> {
  let handle;
  try {
    handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const token = randomBytes(32).toString("base64url");
    await handle.writeFile(token + "\n");
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally { await handle?.close(); }
  const existing = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await existing.stat();
    if (!stat.isFile() || stat.size > 1024) throw new Error("invalid_admin_token_file");
    await existing.chmod(0o600);
    const token = (await existing.readFile("utf8")).trim();
    validateToken(token);
    return token;
  } finally { await existing.close(); }
}
function formatHost(host: string): string { return host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host; }
function validatePublicUrl(value: unknown): URL | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid_public_base_url");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("invalid_public_base_url");
  }
  if (["0.0.0.0", "[::]", "*"].includes(url.hostname)) throw new Error("unreachable_public_base_url");
  return url;
}
function validRequestOrigin(req: IncomingMessage, authorities: Set<string>, origins: Set<string>): boolean {
  const host = req.headers.host;
  if (!host || !authorities.has(host.toLowerCase())) return false;
  if (!req.url?.startsWith("/") || req.url.startsWith("//")) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && (typeof origin !== "string" || !origins.has(origin))) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  let hostHeaders = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === "host") hostHeaders += 1;
  }
  return hostHeaders === 1;
}
function publicSchema(parameters: unknown): { type: "object"; [key: string]: unknown } {
  const schema = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
  if (isObject(schema.properties)) delete schema.properties._actor;
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((key) => key !== "_actor");
  return { ...schema, type: "object" };
}

function requestOrigin(req: IncomingMessage): string { return "http://" + req.headers.host; }
function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  const local = remote === "::1" || remote === "127.0.0.1" || remote === "::ffff:127.0.0.1";
  const hostname = new URL(requestOrigin(req)).hostname;
  return local && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
function isLocalBrowserRequest(req: IncomingMessage, origin: string, requireOrigin = false): boolean {
  if (!isLoopbackRequest(req) || requestOrigin(req) !== origin) return false;
  if (req.headers.origin !== undefined) return req.headers.origin === origin;
  return !requireOrigin && (req.method === "GET" || req.method === "HEAD") && req.headers["sec-fetch-site"] === "same-origin";
}
function readBrowserCookie(req: IncomingMessage): string | undefined {
  return req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(BROWSER_COOKIE + "="))?.slice(BROWSER_COOKIE.length + 1);
}
function browserCookie(value: string, maxAge: number): string {
  return BROWSER_COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge;
}
