/** Full companion/context measurement, cloned calibration data and synthetic text only. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLiveRuntime } from "../../dist/src/live/launch.js";

const configFile = path.resolve(process.argv[2]);
const root = path.resolve(process.argv[3]);
const rounds = Number(process.argv[4] ?? 10);
const seed = process.argv[5] ? path.resolve(process.argv[5]) : undefined;
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw Error("invalid_round_count");
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const stateDir = path.join(root, "state");
if (seed) {
  // Never reuse a live writer's directory or overwrite an earlier benchmark.
  await fs.mkdir(stateDir, { mode: 0o700 });
  await fs.cp(seed, stateDir, { recursive: true, filter: source => ![".standalone.lock", ".write-lock", "authority.json", "connection.json"].includes(path.basename(source)) });
}
const config = JSON.parse(await fs.readFile(configFile, "utf8"));
config.live = { ...config.live, host: "127.0.0.1", port: 19622, dsh: undefined, codex: undefined, native: undefined, visionModel: undefined };
config.publicBaseUrl = "http://127.0.0.1:19621";
let service, ws;
const events = [];
const report = { startedAt: new Date().toISOString(), input: "synthetic text", endpoint: "host PCM over WebSocket, not audible phone playback", phoneUsed: false, clonedCalibrationLibrary: !!seed, turns: [], failures: [] };
const save = () => fs.writeFile(path.join(root, "profile.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
try {
  service = await startLiveRuntime({ stateDir, host: "127.0.0.1", port: 19621, config });
  const admin = (await fs.readFile(service.runtime.adminTokenFile, "utf8")).trim();
  async function post(route, body, token = admin) {
    const r = await fetch(config.publicBaseUrl + "/api/clawsense/" + route, { method: "POST", headers: { Authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw Error(d.error ?? "http_" + r.status); return d;
  }
  const setup = await post("setup", {});
  const payload = JSON.parse(Buffer.from(setup.setupCode, "base64url"));
  const device = await post("pair", { setupToken: payload.token, deviceName: "Synthetic latency calibration", platform: "model-fixture", fingerprint: "closeout-profile" });
  ws = new WebSocket("ws://127.0.0.1:19622/live", { headers: { Authorization: "Bearer " + device.deviceSecret } });
  ws.on("message", raw => { const event = JSON.parse(raw); event.clientReceivedAtMs = performance.now(); events.push(event); if (event.type === "audio") ws.send(JSON.stringify({ type: "audio_ack", seq: event.seq })); });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  async function wait(types, offset, timeout = 180000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = events.slice(offset).find(e => [...types, "error", "configuration_required"].includes(e.type));
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error("profile_timeout");
  }
  const startup = performance.now(); ws.send(JSON.stringify({ type: "hello" }));
  const ready = await wait(["ready"], 0);
  if (ready.type !== "ready") throw Error(ready.code);
  report.startupMs = performance.now() - startup;
  console.log(JSON.stringify({ type: "ready", startupMs: report.startupMs }));
  const queries = ["这是合成测试。小陈希望周四收到方案，预算三万元。明天下午三点开会。请简短确认。", "小陈希望什么时候收到方案？", "预算是多少？", "方案给谁？", "明天会议几点？", "请简短复述小陈的约定。", "预算再确认一下。", "接收方叫什么？", "会议的原时间怎么说？", "结束前简短总结。"];
  for (let round = 0; round < rounds; round++) {
    const offset = events.length, began = performance.now();
    ws.send(JSON.stringify({ type: "text", text: queries[round % queries.length], requestId: randomUUID() }));
    const done = await wait(["completed"], offset);
    const current = events.slice(offset), first = current.find(e => e.type === "audio");
    const item = { round, query: queries[round % queries.length], status: done.type, answer: done.answer, code: done.code,
      contextMs: done.contextMs, firstTextMs: done.firstTextMs, firstAudioMs: done.firstAudioMs, timings: done.timings,
      inputToFirstHostAudioMs: first ? first.at - current.find(e => e.type === "interrupted").at : null,
      websocketTextToFirstPcmMs: first ? first.clientReceivedAtMs - began : null,
      totalMs: performance.now() - began };
    if (done.type !== "completed") report.failures.push(done.code ?? done.type);
    report.turns.push(item); console.log(JSON.stringify(item)); await save();
  }
} catch (error) { report.failures.push(error.message); process.exitCode = 1; }
finally {
  ws?.close(); await service?.stop(); report.completedAt = new Date().toISOString(); await save();
}
