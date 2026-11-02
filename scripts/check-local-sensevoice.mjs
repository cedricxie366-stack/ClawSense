#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { createStandaloneRuntime } from "../dist/src/standalone-runtime.js";
import { resolveClawSenseConfig } from "../dist/src/config.js";
import { transcribeAudioWithLocalAsr } from "../dist/src/local-asr.js";

delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
const { values } = parseArgs({ options: { "state-dir": { type: "string" }, wav: { type: "string" } } });
const preparedDir = path.resolve(values["state-dir"] ?? ".local/cross-agent-asr-validation");
const wavPath = path.resolve(values.wav ?? path.join(preparedDir, "public-fixtures", "zh.wav"));
const audio = await fs.readFile(wavPath);
if (!values.wav) {
  const digest = createHash("sha1").update(`blob ${audio.length}\0`).update(audio).digest("hex");
  assert.equal(digest, "24a2bfc5c039f9d97db2cf1f2461699b582e0a90", "Expected the pinned official public Chinese sample");
}
const prepared = JSON.parse(await fs.readFile(path.join(preparedDir, "prepared-local-asr.json"), "utf8"));
assert.equal(prepared.generatedBy, "clawsense");
assert.equal(prepared.config.localAsrBackend, "sherpa-onnx-sensevoice");
const cfg = resolveClawSenseConfig(prepared.config);
const started = Date.now();
const decoded = await transcribeAudioWithLocalAsr({ cfg, filePath: wavPath, resolveStateDir: () => preparedDir });
assert.ok(decoded.transcript?.trim(), decoded.analysisFailureReason ?? "Local transcript is empty");
const decodeMs = Date.now() - started;
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-local-asr-flow-")));
const runtime = createStandaloneRuntime({ stateDir: directory, port: 0, pluginConfig: prepared.config });
try {
  const { baseUrl } = await runtime.start();
  const admin = (await fs.readFile(runtime.adminTokenFile, "utf8")).trim();
  const request = async (route, body, token = admin) => {
    const response = await fetch(baseUrl + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `HTTP ${response.status}`); return response.json();
  };
  const setup = await request("/api/clawsense/setup", {});
  const payload = JSON.parse(Buffer.from(setup.setupCode, "base64url").toString());
  const phone = await request("/api/clawsense/pair", { setupToken: payload.token, deviceName: "Public ASR fixture", platform: "android" }, "");
  const now = Date.now();
  const session = (await runtime.invokeTool("clawsense_session_create", { title: "Public local ASR validation", startedAt: now - 1000, endedAt: now + 60_000, deviceId: phone.deviceId })).details.session;
  const ingest = await request("/api/clawsense/ingest/audio", { audioBase64: audio.toString("base64"), fileName: "official-zh.wav", mime: "audio/wav", capturedAt: now }, phone.deviceSecret);
  assert.equal(ingest.stored, true);
  let event;
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = JSON.parse(await fs.readFile(path.join(directory, "plugins", "clawsense", "state.json"), "utf8"));
    event = state.events.find((item) => item.artifactId === ingest.artifactId);
    if (event?.transcript?.trim()) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(event?.transcript?.trim(), "Asynchronous ingest must persist a transcript");
  const evidence = await runtime.invokeTool("clawsense_session_evidence", { sessionId: session.sessionId, question: "刚才说的时间是什么？" });
  assert.equal(evidence.details.ok, true);
  assert.ok(JSON.stringify(evidence.details.evidence).includes(event.transcript));
  const report = { ok: true, backend: decoded.analysisProvider, sampleBytes: audio.length, decodeMs,
    transcript: decoded.transcript, persistedTranscript: event.transcript, evidenceReadable: true,
    cloudModelCalls: 0, physicalDeviceTest: false, sample: values.wav ? "user-supplied local file" : "pinned official public zh.wav" };
  await fs.writeFile(path.join(preparedDir, "local-sensevoice-report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally { await runtime.stop(); await fs.rm(directory, { recursive: true, force: true }); }
