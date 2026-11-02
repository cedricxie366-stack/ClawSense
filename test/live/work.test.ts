import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LiveWorkStore } from "../../src/live/work.js";
import { ClawSenseWorkflowStore } from "../../src/workflow-store.js";
it("persists real work results and attaches only current workspace text artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "live-work-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const workflow = new ClawSenseWorkflowStore({
      resolveStateDir: () => root,
    });
    const live = new LiveWorkStore(root, workflow, workspace);
    const record = await live.begin("device", "生成方案文件");
    expect((await workflow.getWork(record.workItemId)).status).toBe("pending");
    await fs.writeFile(path.join(workspace, "result.md"), "小陈周四收到方案。");
    await fs.symlink("/etc/hosts", path.join(workspace, "secret.txt"));
    await live.complete(record, "结果：result.md，secret.txt。");
    const saved = await live.read("device", record.workItemId);
    expect(saved.revision).toBe((await workflow.getWork(record.workItemId)).revision);
    expect(saved.files).toEqual([
      { name: "result.md", content: "小陈周四收到方案。" },
    ]);
    expect((await workflow.getWork(record.workItemId)).status).toBe(
      "completed",
    );
    await expect(live.read("other-device", record.workItemId)).rejects.toThrow(
      "forbidden",
    );
    expect(await live.list("other-device")).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("timeout leaves the shared work pending and marks execution unconfirmed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "live-work-"));
  try {
    const workflow = new ClawSenseWorkflowStore({
      resolveStateDir: () => root,
    });
    const live = new LiveWorkStore(root, workflow);
    const record = await live.begin("device", "执行任务");
    await live.fail(record, "harness_timeout_execution_unconfirmed");
    expect((await live.read("device", record.workItemId)).status).toBe(
      "execution_unconfirmed",
    );
    expect((await workflow.getWork(record.workItemId)).status).toBe("pending");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("a claimed filename cannot complete an actual file request without a readable artifact",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-unverified-file-"));
 try{const workflow=new ClawSenseWorkflowStore({resolveStateDir:()=>root});const live=new LiveWorkStore(root,workflow,root);
  const record=await live.begin("phone","生成 missing.md 文件");
  await expect(live.complete(record,"已生成 missing.md")).rejects.toThrow("harness_artifact_unverified");
  expect((await workflow.getWork(record.workItemId)).status).toBe("pending");
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
