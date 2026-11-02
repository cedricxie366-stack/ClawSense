import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { ClawSenseWorkflowStore } from "../workflow-store.js";
import { contextFor } from "../context-store.js";
import { runWithAgentIdentity } from "../tool-context.js";
import { liveAccess } from "./context.js";
import type { LiveContext } from "./types.js";
export type LiveWork = {
  workItemId: string;
  revision: number;
  deviceId: string;
  status: "queued" | "running" | "waiting_user" | "completed" | "failed" | "cancelling" | "cancelled" | "interrupted" | "execution_unconfirmed";
  assignedAgent?: string;
  requestId?: string;
  resultId?: string;
  reviewRevision?: number;
  resultText?: string;
  failure?: string;
  files?: Array<{ name: string; content: string }>;
  stale?: boolean;
  reviewStatus?: "unreviewed" | "pending" | "accepted" | "rejected";
  updatedAt: number;
};
/** Links actual Live execution to the existing shared work objects. Failure never completes a work item. */
export class LiveWorkStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private root: string,
    private workflow: ClawSenseWorkflowStore,
    private workspace?: string | Record<string, string>,
    private projectId = "live",
  ) {}
  async begin(deviceId: string, query: string, context?: LiveContext, assignedAgent = "live-dsh"): Promise<LiveWork> {
    return runWithAgentIdentity(`device:${deviceId}`, () => this.beginInside(deviceId, query, context, assignedAgent), liveAccess(deviceId, this.projectId));
  }
  private async beginInside(deviceId: string, query: string, context?: LiveContext, assignedAgent = "live-dsh"): Promise<LiveWork> {
    const latest = context?.encounterId ? await this.workflow.getSession(context.encounterId) : (await this.workflow.listSessions()).find(
      (s) => s.deviceId === deviceId && !s.endedAt,
    );
    const session =
      latest ??
      (await this.workflow.createSession(
        { title: "Live 办公交流", deviceId, projectId: this.projectId },
        `device:${deviceId}`,
      ));
    const work = await this.workflow.createWork(
      {
        sessionId: session.sessionId,
        title: query.slice(0, 120),
        instructions: query,
        assignedAgent,
        inputRevision: session.revision,
        unifiedContextSnapshotId: context?.contextSnapshotId,
      },
      `device:${deviceId}`,
    );
    const record: LiveWork = {
      workItemId: work.workItemId,
      revision: work.revision,
      deviceId,
      assignedAgent,
      status: "running",
      updatedAt: Date.now(),
    };
    await this.save(record);
    return record;
  }
  async complete(record: LiveWork, resultText: string) {
    return runWithAgentIdentity(record.assignedAgent ?? "live-dsh", () => this.completeInside(record, resultText), liveAccess(record.deviceId, this.projectId, "private", true, record.assignedAgent));
  }
  private async completeInside(record: LiveWork, resultText: string) {
    const current = await this.workflow.getWork(record.workItemId);
    const context = contextFor(this.root);
    if (context && !(await context.isResultCurrent(record.workItemId, liveAccess(record.deviceId, this.projectId, "private", true, record.assignedAgent)))) throw new Error("live_context_changed");
    if (current.status === "completed")
      resultText = current.resultText ?? resultText;
    const files: Array<{ name: string; content: string }> = [];
    const workspace = typeof this.workspace === "string" ? this.workspace : this.workspace?.[record.assignedAgent ?? "live-dsh"];
    if (workspace) {
      const directory = await fs.realpath(workspace);
      const names = [
        ...new Set(
          resultText.match(
            /[A-Za-z0-9_\-\u4e00-\u9fff]+\.(?:md|txt|csv|json)\b/g,
          ) ?? [],
        ),
      ].slice(0, 4);
      for (const name of names) {
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          const file = path.join(directory, name);
          handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > 1024 * 1024 ||
            stat.mtimeMs < record.updatedAt - 1000
          )
            continue;
          const buffer = Buffer.alloc(1024 * 1024 + 1);
          const read = await handle.read(buffer, 0, buffer.length, 0);
          const final = await handle.stat();
          if (read.bytesRead > 1024 * 1024 || final.size !== stat.size || final.mtimeMs !== stat.mtimeMs || read.bytesRead !== final.size) continue;
          const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, read.bytesRead));
          files.push({ name, content });
        } catch {} finally { await handle?.close(); }
      }
    }
    const requestedFiles = [...new Set(current.instructions.match(/[A-Za-z0-9_\-\u4e00-\u9fff]+\.(?:md|txt|csv|json)\b/g) ?? [])];
    if (requestedFiles.some(name => !files.some(file => file.name === name))) throw new Error("harness_artifact_unverified");
    if (current.status === "pending")
      await this.workflow.completeWork(
        {
          workItemId: record.workItemId,
          expectedRevision: current.revision,
          resultText:
            resultText +
            files.map((f) => "\n\n## " + f.name + "\n" + f.content).join(""),
          resultTitle: "Live 宿主结果",
        },
        record.assignedAgent ?? "live-dsh",
      );
    await this.save({
      ...record,
      revision: (await this.workflow.getWork(record.workItemId)).revision,
      status: "completed",
      resultText,
      files,
      updatedAt: Date.now(),
    });
  }
  async fail(record: LiveWork, error: string) {
    await this.save({
      ...record,
      status: /unconfirmed|timeout|disconnected|aborted/.test(error)
        ? "execution_unconfirmed"
        : "failed",
      failure: error,
      updatedAt: Date.now(),
    });
  }
  async transition(record: LiveWork, status: LiveWork["status"], failure?: string) { await this.save({ ...record, status, failure, updatedAt: Date.now() }); }
  async read(deviceId: string, workItemId: string): Promise<LiveWork> {
    if (!/^work_[a-z0-9-]+$/i.test(workItemId))
      throw new Error("invalid_work_id");
    const record: LiveWork = JSON.parse(
      await fs.readFile(
        path.join(this.root, "live", "work", workItemId + ".json"),
        "utf8",
      ),
    );
    if (record.deviceId !== deviceId) throw new Error("forbidden");
    const context = contextFor(this.root), access = liveAccess(deviceId, this.projectId);
    const work = await runWithAgentIdentity(access.actor, () => this.workflow.getWork(record.workItemId), access);
    record.stale = work.stale || !!context && !(await context.isResultCurrent(record.workItemId, access));
    const review = await context?.workReview(record.workItemId, access);
    record.reviewStatus = review?.state ?? "unreviewed";
    record.resultId = review?.resultId; record.reviewRevision = review?.revision;
    return record;
  }
  async list(deviceId: string) {
    const directory = path.join(this.root, "live", "work"),
      names = await fs.readdir(directory).catch(() => []);
    const records = await Promise.all(
      names
        .filter((n) => /^work_[a-z0-9-]+\.json$/i.test(n))
        .map((n) => this.read(deviceId, n.slice(0, -5)).catch(() => null)),
    );
    return records
      .filter((r): r is LiveWork => !!r)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20);
  }
  private async save(record: LiveWork) {
    const pending = this.writes.then(async () => {
      const context = contextFor(this.root);
      const write = async () => {
      let refs;
      let safeRecord = record;
      if (context) {
        const access = liveAccess(record.deviceId, this.projectId);
        const work = await this.workflow.getWork(record.workItemId);
        if (work.unifiedContextSnapshotId) {
          const snapshot = await context.inspectSnapshot(work.unifiedContextSnapshotId, access);
          refs = snapshot.snapshot.dependencies;
          if (snapshot.state !== "current") safeRecord = { ...record, resultText: undefined, files: undefined, stale: true, failure: "live_context_changed" };
        } else refs = [{ kind: "work" as const, id: record.workItemId }];
      }
      const directory = path.join(this.root, "live", "work");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, record.workItemId + ".json"),
        tmp = file + "." + randomUUID();
      try {
        await fs.writeFile(tmp, JSON.stringify(safeRecord), {
          mode: 0o600,
          flag: "wx",
        });
        await fs.rename(tmp, file);
      } finally {
        await fs.rm(tmp, { force: true });
      }
      if (context) {
        await context.registerManagedCopy(file, refs!, "checkpoint");
      }
      };
      if (context) await context.consistent(write); else await write();
    });
    this.writes = pending.catch(() => {});
    return pending;
  }
}
