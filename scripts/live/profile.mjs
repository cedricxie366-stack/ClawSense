/** Owned-computer model timing; synthetic text only, no microphone or public service. */
import fs from "node:fs/promises";
import path from "node:path";
import { LocalLiveProvider } from "../../dist/src/live/local-provider.js";
import { LiveSession } from "../../dist/src/live/session.js";
import { PERSONAS } from "../../dist/src/live/persona.js";
import { unifiedContext } from "../../dist/src/context-store.js";
import { liveContextHooks, liveAccess } from "../../dist/src/live/context.js";

const configFile = path.resolve(process.argv[2] ?? ".local/p1-p2-2026-10-15/config.json");
const root = path.resolve(process.argv[3] ?? ".local/live-profile");
const count = Number(process.argv[4] ?? 10);
const withContext = process.argv[5] === "--context";
if (!Number.isInteger(count) || count < 1 || count > 100) throw Error("invalid_round_count");
await fs.mkdir(root, { recursive: true, mode: 0o700 });
// Avoid starting unrelated vision and task engines for a response-only measurement.
const cfg = { ...JSON.parse(await fs.readFile(configFile, "utf8")).live, visionModel: undefined, vadModel: undefined, dsh: undefined, codex: undefined };
const provider = new LocalLiveProvider(cfg);
const events = [];
const context = {
  scene: { transcript: [{ text: "小陈希望周四收到方案，预算三万元。" }, { text: "会议改到明天下午三点，资料周五发送。" }] },
  confirmed: [{ text: "小陈希望周四收到方案，预算四万元。" }], work: [],
};
let store, hooks;
if (withContext) {
  store = unifiedContext(root); await store.initialize();
  await store.setDevicePolicy("profile-synthetic", { projectIds: ["live"], audience: "private", processingLocation: "owned-devices", allowedRecipients: [] }, { actor: "local-owner", owner: true });
  const history = [], refs = [], access = liveAccess("profile-synthetic");
  // Seed a full recent conversation with cumulative evidence, like repeated actual turns.
  for (let i = 0; i < 100; i++) {
    refs.push(await store.recordLiveObservation("profile-synthetic", "live", { text: "合成校准记录" + i, digest: String(i).padStart(64, "0"), capturedAt: Date.now(), modality: "audio" }, access));
    const snapshot = await store.snapshot(refs, access);
    for (const role of ["user", "assistant"]) history.push({ role, content: role === "user" ? "这是合成校准记录。" : "收到。", contextSnapshotId: snapshot.snapshotId, at: Date.now() });
  }
  const file = path.join(root, "live/conversations/profile-synthetic.json");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ history }), { mode: 0o600 });
  hooks = liveContextHooks(store, "profile-synthetic", "live", async () => true);
}
const session = new LiveSession("profile-synthetic", structuredClone(PERSONAS[0]), provider, provider, undefined,
  async () => store ? { ...context, contextSnapshotId: (await store.snapshot([], liveAccess("profile-synthetic"))).snapshotId } : context,
  event => events.push(event), root, undefined, false, hooks);
const queries = ["简短说一下小陈的需求。", "小陈希望什么时候收到方案？", "小陈的预算是多少？", "会议安排在几点？", "请用一句话复述小陈的约定。"];
const report = { startedAt: new Date().toISOString(), input: "synthetic text", withContext, seededMessages: withContext ? 200 : 0, phoneUsed: false, microphoneUsed: false, endpoint: "host PCM emitted, not audible Android playback", turns: [], failures: [] };
const output = path.join(root, "profile.json");
const save = () => fs.writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
try {
  const start = performance.now();
  const capabilities = await provider.capabilities();
  report.startupMs = performance.now() - start;
  if (!capabilities.ready) throw Error(capabilities.reason);
  console.log(JSON.stringify({ type: "ready", startupMs: report.startupMs }));
  for (let round = 0; round < count; round++) {
    const query = queries[round % queries.length];
    const first = events.length, began = performance.now();
    await session.text(query);
    const deadline = Date.now() + 120000;
    let done;
    while (!(done = events.slice(first).find(e => ["completed", "error", "configuration_required"].includes(e.type)))) {
      if (Date.now() > deadline) throw Error("turn_timeout");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const turnEvents = events.slice(first);
    const item = { round, query, event: done.type, answer: done.answer, code: done.code,
      firstTextMs: done.firstTextMs, firstAudioMs: done.firstAudioMs, contextMs: done.contextMs,
      timings: done.timings, totalMs: performance.now() - began,
      audioPackets: turnEvents.filter(e => e.type === "audio").length };
    report.turns.push(item);
    if (done.type !== "completed") report.failures.push(done.code ?? done.type);
    console.log(JSON.stringify(item)); await save();
  }
} catch (error) { report.failures.push(error.message); process.exitCode = 1; }
finally {
  await session.close(); await provider.close(); await store?.release();
  report.completedAt = new Date().toISOString(); await save();
}
