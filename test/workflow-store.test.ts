import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClawSenseWorkflowStore, WorkflowError, type CorrectWorkflowParams } from "../src/workflow-store.js";

describe("ClawSenseWorkflowStore", () => {
  let rootDir: string;
  const createStore = () => new ClawSenseWorkflowStore({ resolveStateDir: () => rootDir });
  const statePath = () => path.join(rootDir, "plugins", "clawsense", "workflows.json");
  const people = [{ personId: "person:chen", displayName: "陈经理" }, { personId: "person:li", displayName: "李工" }];

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-workflow-test-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("gives two independent agents the same corrected facts and retains superseded evidence", async () => {
    const host = createStore();
    const session = await host.createSession({ title: "知情面谈", participants: people, projectId: "project:sales", startedAt: 1_000 }, "human:owner");
    const original = await host.correct({ sessionId: session.sessionId, kind: "commitment", text: "陈经理周五交方案", assigneeId: "person:chen", dueAt: 5_000, sourceEventIds: ["event:1"], expectedRevision: 1 }, "human:owner");
    const corrected = await host.correct({ sessionId: session.sessionId, objectId: original.objectId, kind: "commitment", text: "由李工周六交方案", assigneeId: "person:li", dueAt: 6_000, sourceEventIds: ["event:1"], expectedRevision: 2 }, "human:owner");

    const [agentA, agentB] = await Promise.all([createStore().briefing(session.sessionId), createStore().briefing(session.sessionId)]);
    expect(agentA).toEqual(agentB);
    expect(agentA.revision).toBe(3);
    expect(agentA.facts).toEqual([corrected]);
    expect(agentA.facts[0].assigneeId).toBe("person:li");
    expect(agentA.correctionHistory).toEqual([original, corrected]);
    expect(corrected.supersedes).toBe(original.correctionId);
    expect(corrected.actor).toBe("human:owner");
    expect((await createStore().listSessions({ personId: "person:li", projectId: "project:sales" }))[0].sessionId).toBe(session.sessionId);
    expect(await createStore().listSessions({ personId: "person:unknown" })).toEqual([]);
  });

  it("serializes concurrent writers across instances and rejects stale corrections without losing a write", async () => {
    const session = await createStore().createSession({ title: "同时更正" }, "human:owner");
    const params: CorrectWorkflowParams = { sessionId: session.sessionId, kind: "fact", text: "方案已确认", expectedRevision: 1 };
    const results = await Promise.allSettled([createStore().correct(params, "agent:A"), createStore().correct({ ...params, text: "方案未确认" }, "agent:B")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "revision_conflict", statusCode: 409 });
    const current = await createStore().getSession(session.sessionId);
    expect(current.revision).toBe(2);
    expect(current.correctionHistory).toHaveLength(1);
    const succeeded = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ text: string }>;
    expect(current.facts[0].text).toBe(succeeded.value.text);
  });

  it("serializes independent session creation instead of overwriting other instances", async () => {
    const sessions = await Promise.all(Array.from({ length: 8 }, (_, index) => createStore().createSession({ title: `面谈 ${index}` }, "human:owner")));
    const restored = await createStore().listSessions();
    expect(new Set(restored.map((session) => session.sessionId))).toEqual(new Set(sessions.map((session) => session.sessionId)));
  });

  it("restores a linked next meeting and completed work after recreating the store", async () => {
    const host = createStore();
    const first = await host.createSession({ title: "首次面谈", participants: people, startedAt: 1_000, endedAt: 2_000 }, "human:owner");
    const fact = await host.correct({ sessionId: first.sessionId, kind: "person", personId: "person:li", text: "李工负责方案", expectedRevision: 1 }, "human:owner");
    const work = await host.createWork({ sessionId: first.sessionId, title: "准备方案", instructions: "基于已确认的承诺起草方案", assignedAgent: "agent:B", inputRevision: fact.revision }, "human:owner");
    const done = await host.completeWork({ workItemId: work.workItemId, resultTitle: "方案草稿", resultText: "第一步核对需求。", expectedRevision: work.revision }, "agent:B");
    const second = await host.createSession({ title: "第二次面谈", previousSessionId: first.sessionId, participants: people, startedAt: 3_000 }, "human:owner");
    const restored = createStore();
    const briefing = await restored.briefing(second.sessionId);
    expect(briefing.previousSession?.facts).toEqual([fact]);
    expect(briefing.previousWorkItems).toEqual([done]);
    expect(await restored.getWork(work.workItemId)).toEqual(done);
    expect((await restored.briefing(first.sessionId)).workItems).toEqual([done]);
    expect(done).toMatchObject({ status: "completed", revision: 2, completedBy: "agent:B", stale: false });
  });

  it("restricts work completion to the assigned agent and prevents stale or repeated overwrites", async () => {
    const store = createStore();
    const session = await store.createSession({ title: "方案面谈" }, "human:owner");
    const work = await store.createWork({ sessionId: session.sessionId, title: "产出方案", instructions: "写方案", assignedAgent: "agent:B", inputRevision: 1 }, "human:owner");
    await expect(store.completeWork({ workItemId: work.workItemId, resultText: "越权结果", expectedRevision: 1 }, "agent:A")).rejects.toMatchObject({ code: "forbidden" });
    await expect(store.completeWork({ workItemId: work.workItemId, resultText: "旧 revision", expectedRevision: 2 }, "agent:B")).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await store.getWork(work.workItemId)).status).toBe("pending");
    await store.completeWork({ workItemId: work.workItemId, resultText: "方案 v1", expectedRevision: 1 }, "agent:B");
    await expect(store.completeWork({ workItemId: work.workItemId, resultText: "覆盖结果", expectedRevision: 1 }, "agent:B")).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(store.completeWork({ workItemId: work.workItemId, resultText: "覆盖结果", expectedRevision: 2 }, "agent:B")).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await store.getWork(work.workItemId)).resultText).toBe("方案 v1");
  });

  it("preserves stale results with their actual input revision and rejects new work on an old briefing", async () => {
    const store = createStore();
    const session = await store.createSession({ title: "修订后继续工作" }, "human:owner");
    const work = await store.createWork({ sessionId: session.sessionId, title: "草稿", instructions: "先写草稿", assignedAgent: "agent:A", inputRevision: 1 }, "human:owner");
    await store.correct({ sessionId: session.sessionId, kind: "fact", text: "预算更改为两万元", expectedRevision: 1 }, "human:owner");
    expect((await store.getWork(work.workItemId)).stale).toBe(true);
    await expect(store.createWork({ sessionId: session.sessionId, title: "过期输入", instructions: "继续", assignedAgent: "agent:B", inputRevision: 1 }, "human:owner")).rejects.toMatchObject({ code: "revision_conflict" });
    const completed = await store.completeWork({ workItemId: work.workItemId, resultText: "根据旧预算的草稿", expectedRevision: 1 }, "agent:A");
    expect(completed).toMatchObject({ inputRevision: 1, stale: true, status: "completed" });
    expect((await createStore().briefing(session.sessionId)).workItems[0].stale).toBe(true);
    expect((await store.getSession(session.sessionId)).revision).toBe(2);
  });

  it("updates the roster and end time only with the current session revision", async () => {
    const store = createStore();
    const session = await store.createSession({ title: "面谈", startedAt: 1_000 }, "human:owner");
    const updated = await store.updateSession(session.sessionId, { endedAt: 3_000, participants: people, title: "已结束面谈" }, 1, "human:owner");
    expect(updated).toMatchObject({ revision: 2, endedAt: 3_000, participants: people, title: "已结束面谈" });
    await expect(store.updateSession(session.sessionId, { title: "旧更新" }, 1, "human:owner")).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(store.updateSession(session.sessionId, { endedAt: 500 }, 2, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    expect((await store.getSession(session.sessionId)).revision).toBe(2);
  });

  it("rejects unknown sessions and cross-session correction references without modifying state", async () => {
    const store = createStore();
    const first = await store.createSession({ title: "一" }, "human:owner");
    const second = await store.createSession({ title: "二" }, "human:owner");
    const fact = await store.correct({ sessionId: first.sessionId, kind: "fact", text: "属于第一场", expectedRevision: 1 }, "human:owner");
    const original = await fs.readFile(statePath(), "utf8");
    await expect(store.getSession("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.briefing("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.createSession({ title: "错误链接", previousSessionId: "missing" }, "human:owner")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.correct({ sessionId: "missing", kind: "fact", text: "无面谈", expectedRevision: 1 }, "human:owner")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.correct({ sessionId: second.sessionId, objectId: fact.objectId, kind: "fact", text: "跨场更正", expectedRevision: 1 }, "human:owner")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.createWork({ sessionId: "missing", title: "无面谈", instructions: "不应写入", assignedAgent: "agent:A", inputRevision: 1 }, "human:owner")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.getWork("missing")).rejects.toMatchObject({ code: "not_found" });
    expect(await fs.readFile(statePath(), "utf8")).toBe(original);
  });

  it.each(["{bad-json", '{"version":99,"sessions":[],"corrections":[],"workItems":[]}', '{"version":1,"sessions":[],"corrections":[],"workItems":[{}]}'])("fails closed for damaged state without replacing it: %s", async (damaged) => {
    const store = createStore();
    await store.createSession({ title: "原有面谈" }, "human:owner");
    await fs.writeFile(statePath(), damaged);
    await expect(store.listSessions()).rejects.toMatchObject({ code: "store_corrupt" });
    await expect(store.createSession({ title: "不能覆盖" }, "human:owner")).rejects.toMatchObject({ code: "store_corrupt" });
    expect(await fs.readFile(statePath(), "utf8")).toBe(damaged);
    expect(await fs.readdir(path.dirname(statePath()))).toEqual(["workflows.json"]);
  });

  it("detects broken correction history and completion identity in otherwise valid JSON", async () => {
    const store = createStore();
    const session = await store.createSession({ title: "有效状态" }, "human:owner");
    const fact = await store.correct({ sessionId: session.sessionId, kind: "fact", text: "事实", expectedRevision: 1 }, "human:owner");
    const state = JSON.parse(await fs.readFile(statePath(), "utf8"));
    state.corrections[0].supersedes = "unknown";
    await fs.writeFile(statePath(), JSON.stringify(state));
    await expect(store.getSession(session.sessionId)).rejects.toMatchObject({ code: "store_corrupt" });
    delete state.corrections[0].supersedes;
    await fs.writeFile(statePath(), JSON.stringify(state));
    const work = await store.createWork({ sessionId: session.sessionId, title: "工作", instructions: "完成", assignedAgent: "agent:A", inputRevision: fact.revision }, "human:owner");
    await store.completeWork({ workItemId: work.workItemId, resultText: "结果", expectedRevision: 1 }, "agent:A");
    const tampered = JSON.parse(await fs.readFile(statePath(), "utf8"));
    tampered.workItems[0].completedBy = "agent:B";
    await fs.writeFile(statePath(), JSON.stringify(tampered));
    await expect(store.getWork(work.workItemId)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("enforces private permissions and leaves the existing evidence state untouched", async () => {
    const legacyPath = path.join(rootDir, "plugins", "clawsense", "state.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    const original = '{"existingEvidence":"untouched"}';
    await fs.writeFile(legacyPath, original);
    await createStore().createSession({ title: "独立工作流" }, "human:owner");
    expect(await fs.readFile(legacyPath, "utf8")).toBe(original);
    expect((await fs.stat(statePath())).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(statePath()))).mode & 0o777).toBe(0o700);
  });

  it("waits for an existing writer lock instead of replacing another writer's snapshot", async () => {
    const store = createStore();
    const first = await store.createSession({ title: "先前状态" }, "human:owner");
    const lockPath = path.join(path.dirname(statePath()), "workflows.lock");
    await fs.mkdir(lockPath, { mode: 0o700 });
    let settled = false;
    const pending = store.updateSession(first.sessionId, { title: "等待中的更新" }, 1, "human:owner").finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(settled).toBe(false);
    const state = JSON.parse(await fs.readFile(statePath(), "utf8"));
    state.sessions[0].revision = 2;
    state.sessions[0].title = "另一个进程已更新";
    await fs.writeFile(statePath(), JSON.stringify(state));
    await fs.rm(lockPath, { recursive: true });
    await expect(pending).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await store.getSession(first.sessionId)).title).toBe("另一个进程已更新");
  });

  it("rejects untrusted actor fields, invalid types and contradictory time ranges before writing", async () => {
    const store = createStore();
    await expect(store.createSession({ title: "伪造", actor: "agent:other" } as never, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.createSession({ title: "无身份" }, "")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.createSession({ title: "时间错误", startedAt: 2_000, endedAt: 1_000 }, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.createSession({ title: "重复人物", participants: [people[0], people[0]] }, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.createSession({ title: "未知字段", participants: [{ ...people[0], role: "invented" }] } as never, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.createSession({ title: "错误时间", startedAt: Number.NaN }, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    const session = await store.createSession({ title: "面谈" }, "human:owner");
    await expect(store.correct({ sessionId: session.sessionId, kind: "person", text: "没有明确身份", expectedRevision: 1 }, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.correct({ sessionId: session.sessionId, kind: "fact", text: "字段不适用", assigneeId: "person:li", expectedRevision: 1 }, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.correct({ sessionId: session.sessionId, kind: "fact", text: "错误版本", expectedRevision: "1" } as never, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.correct({ sessionId: session.sessionId, kind: "fact", text: "错误引用类型", sourceEventIds: null, expectedRevision: 1 } as never, "human:owner")).rejects.toMatchObject({ code: "invalid_input" });
    expect((await store.getSession(session.sessionId)).revision).toBe(1);
    expect(new WorkflowError("forbidden", "Denied")).toBeInstanceOf(Error);
  });
});
