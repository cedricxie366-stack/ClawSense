import { it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LiveSession, recognitionDiffers } from "../../src/live/session.js";
import { PERSONAS } from "../../src/live/persona.js";
import type { LiveEvent, LiveProvider, ReplyInput } from "../../src/live/types.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(checked = "小周现在的三个IP排是什么？", online = "小周现在的三个安排是什么？") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-input-receipt-"));
  const events: LiveEvent[] = [], calls: ReplyInput[] = [];
  const provider: LiveProvider = {
    async capabilities() { return { id:"fixture", ready:true, local:true, streamingInput:true, streamingText:true, streamingAudio:true, fullDuplex:false, voices:[], styleControl:false }; },
    async *reply(input) { calls.push(input); yield {type:"text",text:"这是测试播报内容。"}; },
    async *synthesize() { yield {type:"audio",pcm:Buffer.alloc(160).toString("base64"),sampleRate:24000}; },
    async recognize() { return online; }, async finalRecognition() { return checked; },
    async resetRecognition() {}, async close() {},
  };
  const session = new LiveSession("receipt-fixture", structuredClone(PERSONAS[0]!), provider, provider, undefined,
    async () => ({ scene:{}, confirmed:[], work:[] }), e => events.push(e), root);
  const voiced = Buffer.alloc(640); for(let i=0;i<voiced.length;i+=2) voiced.writeInt16LE(5000,i);
  async function feed(voiceFrames = 20, source: "user" | "ambient" = "user") {
    for(let i=0;i<voiceFrames;i++) { session.audio(voiced,source); await delay(1); }
    for(let i=0;i<65;i++) { session.audio(Buffer.alloc(640),source); await delay(1); }
  }
  async function until(predicate: () => boolean) {
    for(let i=0;i<150&&!predicate();i++) await delay(5);
    expect(predicate()).toBe(true);
  }
  return {root,session,provider,events,calls,feed,until,async close(){await session.close();await fs.rm(root,{recursive:true,force:true});}};
}

it("reports unaddressed speech without storing or executing it", async () => {
  const f=await fixture("预算是多少？","预算是多少？");
  try {
    await f.feed(); await f.until(()=>f.events.some(e=>e.type==="input_status"&&e.status==="address_required"));
    expect(f.calls).toHaveLength(0);
    expect(f.session.inputDiagnostics().inputOutcomes.address_required).toBe(1);
    await expect(fs.readFile(path.join(f.root,"live/conversations/receipt-fixture.json"),"utf8")).rejects.toThrow();
  } finally {await f.close();}
});

it("exposes recognition alternatives without promoting them to history or rewriting the selected input", async () => {
  const f=await fixture();
  try {
    f.session.inviteOpening(); await f.feed(); await f.until(()=>f.events.some(e=>e.type==="completed")&&f.events.some(e=>e.type==="recognition_comparison"));
    expect(f.calls[0]!.query).toContain("IP排");
    expect(f.events.find(e=>e.type==="recognition_comparison")).toMatchObject({inputId:1,selected:"小周现在的三个IP排是什么？",alternative:"小周现在的三个安排是什么？"});
    const before=JSON.parse(await fs.readFile(path.join(f.root,"live/conversations/receipt-fixture.json"),"utf8"));
    expect(before.history.filter((m:any)=>m.role==="user").map((m:any)=>m.content)).toEqual(["小周现在的三个IP排是什么？"]);
    await f.session.text("小周现在的三个安排是什么？"); await f.until(()=>f.calls.length===2);
    expect(f.calls[1]!.query).toContain("安排");
    expect(JSON.stringify(f.session.inputDiagnostics())).not.toMatch(/IP排|安排|小周/);
  } finally {await f.close();}
});

it("does not wait for a stalled second recognizer or expose its late text after a newer typed input", async () => {
  const f=await fixture(); let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  f.provider.recognize=async()=>{await held;return "superseded private alternative";};
  try {
    f.session.inviteOpening();await f.feed();await f.until(()=>f.events.some(e=>e.type==="completed"));
    await f.session.text("新的手动问题");const start=f.events.length;release();await delay(40);
    expect(f.events.slice(start).some(e=>e.type==="recognition_comparison")).toBe(false);
    expect(f.calls.map(c=>c.query)).not.toContain("superseded private alternative");
  } finally {release();await f.close();}
});

it("cannot expose a late alternative after the source context is invalidated",async()=>{
  const f=await fixture();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  f.provider.recognize=async()=>{await held;return "revoked private alternative";};
  try {
    f.session.inviteOpening();await f.feed();await f.until(()=>f.events.some(e=>e.type==="completed"));
    f.session.invalidateContext();const offset=f.events.length;release();await delay(40);
    expect(f.events.slice(offset).some(e=>e.type==="recognition_comparison"||e.type==="transcript")).toBe(false);
  } finally {release();await f.close();}
});

it("makes empty and too-short utterances visible without inventing a reply", async () => {
  const f=await fixture("","");
  try {
    f.session.inviteOpening();await f.feed();await f.until(()=>f.events.some(e=>e.type==="input_status"&&e.status==="no_transcript"));
    await f.feed(3);await f.until(()=>f.events.some(e=>e.type==="input_status"&&e.status==="too_short"));
    expect(f.calls).toHaveLength(0);
  } finally {await f.close();}
});

