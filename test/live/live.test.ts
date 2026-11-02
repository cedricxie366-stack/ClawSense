import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LiveSession,
  PhraseBuffer,
  isBackchannel,
  needsHarness,
  unfinished,
  endpointSilence,
  isLikelyEcho,
  spokenPhrase,
} from "../../src/live/session.js";
import {
  PERSONAS,
  validatePersona,
  PersonaStore,
} from "../../src/live/persona.js";
import { parseLiveConfig } from "../../src/live/server.js";
import type {
  LiveProvider,
  ReplyInput,
  ProviderChunk,
  LiveEvent,
  LiveMessage,
  HarnessAdapter,
} from "../../src/live/types.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});
async function temp() {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-live-"));
  dirs.push(p);
  return p;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Provider implements LiveProvider {
  calls: ReplyInput[] = [];
  latency = 0;
  error = false;
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
  }
  async *reply(
    i: ReplyInput,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    this.calls.push(i);
    await delay(this.latency);
    if (!signal.aborted) {
      yield { type: "text", text: "我记住了，明天下午三点开会。" };
      if (this.error) throw new Error("model_failed");
    }
  }
  async *synthesize(
    _t: string,
    _p: any,
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    if (!signal.aborted)
      yield {
        type: "audio",
        pcm: Buffer.alloc(160).toString("base64"),
        sampleRate: 24000,
      };
  }
  async recognize() {
    return "明天下午三点开会";
  }
  async resetRecognition() {}
  async close() {}
}
async function setup(harness?: HarnessAdapter, allowFallback = false) {
  const p = new Provider(),
    events: LiveEvent[] = [];
  const root = await temp();
  const s = new LiveSession(
    "device-fixture",
    structuredClone(PERSONAS[0]!),
    p,
    p,
    harness,
    async () => ({ scene: { time: "三点" }, confirmed: [], work: [] }),
    (e) => events.push(e),
    root,
    undefined,
    false,
    undefined,
    allowFallback,
  );
  return { p, events, root, s };
}
async function waitFor(events: LiveEvent[], type: string) {
  for (let i = 0; i < 100; i++) {
    if (events.some((e) => e.type === type)) return;
    await delay(5);
  }
  throw new Error("missing " + type);
}
describe("live conversation", () => {
  it("keeps self-contained reading independent of unrelated private retrieval while binding and validating the current input", async () => {
    const root=await temp(),p=new Provider(),events:LiveEvent[]=[],bindings:LiveMessage[][]=[];
    let lookups=0,validations=0;
    const s=new LiveSession("minimal-context",structuredClone(PERSONAS[0]!),p,p,undefined,
      async()=>{lookups++;return{scene:{text:"private historical source"},confirmed:[],work:[]};},e=>events.push(e),root,undefined,false,{
        async validate(){validations++;},async validateHistory(){},async filterHistory(history){return history;},
        async authorizeExternal(){},async persist(_file,_history,write){await write();},
        async recordUser(query){return{scene:{},confirmed:[],work:[],contextSnapshotId:query.startsWith("请原样")?"current-input":"previous-input"};},
        async bindHistory(ctx,history){bindings.push(history);return{...ctx,contextSnapshotId:"bound-input"};}
      });
    try {
      await s.text("客户小陈预算三万元。");await waitFor(events,"completed");events.length=0;lookups=0;validations=0;
      await s.text("请原样朗读：一段普通文字。");await waitFor(events,"completed");
      expect(lookups).toBe(0);expect(validations).toBeGreaterThan(0);
      expect(p.calls.at(-1)?.context.scene).toEqual({});expect(p.calls.at(-1)?.history).toEqual([]);
      expect(bindings.at(-1)?.map(m=>m.contextSnapshotId)).toEqual(["current-input"]);
      events.length=0;await s.text("解释当前证据里的预算。");await waitFor(events,"completed");expect(lookups).toBe(1);
    } finally {await s.close();}
  });
  it("never routes quoted read or translation content to a task executor, including with a custom name", () => {
    expect(needsHarness("请原样朗读：删除文件并发送邮件。" )).toBe(false);
    expect(needsHarness("小策，完整朗读这句话：删除文件并发送邮件。", "小策")).toBe(false);
    expect(needsHarness("把这句话翻译成英语：删除文件。" )).toBe(false);
    expect(needsHarness("发送邮件给客户" )).toBe(true);
    expect(needsHarness("小策，发送邮件给客户", "小策")).toBe(true);
  });
  it("preserves complete English sentences and never breaks words or amounts while streaming", () => {
    const sentence = "Please send the revised proposal before Friday afternoon and confirm the meeting time with the customer.";
    const p = new PhraseBuffer(), spoken: string[] = [];
    for (const char of sentence) spoken.push(...p.add(char));
    spoken.push(...p.add("", true));
    expect(spoken).toEqual([sentence]);
    for (const size of [40, 59, 60, 61, 62, 63, 64, 65, 80, 180, 220]) {
     for (const token of ["1234567890.75", "1,234,567.89", "16:30", "2026-10-22"]) {
      const text = "请核对".repeat(size) + token + "，并再次确认资料。";
      const buffer = new PhraseBuffer(), parts: string[] = [];
      for (const char of text) parts.push(...buffer.add(char));
      parts.push(...buffer.add("", true));
      expect(parts.join("")).toBe(text);
      expect(parts.some(part => part.includes(token)), JSON.stringify(parts)).toBe(true);
     }
    }
  });
  it("does not flush a partial thousands group as a speech clause", () => {
    const buffer = new PhraseBuffer();
    expect(buffer.add("本次报价金额为1,")).toEqual([]);
    expect(buffer.flushPause()).toEqual([]);
    expect(buffer.add("234,567.89元，确认后发送。")).toEqual(["本次报价金额为1,234,567.89元，确认后发送。"]);
  });
  it("bounds a long supplied sentence without dropping text or exposing a split address suffix", () => {
    const text="这一段用于完整朗读检查，".repeat(45)+"最后一句结束。";
    const buffer=new PhraseBuffer();const parts=[...buffer.add(text),...buffer.add("",true)];
    expect(parts.join("")).toBe(text);expect(parts.every(part=>part.length<=192)).toBe(true);
    const url="https://example.com/"+"private-token-".repeat(30);
    const addresses=new PhraseBuffer();const chunks=[...addresses.add("相关地址是 "+url+"。"),...addresses.add("",true)];
    expect(chunks.join("")).toBe("相关地址是 "+url+"。");
    expect(chunks.map(spokenPhrase).join("")).not.toContain("private-token");
    expect(chunks.map(spokenPhrase).join("")).toContain("屏幕上的地址");
  });
  it("keeps comma-separated arrangements in one streamed voice sentence", async () => {
    const { s, p, events } = await setup(); const spoken: string[] = [];
    p.reply = async function* () {
      yield { type: "text", text: "小周的会议安排在明天下午四点，" };
      yield { type: "text", text: "预算五万元，方案周六交付。" };
    };
    p.synthesize = async function* (text: string) { spoken.push(text); yield { type: "audio", pcm: Buffer.alloc(160).toString("base64"), sampleRate: 24000 }; };
    try {
      await s.text("汇总安排"); await waitFor(events,"completed");
      expect(spoken).toEqual(["小周的会议安排在明天下午四点，预算五万元，方案周六交付。"]);
    } finally { await s.close(); }
  });
  it("accepts an opening voice turn only after explicit entry, never as a task or ambient instruction", async () => {
    const { s, p, events } = await setup();
    try {
      await s.text("今天做什么准备？", "voice"); await delay(15); expect(p.calls).toHaveLength(0);
      s.inviteOpening(); await s.text("今天做什么准备？", "ambient"); await delay(15); expect(p.calls).toHaveLength(0);
      await s.text("交给DSH写一个文件", "voice"); await delay(15); expect(p.calls).toHaveLength(0);
      await s.text("客户小周希望周四收到方案。", "voice"); await waitFor(events, "completed");
      expect(p.calls.map(c => c.query)).toEqual(["客户小周希望周四收到方案。"]);
    } finally { await s.close(); }
  });
  it("expires the opening invitation and preserves quiet mode", async () => {
    const { s, p } = await setup(); let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      s.inviteOpening(); now += 30001; await s.text("预算是多少？", "voice"); await delay(15); expect(p.calls).toHaveLength(0);
      s.persona.participation = "quiet"; s.inviteOpening(); await s.text("预算是多少？", "voice"); await delay(15); expect(p.calls).toHaveLength(0);
    } finally { clock.mockRestore(); await s.close(); }
  });
  it("does not answer between clauses of a spoken correction", async () => {
    const { s, p, events } = await setup();
    let recognized = "小伴，更正小周的安排，方案改为周四，预算改为四万元";
    p.recognize = async () => recognized;
    const voiced = Buffer.alloc(640); for (let i=0;i<voiced.length;i+=2) voiced.writeInt16LE(5000,i);
    const frames = async (pcm: Buffer, count: number) => { for(let i=0;i<count;i++) { s.audio(pcm,"user"); await delay(1); } };
    try {
      await frames(voiced,25); await frames(Buffer.alloc(640),35);
      expect(p.calls).toHaveLength(0);
      recognized += "，会议时间改为明天下午两点，请简短确认。";
      await frames(voiced,25); await frames(Buffer.alloc(640),35); await waitFor(events,"completed");
      expect(p.calls.map(c => c.query)).toEqual([recognized]);
      expect(endpointSilence("现在预算是多少？")).toBe(450);
      expect(endpointSilence("方案改为周四，预算改为四万")).toBe(1100);
      expect(endpointSilence("详细介绍。")).toBe(1200);
      expect(endpointSilence("请解释。")).toBe(1200);
    } finally { await s.close(); }
  });
  it("keeps complete audio and final recognition flowing while partial decoding is stalled", async () => {
    const { s, p, events } = await setup(); let release!: () => void, fullBytes = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    p.recognize = async () => { await held; return "停"; };
    (p as LiveProvider).finalRecognition = async pcm => { fullBytes = Buffer.from(pcm, "base64").length; return "小伴，小陈希望周四收到方案。"; };
    const voiced = Buffer.alloc(640); for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(5000, i);
    try {
      for (let i = 0; i < 200; i++) { s.audio(voiced, "user"); await delay(1); }
      for (let i = 0; i < 35; i++) { s.audio(Buffer.alloc(640), "user"); await delay(1); }
      await waitFor(events, "completed");
      expect(fullBytes).toBeGreaterThanOrEqual(200 * 640);
      expect(p.calls.map(c => c.query)).toEqual(["小伴，小陈希望周四收到方案。"]);
      expect(events.some(e => e.type === "input_timing" && e.partialCoverageLimited === true)).toBe(true);
      expect(events.some(e => e.type === "error")).toBe(false);
      expect(s.inputDiagnostics().pendingFrames).toBeLessThan(5);
      await s.text("换个话题"); const offset = events.length; release(); await delay(30);
      expect(events.slice(offset).some(e => e.type === "transcript" && e.text === "停")).toBe(false);
    } finally { release(); await s.close(); }
  });
  it("rechecks the entire captured utterance when no full-utterance recognizer is available", async () => {
    const { s, p, events } = await setup(); let release!: () => void, finalBytes = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    p.recognize = async (_id: string, pcm: string, final: boolean) => { if (!final) { await held; return "不完整"; } finalBytes = Buffer.from(pcm, "base64").length; return "小伴，小陈希望周四收到报价。"; };
    const voiced = Buffer.alloc(640); for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(5000, i);
    try {
      for (let i = 0; i < 150; i++) { s.audio(voiced, "user"); await delay(1); }
      for (let i = 0; i < 35; i++) { s.audio(Buffer.alloc(640), "user"); await delay(1); }
      expect(s.inputDiagnostics().pendingFrames).toBeLessThan(5);
      release(); await waitFor(events, "completed");
      expect(finalBytes).toBeGreaterThanOrEqual(150 * 640);
      expect(p.calls.map(c => c.query)).toEqual(["小伴，小陈希望周四收到报价。"]);
      expect(events.some(e => e.type === "error")).toBe(false);
    } finally { release(); await s.close(); }
  });
  it("bounds queued audio by duration even when clients use large packets", async () => {
    const { s, p } = await setup(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    p.recognize = async () => { await held; return "小伴，会议几点？"; };
    const second = Buffer.alloc(32000); for (let i = 0; i < second.length; i += 2) second.writeInt16LE(5000, i);
    try {
      s.audio(second, "user"); s.audio(second, "user");
      expect(s.inputDiagnostics().pendingAudioMs).toBe(2000);
      expect(() => s.audio(Buffer.alloc(2), "user")).toThrow("audio_backpressure");
      expect(() => s.audio(Buffer.alloc(0), "user")).toThrow("invalid_audio_frame");
      release(); await s.close(); expect(s.inputDiagnostics().pendingAudioMs).toBe(0);
    } finally { release(); await s.close(); }
  });
  it("also bounds tiny-packet floods without granting them seconds of buffering", async () => {
    const { s } = await setup();
    try { for (let i = 0; i < 200; i++) s.audio(Buffer.alloc(2), "user"); expect(() => s.audio(Buffer.alloc(2), "user")).toThrow("audio_backpressure"); }
    finally { await s.close(); }
  });
  it("does not wait for a slow control probe when the streaming recognizer already heard stop", async () => {
    const { s, events, p } = await setup(); let release!: (text: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    (p as LiveProvider).finalRecognition = async () => held;
    (p as LiveProvider).recognize = async (_id, _pcm, final) => final ? "停" : "听";
    try {
      await s.text("先说一段话"); await waitFor(events, "completed"); s.playback(true);
      const pcm = Buffer.alloc(640); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
      for (let i = 0; i < 20; i++) { s.audio(pcm, "user"); await delay(1); }
      for (let i = 0; i < 100; i++) { s.audio(Buffer.alloc(640), "user"); await delay(1); }
      expect(events.some(e => e.type === "transcript" && e.text === "停" && e.final === true)).toBe(true);
      expect(p.calls).toHaveLength(1);
    } finally { release("听"); await s.close(); }
  });
  it("keeps input flowing during a slow control probe and cannot stop a newer typed request", async () => {
    const { s, events, p } = await setup(); let probes = 0, recognized = 0, release!: (text: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    (p as LiveProvider).finalRecognition = async () => { probes++; return held; };
    p.recognize = async () => { recognized++; return "明天下午三点开会"; };
    try {
      await s.text("先说一段话"); await waitFor(events, "completed"); s.playback(true);
      const pcm = Buffer.alloc(640); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
      for (let i = 0; i < 80; i++) { s.audio(pcm, "user"); await delay(1); }
      await delay(20); expect(probes).toBe(1); expect(recognized).toBeGreaterThan(5);
      events.length = 0; await s.text("这是更新后的问题"); await waitFor(events, "completed");
      const offset = events.length; release("停"); await delay(20);
      expect(events.slice(offset).some(e => e.type === "interrupted")).toBe(false);
      expect(p.calls).toHaveLength(2);
    } finally { release("停"); await s.close(); }
  });
  it("keeps capture flowing during final rechecking and drops the result after an explicit stop", async () => {
    const { s, events, p } = await setup(); let release!: (text: string) => void, checks = 0, recognized = 0;
    const held = new Promise<string>(resolve => { release = resolve; });
    (p as LiveProvider).finalRecognition = async () => { checks++; return held; };
    p.recognize = async () => { recognized++; return "小伴，会议几点？"; };
    const pcm = Buffer.alloc(640); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
    try {
      for (let i = 0; i < 20; i++) { s.audio(pcm, "user"); await delay(1); }
      for (let i = 0; i < 40; i++) { s.audio(Buffer.alloc(640), "user"); await delay(1); }
      expect(checks).toBe(1); const calls = recognized;
      // Longer than the realtime frame queue, while the whole-utterance model is held.
      for (let i = 0; i < 100; i++) { s.audio(Buffer.alloc(640), "user"); await delay(1); }
      expect(s.inputDiagnostics().pendingFrames).toBeLessThan(5);
      expect(recognized).toBe(calls);
      s.interrupt(); const offset = events.length; release("小伴，会议几点？"); await delay(30);
      expect(events.slice(offset).some(e => e.type === "text_delta" || e.type === "audio")).toBe(false);
      expect(p.calls).toHaveLength(0);
    } finally { release("小伴，会议几点？"); await s.close(); }
  });
  it("preserves two ordered voice utterances while the first final recheck is slow", async () => {
    const { s, p } = await setup(); let release!: (text: string) => void, checks = 0;
    const held = new Promise<string>(resolve => { release = resolve; });
    (p as LiveProvider).finalRecognition = async () => ++checks === 1 ? held : "小伴，现在改成周五。";
    p.recognize = async () => "小伴，记住周四。";
    const pcm = Buffer.alloc(640); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
    try {
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 20; i++) { s.audio(pcm, "user"); await delay(1); }
        for (let i = 0; i < 35; i++) { s.audio(Buffer.alloc(640), "user"); await delay(1); }
      }
      expect(s.inputDiagnostics().pendingFinalizations).toBe(2);
      release("小伴，先记住周四。");
      for (let i = 0; i < 100 && p.calls.length < 2; i++) await delay(5);
      expect(p.calls.map(c => c.query)).toEqual(["小伴，先记住周四。", "小伴，现在改成周五。"]);
    } finally { release("小伴，先记住周四。"); await s.close(); }
  });
  it("reports final-recognition overload and prevents queued old replies from resuming", async () => {
    const { s, p, events } = await setup(); let release!: (text: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    (p as LiveProvider).finalRecognition = async () => held;
    p.recognize = async () => "小伴，会议几点？";
    const pcm = Buffer.alloc(640); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
    try {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 20; i++) { s.audio(pcm, "user"); await delay(1); }
        for (let i = 0; i < 35; i++) { s.audio(Buffer.alloc(640), "user"); await delay(1); }
      }
      expect(events.some(e => e.type === "error" && e.code === "audio_backpressure")).toBe(true);
      release("小伴，会议几点？"); await delay(30);
      expect(p.calls).toHaveLength(0);
    } finally { release("小伴，会议几点？"); await s.close(); }
  });
  it("keeps decorative tails in text without sending them to speech synthesis", async () => {
    const { s, events, p } = await setup(); const spoken: string[] = [];
    p.reply = async function* () { yield { type: "text", text: "这是一段完整的中文解释。" }; yield { type: "text", text: "✨\n***" }; };
    p.synthesize = async function* (text: string) { spoken.push(text); yield { type: "audio", pcm: Buffer.alloc(160).toString("base64"), sampleRate: 24000 }; };
    try {
      await s.text("请解释一下。"); await waitFor(events, "completed"); const completed = events.find(e => e.type === "completed")!;
      expect(completed.answer).toBe("这是一段完整的中文解释。✨\n***");
      expect(spoken).toEqual(["这是一段完整的中文解释。"]);
    } finally { await s.close(); }
  });
  it("allows a follow-up after a long reply using playback end rather than the old question time", async () => {
    const { s, events, p } = await setup(); let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await s.text("小伴，说说面谈准备。", "voice"); await waitFor(events, "completed");
      now += 35_000; s.playback(false); now += 1000;
      const count = p.calls.length; events.length = 0;
      await s.text("再具体说一点。", "voice"); await waitFor(events, "completed");
      expect(p.calls).toHaveLength(count + 1);
    } finally { clock.mockRestore(); await s.close(); }
  });
  it("still requires addressing in quiet mode after a recent playback", async () => {
    const { s, p } = await setup();
    try { s.persona.participation = "quiet"; s.playback(false); await s.text("再具体说一点。", "voice"); await delay(15); expect(p.calls).toHaveLength(0); }
    finally { await s.close(); }
  });
  it("does not save or prepare a stopped turn after delayed history validation", async () => {
    const p = new Provider(), root = await temp();
    let release!: () => void, entered!: () => void, writes = 0, contexts = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const s = new LiveSession("phone", structuredClone(PERSONAS[0]!), p, p, undefined,
      async () => { contexts++; return { scene: [], confirmed: [], work: [] }; }, () => {}, root, undefined, false,
      { async filterHistory(history) { entered(); await barrier; return history; }, async validate() {}, async validateHistory() {}, async authorizeExternal() {},
        async persist(_file, _history, write) { writes++; await write(); } });
    try {
      const pending = s.text("这轮在准备时停止"); await waiting;
      s.interrupt(); release(); await pending;
      expect(writes).toBe(0); expect(contexts).toBe(0); expect(p.calls).toHaveLength(0);
    } finally { release(); await s.close(); }
  });
  it("streams text and audio under ordered session and turn identifiers", async () => {
    const { s, events } = await setup();
    await s.text("会议几点？");
    await waitFor(events, "completed");
    const text = events.find((e) => e.type === "text_delta")!,
      audio = events.find((e) => e.type === "audio")!;
    expect(text.turnId).toBe(audio.turnId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_e, i) => i + 1));
    await s.close();
  });
  it("drops a delayed old reply after interruption", async () => {
    const { s, events, p } = await setup();
    p.latency = 40;
    await s.text("第一问");
    s.interrupt();
    await delay(80);
    expect(events.some((e) => e.type === "audio")).toBe(false);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    await s.close();
  });
  it("new turn wins over a slow old turn", async () => {
    const { s, events, p } = await setup();
    p.latency = 30;
    await s.text("第一问");
    await s.text("第二问");
    await waitFor(events, "completed");
    expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn_started").at(-1)?.query).toBe(
      "第二问",
    );
    await s.close();
  });
  it("voice commands require addressing the companion before harness execution", async () => {
    let called = false;
    const h: HarnessAdapter = {
      routes: () => [{ id: "x", provider: "x", model: "x" }],
      cancelSupported: false,
      async *reply() {
        called = true;
        yield { type: "text", text: "已处理" };
      },
      async close() {},
    };
    const { s, events } = await setup(h);
    await s.text("生成方案文件", "voice");
    expect(called).toBe(false);
    expect(
      events.some((e) => e.code === "address_companion_for_harness_task"),
    ).toBe(true);
    await s.text("小伴生成方案文件", "voice");
    await waitFor(events, "completed");
    expect(called).toBe(true);
    await s.close();
  });
  it("ambient input cannot execute a host task", async () => {
    const { s, p } = await setup();
    s.persona.participation = "active";
    await s.text("运行脚本生成文件", "ambient");
    await delay(20);
    expect(p.calls).toHaveLength(0);
    await s.close();
  });
  it("eligible active suggestions stay local", async () => {
    let called = false;
    const h: HarnessAdapter = {
      routes: () => [{ id: "x", provider: "x", model: "x" }],
      cancelSupported: false,
      async *reply() {
        called = true;
        yield { type: "text", text: "wrong" };
      },
      async close() {},
    };
    const { s, p, events } = await setup(h);
    s.persona.participation = "active";
    await s.text("写方案有什么建议", "ambient");
    await waitFor(events, "completed");
    expect(called).toBe(false);
    expect(p.calls).toHaveLength(1);
    await s.close();
  });
  it("quiet mode ignores ambient speech", async () => {
    const { s, p } = await setup();
    s.persona.participation = "quiet";
    await s.text("你觉得呢", "ambient");
    expect(p.calls).toHaveLength(0);
    await s.close();
  });
  it("missing harness prompts configuration instead of fabricating a result", async () => {
    const { s, p, events } = await setup();
    await s.text("生成方案文件");
    await waitFor(events, "configuration_required");
    expect(p.calls).toHaveLength(0);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    await s.close();
  });
  it("persists completed turns and restores them on restart", async () => {
    const { s, p, events, root } = await setup();
    await s.text("记住三点");
    await waitFor(events, "completed");
    await s.close();
    const next = new LiveSession(
      "device-fixture",
      PERSONAS[0]!,
      p,
      p,
      undefined,
      async () => ({ scene: [], confirmed: [], work: [] }),
      () => {},
      root,
    );
    await next.text("那几点？");
    await delay(40);
    expect(p.calls.at(-1)?.history[0]?.content).toBe("记住三点");
    await next.close();
  });
  it("rejects oversized audio and clears recognition on close", async () => {
    const { s } = await setup();
    expect(() => s.audio(Buffer.alloc(32002), "user")).toThrow(
      "invalid_audio_frame",
    );
    await s.close();
  });
  it("preserves partial text on provider failure without completed event", async () => {
    const { s, p, events } = await setup();
    p.error = true;
    await s.text("说点什么");
    await waitFor(events, "error");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    await s.close();
  });
});
describe("personas and boundaries", () => {
  it("keeps file addresses on screen without speaking a UUID or private path", () => {
    expect(spokenPhrase("文件在 /Users/example/task/result.md。")).toBe(
      "文件在 屏幕上的地址。",
    );
    expect(spokenPhrase("文件名是 live-plan-123abc.md。")).toBe(
      "文件名是 这个文件。",
    );
  });
  it("round trips edited personas without writing evidence", async () => {
    const root = await temp(),
      store = new PersonaStore(root);
    const p = {
      ...PERSONAS[0]!,
      background: "自定义角色",
      catchphrases: ["走起"],
    };
    await store.write("fixture", p);
    expect(await store.read("fixture")).toEqual(p);
    expect(await fs.readdir(root)).toEqual(["live"]);
  });
  it("rejects traversal, invalid modes and unbounded catchphrases", async () => {
    const store = new PersonaStore(await temp());
    await expect(store.read("../secret")).rejects.toThrow();
    expect(() =>
      validatePersona({ ...PERSONAS[0], participation: "always" }),
    ).toThrow();
    expect(() =>
      validatePersona({ ...PERSONAS[0], catchphrases: Array(9).fill("x") }),
    ).toThrow();
  });
  it("matches playback across punctuation but preserves interruption controls", () => {
    expect(
      isLikelyEcho(
        "小陈周四收到方案预算三万元",
        "小陈周四收到方案，预算三万元。",
      ),
    ).toBe(true);
    expect(isLikelyEcho("等等", "小陈周四收到方案，预算三万元。")).toBe(false);
    expect(isLikelyEcho("收", "收到，周四收到方案。")).toBe(true);
    expect(isLikelyEcho("停", "停止之前先确认时间。")).toBe(false);
    expect(isLikelyEcho("不对是周三", "小陈周四收到方案，预算三万元。")).toBe(
      false,
    );
    expect(isLikelyEcho("预算是3万元", "预算是三万元。")).toBe(true);
    expect(isLikelyEcho("小陈希望周四收到方案预算是4万元", "小陈希望周四收到方案，预算是三万元。")).toBe(false);
    expect(isLikelyEcho("小陈希望周三收到方案预算是三万元", "小陈希望周四收到方案，预算是三万元。")).toBe(false);
    expect(isLikelyEcho("不对小陈周四收到方案预算三万元", "小陈周四收到方案，预算三万元。")).toBe(false);
  });
  it("does not turn acknowledgements into tasks", () => {
    expect(isBackchannel("嗯，")).toBe(true);
    expect(isBackchannel("嗯，但是我想改时间")).toBe(false);
    expect(needsHarness("用更强模型做深入分析")).toBe(true);
    expect(needsHarness("会议几点")).toBe(false);
    expect(unfinished("因为")).toBe(true);
  });
  it("coalesces comma clauses until sentence completion and preserves the full text", () => {
    const b = new PhraseBuffer();
    expect(b.add("我们下午三点见，")).toEqual([]);
    expect(b.add("别忘了带电脑")).toEqual([]);
    expect(b.add("", true)).toEqual(["我们下午三点见，别忘了带电脑"]);
  });
  it("can flush a stalled comma while retaining later incomplete text", () => {
    const b = new PhraseBuffer();
    expect(b.add("好的，")).toEqual([]);
    expect(b.add("小陈希望周四收到方案，后面的内容还在生成")).toEqual([]);
    expect(b.flushPause()).toEqual(["好的，小陈希望周四收到方案，"]);
    expect(b.add("", true)).toEqual(["后面的内容还在生成"]);
  });
  it("starts speech before a prefixed streamed reply has finished generating", async () => {
    const { s, events, p } = await setup();
    let finish!: () => void;
    const release = new Promise<void>(resolve => { finish = resolve; });
    p.reply = async function* () {
      yield { type: "text", text: "好的，小陈希望周四收到方案，" };
      await release;
      yield { type: "text", text: "预算四万元。" };
    };
    try {
      await s.text("请复述小陈的需求。");
      await waitFor(events, "audio");
      expect(events.some(e => e.type === "completed")).toBe(false);
    } finally { finish(); await s.close(); }
  });
  it("reports preparation and PCM emission separately from audible playback", async () => {
    const { s, events } = await setup();
    await s.text("会议几点？"); await waitFor(events, "completed");
    const timings = events.find(e => e.type === "completed")!.timings as any;
    expect(timings).toMatchObject({ version: 1, input: "text", endpoint: "host-pcm-emitted" });
    expect(timings.milestonesMs.firstHostAudio).toBeGreaterThanOrEqual(timings.milestonesMs.inputPrepared);
    expect(timings.spans.inputCheckpoint.count).toBe(1);
    expect(timings.spans.contextBuild.count).toBe(1);
    expect(timings.spans.outputCheckpoint.count).toBe(1);
    await s.close();
  });
  it("requires explicit live opt-in and distinct valid service config", () => {
    expect(parseLiveConfig(undefined)).toBeUndefined();
    expect(parseLiveConfig({ enabled: false })).toBeUndefined();
    expect(() => parseLiveConfig({ enabled: true })).toThrow();
  });
});

