import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLiveRuntime } from "../../dist/src/live/launch.js";
import { LocalLiveProvider } from "../../dist/src/live/local-provider.js";
import { ClawSenseWorkflowStore } from "../../dist/src/workflow-store.js";
import { PERSONAS } from "../../dist/src/live/persona.js";
const root = path.resolve(process.argv[2] ?? ".local/live"),
  report = {
    phoneUsed: false,
    syntheticOnly: true,
    checks: [],
    failures: [],
    turns: [],
  };
const config = JSON.parse(
  await fs.readFile(path.join(root, "config.json"), "utf8"),
);
config.live.port = 19596;
config.live.host = "127.0.0.1";
delete config.publicBaseUrl;
config.live.native = {
  python: config.live.python,
  model: "openbmb/MiniCPM-o-4_5",
};
config.live.dsh.home = path.join(root, "integration-dsh-home");
config.live.dsh.cwd = path.join(root, "integration-workspace");
await fs.mkdir(config.live.dsh.cwd, { recursive: true });
const stateDir = path.join(root, "integration-state-" + randomUUID());
let service, ws;
const frames = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fact = (condition, label) => {
  report.checks.push({ label, passed: !!condition });
  if (!condition) throw new Error(label);
};
let base, admin, device, workflow, encounter;
async function request(route, method = "GET", body, token = admin) {
  const r = await fetch(base + route, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error("http_" + r.status + "_" + route);
  return r.json();
}
async function wait(type, start = 0, timeout = 180000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const event = frames
      .slice(start)
      .find(
        (e) =>
          e.type === type ||
          e.type === "error" ||
          e.type === "configuration_required",
      );
    if (event) {
      if (event.type !== type) throw new Error(event.code ?? event.type);
      return event;
    }
    await sleep(25);
  }
  throw new Error("missing_" + type);
}
async function connect() {
  const info = await request(
    "/api/clawsense/live",
    "GET",
    undefined,
    device.deviceSecret,
  );
  ws = new WebSocket(info.websocketUrl, {
    headers: { Authorization: "Bearer " + device.deviceSecret },
  });
  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    frames.push(event);
    if (event.type === "audio")
      ws.send(JSON.stringify({ type: "audio_ack", seq: event.seq }));
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const begin = frames.length;
  ws.send(JSON.stringify({ type: "hello", provider: "native" }));
  return wait("ready", begin);
}
async function text(query) {
  const begin = frames.length;
  ws.send(
    JSON.stringify({ type: "text", text: query, requestId: randomUUID() }),
  );
  const result = await wait("completed", begin);
  report.turns.push({
    query,
    answer: result.answer,
    firstAudioMs: result.firstAudioMs,
    workItemId: result.workItemId,
  });
  return result;
}
function resample(pcm) {
  const size = Math.floor(pcm.length / 3),
    out = Buffer.alloc(size * 2);
  for (let i = 0; i < size; i++) {
    const source = i * 1.5,
      a = Math.floor(source),
      b = Math.min(a + 1, pcm.length / 2 - 1),
      weight = source - a;
    out.writeInt16LE(
      Math.round(
        pcm.readInt16LE(a * 2) * (1 - weight) + pcm.readInt16LE(b * 2) * weight,
      ),
      i * 2,
    );
  }
  return out;
}
async function feed(pcm) {
  for (let offset = 0; offset < pcm.length; offset += 640) {
    ws.send(pcm.subarray(offset, offset + 640));
    await sleep(20);
  }
  for (let i = 0; i < 50; i++) {
    ws.send(Buffer.alloc(640));
    await sleep(20);
  }
}
try {
  // Produce a voice fixture without opening either a microphone or a speaker.
  const generator = new LocalLiveProvider(config.live),
    chunks = [];
  for await (const c of generator.synthesize(
    "小伴，明天会议几点？",
    PERSONAS[0],
    new AbortController().signal,
  ))
    chunks.push(Buffer.from(c.pcm, "base64"));
  const sceneChunks=[];
  for await (const c of generator.synthesize("小陈希望周四收到方案，预算是三万元。明天下午三点开会。",PERSONAS[0],new AbortController().signal)) sceneChunks.push(Buffer.from(c.pcm,"base64"));
  const scenePcm=Buffer.concat(sceneChunks);
  const wav=Buffer.alloc(44+scenePcm.length);wav.write("RIFF",0);wav.writeUInt32LE(36+scenePcm.length,4);wav.write("WAVEfmt ",8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write("data",36);wav.writeUInt32LE(scenePcm.length,40);scenePcm.copy(wav,44);
  await generator.close();
  const input = resample(Buffer.concat(chunks));
  service = await startLiveRuntime({
    stateDir,
    port: 0,
    host: "127.0.0.1",
    config,
  });
  base = service.address.baseUrl;
  admin = (await fs.readFile(service.runtime.adminTokenFile, "utf8")).trim();
  const setup = await request("/api/clawsense/setup", "POST", {
    deviceRole: "sensor",
  });
  device = await request(
    "/api/clawsense/pair",
    "POST",
    {
      setupToken: JSON.parse(
        Buffer.from(setup.setupCode, "base64url").toString(),
      ).token,
      deviceName: "Synthetic Live fixture",
      platform: "fixture",
      fingerprint: randomUUID(),
    },
    "",
  );
  const audioReceipt=await request("/api/clawsense/ingest/audio","POST",{audioBase64:wav.toString("base64"),fileName:"synthetic-office.wav",mime:"audio/wav",capturedAt:Date.now(),note:"Synthetic voice fixture only; no room recording."},device.deviceSecret);
  let recent;for(let i=0;i<120;i++){recent=await request("/api/clawsense/recent-context?windowHint=last_5m&deviceId="+device.deviceId);if(recent.recentTranscriptSpans?.some(s=>/三万|3万/.test(s.text)))break;await sleep(250);}
  fact(recent?.recentTranscriptSpans?.some(s=>/周四/.test(s.text)&&/三万|3万/.test(s.text)),"actual-local-background-asr-populates-the-evidence-context");
  report.audioReceipt = {artifactId:audioReceipt.artifactId,status:audioReceipt.status};
  workflow = new ClawSenseWorkflowStore({ resolveStateDir: () => stateDir });
  encounter = await workflow.createSession(
    { title: "合成办公现场", deviceId: device.deviceId, projectId: config.live.projectId ?? "live" },
    "local-owner",
  );
  const originalCorrection = await workflow.correct(
    {
      sessionId: encounter.sessionId,
      expectedRevision: 1,
      kind: "fact",
      text: "合成事实：小陈周四收到方案，预算三万元；会议是明天下午三点，不确认具体日期。",
      sourceEventIds: [],
    },
    "local-owner",
  );
  const ready = await connect();
  report.capabilities = ready.capabilities;
  fact(
    ready.selected === "local-cascade",
    "native-unavailable-falls-back-locally",
  );
  const begin = frames.length;
  await feed(input);
  const voice = await wait("completed", begin);
  report.turns.push({
    query: "synthetic voice",
    answer: voice.answer,
    firstAudioMs: voice.firstAudioMs,
  });
  fact(
    /三点|3点/.test(voice.answer),
    "streamed-voice-question-retrieves-current-context",
  );
  const spoken = Buffer.concat(
    frames
      .slice(begin)
      .filter((e) => e.type === "audio")
      .map((e) => Buffer.from(e.pcm, "base64")),
  );
  const echoStart = frames.length;
  ws.send(JSON.stringify({ type: "playback", active: true }));
  await feed(resample(spoken));
  await sleep(300);
  ws.send(JSON.stringify({ type: "playback", active: false }));
  fact(
    !frames.slice(echoStart).some((e) => e.type === "turn_started"),
    "playback-echo-does-not-create-another-question",
  );
  const current = await workflow.getSession(encounter.sessionId);
  await workflow.correct(
    {
      sessionId: encounter.sessionId,
      expectedRevision: current.revision,
      objectId: originalCorrection.objectId,
      kind: "fact",
      text: "用户确认：预算改为四万元，取代此前三万元。方案接收方仍是小陈，周四收到。",
      sourceEventIds: [],
    },
    "local-owner",
  );
  const budget = await text("预算后来改成多少？");
  fact(/四万|4万/.test(budget.answer), "latest-user-correction-wins");
  const artifact = "live-plan-" + randomUUID() + ".md";
  const task = await text(
    `用更强模型，制作跟进方案文件。请用ClawSense MCP工具读取面谈 ${encounter.sessionId} 的最新更正，按最新预算生成 ${artifact} 到当前工作目录。仅使用本次合成事实，不发送消息、不访问外部资料。最后说明文件名。`,
  );
  fact(!!task.workItemId, "harness-request-creates-shared-work");
  const results = await request(
    "/api/clawsense/live-result?workItemId=" + task.workItemId,
    "GET",
    undefined,
    device.deviceSecret,
  );
  const record = results.results[0];
  fact(
    record.status === "completed" && record.reviewStatus === "pending",
    "saved-harness-result-is-not-semantic-acceptance",
  );
  const file = record.files?.find((x) => x.name === artifact);
  fact(
    file && /四万|4万|40000/.test(file.content),
    "actual-harness-artifact-flows-back-to-phone-api",
  );
  const work = await workflow.getWork(task.workItemId);
  fact(
    work.completedBy === "live-dsh",
    "authenticated-harness-result-is-shared",
  );
  ws.close(1000);
  await sleep(100);
  await service.stop();
  service = undefined;
  // Fresh worker/profile session; existing device, history and work remain in the isolated state.
  const nextConfig = structuredClone(config);
  nextConfig.live.dsh.args = nextConfig.live.dsh.args.filter(
    (arg, index, args) =>
      !(
        arg.endsWith("live-dsh-mcp.patch.yml") ||
        (arg === "--patch" &&
          args[index + 1]?.endsWith("live-dsh-mcp.patch.yml"))
      ),
  );
  service = await startLiveRuntime({
    stateDir,
    port: 0,
    host: "127.0.0.1",
    config: nextConfig,
  });
  base = service.address.baseUrl;
  admin = (await fs.readFile(service.runtime.adminTokenFile, "utf8")).trim();
  await connect();
  const restored = await request(
    "/api/clawsense/live-result?workItemId=" + task.workItemId,
    "GET",
    undefined,
    device.deviceSecret,
  );
  fact(
    restored.results[0]?.files?.some((x) => x.name === artifact),
    "restart-preserves-work-and-artifact",
  );
  const next = await text("之前的方案接收方是谁？");
  fact(
    next.answer.includes("小陈"),
    "restart-restores-conversation-and-context",
  );
  report.stateDir = stateDir;
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.failures.push(error.message);
  console.log("integration_failed", error.message);
  process.exitCode = 1;
} finally {
  ws?.terminate();
  if (service) await service.stop();
  await fs.writeFile(
    path.join(root, "integration.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      checks: report.checks,
      turns: report.turns,
      failures: report.failures,
    }),
  );
}
