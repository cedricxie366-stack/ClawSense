import type { UnifiedContextStore, ContextRef } from "./context-store.js";
import type { DigitalAccess } from "./digital-access.js";
import type { ContextAccess } from "./context-access.js";

export function primaryContextAccess(deviceId: string, digital: DigitalAccess): Omit<ContextAccess, "digitalScopes"> {
  return { actor: `device:${deviceId}`, owner: false, trustedDeviceId: deviceId, processingLocation: "owned-devices", audience: "private", contextScopes: digital.scopes.map(s => ({ projectId: s.projectId, operations: ["read-metadata", "read-analysis", "read-result"] })), contextCapabilities: ["create-encounter", "create-work"] };
}
/** A limited authorized checkpoint for offline reading. It is not a phone authority or a sync replica. */
export async function phoneMemoryCheckpoint(store: UnifiedContextStore, access: ContextAccess) {
  return store.consistent(async () => {
    const selected = new Set((await store.selectedResults(access)).map(r => r.resultId));
    const priority = (kind: string) => kind === "result" ? 0 : kind === "assertion" ? 1 : kind === "digital-evidence" ? 2 : 3;
    const records = (await store.listRecords(access)).filter(r => ["analysis", "digital-evidence", "assertion", "result", "live-observation"].includes(r.ref.kind) && (r.ref.kind !== "result" || selected.has(r.ref.id))).sort((a,b) => priority(a.ref.kind)-priority(b.ref.kind) || (b.capturedAt ?? b.receivedAt ?? 0) - (a.capturedAt ?? a.receivedAt ?? 0)).slice(0, 100);
    const refs: ContextRef[] = records.map(r => r.ref);
    const exported = await store.exportContext(refs, access);
    const entries = (exported.entries as any[]).flatMap(entry => {
      const body = entry.body;
      if (!body || (entry.ref.kind === "result" && !selected.has(entry.ref.id))) return [];
      const text = body.text ?? body.transcript ?? body.summary ?? body.resultText ?? "";
      return [{ ref: entry.ref, source: entry.source, text: String(text).slice(0, 10000), title: body.title ?? body.resultTitle, kind: body.kind, state: entry.ref.kind === "result" ? "accepted-current" : body.assertionState ?? "unconfirmed", objectId: body.objectId, sessionId: body.sessionId, personId: body.personId, projectId: body.projectId, projectIds: entry.source.projectIds }];
    });
    return { workspaceId: exported.workspaceId, snapshotId: exported.snapshot.snapshotId, checkedAt: Date.now(), expiresAt: Date.now() + 24 * 3600000, limit: 100, entries, offlineMeaning: "上次验证时获准的副本；离线无法获知后来撤销，24小时到期后隐藏，重连须重新验证" };
  });
}