it("spoken stop controls do not generate another answer or claim a task was cancelled", async () => {
  const { s, p, events } = await setup();
  await s.text("停止说话", "voice");
  await s.text("取消任务", "user");
  await s.text("停止感知", "user");
  expect(p.calls).toHaveLength(0);
  expect(events.some((e) => e.code === "task_cancel_unavailable")).toBe(true);
  expect(
    events.some(
      (e) => e.type === "client_control" && e.command === "stop_sensing",
    ),
  ).toBe(true);
  await s.close();
});
it("public mode omits private conversation history", async () => {
  const { s, p, events } = await setup();
  s.persona = { ...s.persona, publicScene: false };
  await s.text("这是私人信息，不在公开模式使用");
  await waitFor(events, "completed");
  s.setPersona({ ...s.persona, publicScene: true });
  await s.text("公开聊一下刚才的场景");
  await delay(30);
  expect(
    p.calls.at(-1)?.history.some((m) => m.content.includes("私人信息")),
  ).toBe(false);
  await s.close();
});
it("playback credits bound buffered audio and interruption clears a blocked producer", async () => {
  const root = await temp(),
    provider = new Provider(),
    events: LiveEvent[] = [];
  provider.synthesize = async function* () {
    for (let i = 0; i < 20; i++)
      yield {
        type: "audio" as const,
        pcm: Buffer.alloc(24000).toString("base64"),
        sampleRate: 24000,
      };
  };
  const session = new LiveSession(
    "credit-device",
    PERSONAS[0]!,
    provider,
    provider,
    undefined,
    async () => ({ scene: [], confirmed: [], work: [] }),
    (e) => events.push(e),
    root,
    undefined,
    true,
  );
  await session.text("你好");
  await delay(25);
  expect(events.filter((e) => e.type === "audio")).toHaveLength(4);
  session.acknowledgeAudio(events.find((e) => e.type === "audio")!.seq);
  await delay(15);
  expect(events.filter((e) => e.type === "audio")).toHaveLength(5);
  session.interrupt();
  await delay(20);
  expect(events.filter((e) => e.type === "audio")).toHaveLength(5);
  const a = session.close(),
    b = session.close();
  expect(a).toBe(b);
  await a;
});

