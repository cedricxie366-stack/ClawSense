import { it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { unifiedContext } from "../../src/context-store.js";
import { ClawSenseStateStore } from "../../src/state-store.js";
import { liveAccess, liveContextHooks } from "../../src/live/context.js";
import { canReadContext, type ContextAccess } from "../../src/context-access.js";
import { LiveRequestStore } from "../../src/live/requests.js";
import { LiveSession } from "../../src/live/session.js";
import { PERSONAS } from "../../src/live/persona.js";
import type { LiveProvider } from "../../src/live/types.js";
import { readLiveHistory } from "../../src/live/history.js";
const owner: ContextAccess = { actor: "local-owner", owner: true, processingLocation: "local-only" };
it("does not widen old owned-device sources when an external execution route is later enabled", async () => {
 const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-source-external-"))); const store = unifiedContext(root);
 try {
  await store.initialize();
  await store.setDevicePolicy("phone", { projectIds: ["live"], audience: "private", processingLocation: "owned-devices", allowedRecipients: [] }, owner);
  const ref = await store.recordLiveObservation("phone", "live", { text: "只在自有设备处理的校准资料", digest: "b".repeat(64), capturedAt: Date.now(), modality: "audio" }, liveAccess("phone"));
  const snapshot = await store.snapshot([ref], liveAccess("phone"));
  await store.setDevicePolicy("phone", { projectIds: ["live"], audience: "private", processingLocation: "selected-external", allowedRecipients: ["agent:live-dsh"] }, owner);
  const hooks = liveContextHooks(store, "phone", "live", async () => true);
  await expect(hooks.authorizeExternal({ scene: [], confirmed: [], work: [], contextSnapshotId: snapshot.snapshotId }, [])).rejects.toMatchObject({ code: "external_processing_not_authorized" });
  expect(await store.disclosureReceipts(owner)).toHaveLength(0);
 } finally { await store.release(); await fs.rm(root, { recursive: true, force: true }); }
});
it("batches recent-history checks without returning revoked source text", async () => {
 const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-history-batch-"))); const store = unifiedContext(root);
 try {
  await store.initialize();
  await store.setDevicePolicy("phone", { projectIds: ["live"], audience: "private", processingLocation: "owned-devices", allowedRecipients: [] }, owner);
  const ref = await store.recordLiveObservation("phone", "live", { text: "校准资料", digest: "f".repeat(64), capturedAt: Date.now(), modality: "audio" }, liveAccess("phone"));
  const snapshot = await store.snapshot([ref], liveAccess("phone"));
  const file = path.join(root, "live/conversations/phone.json"); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ history: Array.from({ length: 200 }, () => ({ role: "user", content: "校准资料", at: Date.now(), contextSnapshotId: snapshot.snapshotId })) }));
  const batch = vi.spyOn(store, "inspectSnapshots");
  expect((await readLiveHistory(root, "phone", store)).history).toHaveLength(200);
  expect(batch).toHaveBeenCalledTimes(1);
  await store.setPolicy([ref], { projectIds: ["other"], audience: "private", processingLocation: "owned-devices", allowedRecipients: [] }, owner);
  expect((await readLiveHistory(root, "phone", store)).history).toEqual([]);
 } finally { await store.release(); await fs.rm(root, { recursive: true, force: true }); }
});
it("recipient whitelist admits an authenticated device but not a forged device prefix or public speech", () => {
 const policy = { projectIds: ["live"], audience: "private" as const, processingLocation: "selected-external" as const, allowedRecipients: ["agent:live-dsh"] };
 expect(canReadContext(liveAccess("phone"), policy, "read-analysis", "audio")).toBe(true);
 expect(canReadContext({ ...liveAccess("phone"), trustedDeviceId: undefined }, policy, "read-analysis", "audio")).toBe(false);
 expect(canReadContext(liveAccess("phone", "other"), policy, "read-analysis", "audio")).toBe(false);
 expect(canReadContext(liveAccess("phone", "live", "public"), policy, "read-analysis", "audio")).toBe(false);
});
it("deletion removes Live checkpoints, stops history reuse and cannot be undone by late persistence", async () => {
 const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-g2-")));
 const store = unifiedContext(root);
 try {
  await store.initialize();
  await store.setDevicePolicy("phone", { projectIds: ["live"], audience: "private", processingLocation: "owned-devices", allowedRecipients: [] }, owner);
  const physical = new ClawSenseStateStore({ resolveStateDir: () => root, logger: { info(){},warn(){},error(){},debug(){} } });
  const source = path.join(root, "plugins/clawsense/media/test.wav"); await fs.mkdir(path.dirname(source), {recursive:true}); await fs.writeFile(source,"test");
  await physical.recordCapture({ memoryId:"live-source", namespace:"clawsense", deviceId:"phone", modality:"audio", summary:"测试原话", transcript:"三万元", createdAt:1000, capturedAt:1000, sourcePath:source, fileName:"test.wav", sizeBytes:4, storageRelPath:"test.wav", retentionExpiresAt: Date.now()+3600000, analysisMode:"local-asr", analysisStatus:"succeeded" });
  const snapshot = await store.snapshot([{kind:"analysis",id:"live-source"}],liveAccess("phone"));
  const hooks = liveContextHooks(store,"phone","live",async()=>true);
  const history = [{role:"assistant" as const,content:"三万元",contextSnapshotId:snapshot.snapshotId}];
  const file = path.join(root,"live/conversations/phone.json");
  const write = async()=>{ await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,JSON.stringify(history)); };
  await hooks.persist(file,history,write);
  const empty = await store.snapshot([], liveAccess("phone"));
  const joined = await hooks.bindHistory!({scene:[],confirmed:[],work:[],contextSnapshotId:empty.snapshotId},history,false);
  expect(joined.evidenceRefs?.some(ref=>ref.id === "live-source")).toBe(true);
  await expect(hooks.authorizeExternal({scene:[],confirmed:[],work:[],contextSnapshotId:snapshot.snapshotId},history)).rejects.toMatchObject({code:"external_processing_not_authorized"});
  await store.deleteEvidence({kind:"evidence",id:"live-source"},"evidence-and-derived",owner);
  await expect(fs.readFile(file)).rejects.toMatchObject({code:"ENOENT"});
  await expect(hooks.validateHistory(history)).rejects.toThrow();
  await expect(hooks.validate(joined)).rejects.toThrow();
  await expect(hooks.persist(file,history,write)).rejects.toThrow();
  await expect(fs.readFile(file)).rejects.toMatchObject({code:"ENOENT"});
 } finally { await store.release(); await fs.rm(root,{recursive:true,force:true}); }
});
it("durable request receipts prevent execution on reconnect/restart and reject changed content", async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-requests-"));
 try {
  const first=new LiveRequestStore(root);
  const claimed=await Promise.all([first.claim("phone","r1","写文件"),first.claim("phone","r1","写文件")]);
  expect(claimed.filter(r=>r.fresh)).toHaveLength(1);
  expect((await new LiveRequestStore(root).claim("phone","r1","写文件")).fresh).toBe(false);
  await expect(first.claim("phone","r1","发送文件")).rejects.toThrow("request_id_conflict");
  expect((await first.claim("other-phone","r1","写文件")).fresh).toBe(true);
 } finally { await fs.rm(root,{recursive:true,force:true}); }
});
it("new camera observations have source permissions and deletion invalidates derived replies", async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"live-image-context-")));const store=unifiedContext(root);
 try{await store.initialize();await store.setDevicePolicy("phone",{projectIds:["live"],audience:"private",processingLocation:"owned-devices",allowedRecipients:[]},owner);
  const hooks=liveContextHooks(store,"phone","live",async()=>true);
  const observed=await hooks.recordVisual!({requestId:"r",jpeg:Buffer.from("fixture").toString("base64"),capturedAt:Date.now(),receivedAt:Date.now(),ageMs:1},"红色圆形",false);
  const ref=observed.evidenceRefs![0]!;
  expect((await store.exportContext([ref],liveAccess("phone"))).entries[0]).toMatchObject({body:{text:"红色圆形"},source:{authority:"model-observation"}});
  await expect(store.exportContext([ref],liveAccess("phone","live","public"))).rejects.toThrow();
  await store.deleteEvidence(ref,"evidence-and-derived",owner);await expect(hooks.validate(observed)).rejects.toThrow();
 }finally{await store.release();await fs.rm(root,{recursive:true,force:true});}
});
it("a permission change clears a finished reply without requiring another user question",async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"live-finished-permission-")));const store=unifiedContext(root);const events:any[]=[];
 const provider:LiveProvider={async capabilities(){return {id:"fixture",ready:true,local:true,streamingInput:true,streamingText:true,streamingAudio:true,fullDuplex:false,voices:[],styleControl:false};},async*reply(){yield {type:"text",text:"旧资料回答。"};},async*synthesize(){yield {type:"audio",pcm:"AAA=",sampleRate:24000};},async recognize(){return "";},async resetRecognition(){},async close(){}};
 let session:LiveSession|undefined;
 try{await store.initialize();await store.setDevicePolicy("phone",{projectIds:["live"],audience:"private",processingLocation:"owned-devices",allowedRecipients:[]},owner);
  const ref=await store.recordLiveObservation("phone","live",{text:"资料",digest:"c".repeat(64),capturedAt:Date.now(),modality:"audio"},liveAccess("phone"));const snapshot=await store.snapshot([ref],liveAccess("phone"));
  session=new LiveSession("phone",structuredClone(PERSONAS[0]!),provider,provider,undefined,async()=>({scene:[],confirmed:[],work:[],contextSnapshotId:snapshot.snapshotId}),e=>events.push(e),root,undefined,false,liveContextHooks(store,"phone","live",async()=>true));
  store.registerChangeObserver(()=>session!.recheckContext());await session.text("这份资料是什么？");
  for(let i=0;i<100&&!events.some(e=>e.type==="completed");i++)await new Promise(r=>setTimeout(r,5));expect(events.some(e=>e.type==="completed")).toBe(true);
  await store.setPolicy([ref],{projectIds:["other"],audience:"private",processingLocation:"owned-devices",allowedRecipients:[]},owner);
  for(let i=0;i<100&&!events.some(e=>e.type==="context_invalidated");i++)await new Promise(r=>setTimeout(r,5));expect(events.some(e=>e.type==="context_invalidated")).toBe(true);
 }finally{await session?.close();await store.release();await fs.rm(root,{recursive:true,force:true});}
});
