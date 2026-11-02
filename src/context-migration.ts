import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicContextJson, contextRoot } from "./context-coordinator.js";
import { unifiedContext, seedContextForMigration } from "./context-store.js";

const FILES = ["plugins/clawsense/state.json", "plugins/clawsense/workflows.json", "plugins/clawsense/digital/context.json", "plugins/clawsense/unified/context.json", "agent-grants.json", "prepared-local-asr.json"] as const;
const TREES = ["plugins/clawsense/media", "plugins/clawsense/digital", "plugins/clawsense/assistant-queries", "plugins/clawsense/drafts", "plugins/clawsense/memory-index"] as const;
const LOCKS = [".standalone.lock", "plugins/clawsense/workflows.lock", "plugins/clawsense/digital/.write-lock", "plugins/clawsense/unified/.write-lock"];
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export type ContextMigrationPlan = { version: 1; planId: string; workspaceId: string; sourceRootFingerprint: string; generatedAt: number; sourceFingerprints: Record<string, string>; counts: Record<string, number>; noAutomaticIdentityMerge: true; legacyResultsRequireReview: true };

async function safeFile(root: string, relative: string): Promise<Buffer | undefined> {
  const file = path.join(root, relative);
  let cursor = root;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    const info = await fs.lstat(cursor).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return undefined;
    if (info.isSymbolicLink()) throw new Error("migration_symlink_rejected");
  }
  const info = await fs.stat(file); if (!info.isFile() || info.size > 256 * 1024 * 1024) throw new Error("invalid_migration_file");
  return fs.readFile(file);
}
export async function assertOfflineContext(root: string): Promise<void> {
  for (const relative of LOCKS) if (await fs.lstat(path.join(root, relative)).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("migration_requires_stopped_writer");
  const authority = await safeFile(root, "plugins/clawsense/unified/authority.json");
  if (authority) { const pid = JSON.parse(authority.toString()).pid; if (!Number.isSafeInteger(pid)) throw new Error("invalid_context_authority"); let alive = true; try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; } if (alive) throw new Error("migration_requires_stopped_writer"); }
}
async function fingerprints(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const file of FILES) { const bytes = await safeFile(root, file); if (bytes) output[file] = digest(bytes); }
  const visit = async (relative: string): Promise<void> => {
    const info = await fs.lstat(path.join(root, relative)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error("migration_symlink_rejected");
    if (info.isDirectory()) {
      for (const child of (await fs.readdir(path.join(root, relative))).sort()) {
        if ([".write-lock", "workflows.lock", "authority.json", "write-intent.json"].includes(child)) continue;
        await visit(path.posix.join(relative, child));
      }
    } else if (info.isFile()) {
      const bytes = await safeFile(root, relative);
      if (bytes) output[`managed-file:${digest(relative)}`] = digest(bytes);
    } else throw new Error("migration_special_file_rejected");
  };
  for (const tree of TREES) await visit(tree);
  return output;
}
function same(a: Record<string, string>, b: Record<string, string>) { return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort()); }
export async function planContextMigration(input: string): Promise<ContextMigrationPlan> {
  if ((await fs.lstat(input)).isSymbolicLink()) throw new Error("migration_symlink_rejected");
  const root = contextRoot(input); await assertOfflineContext(root);
  const sourceFingerprints = await fingerprints(root);
  if (!sourceFingerprints[FILES[0]] && !sourceFingerprints[FILES[1]] && !sourceFingerprints[FILES[2]]) throw new Error("migration_no_context");
  const parse = async (file: string) => { const bytes = await safeFile(root, file); return bytes ? JSON.parse(bytes.toString("utf8")) : undefined; };
  const physical = await parse(FILES[0]), workflow = await parse(FILES[1]), digital = await parse(FILES[2]), unified = await parse(FILES[3]);
  if (physical && ![1, 2].includes(physical.version) || workflow && workflow.version !== 1 || digital && digital.version !== 1 || unified && unified.version !== 1) throw new Error("unsupported_migration_schema");
  return { version: 1, planId: `migration_${randomUUID()}`, workspaceId: unified?.workspaceId ?? `workspace_${randomUUID()}`, sourceRootFingerprint: digest(root), generatedAt: Date.now(), sourceFingerprints, counts: { physicalEvents: physical?.events?.length ?? 0, artifacts: physical?.artifacts?.length ?? 0, sessions: workflow?.sessions?.length ?? 0, digitalEvents: digital?.events?.length ?? 0, savedUnreviewedResults: workflow?.workItems?.filter((w: any) => w.status === "completed").length ?? 0 }, noAutomaticIdentityMerge: true, legacyResultsRequireReview: true };
}
async function copyTree(source: string, target: string): Promise<void> {
  const info = await fs.lstat(source).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return; if (info.isSymbolicLink()) throw new Error("migration_symlink_rejected");
  if (info.isDirectory()) { await fs.mkdir(target, { recursive: true, mode: 0o700 }); for (const child of await fs.readdir(source)) { if ([".write-lock", "workflows.lock", "authority.json", "write-intent.json"].includes(child)) continue; await copyTree(path.join(source, child), path.join(target, child)); } }
  else if (info.isFile()) { await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.copyFile(source, target); await fs.chmod(target, 0o600); }
  else throw new Error("migration_special_file_rejected");
}
async function relocateSourcePaths(target: string, originalRoot: string): Promise<void> {
  const file = path.join(target, FILES[0]), bytes = await safeFile(target, FILES[0]); if (!bytes) return;
  const state = JSON.parse(bytes.toString());
  for (const collection of [state.artifacts ?? [], state.events ?? [], state.journal ?? []]) for (const entry of collection) {
    for (const field of ["storagePath", "sourcePath"]) if (typeof entry[field] === "string") {
      const relative = path.relative(originalRoot, contextRoot(entry[field]));
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("external_media_requires_explicit_import");
      entry[field] = path.join(target, relative);
    }
  }
  await atomicContextJson(file, state);
}
export async function applyContextMigration(sourceInput: string, targetInput: string, plan: ContextMigrationPlan): Promise<Record<string, unknown>> {
  const source = contextRoot(sourceInput), target = contextRoot(targetInput);
  if (source === target || source.startsWith(target + path.sep) || target.startsWith(source + path.sep)) throw new Error("migration_requires_separate_target");
  await assertOfflineContext(source);
  if (plan.version !== 1 || plan.sourceRootFingerprint !== digest(source) || !same(plan.sourceFingerprints, await fingerprints(source))) throw new Error("migration_source_changed");
  const existing = await fs.readdir(target).catch((error) => { if (error.code === "ENOENT") return []; throw error; }); if (existing.length) throw new Error("migration_target_not_empty");
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(target, "context-migration.json");
  await atomicContextJson(receiptFile, { version: 1, planId: plan.planId, sourceRootFingerprint: digest(source), workspaceId: plan.workspaceId, state: "preparing", activated: false });
  for (const relative of FILES) { const bytes = await safeFile(source, relative); if (bytes) { await fs.mkdir(path.dirname(path.join(target, relative)), { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(target, relative), bytes, { mode: 0o600, flag: "wx" }); } }
  for (const relative of TREES) await copyTree(path.join(source, relative), path.join(target, relative));
  await relocateSourcePaths(target, source);
  if (!plan.sourceFingerprints[FILES[3]]) await seedContextForMigration(target, plan.workspaceId);
  const store = unifiedContext(target);
  await store.initialize();
  await store.setWorkspaceForMigration(plan.workspaceId);
  const workspace = await store.workspace(); await store.release();
  if (!same(plan.sourceFingerprints, await fingerprints(source))) throw new Error("migration_source_changed_during_copy");
  const receipt = { version: 1, planId: plan.planId, workspaceId: workspace.workspaceId, sourceRootFingerprint: digest(source), targetRootFingerprint: digest(target), originalSourceUnchanged: true, targetFingerprints: await fingerprints(target), state: "shadow-ready", activated: false, rawPathsRelocated: true, existingResultsReview: "pending-not-auto-accepted" };
  await atomicContextJson(receiptFile, receipt); return receipt;
}
export async function activateContextMigration(sourceInput: string, targetInput: string, plan: ContextMigrationPlan): Promise<Record<string, unknown>> {
  const source = contextRoot(sourceInput), target = contextRoot(targetInput); await assertOfflineContext(source); await assertOfflineContext(target);
  if (!same(plan.sourceFingerprints, await fingerprints(source))) throw new Error("migration_source_changed");
  const receipt = JSON.parse(await fs.readFile(path.join(target, "context-migration.json"), "utf8"));
  if (receipt.planId !== plan.planId || receipt.state !== "shadow-ready" || !same(receipt.targetFingerprints, await fingerprints(target))) throw new Error("migration_target_changed");
  await atomicContextJson(path.join(source, "context-authority-moved.json"), { version: 1, workspaceId: plan.workspaceId, targetRoot: target, movedAt: Date.now(), planId: plan.planId });
  receipt.state = "active"; receipt.activated = true; receipt.activatedAt = Date.now(); await atomicContextJson(path.join(target, "context-migration.json"), receipt); return { activated: true, workspaceId: plan.workspaceId, singleWriterRequired: true };
}
/** Forward replay of CURRENT state, never restore an old backup over post-migration writes. */
export async function rollbackContextMigration(sourceInput: string, targetInput: string): Promise<Record<string, unknown>> {
  const source = contextRoot(sourceInput), target = contextRoot(targetInput); await assertOfflineContext(source); await assertOfflineContext(target);
  const moved = JSON.parse(await fs.readFile(path.join(source, "context-authority-moved.json"), "utf8"));
  if (moved.targetRoot !== target) throw new Error("migration_authority_mismatch");
  const fence = path.join(source, ".standalone.lock"); await fs.mkdir(fence, { mode: 0o700 }); await fs.writeFile(path.join(fence, "owner.json"), JSON.stringify({ pid: process.pid, purpose: "context-rollback-replay" }), { mode: 0o600 });
  try {
  const current = await fingerprints(target);
  for (const file of FILES) { const bytes = await safeFile(target, file); if (bytes) { await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(source, file), bytes, { mode: 0o600 }); } }
  for (const relative of TREES) await copyTree(path.join(target, relative), path.join(source, relative));
  await relocateSourcePaths(source, target);
  await fs.rm(path.join(source, "context-authority-moved.json"));
  // Tombstones from the current target are replayed before the restored source can start.
  const store = unifiedContext(source); await store.resetDeletionPropagationForReplay(); await store.initialize(); await store.release();
  if (!same(current, await fingerprints(target))) throw new Error("migration_target_changed_during_rollback");
  await atomicContextJson(path.join(target, "context-authority-moved.json"), { version: 1, workspaceId: moved.workspaceId, targetRoot: source, movedAt: Date.now(), rollback: true });
  return { rolledBackByForwardReplay: true, preservedPostMigrationWrites: true, tombstonesRetained: true, workspaceId: moved.workspaceId };
  } catch (error) { await atomicContextJson(path.join(source, "context-authority-moved.json"), moved); throw error; }
  finally { await fs.rm(fence, { recursive: true, force: true }); }
}