it("explicitly enabled local fallback hands off once to the authorized harness", async () => {
  let calls = 0;
  const h: HarnessAdapter = {
    routes: () => [{ id: "x", provider: "x", model: "x" }],
    cancelSupported: false,
    async *reply() {
      calls++;
      yield { type: "text", text: "这是宿主的回答。" };
    },
    async close() {},
  };
  const { s, p, events } = await setup(h, true);
  p.reply = async function* () {
    throw new Error("model_runtimeerror");
  };
  await s.text("请解释一下");
  await waitFor(events, "completed");
  expect(calls).toBe(1);
  expect(events.find((e) => e.type === "completed")?.answer).toContain("宿主");
  await s.close();
});

it("compares microphone echo with the current phrase before the model completes", async () => {
  const { s, p, events } = await setup();
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  p.synthesize = async function* (_t: string, _p: any, signal: AbortSignal) {
    if (!signal.aborted) yield { type: "audio" as const, pcm: Buffer.alloc(160).toString("base64"), sampleRate: 24000 };
    await held;
  };
  let recognitionCalls = 0;
  p.recognize = async () => ++recognitionCalls === 1 ? "我" : "我记住了明天下午三点开会";
  await s.text("会议几点？"); await waitFor(events, "audio");
  s.playback(true);
  const before = events.filter(e=>e.type==="interrupted").length;
  const voiced=Buffer.alloc(19200); for(let i=0;i<voiced.length;i+=2)voiced.writeInt16LE(1600,i);
  s.audio(voiced,"user");
  for(let i=0;i<40;i++)s.audio(Buffer.alloc(640),"user");
  await delay(80);
  expect(events.filter(e=>e.type==="interrupted")).toHaveLength(before);
  expect(p.calls).toHaveLength(1);
  release(); await waitFor(events,"completed"); await s.close();
});

