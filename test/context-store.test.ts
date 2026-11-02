import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnifiedContextStore, unifiedContext, ContextError } from "../src/context-store.js";
import { ClawSenseStateStore } from "../src/state-store.js";
import { ClawSenseWorkflowStore } from "../src/workflow-store.js";
import { DigitalContextStore } from "../src/digital-store.js";
import { runWithAgentIdentity } from "../src/tool-context.js";
import type { ContextAccess, ContextPolicy } from "../src/context-access.js";
import { planContextMigration, applyContextMigration, activateContextMigration, rollbackContextMigration } from "../src/context-migration.js";
import { withEvidenceProcessing, contextAwareFetch } from "../src/processing-context.js";
import { ClawSenseMemoryStore } from "../src/memory-store.js";
import { resolveClawSenseConfig } from "../src/config.js";
import { atomicContextJson } from "../src/context-coordinator.js";

const owner: ContextAccess = { actor: "local-owner", owner: true, processingLocation: "local-only" };
const policy = (projectId: string): ContextPolicy => ({ projectIds: [projectId], audience: "private", processingLocation: "legacy-configured", allowedRecipients: [] });
const reader = (projectId: string): ContextAccess => ({ actor: "office", owner: false, contextScopes: [{ projectId, operations: ["read-metadata", "read-analysis", "read-result"] }], processingLocation: "selected-external" });
const roots: string[] = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} };
afterEach(async () => { for (const root of roots.splice(0)) { await unifiedContext(root).release().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-"))); roots.push(root);
  const context = unifiedContext(root); const physical = new ClawSenseStateStore({ resolveStateDir: () => root, logger });
  const workflow = new ClawSenseWorkflowStore({ resolveStateDir: () => root });
  const digital = new DigitalContextStore({ resolveStateDir: () => root, workspaceId: "legacy-clawsense" });
  await context.initialize();
  async function capture(projectId: string, id: string, capturedAt = 1000) {
    await context.setDevicePolicy(`device-${projectId}`, policy(projectId), owner);
    const file = path.join(root, "plugins", "clawsense", "media", `${id}.wav`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.from("fixture-original"));
    return physical.recordCapture({ memoryId: id, namespace: "clawsense", deviceId: `device-${projectId}`, modality: "audio", summary: `private source ${id}`, transcript: `客户希望周五收到方案 ${id}`, createdAt: capturedAt, capturedAt, sourcePath: file, fileName: `${id}.wav`, sizeBytes: 16, storageRelPath: `${id}.wav`, retentionExpiresAt: Date.now() + 3600000, analysisMode: "local-asr", analysisStatus: "succeeded" });
  }
  return { root, context, physical, workflow, digital, capture };
}

describe("G2 common identities, versions, rights and deletion", () => {
  it("reuses read-only snapshot data while rechecking each caller and keeping returned objects isolated", async () => {
    const f=await fixture();await f.capture("work","inspection-cache");
    const snap=await f.context.snapshot([{kind:"evidence",id:"inspection-cache"}],owner);
    const reads=vi.spyOn(fs,"readFile");
    try {
      const first=await f.context.inspectSnapshot(snap.snapshotId,reader("work"));
      first.snapshot.dependencies[0]!.revision=999;
      expect((await f.context.inspectSnapshot(snap.snapshotId,reader("work"))).state).toBe("current");
      const batch=await f.context.inspectSnapshots([snap.snapshotId],reader("work"));
      expect(batch[0]?.snapshot?.dependencies[0]?.revision).not.toBe(999);
      expect(reads.mock.calls.filter(([file])=>file===f.context.file)).toHaveLength(1);
      await expect(f.context.inspectSnapshot(snap.snapshotId,reader("other"))).rejects.toThrow("context_unavailable");
      await expect(f.context.inspectSnapshot(snap.snapshotId,{...reader("work"),liveCheck:async()=>false})).rejects.toThrow("context_access_revoked");
    } finally {reads.mockRestore();}
  });
  it("invalidates cached inspection after policy and source changes", async () => {
    const f=await fixture();await f.capture("work","inspection-change");
    const snap=await f.context.snapshot([{kind:"evidence",id:"inspection-change"}],owner);
    await f.context.inspectSnapshot(snap.snapshotId,reader("work"));
    await f.context.setPolicy([{kind:"evidence",id:"inspection-change"}],policy("other"),owner);
    await expect(f.context.inspectSnapshot(snap.snapshotId,reader("work"))).rejects.toThrow("context_unavailable");
    await f.context.setPolicy([{kind:"evidence",id:"inspection-change"}],policy("work"),owner);
    await f.context.inspectSnapshot(snap.snapshotId,reader("work"));
    await f.capture("work","inspection-change",2000);
    expect((await f.context.inspectSnapshot(snap.snapshotId,reader("work"))).state).toBe("stale");
  });
  it("cannot use a primed inspection cache after its evidence is deleted", async () => {
    const f=await fixture();await f.capture("work","inspection-deleted");
    const snap=await f.context.snapshot([{kind:"evidence",id:"inspection-deleted"}],owner);
    expect((await f.context.inspectSnapshot(snap.snapshotId,reader("work"))).state).toBe("current");
    await f.context.deleteEvidence({kind:"evidence",id:"inspection-deleted"},"evidence-and-derived",owner);
    await expect(f.context.inspectSnapshot(snap.snapshotId,owner)).rejects.toThrow("context_unavailable");
    expect((await f.context.inspectSnapshots([snap.snapshotId],reader("work")))[0]?.state).toBe("unavailable");
  });
  it("rejects an external catalog replacement during an inspection read", async () => {
    const f=await fixture();await f.capture("work","inspection-race");
    const snap=await f.context.snapshot([{kind:"evidence",id:"inspection-race"}],owner);
    const original=fs.readFile.bind(fs);let replaced=false;
    const reads=vi.spyOn(fs,"readFile").mockImplementation((async(...args:any[])=>{
      const value=await (original as any)(...args);
      if(args[0]===f.context.file && !replaced){replaced=true;const state=JSON.parse(String(value));state.policyOverrides["evidence:inspection-race"]=policy("other");state.policyEpoch++;await atomicContextJson(f.context.file,state);}
      return value;
    }) as any);
    try {await expect(f.context.inspectSnapshot(snap.snapshotId,reader("work"))).rejects.toThrow("context_changed_retry");}
    finally {reads.mockRestore();}
    await expect(f.context.inspectSnapshot(snap.snapshotId,reader("work"))).rejects.toThrow("context_unavailable");
  });
  it("does not rewrite the catalog after a snapshot-only change, but still reconciles new sources", async () => {
    const f = await fixture(); await f.capture("work", "catalog-original");
    const rename = vi.spyOn(fs, "rename");
    const sources = vi.spyOn(f.context as any, "source");
    try {
      await f.context.snapshot([{ kind: "evidence", id: "catalog-original" }], owner);
      expect(rename.mock.calls.filter(([, target]) => target === f.context.file)).toHaveLength(1);
      const before = await fs.stat(f.context.file);
      await f.context.workspace();
      expect((await fs.stat(f.context.file)).ino).toBe(before.ino);
      await f.context.registerManagedCopy(path.join(f.root,"live","conversations","fixture.json"),[{kind:"evidence",id:"catalog-original"}],"checkpoint");
      expect(sources).not.toHaveBeenCalled();
      await f.capture("work", "catalog-new-source");
      expect(sources).toHaveBeenCalled();
      expect((await f.context.snapshot([{ kind: "evidence", id: "catalog-new-source" }], owner)).dependencies).toContainEqual(expect.objectContaining({ id: "catalog-new-source" }));
    } finally { rename.mockRestore(); sources.mockRestore(); }
  });
  it("does not hide a replaced catalog's policy edit behind a snapshot metadata commit", async () => {
    const f=await fixture();await f.capture("work","replacement-rights");
    const original=fs.rename.bind(fs);let replace=true;
    const rename=vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{
      await original(from,to);
      if(to===f.context.file && replace){
        replace=false;
        const state=JSON.parse(await fs.readFile(f.context.file,"utf8"));
        state.policyOverrides["evidence:replacement-rights"]=policy("other");state.policyEpoch++;
        await atomicContextJson(f.context.file,state);
      }
    });
    try{
      const snap=await f.context.snapshot([{kind:"evidence",id:"replacement-rights"}],reader("work"));
      await expect(f.context.inspectSnapshot(snap.snapshotId,reader("work"))).rejects.toThrow("context_unavailable");
    }finally{rename.mockRestore();}
  });
  it("keeps same-name people and equal IDs in different sources distinct", async () => {
    const f = await fixture();
    const a = await f.context.createPerson("小林", ["work"], owner), b = await f.context.createPerson("小林", ["work"], owner);
    expect(a.personId).not.toBe(b.personId);
    await f.physical.upsertPersonAnnotation({ personRef: "same-id", displayName: "小林" });
    await f.workflow.createSession({ title: "现场", projectId: "work", participants: [{ personId: "same-id", displayName: "小林" }] }, "local-owner");
    const people = await f.context.listPeople(owner);
    const physical = people.find((p) => p.aliases.some((a) => a.source === "physical" && a.legacyId === "same-id"));
    const workflow = people.find((p) => p.aliases.some((a) => a.source === "workflow" && a.legacyId === "same-id"));
    expect(physical?.personId).not.toBe(workflow?.personId);
    const linked = await f.context.linkPerson({ personId: physical!.personId, otherPersonId: workflow!.personId, expectedRevision: physical!.revision }, owner);
    expect(linked.authority).toBe("owner-confirmation");
    expect(await f.context.legacyPersonIds(physical!.personId, "workflow", owner)).toEqual(["same-id"]);
  });
  it("records reversible identity links and invalidates only related snapshots", async () => {
    const f = await fixture(); const a = await f.context.createPerson("甲", ["work"], owner), b = await f.context.createPerson("乙", ["work"], owner), unrelated = await f.context.createPerson("丙", ["other"], owner);
    const snapshot = await f.context.snapshot([{ kind: "person", id: a.personId }], owner);
    await f.context.linkPerson({ personId: unrelated.personId, platform: "test", accountRef: "account", externalId: "different", expectedRevision: 1 }, owner);
    expect((await f.context.inspectSnapshot(snapshot.snapshotId, owner)).state).toBe("current");
    const link = await f.context.linkPerson({ personId: a.personId, otherPersonId: b.personId, expectedRevision: 1 }, owner);
    expect((await f.context.inspectSnapshot(snapshot.snapshotId, owner)).state).toBe("stale");
    const currentA = (await f.context.listPeople(owner)).find((p) => p.personId === a.personId)!;
    await f.context.linkPerson({ personId: a.personId, withdrawLinkId: link.linkId, expectedRevision: currentA.revision }, owner);
    const links = (await f.context.listPeople(owner)).find((p) => p.personId === a.personId)!.links;
    expect(links.map((l) => l.state)).toEqual(["confirmed", "withdrawn"]);
  });
  it("scopes repeated speaker labels to their exact event and device", async () => {
    const f = await fixture(); const first = await f.capture("work", "audio-a"), second = await f.capture("work", "audio-b", 2000);
    const a = await f.context.createPerson("甲", ["work"], owner), b = await f.context.createPerson("乙", ["work"], owner);
    await f.context.linkSpeaker({ personId: a.personId, eventId: first.event.eventId, label: "SPEAKER_00", expectedRevision: 1 }, owner);
    await f.context.linkSpeaker({ personId: b.personId, eventId: second.event.eventId, label: "SPEAKER_00", expectedRevision: 1 }, owner);
    const events = await f.physical.listEvents(); expect(events.find((e) => e.eventId === "audio-a")!.peopleRefs).toContain(a.personId);
    expect(events.find((e) => e.eventId === "audio-b")!.peopleRefs).not.toContain(a.personId);
    expect(events.find((e) => e.eventId === "audio-b")!.peopleRefs).toContain(b.personId);
    const snapshot = await f.context.snapshot([{ kind: "analysis", id: "audio-a" }], owner);
    expect((await f.context.inspectSnapshot(snapshot.snapshotId, owner)).state).toBe("current");
  });
  it("preserves ASR history and detects source changes without a global dirty flag", async () => {
    const f = await fixture(); const a = await f.capture("work", "versioned"), unrelated = await f.capture("other", "unrelated");
    const snapshot = await f.context.snapshot([{ kind: "analysis", id: a.event.eventId }], owner);
    await f.physical.backfillCaptureAnalysis({ artifactId: unrelated.artifact.artifactId, transcript: "另一个人的无关变更", summary: "不同项目", analysisMode: "local-asr", analysisStatus: "succeeded" });
    expect((await f.context.inspectSnapshot(snapshot.snapshotId, owner)).state).toBe("current");
    await f.physical.backfillCaptureAnalysis({ artifactId: a.artifact.artifactId, transcript: "客户希望周四收到方案", summary: "周四", analysisMode: "local-asr", analysisStatus: "succeeded" });
    expect((await f.context.inspectSnapshot(snapshot.snapshotId, owner)).state).toBe("stale");
    const history = await f.context.analysisHistory(a.event.eventId, owner);
    expect(history.length).toBe(2); expect(history[0].body?.transcript).toContain("周五"); expect(history[1].body?.transcript).toContain("周四");
  });
  it("does not retroactively apply a future-capture policy", async () => {
    const f = await fixture(); await f.capture("work", "already-stored");
    const snapshot = await f.context.snapshot([{ kind: "analysis", id: "already-stored" }], owner);
    await f.context.setDevicePolicy("device-work", policy("private"), owner);
    expect((await f.context.exportContext([{ kind: "analysis", id: "already-stored" }], reader("work"))).entries.length).toBe(1);
    expect((await f.context.inspectSnapshot(snapshot.snapshotId, owner)).state).toBe("current");
  });
  it("filters private project metadata, sources and counts, and denies raw access separately", async () => {
    const f = await fixture(); const work = await f.capture("work", "allowed"), secret = await f.capture("private", "secret");
    const access = reader("work");
    const events = await runWithAgentIdentity("office", () => f.physical.listEvents(), { owner: false, contextScopes: access.contextScopes });
    expect(events.map((e) => e.eventId)).toEqual(["allowed"]);
    expect((await f.context.listRecords(access)).some((r) => r.ref.id === secret.event.eventId)).toBe(false);
    await expect(f.context.assertAccess({ kind: "artifact", id: work.artifact.artifactId }, "read-raw", access)).rejects.toBeInstanceOf(ContextError);
    await expect(f.context.exportContext([{ kind: "analysis", id: "secret" }], access)).rejects.toBeInstanceOf(ContextError);
    const before = await f.context.workspaceView(access); await f.capture("private", "new-hidden", 3000); expect(await f.context.workspaceView(access)).toEqual(before);
  });
  it("rejects read-only agent mutations and agent claims of owner confirmation", async () => {
    const f = await fixture(); const session = await f.workflow.createSession({ title: "会议", projectId: "work", startedAt: 1000 }, "local-owner");
    await expect(runWithAgentIdentity("office", () => f.workflow.correct({ sessionId: session.sessionId, kind: "fact", text: "模型提出的说法", expectedRevision: 1 }, "office"), { owner: false, contextScopes: reader("work").contextScopes })).rejects.toBeInstanceOf(ContextError);
    await expect(runWithAgentIdentity("office", () => f.workflow.correct({ sessionId: session.sessionId, kind: "fact", text: "虚构用户已确认", assertionState: "confirmed", expectedRevision: 1 }, "office"), { owner: false, contextScopes: reader("work").contextScopes, contextCapabilities: ["record-user-correction"] })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("keeps an owner-confirmed promise current while a different agent only proposes a change", async () => {
    const f = await fixture(); const session = await f.workflow.createSession({ title: "客户", projectId: "work" }, "local-owner");
    const confirmed = await runWithAgentIdentity("local-owner", () => f.workflow.correct({ sessionId: session.sessionId, kind: "commitment", text: "小林周四收到方案", action: "收到方案", deadlineLiteral: "周四", expectedRevision: 1 }, "local-owner"), { owner: true });
    await runWithAgentIdentity("office", () => f.workflow.correct({ sessionId: session.sessionId, objectId: confirmed.objectId, kind: "commitment", text: "模型认为改周五", expectedRevision: 2 }, "office"), { owner: false, contextScopes: reader("work").contextScopes, contextCapabilities: ["record-user-correction"] });
    expect((await f.workflow.getSession(session.sessionId)).facts[0].text).toBe("小林周四收到方案");
  });
  it("keeps saved results pending and only reuses an explicitly accepted replacement", async () => {
    const f = await fixture(); const session = await f.workflow.createSession({ title: "客户", projectId: "work" }, "local-owner");
    const one = await f.workflow.createWork({ sessionId: session.sessionId, title: "旧稿", instructions: "测试", assignedAgent: "writer", inputRevision: 1 }, "local-owner");
    await f.workflow.completeWork({ workItemId: one.workItemId, resultText: "不正确的测试稿", expectedRevision: 1 }, "writer");
    const first = (await f.context.workReview(one.workItemId, owner))!;
    expect(first.state).toBe("pending"); expect(await f.context.selectedResults(owner)).toEqual([]);
    await expect(f.context.reviewResult({ resultId: first.resultId, state: "accepted", expectedRevision: 1 }, reader("work"))).rejects.toMatchObject({ code: "owner_confirmation_required" });
    await f.context.reviewResult({ resultId: first.resultId, state: "accepted", expectedRevision: 1 }, owner);
    const two = await f.workflow.createWork({ sessionId: session.sessionId, title: "新稿", instructions: "测试", assignedAgent: "writer", inputRevision: 1 }, "local-owner");
    await f.workflow.completeWork({ workItemId: two.workItemId, resultText: "正确的测试稿", expectedRevision: 1 }, "writer");
    const second = (await f.context.workReview(two.workItemId, owner))!;
    await f.context.reviewResult({ resultId: second.resultId, state: "accepted", supersedesResultId: first.resultId, expectedRevision: 1 }, owner);
    expect((await f.context.selectedResults(owner)).map((r) => r.resultId)).toEqual([second.resultId]);
    expect((await f.workflow.getWork(one.workItemId)).resultText).toBe("不正确的测试稿");
  });
  it("binds owner review of a legacy result to its current evidence versions", async () => {
    const f = await fixture(); const source = await f.capture("work", "legacy-result-source");
    const session = await f.workflow.createSession({ title: "客户", projectId: "work", startedAt: 900, endedAt: 1100 }, "local-owner");
    const work = await f.workflow.createWork({ sessionId: session.sessionId, title: "迁移旧稿", instructions: "测试", assignedAgent: "writer", inputRevision: 1 }, "local-owner");
    await f.workflow.completeWork({ workItemId: work.workItemId, resultText: "周五收到方案", expectedRevision: 1 }, "writer");
    const review = (await f.context.workReview(work.workItemId, owner))!;
    const accepted = await f.context.reviewResult({ resultId: review.resultId, state: "accepted", expectedRevision: 1 }, owner);
    expect(accepted.reviewedContextSnapshotId).toBeTruthy();
    expect((await f.context.selectedResults(owner)).length).toBe(1);
    await f.physical.backfillCaptureAnalysis({ artifactId: source.artifact.artifactId, transcript: "周四收到方案", analysisStatus: "succeeded" });
    expect(await f.context.selectedResults(owner)).toEqual([]);
  });
  it("keeps deletion pending when an offline reader cannot purge an existing managed index", async () => {
    const f = await fixture(); const source = await f.capture("work", "indexed-source");
    const index = path.join(f.root, "plugins/clawsense/memory-index");
    await fs.mkdir(index, { recursive: true }); await fs.writeFile(path.join(index, "fixture-index"), "derived indexed-source");
    const deletion = await f.context.deleteEvidence({ kind: "evidence", id: source.event.eventId }, "evidence-and-derived", owner);
    expect(deletion.propagation).toBe("pending");
    expect(await f.physical.listEvents()).toEqual([]);
    await f.context.release(); await f.context.initialize();
    expect((await f.context.deletionStatus(owner))[0].propagation).toBe("pending");
    f.context.registerIndexPurger(async () => { await fs.rm(index, { recursive: true }); });
    await f.context.resumeDeletions();
    expect((await f.context.deletionStatus(owner))[0].propagation).toBe("managed-copies-purged");
  });
  it("purges actual Lance cache files and their old versions with retrieval disabled", async () => {
    const f = await fixture(); const source = await f.capture("work", "lance-private"), retained = await f.capture("work", "lance-retained", 2000);
    const index = path.join(f.root, "plugins/clawsense/memory-index"), lance = await import("@lancedb/lancedb");
    const db = await lance.connect(index), table = await db.createTable("memories", [{ id: source.event.eventId, summary: "PRIVATE_INDEX_CONTENT", vector: [0, 1] }, { id: retained.event.eventId, summary: "retained", vector: [1, 0] }]);
    await table.add([{ id: "historical", summary: "PRIVATE_OLDER_VERSION", vector: [0, 1] }]);
    expect((await table.listVersions()).length).toBeGreaterThan(1); table.close(); db.close();
    const memory = new ClawSenseMemoryStore({ cfg: resolveClawSenseConfig({ retrievalEmbeddingBackend: "none" }), runtimeConfig: {}, logger, stateStore: f.physical, resolveStateDir: () => f.root });
    f.context.registerIndexPurger((ids) => memory.purgeIndexEntries(ids));
    const deleted = await f.context.deleteEvidence({ kind: "evidence", id: source.event.eventId }, "evidence-and-derived", owner);
    expect(deleted.propagation).toBe("managed-copies-purged");
    await expect(fs.access(index)).rejects.toThrow();
    expect((await f.physical.listEvents()).map((event) => event.eventId)).toEqual([retained.event.eventId]);
    expect(await fs.readFile(retained.artifact.storagePath, "utf8")).toBe("fixture-original");
  });
  it("marks digital raw-only removal unavailable while retaining selected analysis", async () => {
    const f = await fixture(); await f.digital.setDeviceGrant("primary", true, ["*"]);
    const payload = { clientEventId: "image-original", projectId: "work", sourceType: "shared_image" as const, capturedAt: 1000, title: "分享图片", text: "选定的图片说明", mime: "image/png", imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=" };
    const event = await f.digital.import(payload, "primary");
    await f.context.deleteEvidence({ kind: "digital-evidence", id: event.eventId }, "raw-only", owner);
    expect((await f.context.listRecords(owner)).find((r) => r.ref.kind === "digital-artifact" && r.ref.id === event.eventId)?.rawState).toBe("deleted");
    expect((await f.digital.query({}, { ...owner, scopes: [] }))[0].text).toBe(payload.text);
    await expect(f.digital.readArtifact(event.eventId, { ...owner, scopes: [] })).rejects.toMatchObject({ code: "raw_context_unavailable" });
    expect((await f.digital.import(payload, "primary")).eventId).toBe(event.eventId);
    await expect(fs.access(path.join(f.root, "plugins/clawsense/digital", `${event.eventId}.media`))).rejects.toThrow();
  });
  it("does not present a legacy import time as its analysis production time", async () => {
    const f = await fixture(); await f.capture("work", "legacy-time"); await f.context.release();
    const file = path.join(f.root, "plugins/clawsense/state.json"), state = JSON.parse(await fs.readFile(file, "utf8"));
    delete state.events[0].analysisProducedAt; await fs.writeFile(file, JSON.stringify(state));
    await fs.rm(f.context.file); await f.context.initialize();
    const [history] = await f.context.analysisHistory("legacy-time", owner);
    expect(history.productionTimeBasis).toBe("legacy-production-time-unknown");
    expect(history.producedAt).toBeUndefined(); expect(history.recordedAt).toBeGreaterThan(1000);
  });
  it("blocks private inputs in public output and rechecks revoked access", async () => {
    const f = await fixture(); await f.capture("work", "private-speaker");
    await expect(f.context.exportContext([{ kind: "analysis", id: "private-speaker" }], { ...owner, audience: "public" })).rejects.toBeInstanceOf(ContextError);
    await expect(f.context.exportContext([{ kind: "analysis", id: "private-speaker" }], { ...reader("work"), liveCheck: async () => false })).rejects.toMatchObject({ code: "context_access_revoked" });
  });
  it("denies any network inference for local-only evidence before the transport runs", async () => {
    const f = await fixture(); await f.capture("work", "local-only");
    await f.context.setPolicy([{ kind: "evidence", id: "local-only" }], { ...policy("work"), processingLocation: "local-only" }, owner);
    await expect(withEvidenceProcessing(f.root, [{ kind: "analysis", id: "local-only" }], () => contextAwareFetch("http://127.0.0.1:1/v1/chat/completions", { method: "POST", body: "must-not-leave" }))).rejects.toMatchObject({ code: "external_processing_not_authorized" });
    expect((await f.context.disclosureReceipts(owner)).length).toBe(0);
  });
  it("raw-only deletion keeps text, removes the original and refuses old queued recapture", async () => {
    const f = await fixture(); const source = await f.capture("work", "raw-removal");
    const result = await f.context.deleteEvidence({ kind: "evidence", id: source.event.eventId }, "raw-only", owner);
    expect(result.propagation).toBe("managed-copies-purged");
    expect((await f.physical.listEvents())[0].transcript).toContain("周五");
    await expect(fs.access(source.artifact.storagePath)).rejects.toThrow();
    await expect(f.context.assertCaptureNotDeleted("device-work", 1000, "audio")).rejects.toMatchObject({ statusCode: 410 });
  });
  it("denies raw reads at expiry even when the catalog files have not changed", async () => {
    const f = await fixture(); const source = await f.capture("work", "expiry");
    await f.context.assertAccess({ kind: "artifact", id: source.artifact.artifactId }, "read-raw", owner);
    const clock = vi.spyOn(Date, "now").mockReturnValue(source.artifact.retentionExpiresAt + 1);
    try {
      await expect(f.context.assertAccess({ kind: "artifact", id: source.artifact.artifactId }, "read-raw", owner)).rejects.toMatchObject({ code: "raw_context_unavailable" });
      expect((await f.context.listRecords(owner)).find((r) => r.ref.kind === "artifact")?.rawState).toBe("expired");
      expect((await f.physical.listEvents())[0].transcript).toContain("周五");
    } finally { clock.mockRestore(); }
  });
  it("full deletion blocks sources and copied results first, then purges managed content", async () => {
    const f = await fixture(); const source = await f.capture("work", "full-removal");
    const session = await f.workflow.createSession({ title: "客户", projectId: "work", startedAt: 900, endedAt: 1100 }, "local-owner");
    const snapshot = await f.context.snapshot(await f.context.refsForEncounter(session.sessionId, owner), owner);
    const work = await f.workflow.createWork({ sessionId: session.sessionId, title: "成果", instructions: "原话全文 full-removal", assignedAgent: "writer", inputRevision: 1, unifiedContextSnapshotId: snapshot.snapshotId }, "local-owner");
    await f.workflow.completeWork({ workItemId: work.workItemId, resultText: "原话全文 full-removal", expectedRevision: 1 }, "writer");
    const draft = path.join(f.root, "plugins/clawsense/drafts/copied.md"); await fs.mkdir(path.dirname(draft), { recursive: true }); await fs.writeFile(draft, "原话全文 full-removal"); await f.context.registerManagedCopy(draft, snapshot.dependencies, "draft");
    let fail = true; f.context.registerIndexPurger(async () => { if (fail) throw new Error("index-down"); });
    const deletion = await f.context.deleteEvidence({ kind: "evidence", id: source.event.eventId }, "evidence-and-derived", owner);
    expect(deletion.propagation).toBe("pending"); expect(await f.physical.listEvents()).toEqual([]);
    await expect(f.context.inspectSnapshot(snapshot.snapshotId, owner)).rejects.toBeInstanceOf(ContextError);
    await expect(f.workflow.getWork(work.workItemId)).rejects.toThrow();
    fail = false; await f.context.resumeDeletions();
    expect((await f.context.deletionStatus(owner))[0].propagation).toBe("managed-copies-purged");
    const state = await fs.readFile(path.join(f.root, "plugins/clawsense/state.json"), "utf8");
    expect(state).not.toContain("客户希望周五收到方案");
    await expect(fs.access(draft)).rejects.toThrow();
  });
  it("rejects late capture commits and never restores a deleted analysis body", async () => {
    const f = await fixture(); const source = await f.capture("work", "late-commit");
    await f.context.deleteEvidence({ kind: "evidence", id: source.event.eventId }, "evidence-and-derived", owner);
    const backfill = await f.physical.backfillCaptureAnalysis({ artifactId: source.artifact.artifactId, transcript: "LATE_DELETED_BODY", summary: "LATE_DELETED_BODY", analysisStatus: "succeeded" });
    expect(backfill.updated).toBe(false); expect(backfill.event).toBeNull();
    await expect(f.physical.recordCapture({ memoryId: "retry-other-id", namespace: "clawsense", deviceId: "device-work", modality: "audio", summary: "LATE_DELETED_BODY", capturedAt: 1000, createdAt: 1000, sourcePath: source.artifact.storagePath, fileName: "retry.wav", sizeBytes: 16, storageRelPath: "retry.wav", retentionExpiresAt: Date.now() + 60000, analysisMode: "local-asr" })).rejects.toMatchObject({ code: "capture_deleted" });
    expect(await fs.readFile(path.join(f.root, "plugins/clawsense/state.json"), "utf8")).not.toContain("LATE_DELETED_BODY");
  });
  it("cleans a queued duplicate whose delayed image analysis finishes after deletion", async () => {
    const f = await fixture(); const capturedAt = Date.now() - 1000;
    await f.context.setDevicePolicy("image-device", policy("work"), owner);
    const body = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrZkAAAAASUVORK5CYII=", "base64");
    const file = path.join(f.root, "plugins/clawsense/media/original.png"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body);
    const source = await f.physical.recordCapture({ memoryId: "old-image", namespace: "clawsense", deviceId: "image-device", modality: "image", summary: "原分析", capturedAt, createdAt: capturedAt, sourcePath: file, fileName: "original.png", sizeBytes: body.length, storageRelPath: "original.png", retentionExpiresAt: Date.now() + 60000, analysisMode: "multimodal-preview", analysisStatus: "succeeded" });
    const memory = new ClawSenseMemoryStore({ cfg: resolveClawSenseConfig({ retrievalEmbeddingBackend: "none", hostModelImageMode: "multimodal" }), runtimeConfig: {}, logger, stateStore: f.physical, resolveStateDir: () => f.root });
    let entered!: () => void, release!: () => void; const armed = new Promise<void>((resolve) => { entered = resolve; }), waiting = new Promise<void>((resolve) => { release = resolve; });
    const ingest = memory.ingest({ device: { deviceId: "image-device", name: "fixture", platform: "fixture", deviceSecretHash: "fixture", createdAt: capturedAt }, modality: "image", body, fileName: "retry.png", mime: "image/png", capturedAt, describeImage: async () => { entered(); await waiting; return { text: "LATE_IMAGE_BODY" }; }, transcribeAudio: async () => ({ text: "unused" }) });
    const observed = ingest.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    await armed; await f.context.deleteEvidence({ kind: "evidence", id: source.event.eventId }, "evidence-and-derived", owner); release();
    expect(await observed).toMatchObject({ ok: false, error: { code: "capture_deleted" } });
    expect(await f.physical.listEvents()).toEqual([]);
    expect(await fs.readFile(path.join(f.root, "plugins/clawsense/state.json"), "utf8")).not.toContain("LATE_IMAGE_BODY");
    const remaining = await fs.readdir(path.join(f.root, "plugins/clawsense/media"), { recursive: true });
    expect(remaining.filter((entry) => entry.endsWith(".png"))).toEqual([]);
  });
  it("refuses changed migration plans and keeps originals byte-identical for a shadow", async () => {
    const f = await fixture(); await f.capture("work", "migration"); await f.context.release();
    const before = await fs.readFile(path.join(f.root, "plugins/clawsense/state.json")); const plan = await planContextMigration(f.root);
    const target = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-target-"))); roots.push(target);
    const receipt = await applyContextMigration(f.root, target, plan); expect(receipt.originalSourceUnchanged).toBe(true);
    expect(await fs.readFile(path.join(f.root, "plugins/clawsense/state.json"))).toEqual(before);
    const changed = await f.capture("work", "changed", 2000); await f.context.release();
    const rejected = path.join(target, "must-not-create"); await expect(applyContextMigration(f.root, rejected, plan)).rejects.toThrow("migration_source_changed"); await expect(fs.access(rejected)).rejects.toThrow();
    expect(changed.event.eventId).toBe("changed");
  });
  it("forward-replays post-migration writes and tombstones on rollback", async () => {
    const f = await fixture(); const source = await f.capture("work", "before-switch"); await f.context.release(); const plan = await planContextMigration(f.root);
    const target = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-current-"))); roots.push(target);
    await applyContextMigration(f.root, target, plan); await activateContextMigration(f.root, target, plan);
    const next = unifiedContext(target); await next.initialize();
    const wf = new ClawSenseWorkflowStore({ resolveStateDir: () => target }); await wf.createSession({ title: "切换后的新面谈", projectId: "work" }, "local-owner");
    await next.deleteEvidence({ kind: "evidence", id: source.event.eventId }, "evidence-and-derived", owner); await next.release();
    const rolled = await rollbackContextMigration(f.root, target); expect(rolled.preservedPostMigrationWrites).toBe(true);
    const restored = new ClawSenseWorkflowStore({ resolveStateDir: () => f.root }); expect((await restored.listSessions()).some((s) => s.title === "切换后的新面谈")).toBe(true);
    await expect(f.context.assertCaptureNotDeleted("device-work", 1000, "audio")).rejects.toMatchObject({ statusCode: 410 });
  });
  it("rejects a migration plan if original media changes without a metadata write", async () => {
    const f = await fixture(); const capture = await f.capture("work", "media-hash"); await f.context.release();
    const plan = await planContextMigration(f.root);
    await fs.writeFile(capture.artifact.storagePath, "changed raw bytes");
    const target = path.join(f.root + "-target"); roots.push(target);
    await expect(applyContextMigration(f.root, target, plan)).rejects.toThrow("migration_source_changed");
    await expect(fs.access(target)).rejects.toThrow();
    expect(Object.keys(plan.sourceFingerprints).some((key) => key.includes("media-hash"))).toBe(false);
  });
});
