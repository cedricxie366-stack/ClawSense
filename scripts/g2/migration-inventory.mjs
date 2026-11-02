#!/usr/bin/env node
// G2 preparation only. Reads an offline copy; never imports a runtime or applies
// a migration. Reports structural metadata, never source text or credentials.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
const array = (value, field) => { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error("invalid_source_array:" + field); return value; };
const nameKey = (value) => typeof value === "string" ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US") : "";

export function inventoryContext({ workspaceId, physical, workflow, digital }) {
  if (!id(workspaceId)) throw new Error("workspace_id_required");
  for (const [name, state, versions] of [["physical", physical, [1, 2]], ["workflow", workflow, [1]], ["digital", digital, [1]]]) {
    if (state === undefined) continue;
    if (!state || typeof state !== "object" || Array.isArray(state) || !versions.includes(state.version)) throw new Error("unsupported_source_schema:" + name);
  }
  const people = array(physical?.people, "physical.people"), speakers = array(physical?.speakers, "physical.speakers");
  const events = array(physical?.events, "physical.events"), artifacts = array(physical?.artifacts, "physical.artifacts");
  const sessions = array(workflow?.sessions, "workflow.sessions"), works = array(workflow?.workItems, "workflow.workItems");
  const digitalPeople = array(digital?.people, "digital.people"), digitalEvents = array(digital?.events, "digital.events"), snapshots = array(digital?.snapshots, "digital.snapshots");
  const aliases = new Map(), names = new Map();
  function candidate(source, legacyId, displayName) {
    if (!id(legacyId)) throw new Error("invalid_legacy_person_id:" + source);
    const key = source + ":" + legacyId;
    const proposedPersonId = "person_" + digest(JSON.stringify([workspaceId, source, legacyId])).slice(0, 32);
    if (!aliases.has(key)) aliases.set(key, { source, legacyKeyFingerprint: digest(key), proposedPersonId, references: 0, labelKeys: new Set() });
    const item = aliases.get(key); item.references++;
    const label = nameKey(displayName);
    if (label) {
      item.labelKeys.add(label);
      if (!names.has(label)) names.set(label, new Set());
      names.get(label).add(proposedPersonId);
    }
  }
  for (const person of people) candidate("physical-person", person.personRef, person.displayName);
  for (const session of sessions) for (const person of array(session.participants, "workflow.participants")) candidate("workflow-person", person.personId, person.displayName);
  for (const person of digitalPeople) candidate("digital-person", person.personId, person.displayName);
  const identityCandidates = [...aliases.values()].map(({ labelKeys, ...item }) => ({ ...item, ambiguousLegacyLabel: labelKeys.size > 1, crossSourceLink: "requires-explicit-confirmation" })).sort((a, b) => a.proposedPersonId.localeCompare(b.proposedPersonId));
  const sameNameGroups = [...names.values()].filter((set) => set.size > 1).map((set) => [...set].sort()).sort((a, b) => a.join().localeCompare(b.join()));
  const deletedDigital = new Set(digitalEvents.filter((event) => event.deletedAt !== undefined).map((event) => event.eventId));
  const deletedSnapshots = new Set(snapshots.filter((snapshot) => array(snapshot.eventVersions, "digital.eventVersions").some((version) => deletedDigital.has(version.eventId))).map((snapshot) => snapshot.snapshotId));
  const completed = works.filter((work) => work.status === "completed");
  const blockerCounts = {
    sameNameGroups: sameNameGroups.length,
    ambiguousLegacyPersonIds: identityCandidates.filter((item) => item.ambiguousLegacyLabel).length,
    speakerLinksRequiringScopeReview: speakers.length,
    physicalEventsWithoutAnalysisRevision: events.filter((event) => !Number.isInteger(event.analysisRevision) || event.analysisRevision < 1).length,
    physicalEventsWithoutProject: events.filter((event) => !Array.isArray(event.projectRefs) || !event.projectRefs.length).length,
    physicalEventsWithMultipleProjects: events.filter((event) => Array.isArray(event.projectRefs) && event.projectRefs.length > 1).length,
    missingReferencedArtifacts: events.filter((event) => !artifacts.some((artifact) => artifact.artifactId === event.artifactId)).length,
    legacyDeletedArtifactsWithoutReason: artifacts.filter((artifact) => artifact.deletedAt !== undefined && !artifact.deletionReason).length,
    completedResultsWithoutReview: completed.filter((work) => !work.resultReview).length,
    workItemsWithoutUnifiedSnapshot: works.filter((work) => !work.unifiedContextSnapshotId).length,
    completedResultsDependingOnDeletedDigital: completed.filter((work) => deletedSnapshots.has(work.contextSnapshotId)).length,
    legacyCaptureEventsNeedReconstruction: physical?.version === 1 && physical.events === undefined ? 1 : 0,
  };
  return {
    kind: "g2-preparation-inventory", schemaVersion: 1, workspaceId, dryRun: true, migrationApplied: false,
    counts: { identityCandidates: identityCandidates.length, physicalEvents: events.length, physicalArtifacts: artifacts.length, speakerAnnotations: speakers.length, sessions: sessions.length, workItems: works.length, digitalEvents: digitalEvents.length },
    identityCandidates, sameNameGroups, automaticIdentityMerges: [], blockerCounts,
    limits: ["Structural inventory only, not a complete schema validator or an executable migration plan.", "Equal IDs across legacy stores and equal names do not confirm the same person.", "No source text, labels, account identifiers, tokens, media paths or media bytes are included.", "No writer, grant, default read path or runtime configuration is changed."],
  };
}

async function readCopyFile(root, parts) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("offline_copy_symlink_rejected"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  const handle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("invalid_offline_copy_file");
    const bytes = await handle.readFile();
    if (bytes.length > 64 * 1024 * 1024) throw new Error("offline_copy_file_too_large");
    let data; try { data = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("invalid_offline_copy_json"); }
    return { data, sha256: digest(bytes) };
  } finally { await handle.close(); }
}

export async function inventoryOfflineCopy(inputDir, workspaceId) {
  if (!inputDir || !(await fs.lstat(inputDir)).isDirectory() || (await fs.lstat(inputDir)).isSymbolicLink()) throw new Error("offline_copy_directory_required");
  const root = await fs.realpath(inputDir);
  for (const parts of [[".standalone.lock"], ["plugins", "clawsense", "workflows.lock"], ["plugins", "clawsense", "digital", ".write-lock"]]) {
    try { await fs.lstat(path.join(root, ...parts)); throw new Error("active_or_uncleared_writer_lock_rejected"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const physical = await readCopyFile(root, ["plugins", "clawsense", "state.json"]);
  const workflow = await readCopyFile(root, ["plugins", "clawsense", "workflows.json"]);
  const digital = await readCopyFile(root, ["plugins", "clawsense", "digital", "context.json"]);
  if (!physical && !workflow && !digital) throw new Error("offline_copy_has_no_context_files");
  const result = inventoryContext({ workspaceId, physical: physical?.data, workflow: workflow?.data, digital: digital?.data });
  return { ...result, sourceFingerprints: { ...(physical ? { physical: physical.sha256 } : {}), ...(workflow ? { workflow: workflow.sha256 } : {}), ...(digital ? { digital: digital.sha256 } : {}) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { "input-dir": { type: "string" }, "workspace-id": { type: "string" } } });
    console.log(JSON.stringify(await inventoryOfflineCopy(values["input-dir"], values["workspace-id"]), null, 2));
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]+(?::[a-z._-]+)?$/.test(error.message) ? error.message : "inventory_failed";
    process.stderr.write(code + "\n"); process.exitCode = 1;
  }
}