it("does not invite background speech just by opening Live", async()=>{
 const {s,p}=await setup();
 await s.text("明天下午三点开会", "voice");
 await delay(20);
 expect(p.calls).toHaveLength(0);
 await s.close();
});

it("local model failure does not silently disclose to a configured harness", async()=>{
 let called=false;
 const h: HarnessAdapter={routes:()=>[{id:"x",provider:"x",model:"x"}],cancelSupported:false,async *reply(){called=true;yield {type:"text",text:"external"};},async close(){}};
 const {s,p,events}=await setup(h); p.error=true;
 await s.text("小伴，会议几点？"); await waitFor(events,"configuration_required");
 expect(called).toBe(false);
 expect(events.some(e=>e.code==="local_harness_fallback_requires_choice")).toBe(true);
 await s.close();
});

it("a deletion invalidation drops a recognition that was already in flight", async()=>{
 const {s,p,events}=await setup();
 let enter!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{enter=r;}); const held=new Promise<void>(r=>{release=r;});
 p.recognize=async()=>{enter();await held;return "deleted private content";};
 const voiced=Buffer.alloc(19200);for(let i=0;i<voiced.length;i+=2)voiced.writeInt16LE(1600,i);
 s.audio(voiced,"user");await started;s.invalidateContext();release();await delay(30);
 expect(events.some(e=>e.type==="transcript" && e.text==="deleted private content")).toBe(false);
 await s.close();
});