export async function recoverContextWriter(rootInput: string): Promise<Record<string, unknown>> {
  const root = contextRoot(rootInput); const removed: string[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  const writerOwners: number[] = [];
  for (const relative of [".standalone.lock/owner.json", "plugins/clawsense/unified/.write-lock/owner.json", "plugins/clawsense/workflows.lock/owner.json"]) {
    const bytes = await safeFile(root, relative); if (!bytes) continue;
    const owner = JSON.parse(bytes.toString()); if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("recovery_owner_metadata_required");
    if (alive(owner.pid)) throw new Error("recovery_writer_still_alive"); writerOwners.push(owner.pid);
  }
  const authority = await safeFile(root, "plugins/clawsense/unified/authority.json");
  if (authority) { const owner = JSON.parse(authority.toString()); if (!Number.isSafeInteger(owner.pid) || alive(owner.pid)) throw new Error("recovery_writer_still_alive"); writerOwners.push(owner.pid); }
  for (const lock of LOCKS) {
    const exists = await fs.lstat(path.join(root, lock)).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; });
    if (!exists) continue;
    if (!writerOwners.length) throw new Error("recovery_owner_metadata_required");
    await fs.rm(path.join(root, lock), { recursive: true }); removed.push(lock);
  }
  if (authority) await fs.rm(path.join(root, "plugins/clawsense/unified/authority.json"));
  const store = unifiedContext(root); await store.initialize(); await store.release();
  return { recovered: true, reconciledCurrentSourceFiles: true, resumedPendingDeletion: true, removedLockCount: removed.length };
}
