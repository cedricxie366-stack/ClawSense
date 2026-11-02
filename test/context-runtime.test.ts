import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStandaloneRuntime } from "../src/standalone-runtime.js";
import { ClawSenseStateStore } from "../src/state-store.js";
import { unifiedContext } from "../src/context-store.js";
import { currentAgentIdentity } from "../src/tool-context.js";
import { ClawSenseWorkflowStore } from "../src/workflow-store.js";
import { answerAssistantQuery } from "../src/realtime-assistant.js";
import { answerFromConfirmedMemory } from "../src/context-memory.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
describe("G2 transport and current corrected memory", () => {
  it("applies identical project/raw boundaries to HTTP and MCP, without leaking local paths", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-http-")));
    const runtime = createStandaloneRuntime({ stateDir: root, port: 0, pluginConfig: { retrievalEmbeddingBackend: "none", hostModelImageMode: "metadata-only", hostModelVideoMode: "none" } });
    const { baseUrl } = await runtime.start();
    try {
      const token = (await fs.readFile(runtime.adminTokenFile, "utf8")).trim();
      const request = (route: string, bearer = token, body?: unknown) => fetch(baseUrl + route, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const context = unifiedContext(root), physical = new ClawSenseStateStore({ resolveStateDir: () => root, logger });
      const owner = { actor: "local-owner", owner: true };
      const captures = [];
      for (const project of ["work", "private"]) {
        await context.setDevicePolicy(project, { projectIds: [project], audience: "private", processingLocation: "legacy-configured", allowedRecipients: [] }, owner);
        const file = path.join(root, "plugins/clawsense/media", project + ".wav"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.from("controlled-original-" + project));
        captures.push(await physical.recordCapture({ memoryId: project + "-event", namespace: "clawsense", deviceId: project, modality: "audio", summary: project + " context", transcript: project + " transcript", capturedAt: Date.now(), createdAt: Date.now(), sourcePath: file, fileName: project + ".wav", sizeBytes: 24, storageRelPath: project + ".wav", retentionExpiresAt: Date.now() + 60000, analysisMode: "local-asr", analysisStatus: "succeeded" }));
      }
      const granted = await (await request("/api/clawsense/agent/grants", token, { agentId: "office", contextScopes: [{ projectId: "work", operations: ["read-metadata", "read-analysis", "read-result"] }] })).json() as any;
      const status = await (await request("/api/clawsense/agent/call", granted.token, { name: "clawsense_status", arguments: {} })).json() as any;
      expect(status.result.details.counts.events).toBe(1);
      const library = await (await request("/api/clawsense/library", granted.token)).text();
      expect(library).not.toContain("private-event"); expect(library).not.toContain(root);
      const raw = await request("/api/clawsense/artifacts?id=" + captures[0].artifact.artifactId, granted.token); expect(raw.status).toBe(404);
      const outsider = await (await request("/api/clawsense/agent/call", granted.token, { name: "clawsense_context_export", arguments: { refs: [{ kind: "analysis", id: "private-event" }] } })).json() as any;
      expect(outsider.result.details.ok).toBe(false); expect(JSON.stringify(outsider)).not.toContain("private transcript");
      const authorizedRaw = await (await request("/api/clawsense/agent/grants", token, { agentId: "reader", contextScopes: [{ projectId: "work", operations: ["read-metadata", "read-analysis", "read-raw"] }] })).json() as any;
      expect((await request("/api/clawsense/artifacts?id=" + captures[0].artifact.artifactId, authorizedRaw.token)).status).toBe(200);
    } finally { await runtime.stop(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it("rechecks an in-flight agent grant before sending its produced result", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-revoke-")));
    const runtime = createStandaloneRuntime({ stateDir: root, port: 0 }); const { baseUrl } = await runtime.start();
    try {
      const token = (await fs.readFile(runtime.adminTokenFile, "utf8")).trim();
      const issue = await (await fetch(baseUrl + "/api/clawsense/agent/grants", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: "reader" }) })).json() as any;
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; }), armed = new Promise<void>((resolve) => { entered = resolve; });
      runtime.tools.set("test_delayed_read", { name: "test_delayed_read", parameters: Type.Object({}, { additionalProperties: false }), async execute() { expect(currentAgentIdentity()).toBe("reader"); entered(); await waiting; return { content: [{ type: "text", text: "MUST_NOT_BE_SENT" }] }; } });
      const result = fetch(baseUrl + "/api/clawsense/agent/call", { method: "POST", headers: { authorization: `Bearer ${issue.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "test_delayed_read", arguments: {} }) });
      await armed; await fetch(baseUrl + "/api/clawsense/agent/grants?id=" + issue.grant.id, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }); release();
      const response = await result; expect(response.status).toBe(403); expect(await response.text()).not.toContain("MUST_NOT_BE_SENT");
    } finally { await runtime.stop(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it("answers with the relevant owner-confirmed correction rather than the old raw date", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-correction-")));
    const store = new ClawSenseWorkflowStore({ resolveStateDir: () => root });
    try {
      const session = await store.createSession({ title: "小林面谈", startedAt: 1000, endedAt: 2000, participants: [{ personId: "lin", displayName: "小林" }] }, "local-owner");
      await store.correct({ sessionId: session.sessionId, kind: "commitment", text: "小林希望周四收到方案", deadlineLiteral: "周四", sourceEventIds: ["source-a"], expectedRevision: 1 }, "local-owner");
      const context = { windowHint: "last_60s" as const, modeUsed: "auto" as const, timeRange: { startAt: 900, endAt: 2100, label: "fixture" }, sceneSummary: "", recentTranscriptSpans: [{ eventId: "source-a", windowId: "fixture", capturedAt: 1500, time: "fixture", text: "小林希望周五收到方案", artifactUrl: "fixture" }], topEvidence: [], peopleHints: [], attentionHints: [], taskHints: [], counts: { windows: 1, events: 1, transcriptSpans: 1, audioEvents: 1, pendingAudioWindows: 0 } };
      const fallback = answerAssistantQuery({ queryText: "小林希望什么时候收到方案？", recentContext: context });
      const result = await answerFromConfirmedMemory("小林希望什么时候收到方案？", context, store, fallback);
      expect(result?.answerSpokenText).toContain("周四"); expect(result?.answerSpokenText).not.toContain("周五"); expect(result?.memoryCorrectionRefs?.length).toBe(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("does not publish an in-flight read after its source has been deleted", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-delete-read-")));
    const runtime = createStandaloneRuntime({ stateDir: root, port: 0, pluginConfig: { retrievalEmbeddingBackend: "none" } });
    const { baseUrl } = await runtime.start();
    try {
      const context = unifiedContext(root), physical = new ClawSenseStateStore({ resolveStateDir: () => root, logger });
      const owner = { actor: "local-owner", owner: true };
      const file = path.join(root, "plugins/clawsense/media/read.wav"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "fixture");
      await physical.recordCapture({ memoryId: "read-source", namespace: "clawsense", deviceId: "fixture", modality: "audio", transcript: "MUST_NOT_BE_SENT_AFTER_DELETE", summary: "fixture", createdAt: 1000, capturedAt: 1000, sourcePath: file, fileName: "read.wav", sizeBytes: 7, storageRelPath: "read.wav", retentionExpiresAt: Date.now() + 60000, analysisMode: "local-asr", analysisStatus: "succeeded" });
      let entered!: () => void, release!: () => void;
      const armed = new Promise<void>((resolve) => { entered = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
      runtime.tools.set("clawsense_status", { name: "clawsense_status", parameters: Type.Object({}, { additionalProperties: false }), async execute() { const events = await physical.listEvents(); entered(); await wait; return { content: [{ type: "text", text: events[0].transcript! }] }; } });
      const token = (await fs.readFile(runtime.adminTokenFile, "utf8")).trim();
      const reading = fetch(baseUrl + "/api/clawsense/agent/call", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "clawsense_status", arguments: {} }) });
      await armed; await context.deleteEvidence({ kind: "evidence", id: "read-source" }, "evidence-and-derived", owner); release();
      const response = await reading; expect(response.status).toBe(409); expect(await response.text()).not.toContain("MUST_NOT_BE_SENT_AFTER_DELETE");
    } finally { await runtime.stop(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
