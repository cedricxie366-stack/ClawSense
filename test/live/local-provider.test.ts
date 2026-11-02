import { expect, it, vi } from "vitest";
import { LocalLiveProvider, reliableVisualDescription, liveVoiceProfile } from "../../src/live/local-provider.js";
import { PERSONAS } from "../../src/live/persona.js";
const fixture = vi.hoisted(() => ({ roles: [] as string[], calls: [] as string[], active: 0, peak: 0, closed: 0, analysis: 0, analysisPeak: 0, generation: 1 }));
it("keeps sampling tied to the chosen voice and style across unrelated requests", () => {
  const profile = { voice: "Vivian", style: "自然、清楚、温和" };
  const before = liveVoiceProfile(profile);
  liveVoiceProfile({ voice: "Ryan", style: "平静" });
  expect(liveVoiceProfile(profile)).toEqual(before);
  expect(liveVoiceProfile({ ...profile, voice: "vivian" }).seed).toBe(before.seed);
  expect(liveVoiceProfile({ ...profile, voice: "Serena" }).seed).not.toBe(before.seed);
  expect(Number.isInteger(before.seed) && before.seed >= 0 && before.seed <= 0xffffffff).toBe(true);
});
vi.mock("../../src/live/process-rpc.js", () => ({ ProcessRpc: class {
  role: string;
  get processGeneration() { return fixture.generation; }
  constructor(_python: string, args: string[]) { this.role = args[args.indexOf("--role") + 1]!; fixture.roles.push(this.role); if (this.role === "vision") { fixture.active++; fixture.peak = Math.max(fixture.peak, fixture.active); } }
  async call(op: string) {
    fixture.calls.push(this.role + ":" + op);
    if (op === "probe") return [{ voices: ["Vivian"], styleControl: true }];
    if (this.role === "vision" && op === "describe") {
      fixture.analysis++; fixture.analysisPeak = Math.max(fixture.analysisPeak, fixture.analysis);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return [{ text: "合成图中的红色方形。" }]; }
      finally { fixture.analysis--; }
    }
    return [];
  }
  async *stream() {
    fixture.analysis++; fixture.analysisPeak = Math.max(fixture.analysisPeak, fixture.analysis);
    try { yield { type: "text", text: "受控语言模型结果。" }; await new Promise(resolve => setTimeout(resolve, 5)); }
    finally { fixture.analysis--; }
  }
  async close() { if (this.role === "vision") { fixture.active--; fixture.closed++; } }
} }));

it("reads literal questions and customer statements instead of answering or acknowledging their contents", async () => {
  const p=new LocalLiveProvider({enabled:true,host:"127.0.0.1",port:0,python:"fixture",worker:"fixture",llmModel:"fixture",ttsModel:"fixture",asrDir:"fixture"});
  const read=async(query:string)=>{let answer="";for await(const e of p.reply({sessionId:"literal",query,persona:PERSONAS[0]!,context:{scene:{currentFrame:{description:"旧画面"}},confirmed:[],work:[]},history:[]},new AbortController().signal)){if(e.type==="text")answer+=e.text;}return answer;};
  try {
    expect(await read("请完整朗读这句话：六加八是多少？")).toBe("六加八是多少？");
    expect(await read("请原样朗读：客户小李希望周五收到方案。" )).toBe("客户小李希望周五收到方案。");
    expect(await read("把“客户小李希望周五收到方案”翻译成英语。" )).toBe("受控语言模型结果。");
  } finally {await p.close();}
});

it("keeps voice readiness independent from vision residency and shares a serial visual worker only until released", async () => {
  fixture.roles.length = 0; fixture.active = fixture.peak = fixture.closed = 0;
  fixture.calls.length = 0;
  const provider = new LocalLiveProvider({ enabled: true, host: "127.0.0.1", port: 19490, python: "fixture", worker: "fixture", llmModel: "fixture", ttsModel: "fixture", asrDir: "fixture", visionModel: "on-demand" });
  try {
    expect((await provider.capabilities()).ready).toBe(true);
    expect(fixture.roles).not.toContain("vision");
    const frame = { jpeg: "fixture", capturedAt: Date.now(), ageMs: 0, requestId: "fixture", receivedAt: Date.now() };
    const signal = new AbortController().signal;
    const results = await Promise.all([provider.describeFrames([frame], "颜色？", signal), provider.describeFrames([frame], "形状？", signal)]);
    expect(results).toEqual(["合成图中的红色方形。", "合成图中的红色方形。"]);
    expect(fixture.calls).not.toContain("llm:idle"); expect(fixture.calls).toContain("vision:idle");
    await provider.cooldown();
    expect(fixture.calls).toContain("llm:idle"); expect(fixture.calls).toContain("tts:idle"); expect(fixture.calls).toContain("vision:idle");
    expect(fixture.peak).toBe(1); expect(fixture.closed).toBe(0); await provider.releaseVisual(); expect(fixture.closed).toBe(1); expect(fixture.active).toBe(0);
  } finally { await provider.close(); }
});

