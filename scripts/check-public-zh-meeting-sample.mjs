#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sampleRoot = path.join(projectRoot, ".local/asr/external/alimeeting");
const resultsDir = path.join(projectRoot, ".local/asr/results");

const dataset = {
  name: "AliMeeting R8002_M8002",
  repository: "ggfox00000/dia-alimeeting-test",
  sourcePage: "https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test",
  rttmUrl: "https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test/resolve/main/rttm/near/R8002_M8002.rttm",
  farUrl:
    "https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test/resolve/main/audio/far/R8002_M8002_MS802.wav",
  nearUrls: [
    "https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test/resolve/main/audio/near/R8002_M8002_N_SPK8005.wav",
    "https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test/resolve/main/audio/near/R8002_M8002_N_SPK8006.wav",
    "https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test/resolve/main/audio/near/R8002_M8002_N_SPK8007.wav",
    "https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test/resolve/main/audio/near/R8002_M8002_N_SPK8008.wav",
  ],
};

const prepareClip = process.env.CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP === "1";
const runAsr = process.env.CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR === "1";
const fullNearCheck = process.env.CLAWSENSE_PUBLIC_ZH_MEETING_FULL_NEAR_CHECK === "1";
const clipSeconds = Number(process.env.CLAWSENSE_PUBLIC_ZH_MEETING_SECONDS || 120);
const clipPath = path.join(sampleRoot, `R8002_M8002_MS802.far-mono.${clipSeconds}s.wav`);

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function runPython(script, args, { binary = false, maxBuffer = 128 * 1024 * 1024 } = {}) {
  const attempts = Number(process.env.CLAWSENSE_PUBLIC_ZH_MEETING_HTTP_RETRIES || 3);
  let lastResult;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("python3", ["-", ...args], {
      cwd: projectRoot,
      input: script,
      encoding: binary ? undefined : "utf8",
      maxBuffer,
      timeout: Number(process.env.CLAWSENSE_PUBLIC_ZH_MEETING_TIMEOUT_MS || 30000),
    });
    if (result.status === 0) {
      return result.stdout;
    }
    lastResult = result;
  }
  throw Object.assign(new Error(`python http helper failed:${lastResult?.status ?? "signal"}`), {
    details: {
      args: args.slice(0, 2),
      stderr: String(lastResult?.stderr || "").slice(-2000),
    },
  });
}

async function requestHeadOptional(url) {
  try {
    return await requestHead(url);
  } catch (error) {
    return {
      status: "unavailable",
      contentType: null,
      contentLength: 0,
      acceptRanges: null,
      error: error.message,
      details: error.details,
      url,
    };
  }
}

function assertAvailableHead(head, label) {
  assert(head.status === 200, `${label} is not reachable`, head);
  assert(head.contentLength > 0, `${label} did not expose content length`, head);
}

async function requestHead(url) {
  const raw = runPython(
    `
import json
import sys
import urllib.request

url = sys.argv[1]
timeout = float(sys.argv[2])
req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "ClawSenseValidation/1.0"})
with urllib.request.urlopen(req, timeout=timeout) as response:
    print(json.dumps({
        "status": response.status,
        "headers": {key.lower(): value for key, value in response.headers.items()},
    }))
`,
    [url, String(Math.ceil(Number(process.env.CLAWSENSE_PUBLIC_ZH_MEETING_TIMEOUT_MS || 30000) / 1000))],
  );
  const { status, headers } = JSON.parse(raw);
  assert(status === 200, `HEAD failed: ${status}`, { url, raw: String(raw).slice(-1000) });
  return {
    status,
    contentType: headers["content-type"] || null,
    contentLength: Number(headers["content-length"] || 0),
    acceptRanges: headers["accept-ranges"] || null,
  };
}

