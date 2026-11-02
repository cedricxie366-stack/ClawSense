import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DigitalContextStore, type DigitalImport } from "../src/digital-store.js";
import type { DigitalAccess } from "../src/digital-access.js";
import { createStandaloneRuntime } from "../src/standalone-runtime.js";

const owner: DigitalAccess = { owner: true, actor: "local-owner", scopes: [] };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=";
let directory: string, store: DigitalContextStore;
const runtimes: ReturnType<typeof createStandaloneRuntime>[] = [];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-digital-"));
  store = new DigitalContextStore({ resolveStateDir: () => directory, workspaceId: "test-workspace" });
  await store.setDeviceGrant("primary-phone", true, ["*"]);
});
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop())); await fs.rm(directory, { recursive: true, force: true }); });
const input = (extra: Partial<DigitalImport> = {}): DigitalImport => ({ clientEventId: "client-1", projectId: "expo", sourceType: "shared_text", capturedAt: Date.now(), title: "Coffee chat", text: "Please prepare the quotation for Friday.", ...extra });
const scope = (projectId = "expo", allowRaw = false): DigitalAccess => ({ owner: false, actor: "codex", scopes: [{ projectId, allowRaw }] });

describe("digital context", () => {
  it("fails closed without a primary-source grant and rechecks revoked access", async () => {
    await expect(store.import(input(), "sensor-phone")).rejects.toMatchObject({ code: "primary_device_authorization_required" });
    const access = await store.deviceAccess("primary-phone");
    await store.setDeviceGrant("primary-phone", false, ["*"]);
    await expect(store.createPerson("Lin", "expo", access)).rejects.toMatchObject({ code: "primary_device_authorization_required" });
    await expect(store.query({}, access)).rejects.toMatchObject({ code: "primary_device_authorization_required" });
  });
  it("retries idempotently and never resurrects a deleted queued event", async () => {
    const payload = input();
    const event = await store.import(payload, "primary-phone");
    expect((await store.import(payload, "primary-phone")).eventId).toBe(event.eventId);
    await expect(store.import({ ...payload, text: "Changed retry" }, "primary-phone")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await store.deleteEvent(event.eventId, owner);
    await expect(store.import(payload, "primary-phone")).rejects.toMatchObject({ code: "context_deleted", statusCode: 410 });
    expect(await store.query({}, owner)).toEqual([]);
  });
  it("filters project/source before reading and separates original image authorization", async () => {
    await store.import(input(), "primary-phone");
    const image = await store.import(input({ clientEventId: "image", sourceType: "shared_image", imageBase64: png, mime: "image/png", claimedApp: "WeChat" }), "primary-phone");
    await store.import(input({ clientEventId: "secret", projectId: "private" }), "primary-phone");
    expect(await store.query({}, { owner: false, actor: "legacy-agent", scopes: [] })).toEqual([]);
    expect((await store.query({}, scope())).length).toBe(2);
    expect((await store.query({}, { ...scope(), scopes: [{ projectId: "expo", sourceTypes: ["shared_text"] }] })).length).toBe(1);
    await expect(store.readArtifact(image.eventId, scope())).rejects.toMatchObject({ code: "raw_context_not_authorized" });
    expect((await store.readArtifact(image.eventId, scope("expo", true))).data.toString("base64")).toBe(png);
    expect(image).toMatchObject({ sourceLevel: "user-shared", coverage: "visible-fragment", timeBasis: "unknown" });
    await store.deleteEvent(image.eventId, owner);
    await expect(fs.stat(path.join(directory, "plugins/clawsense/digital", image.eventId + ".media"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps equal names separate and requires rejecting a conflicting identity before reassignment", async () => {
    const first = await store.createPerson("Lin", "expo", owner), second = await store.createPerson("Lin", "expo", owner);
    expect(first.personId).not.toBe(second.personId);
    const link = { platform: "wechat", accountRef: "my-account", externalId: "verified-account-id", label: "Lin" };
    await store.linkIdentity({ ...link, personId: first.personId, expectedRevision: 1 }, owner);
    await expect(store.linkIdentity({ ...link, personId: second.personId, expectedRevision: 1 }, owner)).rejects.toMatchObject({ code: "identity_already_linked_confirm_split_first" });
    await store.linkIdentity({ ...link, personId: first.personId, expectedRevision: 2, reject: true }, owner);
    await store.linkIdentity({ ...link, personId: second.personId, expectedRevision: 1 }, owner);
  });
  it("tracks snapshot revisions, correction history, identity changes and deletion dependencies", async () => {
    const person = await store.createPerson("Lin", "expo", owner);
    const event = await store.import(input({ personId: person.personId }), "primary-phone");
    const snapshot = await store.snapshot([event.eventId], scope());
    expect((await store.inspectSnapshot(snapshot.snapshotId, scope())).stale).toBe(false);
    await expect(store.correctEvent({ eventId: event.eventId, expectedRevision: 1, text: "Thursday" }, scope())).rejects.toMatchObject({ code: "owner_confirmation_required" });
    const corrected = await store.correctEvent({ eventId: event.eventId, expectedRevision: 1, text: "Thursday" }, owner);
    expect(corrected.correctionHistory?.[0].previousText).toBe(event.text);
    expect((await store.inspectSnapshot(snapshot.snapshotId, scope())).stale).toBe(true);
    const latest = await store.snapshot([event.eventId], scope());
    await store.linkIdentity({ personId: person.personId, platform: "contacts", accountRef: "phone", externalId: "1", label: "Lin", expectedRevision: 1 }, owner);
    expect((await store.inspectSnapshot(latest.snapshotId, scope())).stale).toBe(true);
    await store.deleteEvent(event.eventId, owner);
    await expect(store.inspectSnapshot(latest.snapshotId, scope())).rejects.toMatchObject({ code: "context_deleted" });
  });
  it("rejects malformed images, cross-project person associations and corrupted authorization files", async () => {
    const person = await store.createPerson("Private", "private", owner);
    await expect(store.import(input({ personId: person.personId }), "primary-phone")).rejects.toMatchObject({ code: "person_project_mismatch" });
    await expect(store.import(input({ sourceType: "shared_image", imageBase64: "SGVsbG8=", mime: "image/png" }), "primary-phone")).rejects.toMatchObject({ code: "invalid_shared_image" });
    await fs.writeFile(path.join(directory, "plugins/clawsense/digital/context.json"), '{"version":1}');
    await expect(store.query({}, owner)).rejects.toMatchObject({ code: "digital_store_unreadable" });
  });
});

describe("digital HTTP and agent handoff", () => {
  it("preserves sensor pairing and protects handoffs from unscoped agents, corrections and deletion", async () => {
    const admin = "fixture-admin-token";
    const runtime = createStandaloneRuntime({ stateDir: path.join(directory, "http"), port: 0, adminToken: admin, pluginConfig: { hostModelImageMode: "metadata-only", retrievalEmbeddingBackend: "none", localAsrBackend: "none", hostModelVideoMode: "none", asrWorkerEnabled: false } });
    runtimes.push(runtime);
    const { baseUrl } = await runtime.start();
    const request = async (route: string, token: string | undefined, body: unknown) => fetch(baseUrl + route, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const pair = async (deviceRole: string, fingerprint: string) => {
      const setup = await (await request("/api/clawsense/setup", admin, { deviceRole })).json() as any;
      const code = JSON.parse(Buffer.from(setup.setupCode, "base64url").toString());
      return await (await request("/api/clawsense/pair", undefined, { setupToken: code.token, deviceName: deviceRole, fingerprint })).json() as any;
    };
    const sensor = await pair("sensor", "sensor"), primary = await pair("primary", "primary");
    expect(sensor.digitalContextEnabled).toBe(false); expect(primary.digitalContextEnabled).toBe(true);
    expect((await request("/api/clawsense/digital/bootstrap", sensor.deviceSecret, {})).status).toBe(403);
    expect((await request("/api/clawsense/digital/bootstrap", primary.deviceSecret, {})).status).toBe(200);
    const call = async (name: string, args: Record<string, unknown>, token = admin) => {
      const response = await request("/api/clawsense/agent/call", token, { name, arguments: args });
      const value = await response.json() as any;
      return value.result?.details ?? value;
    };
    const grant = await (await request("/api/clawsense/agent/grants", admin, { agentId: "codex", digitalScopes: [{ projectId: "expo" }] })).json() as any;
    const legacy = await (await request("/api/clawsense/agent/grants", admin, { agentId: "claude-code" })).json() as any;
    const { session } = await call("clawsense_session_create", { title: "Coffee chat", projectId: "expo" });
    const imported = await (await request("/api/clawsense/digital/ingest", primary.deviceSecret, input({ sessionId: session.sessionId }))).json() as any;
    expect(imported.stored).toBe(true);
    const queried = await call("clawsense_digital_query", { projectId: "expo" }, grant.token);
    expect(queried.events.length).toBe(1);
    expect((await call("clawsense_digital_query", {}, legacy.token)).events).toEqual([]);
    const { work } = await call("clawsense_work_create", { sessionId: session.sessionId, title: "Quotation", instructions: "Prepare a quotation", assignedAgent: "codex", inputRevision: 1, contextSnapshotId: queried.snapshot.snapshotId }, grant.token);
    expect(["snapshot_not_authorized", "not_found"]).toContain((await call("clawsense_work_get", { workItemId: work.workItemId }, legacy.token)).error);
    await call("clawsense_work_complete", { workItemId: work.workItemId, resultText: "Quotation for Friday", expectedRevision: 1 }, grant.token);
    await call("clawsense_digital_correct", { eventId: imported.event.eventId, text: "Thursday", expectedRevision: 1 });
    expect((await call("clawsense_work_get", { workItemId: work.workItemId }, grant.token)).work.stale).toBe(true);
    const { session: next } = await call("clawsense_session_create", { title: "Next coffee", previousSessionId: session.sessionId, projectId: "expo" });
    expect((await call("clawsense_briefing", { sessionId: next.sessionId }, legacy.token)).previousWorkItems).toEqual([]);
    await call("clawsense_digital_delete", { eventId: imported.event.eventId });
    expect(["context_deleted", "not_found"]).toContain((await call("clawsense_work_get", { workItemId: work.workItemId }, grant.token)).error);
    expect((await call("clawsense_briefing", { sessionId: next.sessionId }, grant.token)).previousWorkItems).toEqual([]);
  });
});