it("a recognized partial stop stays stopped even if final ASR revises the word",async()=>{
 const {s,p,events}=await setup();let release!:()=>void;
 const held=new Promise<void>(r=>{release=r;});
 p.synthesize=async function*(){yield {type:"audio" as const,pcm:Buffer.alloc(160).toString("base64"),sampleRate:24000};await held;};
 let calls=0;p.recognize=async()=>++calls===1?"停":"听";
 await s.text("说话测试");await waitFor(events,"audio");s.playback(true);
 const voiced=Buffer.alloc(19200);for(let i=0;i<voiced.length;i+=2)voiced.writeInt16LE(1600,i);
 s.audio(voiced,"user");for(let i=0;i<40;i++)s.audio(Buffer.alloc(640),"user");await delay(80);
 expect(p.calls).toHaveLength(1);expect(events.some(e=>e.code==="speech_stopped_task_unchanged")).toBe(true);
 release();await s.close();
});

it("public speech cannot use a harness whose own tools retain private project access",async()=>{
 let called=false;
 const h:HarnessAdapter={routes:()=>[{id:"x",provider:"x",model:"x"}],cancelSupported:false,async *reply(){called=true;yield {type:"text",text:"private"};},async close(){}};
 const {s,events}=await setup(h);s.persona={...s.persona,publicScene:true};
 await s.text("用更强模型查询资料");await waitFor(events,"configuration_required");
 expect(events.some(e=>e.code==="public_harness_not_available")).toBe(true);expect(called).toBe(false);await s.close();
});

it("retains communication-channel speech below the legacy MIC gate",async()=>{
 const {s,events}=await setup();
 const quietSpeech=Buffer.alloc(19200);for(let i=0;i<quietSpeech.length;i+=2)quietSpeech.writeInt16LE(90,i);
 s.audio(quietSpeech,"user");for(let i=0;i<40;i++)s.audio(Buffer.alloc(640),"user");await delay(60);
 expect(events.some(e=>e.type==="transcript")).toBe(true);await s.close();
});

it("final recheck cannot turn a recognized stop into another request",async()=>{
 const {s,p,events}=await setup();
 p.recognize=async()=>"停";
 (p as any).finalRecognition=async()=>"听";
 const voiced=Buffer.alloc(19200);for(let i=0;i<voiced.length;i+=2)voiced.writeInt16LE(1600,i);
 s.audio(voiced,"user");for(let i=0;i<40;i++)s.audio(Buffer.alloc(640),"user");await delay(80);
 expect(p.calls).toHaveLength(0);expect(events.some(e=>e.code==="speech_stopped_task_unchanged")).toBe(true);await s.close();
});
