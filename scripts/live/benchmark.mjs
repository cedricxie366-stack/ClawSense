import fs from "node:fs/promises";
import path from "node:path";
import {
  LocalLiveProvider,
  MiniCpmProvider,
} from "../../dist/src/live/local-provider.js";
import { LiveSession } from "../../dist/src/live/session.js";
import { PERSONAS } from "../../dist/src/live/persona.js";
const root = path.resolve(process.argv[2] ?? ".local/live");
const config = JSON.parse(
  await fs.readFile(path.join(root, "config.json"), "utf8"),
).live;
const provider = new LocalLiveProvider(config);
const report = {
  startedAt: new Date().toISOString(),
  hardware: "Apple M4 / 16GB",
  phoneUsed: false,
  models: JSON.parse(await fs.readFile(path.join(root, "models.json"), "utf8"))
    .models,
  turns: [],
  failures: [],
};
async function save() {
  await fs.writeFile(
    path.join(root, "benchmark.json"),
    JSON.stringify(report, null, 2),
  );
}
try {
  report.capabilities = await provider.capabilities();
  console.log("capabilities", JSON.stringify(report.capabilities));
  if (!report.capabilities.ready) throw new Error(report.capabilities.reason);
  const sample = [];
  const start = performance.now();
  let first;
  for await (const c of provider.synthesize(
    "小陈希望周四收到方案，预算是三万元。明天下午三点开会。",
    PERSONAS[0],
    new AbortController().signal,
  )) {
    first ??= performance.now() - start;
    sample.push(Buffer.from(c.pcm, "base64"));
  }
  const pcm = Buffer.concat(sample);
  report.speech = {
    firstChunkMs: first,
    durationMs: pcm.length / 48,
    bytes: pcm.length,
  };
  // Resample generated 24kHz speech to recognizer's 16kHz, without recording a microphone.
  const samples = [];
  for (let i = 0; i + 3 < pcm.length; i += 3) {
    const j = Math.floor(i / 2) * 2;
    samples.push(pcm.readInt16LE(Math.min(j, pcm.length - 2)));
  }
  const resampled = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => resampled.writeInt16LE(s, i * 2));
  let transcript = "";
  for (let i = 0; i < resampled.length; i += 19200)
    transcript = await provider.recognize(
      "synthetic-calibration",
      resampled.subarray(i, i + 19200).toString("base64"),
      false,
      new AbortController().signal,
    );
  transcript = await provider.recognize(
    "synthetic-calibration",
    Buffer.alloc(24000).toString("base64"),
    true,
    new AbortController().signal,
  );
  report.asr = { transcript, expectedFacts: ["周四", "三万", "三点"] };
  console.log("asr", JSON.stringify(report.asr));
  await fs.writeFile(path.join(root, "synthetic-speech.pcm"), pcm);
  const events = [];
  const context = {
    scene: {
      transcript: "小陈希望周四收到方案，预算是三万元。明天下午三点开会。",
    },
    confirmed: [{ fact: "方案接收方是小陈" }],
    work: [],
  };
  const session = new LiveSession(
    "benchmark-device",
    structuredClone(PERSONAS[0]),
    provider,
    provider,
    undefined,
    async () => context,
    (e) => events.push(e),
    path.join(root, "benchmark-state"),
  );
  const queries = [
    "明天会议几点？",
    "小陈希望哪天收到方案？",
    "预算是多少？",
    "那接收方是谁？",
    "简短说一下我们的约定。",
  ];
  for (const query of queries) {
    let baseline = events.length;
    await session.text(query);
    const until = Date.now() + 120000;
    let ended;
    while (Date.now() < until) {
      ended = events
        .slice(baseline)
        .find((e) =>
          ["completed", "error", "configuration_required"].includes(e.type),
        );
      if (ended) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ended) throw new Error("turn_timeout");
    report.turns.push({
      query,
      ...ended,
      audioPackets: events.slice(baseline).filter((e) => e.type === "audio")
        .length,
    });
    console.log("turn", JSON.stringify(report.turns.at(-1)));
    await save();
  }
  await session.close();
  // Native on this baseline must report its real deployment boundary.
  const native = new MiniCpmProvider(
    {
      ...config,
      native: { python: config.python, model: "openbmb/MiniCPM-o-4_5" },
    },
    provider,
  );
  report.native = await native.capabilities();
  await native.close();
  report.completedAt = new Date().toISOString();
} catch (e) {
  report.failures.push(e.message);
  console.log("failed", e.message);
  process.exitCode = 1;
} finally {
  await provider.close();
  await save();
}
