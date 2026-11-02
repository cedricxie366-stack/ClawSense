import { it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LiveExecutionQueue } from "../../src/live/execution.js";
import { LiveWorkStore } from "../../src/live/work.js";
import { ClawSenseWorkflowStore } from "../../src/workflow-store.js";
import { PERSONAS } from "../../src/live/persona.js";
import type { HarnessAdapter, LiveSessionHooks, ReplyInput } from "../../src/live/types.js";
import { unifiedContext } from "../../src/context-store.js";
import { liveAccess, liveContextHooks } from "../../src/live/context.js";
const wait = async (test: () => Promise<boolean>) => { for(let i=0;i<100;i++){ if(await test())return; await new Promise(r=>setTimeout(r,10)); } throw new Error("missing state"); };
const hooks: LiveSessionHooks = { validate: async()=>{},validateHistory:async()=>{},authorizeExternal:async()=>{},persist:async(_f,_h,write)=>write() };
const input: ReplyInput = {sessionId:"x",query:"写方案文件",persona:PERSONAS[0]!,context:{scene:[],confirmed:[],work:[]},history:[]};
it("queues external work independently, returns real results, and never executes a replay", async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-execution-"));let calls=0;
 const adapter:HarnessAdapter={routes:()=>[],cancelSupported:false,async*reply(){calls++;yield {type:"text",text:"真实草稿正文"};},async close(){}};
 const work=new LiveWorkStore(root,new ClawSenseWorkflowStore({resolveStateDir:()=>root}));
 const queue=new LiveExecutionQueue(root,work,{"live-dsh":adapter});queue.bind("phone",hooks);
 try{
  const first=await queue.submit("phone","r1",input);expect(first.state).toBe("queued");
  await wait(async()=> (await work.read("phone",first.workItemId!)).status === "completed");
  expect((await work.read("phone",first.workItemId!)).resultText).toBe("真实草稿正文");
  expect((await queue.submit("phone","r1",input)).replayed).toBe(true);expect(calls).toBe(1);
  await expect(queue.submit("phone","r1",{...input,query:"不同请求"})).rejects.toThrow("request_id_conflict");
 }finally{await queue.close();await fs.rm(root,{recursive:true,force:true});}
});
it("confirms runner cancellation and never publishes a late reply",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-cancel-"));let finish:()=>void=()=>{};
 const adapter:HarnessAdapter={routes:()=>[],cancelSupported:true,async*reply(){await new Promise<void>(r=>finish=r);yield {type:"text",text:"迟到稿"};},async cancel(){finish();return "cancelled";},async close(){finish();}};
 const work=new LiveWorkStore(root,new ClawSenseWorkflowStore({resolveStateDir:()=>root}));const queue=new LiveExecutionQueue(root,work,{"live-dsh":adapter});queue.bind("phone",hooks);
 try{const task=await queue.submit("phone","cancel",input);await wait(async()=>(await work.read("phone",task.workItemId!)).status === "running");
  expect((await queue.cancel("phone",task.workItemId!)).state).toBe("cancelled");
  await new Promise(r=>setTimeout(r,30));const result=await work.read("phone",task.workItemId!);expect(result.status).toBe("cancelled");expect(result.resultText).toBeUndefined();
  await expect(queue.cancel("other",task.workItemId!)).rejects.toThrow("task_not_found");
 }finally{await queue.close();await fs.rm(root,{recursive:true,force:true});}
});
it("requires reconciliation of dispatched work after a process restart",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-recover-"));const work=new LiveWorkStore(root,new ClawSenseWorkflowStore({resolveStateDir:()=>root}));
 let started=false;let finish:()=>void=()=>{};const adapter:HarnessAdapter={routes:()=>[],cancelSupported:false,async*reply(){started=true;await new Promise<void>(r=>finish=r);throw new Error("disconnected_execution_unconfirmed");},async close(){finish();}};
 const queue=new LiveExecutionQueue(root,work,{"live-dsh":adapter});queue.bind("phone",hooks);
 try{const task=await queue.submit("phone","restart",input);await wait(async()=>started && (await work.read("phone",task.workItemId!)).status === "running");await queue.close();await new Promise(r=>setTimeout(r,30));
  const restarted=new LiveExecutionQueue(root,work,{"live-dsh":adapter});await restarted.recover();restarted.bind("phone",hooks);
  expect((await restarted.submit("phone","restart",input)).replayed).toBe(true);
  await expect(restarted.resume("phone",task.workItemId!)).rejects.toThrow("execution_reconciliation_required");await restarted.close();
 }finally{await queue.close();await fs.rm(root,{recursive:true,force:true});}
});
it("registers execution checkpoints with the real context coordinator and purges them",async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"live-queue-context-")));const context=unifiedContext(root);
 const adapter:HarnessAdapter={routes:()=>[],cancelSupported:false,async*reply(){yield {type:"text",text:"真实结果"};},async close(){}};
 const work=new LiveWorkStore(root,new ClawSenseWorkflowStore({resolveStateDir:()=>root}));const queue=new LiveExecutionQueue(root,work,{"live-dsh":adapter},context);
 try{await context.initialize();await context.setDevicePolicy("phone",{projectIds:["live"],audience:"private",processingLocation:"selected-external",allowedRecipients:["agent:live-dsh"]},{actor:"local-owner",owner:true});
  const ref=await context.recordLiveObservation("phone","live",{text:"原话",digest:"b".repeat(64),capturedAt:Date.now(),modality:"audio"},liveAccess("phone"));const snapshot=await context.snapshot([ref],liveAccess("phone"));
  queue.bind("phone",liveContextHooks(context,"phone","live",async()=>true));const task=await queue.submit("phone","real-coordinator",{...input,context:{scene:[],confirmed:[],work:[],contextSnapshotId:snapshot.snapshotId,evidenceRefs:snapshot.dependencies}});
  await wait(async()=>(await work.read("phone",task.workItemId!)).status === "completed");
  await context.deleteEvidence(ref,"evidence-and-derived",{actor:"local-owner",owner:true});await queue.close();
  expect(await fs.readdir(path.join(root,"live","execution"))).toEqual([]);
 }finally{await queue.close();await context.release();await fs.rm(root,{recursive:true,force:true});}
});
