import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inventoryContext, inventoryOfflineCopy } from "./migration-inventory.mjs";

function fixture() {
  return {
    workspaceId: "workspace-synthetic-g2",
    physical: { version: 2, people: [{ personRef: "same-id", displayName: "小林" }], speakers: [{ speakerRef: "SPEAKER_00" }], events: [{ eventId: "audio-1", artifactId: "raw-1", projectRefs: [] }], artifacts: [{ artifactId: "raw-1", deletedAt: 123 }] },
    workflow: { version: 1, sessions: [{ sessionId: "session-1", participants: [{ personId: "same-id", displayName: "小林" }] }], workItems: [{ status: "completed", resultText: "PRIVATE_DRAFT", contextSnapshotId: "snapshot-1" }] },
    digital: { version: 1, people: [{ personId: "same-id", displayName: "小林" }], events: [{ eventId: "digital-1", deletedAt: 234 }], snapshots: [{ snapshotId: "snapshot-1", eventVersions: [{ eventId: "digital-1", revision: 1 }] }] },
  };
}

test("never merges equal names or equal IDs across legacy stores", () => {
  const result = inventoryContext(fixture());
  assert.equal(result.identityCandidates.length, 3);
  assert.equal(new Set(result.identityCandidates.map((item) => item.proposedPersonId)).size, 3);
  assert.deepEqual(result.automaticIdentityMerges, []); assert.equal(result.sameNameGroups.length, 1);
});
test("keeps mapping IDs deterministic and bound to a unique workspace", () => {
  const input = fixture(); assert.deepEqual(inventoryContext(input), inventoryContext(input));
  const other = inventoryContext({ ...input, workspaceId: "workspace-other" });
  assert.notEqual(other.identityCandidates[0].proposedPersonId, inventoryContext(input).identityCandidates[0].proposedPersonId);
});
test("flags missing analysis versions, project scopes, unreviewed results and deleted dependencies", () => {
  const result = inventoryContext(fixture());
  assert.equal(result.blockerCounts.physicalEventsWithoutAnalysisRevision, 1);
  assert.equal(result.blockerCounts.physicalEventsWithoutProject, 1);
  assert.equal(result.blockerCounts.completedResultsWithoutReview, 1);
  assert.equal(result.blockerCounts.completedResultsDependingOnDeletedDigital, 1);
  assert.equal(result.blockerCounts.legacyDeletedArtifactsWithoutReason, 1);
});
test("never exports private source content, account identifiers or credentials", () => {
  const input = fixture();
  input.physical.setupTokens = [{ token: "PRIVATE_TOKEN" }]; input.physical.events[0].transcript = "PRIVATE_TRANSCRIPT"; input.physical.artifacts[0].storagePath = "/PRIVATE_PATH";
  input.digital.identities = [{ externalId: "PRIVATE_ACCOUNT" }];
  input.physical.people[0].personRef = "PRIVATE_PERSON_ID";
  const json = JSON.stringify(inventoryContext(input));
  for (const text of ["小林", "PRIVATE_DRAFT", "PRIVATE_TOKEN", "PRIVATE_TRANSCRIPT", "PRIVATE_PATH", "PRIVATE_ACCOUNT", "PRIVATE_PERSON_ID"]) assert.ok(!json.includes(text));
});
test("preserves ambiguous legacy labels and unsupported schemas for explicit review", () => {
  const input = fixture(); input.workflow.sessions.push({ participants: [{ personId: "same-id", displayName: "小王" }] });
  assert.equal(inventoryContext(input).blockerCounts.ambiguousLegacyPersonIds, 1);
  assert.equal(inventoryContext({ workspaceId: input.workspaceId, physical: { version: 1, journal: [] } }).blockerCounts.legacyCaptureEventsNeedReconstruction, 1);
  assert.throws(() => inventoryContext({ ...input, digital: { version: 99 } }), /unsupported_source_schema/);
  assert.throws(() => inventoryContext({ ...input, physical: {} }), /unsupported_source_schema/);
});
test("offline inventory leaves every source byte unchanged and rejects active locks / symlinks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-copy-"));
  try {
    const folder = path.join(directory, "plugins/clawsense"); await fs.mkdir(path.join(folder, "digital"), { recursive: true });
    const input = fixture(); const files = [["state.json", input.physical], ["workflows.json", input.workflow], ["digital/context.json", input.digital]];
    for (const [file, value] of files) await fs.writeFile(path.join(folder, file), JSON.stringify(value));
    const before = await Promise.all(files.map(([file]) => fs.readFile(path.join(folder, file))));
    const result = await inventoryOfflineCopy(directory, input.workspaceId);
    assert.equal(result.migrationApplied, false); assert.equal(Object.keys(result.sourceFingerprints).length, 3);
    const after = await Promise.all(files.map(([file]) => fs.readFile(path.join(folder, file))));
    after.forEach((bytes, index) => assert.deepEqual(bytes, before[index]));
    await fs.mkdir(path.join(directory, ".standalone.lock"));
    await assert.rejects(inventoryOfflineCopy(directory, input.workspaceId), /writer_lock_rejected/);
    await fs.rmdir(path.join(directory, ".standalone.lock"));
    await fs.rename(path.join(folder, "state.json"), path.join(directory, "original.json"));
    await fs.symlink(path.join(directory, "original.json"), path.join(folder, "state.json"));
    await assert.rejects(inventoryOfflineCopy(directory, input.workspaceId), /symlink_rejected/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("CLI emits only a read-only report and has no apply mode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-g2-cli-"));
  try {
    const folder = path.join(directory, "plugins/clawsense"); await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, "state.json"), input = JSON.stringify(fixture().physical);
    await fs.writeFile(file, input);
    const binary = fileURLToPath(new URL("./migration-inventory.mjs", import.meta.url));
    const args = [binary, "--input-dir", directory, "--workspace-id", "workspace-synthetic-g2"];
    const { stdout } = await promisify(execFile)(process.execPath, args);
    assert.equal(JSON.parse(stdout).migrationApplied, false);
    await assert.rejects(promisify(execFile)(process.execPath, [...args, "--apply"]), (error) => error.code === 1 && /inventory_failed/.test(error.stderr));
    assert.equal(await fs.readFile(file, "utf8"), input);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
