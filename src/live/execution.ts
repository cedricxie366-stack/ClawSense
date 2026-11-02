import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicContextJson } from "../context-coordinator.js";
import type { UnifiedContextStore } from "../context-store.js";
import type { HarnessAdapter, LiveSessionHooks, ReplyInput } from "./types.js";
import type { LiveWork, LiveWorkStore } from "./work.js";
import { LiveRequestStore } from "./requests.js";
import { liveAccess } from "./context.js";
type Job = { key: string; requestId: string; deviceId: string; agentId: string; input: ReplyInput; work: LiveWork; state: LiveWork["status"]; dispatched: boolean; at: number };

/** Serializes external work independently of microphone/playback and the socket lifetime. */
export class LiveExecutionQueue {
  private jobs = new Map<string, Job>();
  private bindings = new Map<string, LiveSessionHooks>();
  private controls = new Map<string, AbortController>();
  private draining = false;
  private stopping = false;
  private running?: Promise<void>;
  private mutations: Promise<unknown> = Promise.resolve();
  private receipts: LiveRequestStore;
  constructor(private root: string, private work: LiveWorkStore, private adapters: Record<string, HarnessAdapter>, private context?: UnifiedContextStore, private notify: (device: string, workItemId: string) => void = () => {}, private projectId = "live") { this.root = path.resolve(root); this.receipts = new LiveRequestStore(this.root); this.context?.registerManagedMediaRoot(path.join(this.root, "live", "execution")); }
  private key(device: string, request: string) { return createHash("sha256").update(JSON.stringify([device, request])).digest("hex"); }
  private file(job: Job) { return path.join(this.root, "live", "execution", job.key + ".json"); }
  async recover() {
    const directory = path.join(this.root, "live", "execution");
    for (const name of await fs.readdir(directory).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const job: Job = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (job.key !== this.key(job.deviceId, job.requestId)) throw new Error("invalid_execution_checkpoint");
      if (["queued", "running", "cancelling"].includes(job.state)) { job.state = "interrupted"; await this.work.transition(job.work, "interrupted", job.dispatched ? "runner_interrupted_execution_unconfirmed" : "queued_requires_resume"); await this.save(job); }
      this.jobs.set(job.key, job);
    }
  }
  bind(device: string, hooks: LiveSessionHooks) { this.bindings.set(device, hooks); }
  async submit(device: string, requestId: string, input: ReplyInput, agentId = "live-dsh") {
    const adapter = this.adapters[agentId], hooks = this.bindings.get(device);
    if (!adapter || !hooks) throw new Error("configure_harness_model");
    if (input.persona.publicScene) throw new Error("public_harness_not_available");
    await hooks.validate(input.context); await hooks.authorizeExternal(input.context, input.history, agentId);
    const claimed = await this.receipts.claim(device, requestId, JSON.stringify({ query: input.query, agentId }));
    if (!claimed.fresh) return { replayed: true, state: claimed.state, workItemId: this.jobs.get(this.key(device, requestId))?.work.workItemId };
    if ([...this.jobs.values()].filter(j => ["queued", "running", "cancelling"].includes(j.state)).length >= 20) { await this.receipts.update(device, requestId, "queue_full"); throw new Error("task_queue_full"); }
    const record = await this.work.begin(device, input.query, input.context, agentId);
    record.requestId = requestId;
    const job: Job = { key: this.key(device, requestId), requestId, deviceId: device, agentId, input: structuredClone(input), work: record, state: "queued", dispatched: false, at: Date.now() };
    job.input.context.work = { briefing: input.context.work, assignedWorkItemId: record.workItemId, authenticatedAgent: agentId };
    job.input.sessionId = job.key;
    job.input.audio = undefined; // Only the authorized transcript is needed by these work adapters.
    this.jobs.set(job.key, job); await this.work.transition(record, "queued"); await this.save(job);
    await this.receipts.update(device, requestId, "queued", record.workItemId);
    this.kick(); return { replayed: false, state: "queued", workItemId: record.workItemId };
  }
  private async save(job: Job) {
    const pending = this.mutations.then(async () => {
      const write = async () => {
        if (this.context && job.input.context.contextSnapshotId) {
          const current = await this.context.inspectSnapshot(job.input.context.contextSnapshotId, liveAccess(job.deviceId, this.projectId)).then(s => s.state === "current", () => false);
          if (!current) job.input = { ...job.input, query: "来源或权限已变化", history: [], audio: undefined, context: { scene: [], confirmed: [], work: [], contextSnapshotId: job.input.context.contextSnapshotId, evidenceRefs: [] } };
        }
        await atomicContextJson(this.file(job), job); if (this.context) await this.context.registerManagedCopy(this.file(job), job.input.context.evidenceRefs ?? [], "checkpoint");
      };
      if (this.context) await this.context.consistent(write); else await write();
    });
    this.mutations = pending.catch(() => {}); await pending;
    this.notify(job.deviceId, job.work.workItemId);
  }
  private kick() { if (!this.running && !this.stopping) this.running = this.drain().catch(() => {}).finally(() => { this.running = undefined; }); }
  private async drain() {
    if (this.draining || this.stopping) return;
    this.draining = true;
    try {
      for (;;) {
        const job = [...this.jobs.values()].find(j => j.state === "queued"); if (!job || this.stopping) break;
        const hooks = this.bindings.get(job.deviceId), adapter = this.adapters[job.agentId];
        const controller = new AbortController(); this.controls.set(job.key, controller);
        try {
          if (!hooks || !adapter) throw new Error("task_requires_reconnect");
          await hooks.validate(job.input.context); await hooks.authorizeExternal(job.input.context, job.input.history, job.agentId);
          if (job.state !== "queued") continue;
          job.state = "running"; await this.save(job); await this.work.transition(job.work, "running"); await this.receipts.update(job.deviceId, job.requestId, "running", job.work.workItemId);
          if (this.stopping || controller.signal.aborted || job.state !== "running") { if (job.state === "running") { job.state = "interrupted"; await this.work.transition(job.work,"interrupted","queued_requires_resume"); } continue; }
          job.dispatched = true; await this.save(job);
          if (this.stopping || controller.signal.aborted || job.state !== "running") { if (job.state === "running") { job.dispatched = false; job.state = "interrupted"; await this.work.transition(job.work,"interrupted","queued_requires_resume"); } continue; }
          let answer = "";
          for await (const chunk of adapter.reply(job.input, controller.signal)) { await hooks.validate(job.input.context); if (chunk.type === "text") answer += chunk.text; }
          if (controller.signal.aborted || job.state !== "running") continue;
          await hooks.validate(job.input.context);
          if (!answer.trim()) throw new Error("harness_no_answer");
          await this.work.complete(job.work, answer); job.state = "completed";
        } catch (error) {
          if (!["cancelled", "cancelling"].includes(job.state)) { const code = (error as Error).message; job.state = /unconfirmed|disconnected|timeout/.test(code) ? "execution_unconfirmed" : "failed"; await this.work.fail(job.work, code); }
        } finally { this.controls.delete(job.key); await this.save(job); await this.receipts.update(job.deviceId, job.requestId, job.state, job.work.workItemId); }
      }
    } finally { this.draining = false; }
  }
  async cancel(device: string, workItemId: string) {
    const job = [...this.jobs.values()].find(j => j.deviceId === device && j.work.workItemId === workItemId); if (!job) throw new Error("task_not_found");
    if (job.state === "queued" || (job.state === "interrupted" && !job.dispatched)) { job.state = "cancelled"; await this.work.transition(job.work, "cancelled"); }
    else if (job.state === "running") {
      job.state = "cancelling"; await this.save(job); await this.work.transition(job.work, "cancelling");
      const result = await this.adapters[job.agentId]?.cancel?.(job.key) ?? "unconfirmed";
      this.controls.get(job.key)?.abort(); job.state = result === "cancelled" ? "cancelled" : "execution_unconfirmed";
      await this.work.transition(job.work, job.state, "runner_stopped_external_effects_unknown");
    }
    await this.save(job); await this.receipts.update(device, job.requestId, job.state, workItemId); return { state: job.state, meaning: "执行端停止不撤销已发生的外部动作" };
  }
  async cancelLatest(device: string) {
    const latest = [...this.jobs.values()].filter(job => job.deviceId === device && ["queued", "running"].includes(job.state)).sort((a,b) => b.at-a.at)[0];
    if (!latest) return { state: "no_active_task" };
    return this.cancel(device, latest.work.workItemId);
  }
  async resume(device: string, workItemId: string) {
    const job = [...this.jobs.values()].find(j => j.deviceId === device && j.work.workItemId === workItemId);
    if (!job || job.state !== "interrupted" || job.dispatched) throw new Error("execution_reconciliation_required");
    const hooks = this.bindings.get(device); if (!hooks) throw new Error("task_requires_reconnect"); await hooks.validate(job.input.context);
    job.state = "queued"; await this.save(job); await this.work.transition(job.work, "queued"); this.kick(); return { state: "queued" };
  }
  async close() { this.stopping = true; await Promise.allSettled(Object.values(this.adapters).map(a => a.close())); await this.running; await this.mutations; }
}