async function downloadTextIfMissing(url, filePath) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return { downloaded: false, text: fs.readFileSync(filePath, "utf8") };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buffer = runPython(
    `
import sys
import urllib.request

url = sys.argv[1]
timeout = float(sys.argv[2])
req = urllib.request.Request(url, headers={"User-Agent": "ClawSenseValidation/1.0"})
with urllib.request.urlopen(req, timeout=timeout) as response:
    sys.stdout.buffer.write(response.read())
`,
    [url, String(Math.ceil(Number(process.env.CLAWSENSE_PUBLIC_ZH_MEETING_TIMEOUT_MS || 30000) / 1000))],
    { binary: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const text = buffer.toString("utf8");
  fs.writeFileSync(filePath, text);
  return { downloaded: true, text };
}

async function downloadRange(url, start, end) {
  const expected = end - start + 1;
  const buffer = runPython(
    `
import sys
import urllib.request

url = sys.argv[1]
start = sys.argv[2]
end = sys.argv[3]
timeout = float(sys.argv[4])
req = urllib.request.Request(
    url,
    headers={"Range": f"bytes={start}-{end}", "User-Agent": "ClawSenseValidation/1.0"},
)
with urllib.request.urlopen(req, timeout=timeout) as response:
    sys.stdout.buffer.write(response.read())
`,
    [url, String(start), String(end), String(Math.ceil(Number(process.env.CLAWSENSE_PUBLIC_ZH_MEETING_TIMEOUT_MS || 30000) / 1000))],
    { binary: true, maxBuffer: Math.max(16 * 1024 * 1024, expected + 1024 * 1024) },
  );
  assert(buffer.length > 0, "range download returned no bytes", { url, start, end });
  return buffer;
}

function parseRttm(text) {
  const turns = [];
  const speakers = new Set();
  let totalSpeechSec = 0;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8 || parts[0] !== "SPEAKER") continue;
    const startSec = Number(parts[3]);
    const durationSec = Number(parts[4]);
    const speaker = parts[7];
    if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || !speaker) continue;
    speakers.add(speaker);
    totalSpeechSec += durationSec;
    if (turns.length < 8) {
      turns.push({ startSec, durationSec, speaker });
    }
  }
  return {
    lineCount: turns.length === 0 ? 0 : text.split(/\r?\n/).filter((line) => line.startsWith("SPEAKER ")).length,
    speakerCount: speakers.size,
    speakers: Array.from(speakers).sort(),
    totalSpeechSec,
    firstTurns: turns,
  };
}

function parseWavInfo(buffer) {
  assert(buffer.toString("ascii", 0, 4) === "RIFF", "not a RIFF wav");
  assert(buffer.toString("ascii", 8, 12) === "WAVE", "not a WAVE file");
  let offset = 12;
  let fmt;
  let data;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        offset,
        size,
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = { offset, start, size };
      break;
    }
    offset = start + size + (size % 2);
  }
  assert(fmt && data, "wav fmt/data chunks missing");
  return {
    ...fmt,
    dataOffset: data.offset,
    dataStart: data.start,
    dataSize: data.size,
    durationSec: data.size / fmt.byteRate,
  };
}

function writePcm16MonoWav(filePath, sampleRate, pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

async function prepareFarMonoClip() {
  if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 44) {
    return { created: false, clipPath, wav: parseWavInfo(fs.readFileSync(clipPath)) };
  }
  const head = await downloadRange(dataset.farUrl, 0, 1024 * 1024 - 1);
  const info = parseWavInfo(head);
  assert(info.audioFormat === 1 || info.audioFormat === 65534, "expected PCM or extensible PCM wav", info);
  assert(info.bitsPerSample === 16, "expected 16-bit PCM", info);
  assert(info.channels >= 1, "expected at least one channel", info);
  const bytesNeeded = info.dataStart + Math.floor(Math.min(clipSeconds, info.durationSec) * info.byteRate);
  const ranged = head.length >= bytesNeeded ? head : await downloadRange(dataset.farUrl, 0, bytesNeeded - 1);
  const data = ranged.subarray(info.dataStart, bytesNeeded);
  const frameCount = Math.floor(data.length / info.blockAlign);
  const pcm = Buffer.alloc(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    const frameOffset = frame * info.blockAlign;
    for (let channel = 0; channel < info.channels; channel += 1) {
      sum += data.readInt16LE(frameOffset + channel * 2);
    }
    const mixed = Math.max(-32768, Math.min(32767, Math.round(sum / info.channels)));
    pcm.writeInt16LE(mixed, frame * 2);
  }
  writePcm16MonoWav(clipPath, info.sampleRate, pcm);
  return { created: true, clipPath, wav: parseWavInfo(fs.readFileSync(clipPath)), sourceWav: info };
}

