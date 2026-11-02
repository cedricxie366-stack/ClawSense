import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createStandaloneRuntime } from "../src/standalone-runtime.js";
import type { AnyAgentTool, OpenClawPluginApi } from "../src/openclaw-types.js";

let directory: string;
let runtime: ReturnType<typeof createStandaloneRuntime>;
const admin = "openclaw-companion-fixture-admin-token";
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-openclaw-client-"));
  vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("OPENAI_BASE_URL", "");
  runtime = createStandaloneRuntime({ stateDir: path.join(directory, "owner"), port: 0, adminToken: admin,
    pluginConfig: { hostModelImageMode: "metadata-only", localAsrBackend: "none", retrievalEmbeddingBackend: "none", asrWorkerEnabled: false } });
});
afterEach(async () => { await runtime.stop(); await fs.rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function adapter(config: Record<string, unknown>) {
  const tools: AnyAgentTool[] = [];
  const api = {
    pluginConfig: config, registerTool: (tool: AnyAgentTool) => tools.push(tool),
    get runtime() { throw new Error("client_must_not_open_local_store"); },
    registerHttpRoute: vi.fn(), registerService: vi.fn(), registerCli: vi.fn(),
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  expect(api.registerHttpRoute).not.toHaveBeenCalled(); expect(api.registerService).not.toHaveBeenCalled(); expect(api.registerCli).not.toHaveBeenCalled();
  return tools;
}
async function setup() {
  const { baseUrl } = await runtime.start();
  const result = await fetch(baseUrl + "/api/clawsense/agent/grants", { method: "POST", headers: { Authorization: "Bearer " + admin, "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "openclaw-client" }) });
  const grant = await result.json();
  const tokenFile = path.join(directory, "client-token");
  await fs.writeFile(tokenFile, grant.token, { mode: 0o600 });
  return { baseUrl, tokenFile, grant, tools: adapter({ companionUrl: baseUrl, companionTokenFile: tokenFile }) };
}
async function call(tool: AnyAgentTool, name: string, args: Record<string, unknown>) {
  return await tool.execute("test", { name, arguments: args });
}

it("connects OpenClaw to the single owner, preserving corrections, identity and assignment restrictions", async () => {
  const { tools, baseUrl } = await setup();
  const ownerCall = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(baseUrl + "/api/clawsense/agent/call", { method: "POST", headers: { Authorization: "Bearer " + admin, "Content-Type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
    return (await response.json()).result;
  };
  const catalog = await tools[0]!.execute("test", {});
  expect((catalog.details as any).tools.some((item: any) => item.name === "clawsense_memory_correct")).toBe(true);
  expect((catalog.details as any).tools.some((item: any) => item.name.startsWith("clawsense_digital"))).toBe(false);
  const session = (await ownerCall("clawsense_session_create", { title: "Approved fixture" })).details as any;
  await ownerCall("clawsense_memory_correct", { sessionId: session.session.sessionId, kind: "commitment", text: "User confirms Thursday", expectedRevision: 1 });
  const received = (await call(tools[1]!, "clawsense_session_get", { sessionId: session.session.sessionId, _actor: "local-owner" })).details as any;
  expect(received.actor).toBe("openclaw-client"); expect(received.session.revision).toBe(2);
  expect(received.session.facts[0].text).toContain("Thursday");
  const wrong = (await ownerCall("clawsense_work_create", { sessionId: received.session.sessionId, title: "Other host", instructions: "Fixture", assignedAgent: "codex", inputRevision: 2 })).details as any;
  const denied = await call(tools[1]!, "clawsense_work_complete", { workItemId: wrong.work.workItemId, resultText: "Must not save", expectedRevision: 1 });
  expect((denied.details as any).error).toBe("forbidden");
  const assigned = (await ownerCall("clawsense_work_create", { sessionId: received.session.sessionId, title: "OpenClaw host", instructions: "Fixture", assignedAgent: "openclaw-client", inputRevision: 2 })).details as any;
  const done = await call(tools[1]!, "clawsense_work_complete", { workItemId: assigned.work.workItemId, resultText: "Thursday draft", expectedRevision: 1 });
  expect((done.details as any).work.completedBy).toBe("openclaw-client");
  const reused = (await ownerCall("clawsense_work_get", { workItemId: assigned.work.workItemId })).details as any;
  expect(reused.work.resultText).toBe("Thursday draft");
  await expect(fs.stat(path.join(directory, "plugins"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("honors revocation on an already loaded adapter and reports failure without credentials", async () => {
  const { baseUrl, tools, grant, tokenFile } = await setup();
  expect((await call(tools[1]!, "clawsense_status", {})).details).toMatchObject({ ok: true, actor: "openclaw-client" });
  await fetch(baseUrl + "/api/clawsense/agent/grants?id=" + grant.grant.id, { method: "DELETE", headers: { Authorization: "Bearer " + admin } });
  const result = await call(tools[1]!, "clawsense_status", {});
  expect(result.details).toMatchObject({ ok: false, error: "companion_request_failed_401" });
  expect(JSON.stringify(result)).not.toContain(grant.token); expect(JSON.stringify(result)).not.toContain(tokenFile);
});

it("preserves native image bytes from the owner's original artifact", async () => {
  const { baseUrl, tools } = await setup();
  const post = async (route: string, body: unknown, token = admin) => (await fetch(baseUrl + route, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const setupCode = await post("/api/clawsense/setup", {});
  const code = JSON.parse(Buffer.from(setupCode.setupCode, "base64url").toString());
  const phone = await post("/api/clawsense/pair", { setupToken: code.token, deviceName: "Fixture", platform: "fixture" });
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=";
  const receipt = await post("/api/clawsense/ingest/image", { imageBase64: pixel, mime: "image/png", fileName: "pixel.png", capturedAt: Date.now() }, phone.deviceSecret);
  const result = await call(tools[1]!, "clawsense_artifact_get", { artifactId: receipt.artifactId });
  expect(result.content.find((item) => item.type === "image")).toMatchObject({ data: pixel, mimeType: "image/png" });
});

it("fails closed on partial/unsafe client configuration and rejects proxying a standalone owner", () => {
  expect(() => adapter({ companionUrl: "http://127.0.0.1:1234" })).toThrow("companion_url_and_token_file_required");
  expect(() => adapter({ companionUrl: "http://192.168.0.1", companionTokenFile: "/private/token" })).toThrow("remote_companion_requires_https");
  expect(() => adapter({ companionUrl: "http://127.0.0.1", companionTokenFile: "token" })).toThrow("companion_token_file_must_be_absolute");
  expect(() => createStandaloneRuntime({ stateDir: directory, pluginConfig: { companionUrl: "http://127.0.0.1" } })).toThrow("standalone_cannot_proxy_companion");
});

it("limits the proxy surface and honors a canceled request", async () => {
  const { tools } = await setup();
  expect((await call(tools[1]!, "clawsense_digital_import", {})).details).toMatchObject({ ok: false });
  const controller = new AbortController(); controller.abort();
  const result = await tools[0]!.execute("test", {}, controller.signal);
  expect(result.details).toMatchObject({ ok: false, error: "companion_unavailable" });
});
