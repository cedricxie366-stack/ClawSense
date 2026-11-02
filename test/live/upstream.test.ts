import { expect, it } from "vitest";
import { UpstreamConversation, validateUpstreamConfig, registerUpstreamLive } from "../../src/live/upstream.js";
import { PERSONAS, PersonaStore } from "../../src/live/persona.js";
import type { LiveProvider, LiveSessionHooks } from "../../src/live/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { unifiedContext } from "../../src/context-store.js";
import { liveContextHooks } from "../../src/live/context.js";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

function fixture() {
  let allowed = true, current = true, calls = 0;
  const inputs: any[] = [];
  const provider: LiveProvider = {
    async capabilities() { throw Error("unused"); }, async recognize() { return ""; }, async resetRecognition() {}, async close() {},
    async *reply(input) { calls++; inputs.push(input); yield { type: "text", text: "周四交方案，预算八万元。" }; },
    async *synthesize() { yield { type: "audio", pcm: "AAA=", sampleRate: 24000 }; yield { type: "audio", pcm: "AAA=", sampleRate: 24000 }; },
    async describeFrame() { return "本次图片里是一只杯子。"; },
  };
  const hooks: LiveSessionHooks = {
    async validate() { if (!current) throw Error("live_context_changed"); }, async validateHistory() {}, async authorizeExternal() {},
    async filterHistory(history) { return history; }, async recordUser() { return { scene: {}, confirmed: [], work: [], contextSnapshotId: "user-source" }; },
    async bindHistory(context) { return { ...context, contextSnapshotId: "bound" }; },
  };
  const session = new UpstreamConversation("fixture", structuredClone(PERSONAS[0]!), provider, hooks,
    async () => ({scene: {}, confirmed: [], work: []}), async () => allowed);
  return { session, provider, inputs, calls: () => calls, revoke: () => { allowed = false; }, invalidate: () => { current = false; } };
}
async function drain<T>(stream: AsyncIterable<T>) { const result: T[] = []; for await (const item of stream) result.push(item); return result; }
it("keeps the same models behind a separate conversation boundary and only commits heard answers", async () => {
  const f = fixture(); await drain(f.session.reply("方案改周四、八万元"));
  expect(f.session.history.map(m=>m.role)).toEqual(["user"]);
  await f.session.commitHeard("周四交方案，", f.session.responseId, true);
  expect(f.session.history.at(-1)).toMatchObject({content:"周四交方案，", interrupted:true, contextSnapshotId:"bound"});
  await expect(f.session.commitHeard("从没说过的内容",f.session.responseId,false)).rejects.toThrow("invalid_playback_receipt");
});
it("requires a fresh camera frame and does not reuse old image descriptions", async () => {
  const f=fixture();
  await expect(drain(f.session.reply("我现在在看什么？"))).rejects.toThrow("current_frame_unavailable");
  await expect(drain(f.session.reply("我现在在看什么？",{jpeg:"fixture",capturedAt:Date.now(),ageMs:2100}))).rejects.toThrow("current_frame_unavailable");
  expect(f.calls()).toBe(0);
  await drain(f.session.reply("我现在在看什么？",{jpeg:"fixture",capturedAt:Date.now(),ageMs:0}));
  expect(f.inputs[0].context.scene.currentFrame.description).toContain("杯子");
});
it("rejects old synthesis after interruption and after a new answer", async () => {
  const f=fixture();await drain(f.session.reply("复述安排"));
  const old=f.session.responseId,stream=f.session.speak("周四交方案，",old,new AbortController().signal);
  expect((await stream.next()).done).toBe(false);f.session.interrupt();
  await expect(stream.next()).rejects.toThrow("aborted");
  await expect(drain(f.session.speak("周四交方案，",old,new AbortController().signal))).rejects.toThrow("stale_speech");
  await drain(f.session.reply("新的问题"));
  await expect(drain(f.session.speak("周四交方案，",old,new AbortController().signal))).rejects.toThrow("stale_speech");
});
it.each(["revoke","invalidate"] as const)("checks %s between actual model audio chunks", async action => {
  const f=fixture();await drain(f.session.reply("复述安排"));
  const stream=f.session.speak("周四交方案，",f.session.responseId,new AbortController().signal);
  await stream.next();f[action]();await expect(stream.next()).rejects.toThrow();
});
it("limits model sidecar configuration to private loopback and bounded sessions", () => {
  expect(()=>validateUpstreamConfig({url:"https://unrelated.example/",tokenFile:"/tmp/token"})).toThrow();
  expect(()=>validateUpstreamConfig({url:"http://127.0.0.1:19723/",tokenFile:"relative"})).toThrow();
  expect(()=>validateUpstreamConfig({url:"http://127.0.0.1:19723/",tokenFile:"/tmp/token",maxSessionMs:1})).toThrow();
  expect(()=>validateUpstreamConfig({url:"http://127.0.0.1:19723/",tokenFile:"/tmp/token"})).not.toThrow();
});
it("binds delayed playback receipts to their original response and permits sentence spacing only", async () => {
  const f=fixture();await drain(f.session.reply("第一个问题"));const first=f.session.responseId;
  await drain(f.session.reply("第二个问题"));
  await f.session.commitHeard("周四交方案，预算八万元。 ", first, false);
  expect(f.session.history.map(m=>m.role)).toEqual(["user","assistant","user"]);
  expect(f.session.history[1]?.turnId).toBe(first);
  await f.session.commitHeard("周四交方案，预算八万元。", first, false);
  expect(f.session.history).toHaveLength(3);
});
it("never sends private conversation history to a public-scene model request", async () => {
  const f=fixture();await drain(f.session.reply("私密预算"));
  f.session.persona.publicScene=true;
  await drain(f.session.reply("公开场景的问题"));
  expect(f.inputs[1].history).toEqual([]);
});
it("ignores a delayed cancel for the previous response after the next response has started", async () => {
  const f=fixture(),old=new AbortController();
  const pending=f.session.reply("先前问题",undefined,old.signal);await pending.next();
  await drain(f.session.reply("六加八"));const next=f.session.responseId;
  old.abort();await expect(pending.next()).rejects.toThrow("aborted");
  expect(await drain(f.session.speak("周四交方案，",next,new AbortController().signal))).toHaveLength(2);
  f.session.interrupt();
  await expect(drain(f.session.speak("周四交方案，",next,new AbortController().signal))).rejects.toThrow("stale_speech");
});
it("reopens a managed checkpoint and removes it when its evidence is deleted", async () => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"upstream-checkpoint-"))),store=unifiedContext(root);
  const owner={actor:"local-owner",owner:true,processingLocation:"local-only" as const};
  const file=path.join(root,"plugins/clawsense/unified/checkpoints/upstream/phone.json");
  try {
    await store.initialize();
    await store.setDevicePolicy("phone",{projectIds:["live"],audience:"private",processingLocation:"owned-devices",allowedRecipients:[]},owner);
    const hooks=liveContextHooks(store,"phone","live",async()=>true),provider=fixture().provider;
    const make=()=>new UpstreamConversation("phone",structuredClone(PERSONAS[0]!),provider,hooks,async()=>({scene:{},confirmed:[],work:[]}),async()=>true,file);
    const first=make();await first.restore();await drain(first.reply("用户本轮提供的私密事实"));await first.commitHeard(first.answer,first.responseId,false);await first.close();
    const second=make();await second.restore();expect(second.history).toHaveLength(2);
    const source=(await store.listRecords(owner)).find(row=>row.ref.kind==="live-observation")!;
    expect(source).toBeDefined();
    await store.deleteEvidence(source.ref,"evidence-and-derived",owner);
    await expect(fs.readFile(file)).rejects.toMatchObject({code:"ENOENT"});
    const third=make();await third.restore();expect(third.history).toEqual([]);
    await second.close();await third.close();
  } finally {await store.release();await fs.rm(root,{recursive:true,force:true});}
});
it("detects public/private persona changes and rejects a symlinked persona file", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"upstream-persona-")),store=new PersonaStore(root);
  try {
    const initial=store.revision("phone");await store.write("phone",PERSONAS[0]);
    const privateRevision=store.revision("phone");expect(privateRevision).not.toBe(initial);
    await store.write("phone",{...PERSONAS[0],publicScene:true});expect(store.revision("phone")).not.toBe(privateRevision);
    const file=path.join(root,"live/personas/phone.json"),target=path.join(root,"target.json");await fs.rename(file,target);await fs.symlink(target,file);
    expect(()=>store.revision("phone")).toThrow("invalid_persona_file");
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
it("authenticates the model boundary, reserves one owner, and ends authorization after an audience change", async () => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"upstream-route-"))),store=unifiedContext(root);
  const tokenFile=path.join(root,"token"),token="fixture-".repeat(8),routes:any[]=[];await fs.writeFile(tokenFile,token,{mode:0o600});
  const personas=new PersonaStore(root);await store.initialize();
  const stop=registerUpstreamLive({api:{runtime:{state:{resolveStateDir:()=>root}},registerHttpRoute:(r:any)=>routes.push(r)} as any,
    config:{enabled:true,host:"127.0.0.1",port:19722,python:"unused",worker:"unused",llmModel:"unused",ttsModel:"unused",asrDir:"unused",upstream:{url:"http://127.0.0.1:19723/",tokenFile}},
    store,personas,local:fixture().provider,activeDevices:new Set(),authorize:async()=>{},idle(){},
    authenticate:async a=>a==="Bearer phone"?{ok:true,device:{deviceId:"phone"}}:{ok:false},context:async()=>({scene:{},confirmed:[],work:[]})});
  const call=async(body:any,secret=token)=>{
    const req=Object.assign(Readable.from([JSON.stringify(body)]),{method:"POST",headers:{authorization:"Bearer phone","x-clawsense-bridge":secret}});
    let result:any;const res=Object.assign(new EventEmitter(),{statusCode:0,setHeader(){},end:(v:string)=>{result=JSON.parse(v);}});
    await routes.find(r=>r.path.endsWith("/model")).handler(req,res);return{status:res.statusCode,body:result};
  };
  try {
    expect((await call({op:"open"},"wrong")).status).toBe(401);
    const results=await Promise.all([call({op:"open"}),call({op:"open"})]);
    expect(results.filter(r=>r.status===200)).toHaveLength(1);
    const sessionId=results.find(r=>r.status===200)!.body.sessionId;
    expect((await call({op:"check",sessionId})).status).toBe(200);
    await personas.write("phone",{...PERSONAS[0],publicScene:true});
    expect((await call({op:"check",sessionId})).body.error).toBe("upstream_authorization_revoked");
    expect((await call({op:"close",sessionId})).status).toBe(200);
  } finally {await stop();await store.release();await fs.rm(root,{recursive:true,force:true});}
});
