import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStandaloneRuntime } from "../src/standalone-runtime.js";

const ADMIN = "cross-agent-fixture-admin-token-0000000000";
const clients: Client[] = [];
const runtimes: ReturnType<typeof createStandaloneRuntime>[] = [];
let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-cross-agent-"));
  vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("OPENAI_BASE_URL", "");
});
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await fs.rm(stateDir, { recursive: true, force: true }); vi.unstubAllEnvs();
});

async function start() {
  const runtime = createStandaloneRuntime({ stateDir, port: 0, adminToken: ADMIN, pluginConfig: {
    hostModelImageMode: "metadata-only", hostModelVideoMode: "keyframes", retrievalEmbeddingBackend: "none",
    localAsrBackend: "none", asrWorkerEnabled: false,
  } });
  runtimes.push(runtime);
  return { runtime, ...(await runtime.start()) };
}
async function post(base: string, route: string, body: unknown, token = ADMIN) {
  const response = await fetch(base + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return await response.json() as any;
}
async function connect(base: string, name: string, token: string) {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent as Record<string, any>;
}

describe("cross-agent evidence workflow over real MCP HTTP", () => {
  it("captures evidence, shares corrections, returns work, restores after restart and revokes one agent", async () => {
    const { runtime, baseUrl } = await start();
    const a = await post(baseUrl, "/api/clawsense/agent/grants", { agentId: "agent-a" });
    const b = await post(baseUrl, "/api/clawsense/agent/grants", { agentId: "agent-b" });
    const agentA = await connect(baseUrl, "fixture-agent-a", a.token);
    const agentB = await connect(baseUrl, "fixture-agent-b", b.token);
    expect((await agentA.listTools()).tools.some((tool) => tool.name === "clawsense_session_evidence")).toBe(true);
    expect((await call(agentA, "clawsense_status", {})).actor).toBe("agent-a");

    const setup = await post(baseUrl, "/api/clawsense/setup", {});
    const code = JSON.parse(Buffer.from(setup.setupCode, "base64url").toString());
    const phone = await post(baseUrl, "/api/clawsense/pair", { setupToken: code.token, deviceName: "Synthetic test phone", platform: "android" }, "");
    const now = Date.now();
    const created = await call(agentA, "clawsense_session_create", {
      title: "Synthetic customer encounter", startedAt: now - 1000, endedAt: now + 60_000, deviceId: phone.deviceId,
      projectId: "project-demo", participants: [{ personId: "alice", displayName: "Alice" }, { personId: "bob", displayName: "Bob" }],
    });
    const sessionId = created.session.sessionId;
    const image = await post(baseUrl, "/api/clawsense/ingest/image", {
      imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=",
      fileName: "synthetic-pixel.png", mime: "image/png", capturedAt: now,
      note: "Synthetic fixture for pipeline validation, not semantic quality evaluation.",
    }, phone.deviceSecret);
    expect(image.stored).toBe(true);
    const media = await agentB.callTool({ name: "clawsense_artifact_get", arguments: { artifactId: image.artifactId } });
    expect(media.isError).not.toBe(true);
    expect((media.content as Array<{ type: string; mimeType?: string }>).some((item) => item.type === "image" && item.mimeType === "image/png")).toBe(true);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, "plugins/clawsense/state.json"), "utf8"));
    const eventId = state.events.find((event: any) => event.artifactId === image.artifactId).eventId;
    const person = await call(agentA, "clawsense_memory_correct", {
      sessionId, kind: "person", personId: "bob", text: "The participant is Bob, not Alice.", expectedRevision: 1, sourceEventIds: [eventId],
    });
    expect(person.correction.revision).toBe(2);
    await call(agentA, "clawsense_memory_correct", {
      sessionId, kind: "commitment", text: "Bob will deliver the first draft on Friday.", assigneeId: "bob", expectedRevision: 2, sourceEventIds: [eventId],
    });
    const evidence = await call(agentB, "clawsense_session_evidence", { sessionId, question: "Who owns the next step?" });
    expect(evidence.revision).toBe(3);
    expect(evidence.corrections.some((item: any) => item.assigneeId === "bob")).toBe(true);
    expect(JSON.stringify(evidence.evidence)).toContain(eventId);
    expect(evidence.actor).toBe("agent-b");
    const conflict = await agentA.callTool({ name: "clawsense_memory_correct", arguments: { sessionId, kind: "fact", text: "stale write", expectedRevision: 1 } });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent?.error).toBe("revision_conflict");

    const work = (await call(agentA, "clawsense_work_create", { sessionId, title: "Follow-up draft", instructions: "Write the confirmed follow-up.", assignedAgent: "agent-b", inputRevision: 3 })).work;
    const denied = await agentA.callTool({ name: "clawsense_work_complete", arguments: { workItemId: work.workItemId, resultText: "Spoofed completion", expectedRevision: 1 } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.error).toBe("forbidden");
    const finished = (await call(agentB, "clawsense_work_complete", { workItemId: work.workItemId, resultTitle: "Follow-up", resultText: "# Follow-up\nBob will provide the first draft on Friday.\n", expectedRevision: 1 })).work;
    expect(finished.stale).toBe(false);
    expect(finished.completedBy).toBe("agent-b");
    const next = (await call(agentA, "clawsense_session_create", { title: "Next encounter", previousSessionId: sessionId, projectId: "project-demo", participants: [{ personId: "bob", displayName: "Bob" }] })).session;
    await agentA.close(); await agentB.close(); await runtime.stop();

    const restarted = await start();
    const resumedA = await connect(restarted.baseUrl, "fixture-agent-a", a.token);
    const resumedB = await connect(restarted.baseUrl, "fixture-agent-b", b.token);
    const briefing = await call(resumedB, "clawsense_briefing", { sessionId: next.sessionId });
    expect(briefing.previousSession.revision).toBe(3);
    expect(briefing.previousWorkItems[0].resultText).toContain("Friday");
    const original = await call(resumedA, "clawsense_session_get", { sessionId });
    const commitment = original.session.facts.find((item: any) => item.kind === "commitment");
    await call(resumedA, "clawsense_memory_correct", { sessionId, objectId: commitment.objectId, kind: "commitment", text: "Bob now commits to Monday.", assigneeId: "bob", expectedRevision: 3 });
    const oldWork = (await call(resumedB, "clawsense_work_get", { workItemId: work.workItemId })).work;
    expect(oldWork.stale).toBe(true);
    expect(oldWork.resultText).toContain("Friday");
    const revoke = await fetch(`${restarted.baseUrl}/api/clawsense/agent/grants?id=${b.grant.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(revoke.ok).toBe(true);
    await expect(resumedB.callTool({ name: "clawsense_status", arguments: {} })).rejects.toThrow();
    expect((await call(resumedA, "clawsense_status", {})).actor).toBe("agent-a");
  }, 30_000);
});
