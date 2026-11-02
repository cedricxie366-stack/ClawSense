import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LocalLiveProvider } from "../../dist/src/live/local-provider.js";
import { LiveSession } from "../../dist/src/live/session.js";
import { PERSONAS } from "../../dist/src/live/persona.js";
const root = path.resolve(process.argv[2] ?? ".local/live"),
  duration = Number(process.argv[3] ?? 1800) * 1000;
const cfg = JSON.parse(
    await fs.readFile(path.join(root, "config.json"), "utf8"),
  ).live,
  provider = new LocalLiveProvider(cfg),
  events = [];
const report = {
  startedAt: new Date().toISOString(),
  requestedDurationMs: duration,
  phoneUsed: false,
  fixture: "synthetic controlled office facts",
  turns: [],
  failures: [],
  interruptions: [],
  rssSamples: [],
};
const file = path.join(root, "stability.json");
const save = () => fs.writeFile(file, JSON.stringify(report, null, 2));
const context = {
  scene: {
    commitment: { recipient: "小陈", deliveryDay: "周四", budget: "三万元" },
    meeting: { timeOriginal: "明天下午三点", date: "未确认具体日期" },
  },
  confirmed: [
    {
      text: "方案给小陈，周四收到，预算三万元。会议为明天下午三点，不能把周四拼接成会议日期。",
    },
  ],
  work: [],
};
const session = new LiveSession(
  "stability-device",
  structuredClone(PERSONAS[0]),
  provider,
  provider,
  undefined,
  async () => context,
  (e) => events.push(e),
  path.join(root, "stability-state"),
);
const queries = [
  "小陈希望哪天收到方案？",
  "预算是多少？",
  "那方案接收方是谁？",
  "明天会议几点？",
  "简短说一下这两件事。",
];
try {
  const caps = await provider.capabilities();
  if (!caps.ready) throw new Error(caps.reason);
  report.capabilities = caps;
  console.log("models_ready");
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < duration) {
    const before = events.length;
    const query = queries[i++ % queries.length];
    await session.text(query);
    const until = Date.now() + 120000;
    let end;
    while (Date.now() < until) {
      end = events
        .slice(before)
        .find((e) => e.type === "completed" || e.type === "error");
      if (end) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!end) throw new Error("stability_turn_timeout");
    report.turns.push({
      query,
      answer: end.answer,
      firstAudioMs: end.firstAudioMs,
      durationMs: end.durationMs,
      event: end.type,
    });
    if (end.type === "error") report.failures.push(end.code);
    if (i % 5 === 0) {
      const seq = events.length;
      await session.text("请详细说明现场两项约定。");
      const stopStart = performance.now();
      session.interrupt();
      await new Promise((r) => setTimeout(r, 200));
      report.interruptions.push({
        durationMs: performance.now() - stopStart,
        staleAudioPackets: events.slice(seq).filter((e) => e.type === "audio")
          .length,
      });
    }
    try {
      const child = (
        await promisify(execFile)("pgrep", ["-P", String(process.pid)])
      ).stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const rss = (
        await promisify(execFile)("ps", [
          "-o",
          "rss=",
          "-p",
          [process.pid, ...child].join(","),
        ])
      ).stdout
        .trim()
        .split(/\s+/)
        .reduce((sum, x) => sum + Number(x), 0);
      report.rssSamples.push({
        elapsedMs: Date.now() - start,
        combinedRssMiB: rss / 1024,
      });
    } catch {}
    report.elapsedMs = Date.now() - start;
    await save();
    console.log(
      JSON.stringify({
        turn: i,
        elapsedSeconds: Math.round(report.elapsedMs / 1000),
        firstAudioMs: end.firstAudioMs,
        failures: report.failures.length,
      }),
    );
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(15000, Math.max(0, duration - (Date.now() - start))),
      ),
    );
  }
  report.elapsedMs = Date.now() - start;
  report.completedAt = new Date().toISOString();
  const warm = report.turns
    .slice(1)
    .map((t) => t.firstAudioMs)
    .filter((x) => typeof x === "number")
    .sort((a, b) => a - b);
  report.warmFirstAudio = {
    p50: warm[Math.floor(warm.length * 0.5)],
    p95: warm[Math.min(warm.length - 1, Math.floor(warm.length * 0.95))],
  };
} catch (e) {
  report.failures.push(e.message);
  process.exitCode = 1;
} finally {
  await session.close();
  await provider.close();
  await save();
  console.log(
    "finished",
    JSON.stringify({
      elapsedMs: report.elapsedMs,
      turns: report.turns.length,
      failures: report.failures,
      warmFirstAudio: report.warmFirstAudio,
    }),
  );
}
