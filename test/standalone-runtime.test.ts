import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { Type } from "@sinclair/typebox";
import qrcode from "qrcode-terminal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStandaloneRuntime } from "../src/standalone-runtime.js";
import { currentAgentIdentity } from "../src/tool-context.js";
import { renderPairingQrSvg } from "../src/pairing-qr.js";

type Runtime = ReturnType<typeof createStandaloneRuntime>;
const ADMIN = "standalone-test-admin-credential";
const offlineConfig = {
  hostModelImageMode: "metadata-only", retrievalEmbeddingBackend: "none", localAsrBackend: "none",
  hostModelVideoMode: "none", asrWorkerEnabled: false,
};
let directory: string;
let runtimes: Runtime[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-standalone-test-"));
  runtimes = [];
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_BASE_URL", "");
});
afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.stop()));
  await fs.rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function runtime(extra: Partial<Parameters<typeof createStandaloneRuntime>[0]> = {}): Runtime {
  const instance = createStandaloneRuntime({ stateDir: directory, port: 0, adminToken: ADMIN, pluginConfig: offlineConfig, ...extra });
  runtimes.push(instance);
  return instance;
}
async function request(base: string, route: string, token?: string, body?: unknown, method?: string) {
  return fetch(base + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function pair(base: string) {
  const setupResponse = await request(base, "/api/clawsense/setup", ADMIN, {});
  expect(setupResponse.status).toBe(200);
  const setup = await setupResponse.json() as { setupCode: string; expiresAt: number; baseUrl: string };
  const code = JSON.parse(Buffer.from(setup.setupCode, "base64url").toString("utf8"));
  expect(code.url).toBe(base);
  const response = await request(base, "/api/clawsense/pair", undefined, {
    setupToken: code.token, deviceName: "Offline fixture phone", platform: "android", appVersion: "test", fingerprint: "test-phone",
  });
  expect(response.status).toBe(200);
  return { ...(await response.json()) as { deviceId: string; deviceSecret: string; uploadBaseUrl: string; heartbeatIntervalSec: number }, setupToken: code.token };
}

describe("standalone runtime", () => {
  it("refuses a LAN listener if another server owns the local-client endpoint", async () => {
    const other = http.createServer((_req, res) => { res.statusCode = 404; res.end("other service"); });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const port = (other.address() as import("node:net").AddressInfo).port;
    try {
      const instance = runtime({ host: "0.0.0.0", port, pluginConfig: { ...offlineConfig, publicBaseUrl: `http://192.168.1.12:${port}` } });
      await expect(instance.start()).rejects.toThrow(/companion_port_shadowed|EADDRINUSE/);
      await expect(fs.stat(path.join(directory, ".standalone.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await new Promise<void>((resolve) => other.close(() => resolve())); }
  });
  it("renders the existing setup payload as a numeric QR matrix with a four-module quiet zone", () => {
    const code = Buffer.from(JSON.stringify({ url: "http://192.168.1.12:18790", token: "fixture-token" })).toString("base64url");
    const svg = renderPairingQrSvg(code);
    const size = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)?.[1]);
    const cells = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((match) => [Number(match[1]), Number(match[2])]);
    expect(cells.length).toBeGreaterThan(100);
    expect(cells.every(([x, y]) => x! >= 4 && y! >= 4 && x! < size - 4 && y! < size - 4)).toBe(true);
    expect(svg).not.toContain(code);
    expect(svg).not.toContain("<script");
    expect(() => renderPairingQrSvg('<img src=x onerror="alert(1)">')).toThrow("invalid_pairing_code");
  });
  it("runs Android pairing and audio/image ingest over real HTTP and preserves evidence after restart", async () => {
    const qr = vi.spyOn(qrcode, "generate");
    const first = runtime();
    const address = await first.start();
    expect(address.host).toBe("127.0.0.1");
    expect(qr).not.toHaveBeenCalled();
    const phone = await pair(address.baseUrl);
    expect(phone.uploadBaseUrl).toBe(address.baseUrl + "/api/clawsense");
    expect(phone.heartbeatIntervalSec).toBeGreaterThan(0);
    expect((await request(address.baseUrl, "/api/clawsense/pair", undefined, { setupToken: phone.setupToken })).status).toBe(403);
    expect((await request(address.baseUrl, "/api/clawsense/ingest/audio", undefined, {})).status).toBe(401);
    const wav = silenceWav();
    const audioResponse = await request(address.baseUrl, "/api/clawsense/ingest/audio", phone.deviceSecret, {
      audioBase64: wav.toString("base64"), fileName: "short-silence.wav", mime: "audio/wav", capturedAt: Date.now(),
    });
    expect(audioResponse.status).toBe(202);
    const audio = await audioResponse.json() as { stored: boolean; artifactId: string };
    expect(audio.stored).toBe(true);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=", "base64");
    const imageResponse = await request(address.baseUrl, "/api/clawsense/ingest/image", phone.deviceSecret, {
      imageBase64: png.toString("base64"), fileName: "pixel.png", mime: "image/png", capturedAt: Date.now(),
    });
    expect(imageResponse.status).toBe(202);
    expect((await imageResponse.json() as { stored: boolean }).stored).toBe(true);
    expect((await request(address.baseUrl, "/api/clawsense/heartbeat", phone.deviceSecret, { appState: "service" })).status).toBe(200);
    expect((await request(address.baseUrl, "/api/clawsense/agent/tools", phone.deviceSecret)).status).toBe(401);
    const artifact = await request(address.baseUrl, "/api/clawsense/artifacts?id=" + audio.artifactId, ADMIN);
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(wav);
    await first.stop();
    const state = JSON.parse(await fs.readFile(path.join(directory, "plugins/clawsense/state.json"), "utf8"));
    expect(state.devices).toHaveLength(1);
    expect(state.events.map((event: { modality: string }) => event.modality).sort()).toEqual(["audio", "image"]);
    const second = runtime();
    const restarted = await second.start();
    expect((await request(restarted.baseUrl, "/api/clawsense/heartbeat", phone.deviceSecret, { appState: "service" })).status).toBe(200);
    const status = await (await request(restarted.baseUrl, "/api/clawsense/status", ADMIN)).json() as any;
    expect(status.devices.total).toBe(1);
    expect(status.ingest24h.totalEvents).toBe(2);
  });

  it("enforces admin, Agent and device boundaries and derives actor from the grant", async () => {
    const instance = runtime();
    const { baseUrl } = await instance.start();
    for (const route of ["/api/clawsense/status", "/api/clawsense/library", "/plugins/clawsense/library", "/api/clawsense/agent/tools", "/api/clawsense/agent/grants"]) {
      expect((await request(baseUrl, route)).status).toBe(401);
    }
    expect((await request(baseUrl, "/api/clawsense/setup", undefined, {})).status).toBe(401);
    const grantResponse = await request(baseUrl, "/api/clawsense/agent/grants", ADMIN, { agentId: "test-agent" });
    expect(grantResponse.status).toBe(201);
    const issued = await grantResponse.json() as { token: string; grant: { id: string } };
    const grantFile = await fs.readFile(path.join(directory, "agent-grants.json"), "utf8");
    expect(grantFile).not.toContain(issued.token);
    instance.tools.set("test_identity", {
      name: "test_identity", description: "Verify authenticated transport identity", parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      execute: async (_id, args) => ({ content: [{ type: "text", text: currentAgentIdentity() }], details: args }),
    });
    const catalog = await (await request(baseUrl, "/api/clawsense/agent/tools", issued.token)).json() as any;
    expect(catalog.tools.some((tool: { name: string }) => tool.name === "clawsense_context")).toBe(true);
    expect(catalog.tools.some((tool: { name: string }) => tool.name === "test_identity")).toBe(true);
    const call = await request(baseUrl, "/api/clawsense/agent/call", issued.token, {
      name: "test_identity", arguments: { value: "ok", _actor: "local-owner" }, agentId: "local-owner",
    });
    expect(call.status).toBe(200);
    expect((await call.json() as any).result.content[0].text).toBe("test-agent");
    const local = await instance.invokeTool("test_identity", { value: "ok" });
    expect(local.content[0].text).toBe("local-owner");
    expect((await request(baseUrl, "/api/clawsense/agent/call", issued.token, { name: "test_identity", arguments: {} })).status).toBe(400);
    expect((await request(baseUrl, "/api/clawsense/agent/call", issued.token, { name: "missing", arguments: {} })).status).toBe(404);
    expect((await request(baseUrl, "/api/clawsense/library", issued.token)).status).toBe(200);
    for (const route of ["/api/clawsense/setup", "/api/clawsense/agent/grants", "/api/clawsense/pair"]) {
      expect((await request(baseUrl, route, issued.token, {})).status).toBe(403);
    }
    expect((await request(baseUrl, "/api/clawsense/status", issued.token)).status).toBe(403);
    expect((await request(baseUrl, "/api/clawsense/agent/grants?id=" + issued.grant.id, ADMIN, undefined, "DELETE")).status).toBe(200);
    expect((await request(baseUrl, "/api/clawsense/agent/tools", issued.token)).status).toBe(401);
  });

  it("blocks cross-origin and DNS rebinding requests even with valid credentials", async () => {
    const { baseUrl, port } = await runtime().start();
    const maliciousOrigin = await fetch(baseUrl + "/api/clawsense/agent/tools", {
      headers: { Authorization: "Bearer " + ADMIN, Origin: "https://attacker.example" },
    });
    expect(maliciousOrigin.status).toBe(403);
    const sameOrigin = await fetch(baseUrl + "/api/clawsense/agent/tools", {
      headers: { Authorization: "Bearer " + ADMIN, Origin: baseUrl },
    });
    expect(sameOrigin.status).toBe(200);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/api/clawsense/agent/tools", headers: {
        Host: "attacker.example:" + port, Authorization: "Bearer " + ADMIN,
      } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end();
    });
    expect(badHostStatus).toBe(403);
    expect(() => runtime({ host: "0.0.0.0" })).toThrow("wildcard_bind_requires_public_base_url");
  });

  it("serves authenticated stateless MCP discovery without accepting credentials in URLs", async () => {
    const { baseUrl } = await runtime().start();
    expect((await request(baseUrl, "/mcp", undefined, {})).status).toBe(401);
    expect((await request(baseUrl, "/api/clawsense/agent/tools?token=" + ADMIN)).status).toBe(401);
    expect((await request(baseUrl, "/mcp", ADMIN)).status).toBe(405);
    const response = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer " + ADMIN, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
    const reply = await response.json() as any;
    expect(reply.result.tools.some((tool: { name: string }) => tool.name === "clawsense_context")).toBe(true);
    for (const tool of reply.result.tools) expect(tool.inputSchema.properties).not.toHaveProperty("_actor");
  });

  it("exchanges a one-use local browser code for a same-origin HttpOnly session and revokes it on logout", async () => {
    const { baseUrl, port } = await runtime().start();
    const page = await request(baseUrl, "/app");
    expect(page.status).toBe(200);
    expect((await request(baseUrl, "/favicon.ico")).status).toBe(204);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).not.toContain(ADMIN);
    expect(html).not.toContain("innerHTML");
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script!)).not.toThrow();
    expect(script!.indexOf("history.replaceState")).toBeLessThan(script!.indexOf("async function api"));
    expect((await request(baseUrl, "/api/clawsense/browser-login", undefined, {})).status).toBe(401);
    const issued = await (await request(baseUrl, "/api/clawsense/browser-login", ADMIN, {})).json() as any;
    expect(issued.code).toHaveLength(43);
    expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    expect((await request(baseUrl, "/api/clawsense/browser-login/redeem", undefined, { code: issued.code })).status).toBe(403);
    const redeem = (origin: string) => fetch(baseUrl + "/api/clawsense/browser-login/redeem", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: issued.code }),
    });
    expect((await redeem("http://localhost:" + port)).status).toBe(403);
    const response = await redeem(baseUrl);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=3600");
    expect(setCookie).not.toContain(ADMIN);
    const cookie = setCookie.split(";")[0];
    expect((await redeem(baseUrl)).status).toBe(401);
    const browserCall = (origin?: string) => fetch(baseUrl + "/api/clawsense/agent/tools", {
      headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
    });
    expect((await browserCall(baseUrl)).status).toBe(200);
    expect((await browserCall()).status).toBe(401);
    expect((await browserCall("http://localhost:" + port)).status).toBe(401);
    expect((await fetch(baseUrl + "/api/clawsense/agent/tools", { headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
    expect((await fetch(baseUrl + "/api/clawsense/shutdown", { method: "POST", headers: { Cookie: cookie, Origin: baseUrl } })).status).toBe(401);
    const create = await fetch(baseUrl + "/api/clawsense/agent/call", {
      method: "POST", headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "clawsense_session_create", arguments: { title: "浏览器面谈" } }),
    });
    expect(create.status).toBe(200);
    expect((await create.json() as any).result.details.session.createdBy).toBe("local-owner");
    const logout = await fetch(baseUrl + "/api/clawsense/browser-logout", { method: "POST", headers: { Cookie: cookie, Origin: baseUrl } });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await browserCall(baseUrl)).status).toBe(401);
  });

  it("expires browser codes and sessions instead of keeping permanent browser access", async () => {
    const { baseUrl } = await runtime().start();
    const issued = await (await request(baseUrl, "/api/clawsense/browser-login", ADMIN, {})).json() as any;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    const expired = await fetch(baseUrl + "/api/clawsense/browser-login/redeem", {
      method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ code: issued.code }),
    });
    expect(expired.status).toBe(401);
    clock.mockReturnValue(now);
    const next = await (await request(baseUrl, "/api/clawsense/browser-login", ADMIN, {})).json() as any;
    const redeemed = await fetch(baseUrl + "/api/clawsense/browser-login/redeem", {
      method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ code: next.code }),
    });
    const cookie = redeemed.headers.get("set-cookie")!.split(";")[0];
    clock.mockReturnValue(now + 3_600_001);
    const protectedResponse = await fetch(baseUrl + "/api/clawsense/agent/tools", { headers: { Cookie: cookie, Origin: baseUrl } });
    expect(protectedResponse.status).toBe(401);
  });

  it("persists a private admin credential and prevents simultaneous writers", async () => {
    const first = runtime({ adminToken: undefined });
    const address = await first.start();
    const token = (await fs.readFile(first.adminTokenFile, "utf8")).trim();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect((await fs.stat(first.adminTokenFile)).mode & 0o777).toBe(0o600);
    expect((await request(address.baseUrl, "/api/clawsense/agent/tools", token)).status).toBe(200);
    const concurrent = runtime({ adminToken: undefined });
    await expect(concurrent.start()).rejects.toThrow("state_directory_locked");
    await concurrent.stop();
    expect((await fs.stat(path.join(directory, ".standalone.lock"))).isDirectory()).toBe(true);
    await first.stop();
    await concurrent.start();
    expect((await fs.readFile(concurrent.adminTokenFile, "utf8")).trim()).toBe(token);
  });

  it("allows only a local admin bearer to request shutdown and responds before stopping", async () => {
    const instance = runtime();
    const { baseUrl } = await instance.start();
    expect((await request(baseUrl, "/api/clawsense/shutdown", undefined, {})).status).toBe(401);
    const grant = await (await request(baseUrl, "/api/clawsense/agent/grants", ADMIN, { agentId: "shutdown-test" })).json() as any;
    expect((await request(baseUrl, "/api/clawsense/shutdown", grant.token, {})).status).toBe(401);
    const response = await request(baseUrl, "/api/clawsense/shutdown", ADMIN, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stopping: true });
    await expect.poll(async () => fs.stat(path.join(directory, ".standalone.lock")).then(() => true, () => false)).toBe(false);
    await expect(fetch(baseUrl + "/api/clawsense/status")).rejects.toThrow();
  });

  it("stops service intervals and waits for an in-flight tool before releasing its lock", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const instance = runtime();
    const { baseUrl } = await instance.start();
    const intervals = setIntervalSpy.mock.results.map((result) => result.value);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    instance.tools.set("test_slow", { name: "test_slow", description: "Test shutdown", parameters: Type.Object({}),
      async execute() { await gate; return { content: [{ type: "text", text: "done" }] }; },
    });
    const result = instance.invokeTool("test_slow", {});
    const stopping = instance.stop();
    expect((await fs.stat(path.join(directory, ".standalone.lock"))).isDirectory()).toBe(true);
    release(); await result; await stopping;
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    for (const interval of intervals) expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    await expect(fs.stat(path.join(directory, ".standalone.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(baseUrl + "/api/clawsense/status")).rejects.toThrow();
    await expect(instance.invokeTool("test_slow", {})).rejects.toThrow("runtime_not_ready");
  });
});

function silenceWav(): Buffer {
  const dataSize = 3200;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF"); wav.writeUInt32LE(36 + dataSize, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(dataSize, 40); return wav;
}
