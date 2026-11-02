import { it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { registerLive } from "../../src/live/server.js";
import type { OpenClawPluginApi } from "../../src/openclaw-types.js";
import type { LiveProvider, LiveConfig } from "../../src/live/types.js";
import { Readable } from "node:stream";
import { unifiedContext } from "../../src/context-store.js";
const base: LiveConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 19499,
  python: "unused",
  worker: "unused",
  llmModel: "unused",
  ttsModel: "unused",
  asrDir: "unused",
};
it("stops a self-contained reply when the device processing policy is revoked during playback", async () => {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"live-processing-revoked-"))),services:any[]=[],frames:any[]=[];
  const context=unifiedContext(root);await context.initialize();
  await context.setDevicePolicy("processing-fixture",{projectIds:["live"],audience:"private",processingLocation:"owned-devices",allowedRecipients:[]},{actor:"local-owner",owner:true,processingLocation:"local-only"});
  let allowed=true,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const provider:LiveProvider={
    async capabilities(){return{id:"fixture",ready:true,local:true,streamingInput:true,streamingText:true,streamingAudio:true,fullDuplex:false,voices:[],styleControl:false};},
    async *reply(){yield{type:"text",text:"测试中的短句。"};},async *synthesize(){yield{type:"audio",pcm:Buffer.alloc(480).toString("base64"),sampleRate:24000};await held;yield{type:"audio",pcm:Buffer.alloc(480).toString("base64"),sampleRate:24000};},
    async recognize(){return "";},async resetRecognition(){},async close(){}
  };
  registerLive({api:{runtime:{state:{resolveStateDir:()=>root}},registerService:(s:any)=>services.push(s),registerHttpRoute(){}} as unknown as OpenClawPluginApi,
    contextStore:context,config:{...base,port:19497},publicBaseUrl:()=>"http://127.0.0.1:19496",authenticate:async()=>({ok:true,device:{deviceId:"processing-fixture"}}),
    authorizeCapture:async()=>{if(!allowed)throw Error("phone_local_processing_required");},context:async()=>{throw Error("unrelated_context_loaded");},providers:{local:provider}});
  let ws:WebSocket|undefined;const wait=async(type:string)=>{for(let i=0;i<300;i++){if(frames.some(e=>e.type===type))return;await new Promise(r=>setTimeout(r,5));}throw Error("missing "+type+": "+JSON.stringify(frames.filter(e=>["error","notice","configuration_required"].includes(e.type))));};
  try {
    await services[0].start();ws=new WebSocket("ws://127.0.0.1:19497/live");ws.on("message",raw=>frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve,reject)=>{ws!.once("open",resolve);ws!.once("error",reject);});ws.send(JSON.stringify({type:"hello"}));await wait("ready");
    ws.send(JSON.stringify({type:"text",text:"请原样朗读：测试中的短句。"}));await wait("audio");
    allowed=false;release();await wait("context_invalidated");expect(frames.filter(e=>e.type==="audio")).toHaveLength(1);
  } finally {release();ws?.terminate();await services[0].stop();await context.release();await fs.rm(root,{recursive:true,force:true});}
});
it("keeps an explicit reading on the conversation path even when work execution is enabled", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-literal-routing-")),services:any[]=[],frames:any[]=[],calls:string[]=[];
  const provider:LiveProvider={
    async capabilities(){return{id:"fixture",ready:true,local:true,streamingInput:true,streamingText:true,streamingAudio:true,fullDuplex:false,voices:[],styleControl:false};},
    async *reply(input){calls.push(input.query);yield{type:"text",text:"这是只需朗读的测试文字。"};},
    async *synthesize(){},async recognize(){return "";},async resetRecognition(){},async close(){}
  };
  registerLive({api:{runtime:{state:{resolveStateDir:()=>root}},registerService:(s:any)=>services.push(s),registerHttpRoute(){}} as unknown as OpenClawPluginApi,
    config:{...base,port:19497},publicBaseUrl:()=>"http://127.0.0.1:19496",authenticate:async()=>({ok:true,device:{deviceId:"literal-fixture"}}),
    context:async()=>({scene:{},confirmed:[],work:[]}),work:{} as any,providers:{local:provider}});
  let ws:WebSocket|undefined;
  const wait=async(type:string)=>{for(let i=0;i<200;i++){if(frames.some(e=>e.type===type))return;await new Promise(r=>setTimeout(r,5));}throw Error("missing "+type);};
  try {
    await services[0].start();ws=new WebSocket("ws://127.0.0.1:19497/live");ws.on("message",raw=>frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve,reject)=>{ws!.once("open",resolve);ws!.once("error",reject);});ws.send(JSON.stringify({type:"hello"}));await wait("ready");
    const query="请原样朗读："+"删除文件并发送邮件。".repeat(30);
    ws.send(JSON.stringify({type:"text",text:query}));await wait("completed");
    expect(calls).toEqual([query]);expect(frames.find(e=>e.type==="turn_started")?.route).toBe("local");
    expect(frames.some(e=>["task_queued","configuration_required","error"].includes(e.type))).toBe(false);
  } finally {ws?.terminate();await services[0].stop();await fs.rm(root,{recursive:true,force:true});}
});
it("prepares local assets before Live without media, rejecting unauthorized and phone-only requests", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-preparation-"));
  const routes:any[]=[],services:any[]=[];let allowed=true, prepared=0, probes=0;
  const provider:LiveProvider={
    async capabilities(){probes++;return{id:"fixture",ready:true,local:true,streamingInput:true,streamingText:true,streamingAudio:true,fullDuplex:false,voices:[],styleControl:false};},
    async prepare(){prepared++;},
    async *reply(){throw Error("unexpected media");},async *synthesize(){throw Error("unexpected media");},
    async recognize(){throw Error("unexpected media");},async resetRecognition(){},async close(){}
  };
  registerLive({api:{runtime:{state:{resolveStateDir:()=>root}},registerHttpRoute:(r:any)=>routes.push(r),registerService:(s:any)=>services.push(s)} as unknown as OpenClawPluginApi,
    config:base,publicBaseUrl:()=>"http://127.0.0.1:19498",authenticate:async auth=>auth==="Bearer fixture"?{ok:true,device:{deviceId:"preparation"}}:{ok:false},
    authorizeCapture:async()=>{if(!allowed)throw Error("phone_local_processing_required");},
    context:async()=>{throw Error("preparation cannot read private context");},providers:{local:provider}});
  const request=async(authorization:string)=>{
    const req=Object.assign(Readable.from(["{}"]),{method:"POST",headers:{authorization}});
    let body:any;
    const res={statusCode:0,end:(value:string)=>{body=JSON.parse(value);},setHeader(){}};
    await routes.find(r=>r.path==="/api/clawsense/live-prepare").handler(req,res);
    return{status:res.statusCode,body};
  };
  try {
    expect((await request("Bearer wrong")).status).toBe(401);expect(probes).toBe(0);
    allowed=false;expect((await request("Bearer fixture")).body.error).toBe("phone_local_processing_required");expect(prepared).toBe(0);
    allowed=true;expect((await request("Bearer fixture")).body).toMatchObject({ok:true,ready:true,mediaStarted:false});expect(prepared).toBe(1);
  } finally {await services[0].stop();await fs.rm(root,{recursive:true,force:true});}
});
it("authenticates sockets, rejects concurrent device sessions, streams replies and closes cleanly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "live-server-"));
  const services: any[] = [];
  let delayAuthentication: (() => Promise<void>) | undefined;
  const observedAudio: number[] = [];
  const provider: LiveProvider = {
    async capabilities() {
      return {
        id: "fixture",
        ready: true,
        local: true,
        streamingInput: true,
        streamingText: true,
        streamingAudio: true,
        fullDuplex: false,
        voices: [],
        styleControl: false,
      };
    },
    async *reply(input) {
      yield { type: "text", text: (input.context.scene as any)?.currentFrame?.description ?? "已收到这条测试消息。" };
    },
    async describeFrame(frame) { expect(Buffer.from(frame.jpeg, "base64")).toHaveLength(200000); return "完整的大帧已接收。"; },
    async *synthesize() {
      yield { type: "audio", pcm: "AAA=", sampleRate: 24000 };
    },
    async recognize() {
      return "";
    },
    async voiceActivity(_id, pcm) { observedAudio.push(Buffer.from(pcm,"base64").readInt16LE(0)); return false; },
    async resetRecognition() {},
    async close() {},
  };
  const api = {
    runtime: { state: { resolveStateDir: () => root } },
    registerService(s: any) {
      services.push(s);
    },
    registerHttpRoute() {},
  } as unknown as OpenClawPluginApi;
  registerLive({
    api,
    config: base,
    publicBaseUrl: () => "http://127.0.0.1:19498",
    authenticate: async (auth) => {
      const pause = delayAuthentication; delayAuthentication = undefined;
      await pause?.();
      return auth === "Bearer fixture-token"
        ? { ok: true, device: { deviceId: "fixture-device" } }
        : { ok: false };
    },
    context: async () => ({ scene: [], confirmed: [], work: [] }),
    providers: { local: provider },
  });
  let ws: WebSocket | undefined;
  try {
    await services[0].start();
    const unauthorized = new WebSocket("ws://127.0.0.1:19499/live");
    await expect(
      new Promise((resolve, reject) => {
        unauthorized.on("open", resolve);
        unauthorized.on("error", reject);
      }),
    ).rejects.toThrow();
    ws = new WebSocket("ws://127.0.0.1:19499/live", {
      headers: { Authorization: "Bearer fixture-token" },
    });
    const frames: any[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      ws!.on("open", resolve);
      ws!.on("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello" }));
    const wait = async (type: string) => {
      for (let i = 0; i < 100; i++) {
        const f = frames.find((x) => x.type === type);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("missing " + type);
    };
    const ready = await wait("ready");
    expect(ready.selected).toBe("local-cascade");
    const duplicate = new WebSocket("ws://127.0.0.1:19499/live", {
      headers: { Authorization: "Bearer fixture-token" },
    });
    await expect(
      new Promise((resolve, reject) => {
        duplicate.on("open", resolve);
        duplicate.on("error", reject);
      }),
    ).rejects.toThrow();
    let audioEntered!:()=>void,audioResume!:()=>void;
    const waitingAudio=new Promise<void>(resolve=>{audioEntered=resolve;});
    delayAuthentication=()=>{audioEntered();return new Promise<void>(resolve=>{audioResume=resolve;});};
    ws.send(Buffer.from([1,0]));await waitingAudio;ws.send(Buffer.from([2,0]));
    await new Promise(resolve=>setTimeout(resolve,20));
    try { expect(observedAudio).toEqual([]); } finally {audioResume();}
    for(let i=0;i<100&&observedAudio.length<2;i++)await new Promise(resolve=>setTimeout(resolve,5));
    expect(observedAudio).toEqual([1,2]);
    let heldAudio!:()=>void,releaseAudio!:()=>void;
    const blockedAudio=new Promise<void>(resolve=>{heldAudio=resolve;});
    delayAuthentication=()=>{heldAudio();return new Promise<void>(resolve=>{releaseAudio=resolve;});};
    ws.send(Buffer.from([3,0]));await blockedAudio;ws.send(Buffer.from([4,0]));
    frames.length=0;ws.send(JSON.stringify({type:"interrupt"}));await wait("interrupted");releaseAudio();
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(observedAudio).toEqual([1,2]);
    ws.send(JSON.stringify({ type: "text", text: "你好" }));
    expect((await wait("completed")).answer).toContain("收到");
    expect(frames.some((x) => x.type === "audio")).toBe(true);
    frames.length = 0;
    let playbackEntered!:()=>void,playbackResume!:()=>void;
    const pendingPlayback=new Promise<void>(resolve=>{playbackEntered=resolve;});
    delayAuthentication=()=>{playbackEntered();return new Promise<void>(resolve=>{playbackResume=resolve;});};
    ws.send(JSON.stringify({type:"playback",active:false}));await pendingPlayback;
    ws.send(JSON.stringify({type:"playback",active:true}));await new Promise(resolve=>setTimeout(resolve,20));
    playbackResume();await new Promise(resolve=>setTimeout(resolve,20));
    const originalVad=provider.voiceActivity;
    provider.voiceActivity=async()=>true;provider.finalRecognition=async()=>"停。";
    const voice=Buffer.alloc(640);for(let i=0;i<voice.length;i+=2)voice.writeInt16LE(5000,i);
    for(let i=0;i<20;i++)ws.send(voice);
    expect((await wait("notice")).code).toBe("speech_stopped_task_unchanged");
    provider.voiceActivity=originalVad;
    frames.length = 0;
    let entered!: () => void, resume!: () => void;
    const pendingAuth = new Promise<void>(resolve => { entered = resolve; });
    delayAuthentication = () => { entered(); return new Promise<void>(resolve => { resume = resolve; }); };
    ws.send(JSON.stringify({ type: "text", text: "这轮马上停止", requestId: "pending-stop" }));
    await pendingAuth;
    ws.send(JSON.stringify({ type: "interrupt" }));
    await wait("interrupted");
    resume();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(frames.some(e => ["turn_started", "text_delta", "audio"].includes(e.type))).toBe(false);
    frames.length = 0;
    ws.send(JSON.stringify({ type: "text", text: "这是停止后的新问题" }));
    expect((await wait("completed")).answer).toContain("收到");
    frames.length = 0;
    const bytes = Buffer.alloc(200000); bytes[0] = 255; bytes[1] = 216; bytes[bytes.length - 2] = 255; bytes[bytes.length - 1] = 217;
    ws.on("message", raw => { const event = JSON.parse(raw.toString()); if (event.type === "vision_request") ws!.send(JSON.stringify({ type: "frame", requestId: event.requestId, capturedAt: Date.now(), ageMs: 0, jpeg: bytes.toString("base64") })); });
    ws.send(JSON.stringify({ type: "text", text: "我现在在看什么？" }));
    expect((await wait("completed")).answer).toBe("完整的大帧已接收。");
    let overflowEntered!:()=>void,overflowRelease!:()=>void;
    const overflowHold=new Promise<void>(resolve=>{overflowEntered=resolve;});
    delayAuthentication=()=>{overflowEntered();return new Promise<void>(resolve=>{overflowRelease=resolve;});};
    frames.length=0;ws.send(Buffer.alloc(640));await overflowHold;
    for(let i=0;i<101;i++)ws.send(Buffer.alloc(640));
    try { expect((await wait("error")).code).toBe("audio_backpressure"); }
    finally {overflowRelease();}
  } finally {
    ws?.terminate();
    await services[0].stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("warms the selected persona before ready and rechecks worker availability on reconnect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "live-readiness-"));
  const services: any[] = []; let available = true, probes = 0, warmed = 0, cooled = 0;
  const originalTimeout = globalThis.setTimeout;
  let idleCallback: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...args: any[]) => {
    const timer = originalTimeout(handler, ms, ...args);
    if (ms === 60000) { idleCallback = handler; idleTimer = timer; }
    return timer;
  }) as typeof setTimeout);
  let release!: () => void, entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const provider: LiveProvider = {
    async capabilities() { probes++; return { id: "fixture", ready: available, local: true, streamingInput: true, streamingText: true, streamingAudio: true, fullDuplex: false, voices: [], styleControl: true }; },
    async prepare(persona) { expect(persona.voice).toBeTruthy(); warmed++; entered(); await barrier; },
    async cooldown() { cooled++; },
    async *reply() {}, async *synthesize() {}, async recognize() { return ""; }, async resetRecognition() {}, async close() {},
  };
  registerLive({ api: { runtime: { state: { resolveStateDir: () => root } }, registerService(s: any) { services.push(s); }, registerHttpRoute() {} } as unknown as OpenClawPluginApi,
    config: { ...base, port: 19497 }, publicBaseUrl: () => "http://127.0.0.1:19496", authenticate: async () => ({ ok: true, device: { deviceId: "readiness-fixture" } }),
    context: async () => ({ scene: [], confirmed: [], work: [] }), providers: { local: provider } });
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const ws = new WebSocket("ws://127.0.0.1:19497/live"); sockets.push(ws); const frames: any[] = [];
    ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }); ws.send(JSON.stringify({ type: "hello" }));
    return { ws, frames };
  };
  const wait = async (frames: any[], type: string) => { for (let i = 0; i < 100; i++) { if (frames.some(e => e.type === type)) return; await new Promise(r => setTimeout(r, 5)); } throw Error("missing " + type); };
  const close = (ws: WebSocket) => new Promise<void>(resolve => { ws.once("close", () => resolve()); ws.close(); });
  try {
    await services[0].start(); const first = await connect(); await preparing;
    expect(first.frames.some(e => e.type === "ready")).toBe(false); release(); await wait(first.frames, "ready"); await close(first.ws);
    available = false; const second = await connect(); await wait(second.frames, "configuration_required");
    if (second.ws.readyState !== WebSocket.CLOSED) await new Promise<void>(resolve => second.ws.once("close", () => resolve()));
    available = true; const third = await connect(); await wait(third.frames, "ready");
    expect(probes).toBe(3); expect(warmed).toBe(3); expect(cooled).toBe(0);
    expect(second.frames.some(e=>e.type==="ready")).toBe(false);
    clearTimeout(idleTimer); idleCallback?.(); expect(cooled).toBe(0); // Never cool an active connection.
    const previousTimer = idleTimer;
    await close(third.ws);
    // Client close precedes the server's async session cleanup and idle timer.
    for (let i = 0; i < 200 && idleTimer === previousTimer; i++) await new Promise(r => originalTimeout(r, 5));
    expect(idleTimer).not.toBe(previousTimer);
    clearTimeout(idleTimer); idleCallback?.(); expect(cooled).toBe(1);
  } finally { clearTimeout(idleTimer); timerSpy.mockRestore(); release(); for (const ws of sockets) ws.terminate(); await services[0].stop(); await fs.rm(root, { recursive: true, force: true }); }
});