it("identifies ignored echo without another reply or a saved user statement", async () => {
  const f=await fixture("这是测试播报内容。","这是测试播报内容。");
  try {
    await f.session.text("先播一段测试文字");await f.until(()=>f.events.some(e=>e.type==="completed"));f.session.playback(true);
    await f.feed();await f.until(()=>f.events.some(e=>e.type==="input_status"&&e.status==="echo_ignored"));
    expect(f.calls).toHaveLength(1);
    expect(f.session.inputDiagnostics().inputOutcomes.echo_ignored).toBe(1);
  } finally {await f.close();}
});

it("does not label punctuation and simple numeral formatting as a recognition disagreement",()=>{
  expect(recognitionDiffers("预算5万元。","预算五万元")).toBe(false);
  expect(recognitionDiffers("小周的IP排","小周的安排")).toBe(true);
  expect(recognitionDiffers("预算三万元","预算五万元")).toBe(true);
  expect(recognitionDiffers("","安排")).toBe(false);
});

it("keeps a fast recognized stop marked handled when a slow recheck finishes later",async()=>{
  const f=await fixture();let release!:(text:string)=>void;const held=new Promise<string>(resolve=>{release=resolve;});
  f.provider.recognize=async(_id,_pcm,final)=>final?"停":"";
  f.provider.finalRecognition=async()=>held;
  try {
    f.session.playback(true);await f.feed();await f.until(()=>f.events.some(e=>e.type==="input_status"&&e.status==="control_handled"));
    release("停");await delay(40);
    expect(f.events.filter(e=>e.type==="input_status").at(-1)?.status).toBe("control_handled");
    expect(f.calls).toHaveLength(0);
  } finally {release("停");await f.close();}
});

it("reports received frames even without a speech endpoint, rate limited and without transcript text",async()=>{
  let now=0;const clock=vi.spyOn(performance,"now").mockImplementation(()=>now);const f=await fixture();
  try {
    now=1500;await f.feed(0);
    const health=f.events.filter(e=>e.type==="input_health");expect(health).toHaveLength(1);
    expect(health[0]!.diagnostics).toMatchObject({processedAudioFrames:1,voicedAudioFrames:0,maxInputRms:0});
    expect(JSON.stringify(health)).not.toMatch(/IP排|安排|小周/);
    expect(f.calls).toHaveLength(0);
  } finally {clock.mockRestore();await f.close();}
});
it("does not interrupt or start filler replies for incomplete or acknowledgment fragments", async () => {
  for (const text of ["我。","被。","对。"]) {
    const f=await fixture(text,text);
    try {
      await f.session.text("请播报测试内容");await f.until(()=>f.events.some(e=>e.type==="completed"));f.session.playback(true);
      const offset=f.events.length;
      await f.feed();await f.until(()=>f.events.slice(offset).some(e=>e.type==="input_status"&&["fragment_ignored","backchannel_ignored"].includes(e.status as string)));
      expect(f.calls).toHaveLength(1);
      expect(f.events.slice(offset).some(e=>e.type==="interrupted")).toBe(false);
    } finally {await f.close();}
  }
});
it("pauses ambiguous short interruptions without inventing a stop transcript or a new topic", async () => {
  const f=await fixture("银。","银。");
  try {
    await f.session.text("请播报测试内容");await f.until(()=>f.events.some(e=>e.type==="completed"));f.session.playback(true);
    await f.feed();await f.until(()=>f.events.some(e=>e.type==="input_status"&&e.status==="interruption_unclear"));
    expect(f.calls).toHaveLength(1);
    expect(f.events.some(e=>e.type==="notice"&&e.code==="unclear_interruption_paused")).toBe(true);
    expect(f.events.some(e=>e.type==="transcript"&&e.final===true&&e.text==="银。")).toBe(true);
    await delay(30);expect(f.calls).toHaveLength(1);
    await f.session.text("六加八是多少？");await f.until(()=>f.calls.length===2);
  } finally {await f.close();}
});
it("uses an independently recognized stop instead of answering a misrecognized metal", async () => {
  const f=await fixture("银。","停");
  f.provider.recognize=async(_id,_pcm,final)=>final?"停":"";
  try {
    await f.session.text("请播报测试内容");await f.until(()=>f.events.some(e=>e.type==="completed"));f.session.playback(true);
    await f.feed();await f.until(()=>f.events.some(e=>e.type==="input_status"&&e.status==="control_handled"));
    expect(f.calls).toHaveLength(1);
  } finally {await f.close();}
});
it("rechecks a short stop after an incomplete first prefix, without mapping a similar word to stop", async () => {
  const f=await fixture("停。","");
  let probes=0;
  f.provider.finalRecognition=async()=>++probes===1?"听。":"停。";
  try {
    f.session.playback(true);
    await f.feed();
    await f.until(()=>f.events.some(e=>e.type==="notice"&&e.code==="speech_stopped_task_unchanged"));
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(f.calls).toHaveLength(0);
  } finally {await f.close();}
});
it("does not execute stop commands from explicitly ambient source audio", async () => {
  const f=await fixture("停。","停。");
  try {
    f.session.playback(true);await f.feed(20,"ambient");
    await f.until(()=>f.events.some(e=>e.type==="input_status"&&e.status==="ambient_ignored"));
    expect(f.events.some(e=>e.type==="notice"&&e.code==="speech_stopped_task_unchanged")).toBe(false);
  } finally {await f.close();}
});
