import type { ContextAccess } from "../context-access.js";
import { ContextError, type UnifiedContextStore, type ContextRef } from "../context-store.js";
import type { LiveContext, LiveMessage, LiveSessionHooks } from "./types.js";
import { createHash } from "node:crypto";

export function liveAccess(device: string, projectId = "live", audience: "private" | "public" = "private", external = false, agentId = "live-dsh"): Omit<ContextAccess, "digitalScopes"> {
  return { actor: external ? agentId : `device:${device}`, owner: false, trustedDeviceId: external ? undefined : device,
    processingLocation: external ? "selected-external" : "owned-devices", audience,
    contextScopes: [{ projectId, operations: ["read-metadata", "read-analysis", "read-result"] }],
    contextCapabilities: external ? ["complete-work"] : ["create-encounter", "create-work"] };
}

export function liveContextHooks(store: UnifiedContextStore, device: string, projectId: string, authorized: () => Promise<boolean>): LiveSessionHooks {
  const live = async () => { if (!(await authorized())) throw new ContextError("live_authorization_revoked", 403); };
  const snapshot = async (id: string, publicScene = false, external = false) => {
    await live();
    const value = await store.inspectSnapshot(id, { ...liveAccess(device, projectId, publicScene ? "public" : "private", external), liveCheck: authorized });
    if (value.state !== "current") throw new ContextError("live_context_changed", 409);
    return value.snapshot;
  };
  const histories = async (history: LiveMessage[]) => {
    await live(); const result = new Map<string, Awaited<ReturnType<typeof store.inspectSnapshots>>[number]>();
    for (const publicScene of [false,true]) {
      const ids = history.filter(m=>!!m.publicScene===publicScene).map(m=>m.contextSnapshotId).filter((id):id is string=>!!id);
      if (ids.length) for (const value of await store.inspectSnapshots(ids,{ ...liveAccess(device,projectId,publicScene?"public":"private"),liveCheck:authorized })) result.set(value.snapshotId,value);
    }
    return result;
  };
  return {
    async filterHistory(history) { const values = await histories(history); return history.filter(m=>!m.contextSnapshotId || values.get(m.contextSnapshotId)?.state==="current"); },
    async recordUser(query, at, publicScene) {
      await live(); const access = { ...liveAccess(device, projectId, publicScene ? "public" : "private"), liveCheck: authorized };
      const policy = await store.devicePolicy(device);
      // Public dialogue does not implicitly publish private device memory.
      if (publicScene && policy.audience !== "public") return { scene: [], confirmed: [], work: [] };
      const ref = await store.recordLiveObservation(device, projectId, { text: query, digest: createHash("sha256").update(query).digest("hex"), capturedAt: at, modality: "audio" }, access);
      const snap = await store.snapshot([ref], access); return { scene: [], confirmed: [], work: [], contextSnapshotId: snap.snapshotId, evidenceRefs: snap.dependencies };
    },
    async recordVisual(frame, description, publicScene) {
      await live();
      const access = { ...liveAccess(device, projectId, publicScene ? "public" : "private"), liveCheck: authorized };
      const sourceText = frame.timestampBasis === "server-receive" ? description + "\n图像时间取运行时收到帧的时刻；设备拍摄时间尚未校准。" : description;
      const ref = await store.recordLiveObservation(device, projectId, { text: sourceText, digest: createHash("sha256").update(Buffer.from(frame.jpeg, "base64")).digest("hex"), capturedAt: frame.capturedAt, modality: "image" }, access);
      const snap = await store.snapshot([ref], access);
      return { contextSnapshotId: snap.snapshotId, evidenceRefs: snap.dependencies, scene: { currentFrame: { description, capturedAt: frame.capturedAt, receivedAt: frame.receivedAt, timestampBasis: frame.timestampBasis ?? "device-capture", ageAtReceiveMs: frame.ageMs, source: ref, meaning: "本次问题的新帧观察，不是人物身份或已确认事实" } }, confirmed: [], work: [] };
    },
    async bindHistory(context, history, publicScene) {
      return store.consistent(async () => {
        const refs = new Map<string, ContextRef>();
        if (context.contextSnapshotId) for (const ref of (await snapshot(context.contextSnapshotId, publicScene)).dependencies) refs.set(`${ref.kind}:${ref.id}`, ref);
        const ids = history.filter(message=>!publicScene || message.publicScene).map(message=>message.contextSnapshotId).filter((id):id is string=>!!id);
        for (const value of await store.inspectSnapshots(ids,{ ...liveAccess(device,projectId,publicScene?"public":"private"),liveCheck:authorized })) {
          if (value.state!=="current" || !value.snapshot) throw new ContextError("live_context_changed",409);
          for (const ref of value.snapshot.dependencies) {
            // Historical source versions matter; old search windows do not become conversation facts.
            if (ref.kind === "physical-range" || ref.kind === "digital-range") continue;
            refs.set(`${ref.kind}:${ref.id}`, ref);
          }
        }
        const merged = await store.snapshot([...refs.values()], { ...liveAccess(device, projectId, publicScene ? "public" : "private"), liveCheck: authorized });
        return { ...context, contextSnapshotId: merged.snapshotId, evidenceRefs: merged.dependencies };
      });
    },
    async validate(context) { await live(); if (context.contextSnapshotId) await snapshot(context.contextSnapshotId); },
    async validateHistory(history) {
      const values = await histories(history); if ([...values.values()].some(value=>value.state!=="current")) throw new ContextError("live_context_changed",409);
    },
    async authorizeExternal(context: LiveContext, history: LiveMessage[], agentId = "live-dsh") {
      const policy = await store.devicePolicy(device);
      if (policy.processingLocation === "local-only" || policy.processingLocation === "owned-devices" || (policy.processingLocation === "selected-external" && !policy.allowedRecipients.includes(`agent:${agentId}`))) throw new ContextError("external_processing_not_authorized", 403);
      const refs = new Map<string, ContextRef>();
      for (const id of new Set([context.contextSnapshotId, ...history.map((m) => m.contextSnapshotId)].filter((s): s is string => !!s))) {
        let value: Awaited<ReturnType<UnifiedContextStore["inspectSnapshot"]>>;
        try { value = await store.inspectSnapshot(id, { ...liveAccess(device, projectId, "private", true, agentId), liveCheck: authorized }); }
        catch (error) {
          // A device-wide setting does not retroactively widen old source permissions.
          if (error instanceof ContextError && error.code === "context_unavailable") throw new ContextError("external_processing_not_authorized", 403);
          throw error;
        }
        if (value.state !== "current") throw new ContextError("live_context_changed", 409);
        for (const ref of value.snapshot.dependencies) refs.set(`${ref.kind}:${ref.id}`, ref);
      }
      await store.disclosure([...refs.values()], `agent:${agentId}`, "selected-external", { ...liveAccess(device, projectId, "private", true, agentId), liveCheck: authorized });
    },
    async persist(file, history, write) {
      await store.consistent(async () => {
        await live();
        const refs = new Map<string, ContextRef>();
        for (const value of (await histories(history)).values()) {
          if (value.state!=="current" || !value.snapshot) throw new ContextError("live_context_changed",409);
          for (const ref of value.snapshot.dependencies) refs.set(`${ref.kind}:${ref.id}`, ref);
        }
        await write();
        await store.registerManagedCopy(file, [...refs.values()], "checkpoint");
      });
    },
  };
}