it("does not overlap heavy language and visual analysis or strand the lease after an aborted request", async () => {
  fixture.analysis = fixture.analysisPeak = 0;
  const provider = new LocalLiveProvider({ enabled: true, host: "127.0.0.1", port: 19490, python: "fixture", worker: "fixture", llmModel: "fixture", ttsModel: "fixture", asrDir: "fixture", visionModel: "fixture" });
  const input = { sessionId: "analysis-budget", query: "解释一下光的散射。", persona: { version: 1 as const, id: "fixture", name: "小伴", background: "", expression: "", catchphrases: [], voice: "Vivian", style: "", participation: "addressed" as const, cooldownMs: 30000, publicScene: false }, context: { scene: {}, confirmed: [], work: [] }, history: [] };
  const drain = async (signal = new AbortController().signal) => { for await (const _ of provider.reply(input, signal)) { /* drain */ } };
  try {
    await Promise.all([drain(), provider.describeFrames([{ jpeg: "fixture", requestId: "fixture", ageMs: 0, capturedAt: Date.now(), receivedAt: Date.now() }], "颜色？", new AbortController().signal)]);
    expect(fixture.analysisPeak).toBe(1);
    const cancelled = new AbortController(); cancelled.abort(); await expect(drain(cancelled.signal)).rejects.toThrow("aborted");
    await drain(); expect(fixture.analysis).toBe(0);
  } finally { await provider.close(); }
});

it("cannot infer motion or stillness from a single frame even if the model might guess", async () => {
  fixture.roles.length = 0;
  const provider = new LocalLiveProvider({ enabled: true, host: "127.0.0.1", port: 19490, python: "fixture", worker: "fixture", llmModel: "fixture", ttsModel: "fixture", asrDir: "fixture", visionModel: "fixture" });
  try {
    const answer = await provider.describeFrames([{ jpeg: "fixture", requestId: "fixture", ageMs: 0, capturedAt: Date.now(), receivedAt: Date.now() }], "发生了什么移动？", new AbortController().signal);
    expect(answer).toContain("无法判断"); expect(fixture.roles).not.toContain("vision");
  } finally { await provider.close(); }
});
it("rejects degenerate repeated captions without inventing a repaired observation", () => {
  expect(reliableVisualDescription("画面中有红色正方形和蓝色圆形。")).toBe(true);
  expect(reliableVisualDescription("画面中有：" + Array(15).fill("一个浅绿色的长条").join("、") + "。")).toBe(false);
  expect(reliableVisualDescription("")).toBe(false);
});
it("reuses prepared voice across reconnects without preloading vision, and invalidates it on cooldown", async () => {
  fixture.calls.length=0;fixture.roles.length=0;
  const p=new LocalLiveProvider({enabled:true,host:"127.0.0.1",port:0,python:"fixture",worker:"fixture",llmModel:"fixture",ttsModel:"fixture",asrDir:"fixture",visionModel:"fixture"});
  try {
    await p.capabilities();fixture.calls.length=0;
    await Promise.all([p.prepare(PERSONAS[0]!,{vision:true}),p.prepare(PERSONAS[0]!,{vision:true})]);
    expect(fixture.calls.filter(v=>v==="tts:probe")).toHaveLength(1);
    expect(fixture.calls.filter(v=>v==="llm:probe")).toHaveLength(1);
    expect(fixture.roles).not.toContain("vision");
    await p.cooldown();await p.prepare(PERSONAS[0]!);
    expect(fixture.calls.filter(v=>v==="tts:probe")).toHaveLength(2);
    await p.prepare({...PERSONAS[0]!,voice:"Serena"});
    expect(fixture.calls.filter(v=>v==="tts:probe")).toHaveLength(3);
    fixture.generation++; // A worker replacement invalidates the prepared path.
    await p.prepare({...PERSONAS[0]!,voice:"Serena"});
    expect(fixture.calls.filter(v=>v==="tts:probe")).toHaveLength(4);
  } finally {await p.close();}
});

it("refreshes idle stop recognition before playback without warming full streaming ASR or queueing duplicate probes", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  fixture.calls.length = 0;
  const p = new LocalLiveProvider({enabled:true,host:"127.0.0.1",port:0,python:"fixture",worker:"fixture",llmModel:"fixture",ttsModel:"fixture",asrDir:"fixture",asrRecheckDir:"fixture"});
  const speak = async () => { for await (const _ of p.synthesize("测试。", PERSONAS[0]!, new AbortController().signal)) { /* drain */ } };
  try {
    await p.capabilities(); await p.prepare(PERSONAS[0]!); fixture.calls.length = 0;
    clock.mockReturnValue(102100);
    await Promise.all([speak(), speak()]);
    expect(fixture.calls.filter(c => c === "final-asr:probe")).toHaveLength(1);
    expect(fixture.calls).not.toContain("asr:probe");
    fixture.calls.length = 0; clock.mockReturnValue(103000);
    await p.finalRecognition("fixture", new AbortController().signal);
    await speak();
    expect(fixture.calls).not.toContain("final-asr:probe");
  } finally { clock.mockRestore(); await p.close(); }
});