function runHybridAsr(audioPath) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const primary = process.env.CLAWSENSE_PUBLIC_ZH_MEETING_PRIMARY || "funasr";
  const primaryCommand =
    primary === "whisper"
      ? path.join(projectRoot, ".local/asr/whisperx-runner.sh")
      : path.join(projectRoot, ".local/asr/funasr-runner.sh");
  const outputPath = path.join(resultsDir, `public-zh-alimeeting-${primary}-primary-${timestamp}.json`);
  const stderrPath = path.join(resultsDir, `public-zh-alimeeting-${primary}-primary-${timestamp}.stderr`);
  const env = {
    ...process.env,
    CLAWSENSE_HYBRID_ASR_COMMAND: primaryCommand,
    CLAWSENSE_HYBRID_SPEAKER_COMMAND: path.join(projectRoot, ".local/asr/funasr-runner.sh"),
    CLAWSENSE_WHISPERX_MODEL: path.join(projectRoot, ".local/asr/models/faster-whisper-tiny"),
    CLAWSENSE_WHISPERX_ALIGN: "0",
    CLAWSENSE_WHISPERX_DEVICE: "cpu",
    CLAWSENSE_WHISPERX_COMPUTE_TYPE: "int8",
    CLAWSENSE_ASR_LANGUAGE: "zh",
    CLAWSENSE_FUNASR_PUNC_MODEL: process.env.CLAWSENSE_FUNASR_PUNC_MODEL || "none",
  };
  const result = spawnSync(path.join(projectRoot, "scripts/local-asr/hybrid-whisper-funasr.py"), [audioPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
    maxBuffer: 128 * 1024 * 1024,
    timeout: Number(process.env.CLAWSENSE_PUBLIC_ZH_MEETING_ASR_TIMEOUT_MS || 900000),
  });
  fs.writeFileSync(outputPath, result.stdout);
  fs.writeFileSync(stderrPath, result.stderr);
  if (result.status !== 0) {
    throw Object.assign(new Error("Chinese meeting hybrid ASR command failed"), {
      details: { status: result.status, outputPath, stderrPath, stderr: result.stderr.slice(-4000) },
    });
  }
  const payload = JSON.parse(result.stdout);
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const speakerTimelineSegments = Array.isArray(payload.speakerTimelineSegments)
    ? payload.speakerTimelineSegments
    : [];
  const speakerLabels = Array.from(
    new Set(
      segments
        .concat(speakerTimelineSegments)
        .map((segment) => segment.speakerLabel)
        .filter(Boolean),
    ),
  ).sort();
  return {
    outputPath,
    stderrPath,
    language: payload.language,
    transcriptLength: String(payload.transcript || "").length,
    segmentCount: segments.length,
    speakerTimelineSegmentCount: speakerTimelineSegments.length,
    speakerLabels,
    assignedSpeakerSegmentCount: Number(payload.hybrid?.assignedSpeakerSegmentCount || 0),
    primary: payload.hybrid?.primary || primary,
  };
}

async function main() {
  fs.mkdirSync(sampleRoot, { recursive: true });
  const rttmPath = path.join(sampleRoot, "R8002_M8002.near.rttm");
  const rttm = await downloadTextIfMissing(dataset.rttmUrl, rttmPath);
  const farHead = await requestHeadOptional(dataset.farUrl);
  const nearUrlsToCheck = fullNearCheck ? dataset.nearUrls : dataset.nearUrls.slice(0, 1);
  const nearHeads = [];
  for (const url of nearUrlsToCheck) {
    nearHeads.push(await requestHeadOptional(url));
  }
  const rttmSummary = parseRttm(rttm.text);
  assert(rttmSummary.speakerCount >= 4, "AliMeeting RTTM should expose at least four near-field speakers", rttmSummary);
  assert(rttmSummary.lineCount > 100, "AliMeeting RTTM should contain many speaker turns", rttmSummary);
  assertAvailableHead(farHead, "AliMeeting far-field WAV");
  assert(farHead.contentLength > 100 * 1024 * 1024, "far-field meeting WAV should be a large meeting recording", farHead);
  for (const near of nearHeads) {
    assertAvailableHead(near, "AliMeeting near-field WAV");
    assert(near.contentLength > 10 * 1024 * 1024, "near-field speaker WAV should be non-trivial", near);
    assert(String(near.contentType || "").includes("audio"), "near-field file should be audio", near);
  }

  let clip;
  if (prepareClip || runAsr) {
    clip = await prepareFarMonoClip();
    assert(Math.abs(clip.wav.durationSec - clipSeconds) < 0.5, "prepared clip duration mismatch", clip.wav);
    assert(clip.wav.channels === 1, "prepared clip should be mono", clip.wav);
  }

  let asr;
  if (runAsr) {
    asr = runHybridAsr(clipPath);
    assert(asr.transcriptLength > 100, "Chinese meeting ASR transcript should be non-trivial", asr);
    assert(asr.segmentCount > 0, "Chinese meeting ASR should return at least one segment", asr);
    assert(asr.speakerTimelineSegmentCount > 1, "Chinese meeting speaker timeline should contain multiple segments", asr);
    assert(asr.speakerLabels.length >= 2, "Chinese meeting speaker labels should contain multiple speakers", asr);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        mode: runAsr ? "fresh-asr" : prepareClip ? "prepared-clip" : "metadata-only",
        source: dataset,
        rttm: {
          path: rttmPath,
          downloaded: rttm.downloaded,
          ...rttmSummary,
        },
        audio: {
          far: farHead,
          checkedNearFiles: nearUrlsToCheck.length,
          fullNearCheck,
          near: nearHeads,
        },
        clip,
        asr,
        nextActions: runAsr
          ? []
          : [
              "Run CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting to create a 120s mono far-field clip.",
              "Run CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting to run the optional local ASR / speaker deep check.",
            ],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message,
        details: error.details,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
