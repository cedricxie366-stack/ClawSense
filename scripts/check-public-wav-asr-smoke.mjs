#!/usr/bin/env node
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sampleUrl =
  "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2004a.Mix-Headset.wav";
const sampleDir = path.join(projectRoot, ".local/asr/external/ami-full");
const fullWavPath = path.join(sampleDir, "ES2004a.Mix-Headset.wav");
const clipWavPath = path.join(sampleDir, "ES2004a.Mix-Headset.60-360s.wav");
const resultsDir = path.join(projectRoot, ".local/asr/results");
const runAsr = process.env.CLAWSENSE_PUBLIC_WAV_RUN_ASR === "1";

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function readWavInfo(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert(buffer.toString("ascii", 0, 4) === "RIFF", "not a RIFF wav", filePath);
  assert(buffer.toString("ascii", 8, 12) === "WAVE", "not a WAVE file", filePath);
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
  assert(fmt && data, "wav fmt/data chunks missing", filePath);
  return {
    ...fmt,
    dataOffset: data.offset,
    dataStart: data.start,
    dataSize: data.size,
    frameCount: Math.floor(data.size / fmt.blockAlign),
    durationSec: Math.floor(data.size / fmt.blockAlign) / fmt.sampleRate,
    fileSize: buffer.length,
  };
}

function downloadIfMissing(url, targetPath) {
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1024 * 1024) {
    return Promise.resolve(false);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        downloadIfMissing(new URL(response.headers.location, url).toString(), targetPath).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed: ${response.statusCode}`));
        return;
      }
      const tempPath = `${targetPath}.tmp`;
      const out = fs.createWriteStream(tempPath);
      response.pipe(out);
      out.on("finish", () => {
        out.close(() => {
          fs.renameSync(tempPath, targetPath);
          resolve(true);
        });
      });
      out.on("error", reject);
    });
    request.setTimeout(60_000, () => {
      request.destroy(new Error("download timed out"));
    });
    request.on("error", reject);
  });
}

function ensureClip(sourcePath, targetPath, startSec, durationSec) {
  const source = fs.readFileSync(sourcePath);
  const info = readWavInfo(sourcePath);
  if (fs.existsSync(targetPath)) {
    const clipInfo = readWavInfo(targetPath);
    if (Math.abs(clipInfo.durationSec - durationSec) < 0.1) {
      return { created: false, info: clipInfo };
    }
  }
  const startFrame = Math.max(0, Math.floor(startSec * info.sampleRate));
  const frameCount = Math.floor(durationSec * info.sampleRate);
  const byteStart = info.dataStart + startFrame * info.blockAlign;
  const byteLength = Math.min(frameCount * info.blockAlign, source.length - byteStart);
  const header = Buffer.from(source.subarray(0, info.dataStart));
  const body = source.subarray(byteStart, byteStart + byteLength);
  header.writeUInt32LE(4 + (info.dataStart - 8) + body.length, 4);
  header.writeUInt32LE(body.length, info.dataOffset + 4);
  fs.writeFileSync(targetPath, Buffer.concat([header, body]));
  return { created: true, info: readWavInfo(targetPath) };
}

function newestExistingResult() {
  if (!fs.existsSync(resultsDir)) {
    return undefined;
  }
  const candidates = fs
    .readdirSync(resultsDir)
    .filter((name) => /(?:evidence-v2-ami-hybrid|hybrid-ami-es2004a-60-360s).*\.json$/.test(name))
    .map((name) => path.join(resultsDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0];
}

function runHybridAsr(clipPath) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const outputPath = path.join(resultsDir, `public-wav-ami-hybrid-${timestamp}.json`);
  const stderrPath = path.join(resultsDir, `public-wav-ami-hybrid-${timestamp}.stderr`);
  const env = {
    ...process.env,
    CLAWSENSE_HYBRID_ASR_COMMAND: path.join(projectRoot, ".local/asr/whisperx-runner.sh"),
    CLAWSENSE_HYBRID_SPEAKER_COMMAND: path.join(projectRoot, ".local/asr/funasr-runner.sh"),
    CLAWSENSE_WHISPERX_MODEL: path.join(projectRoot, ".local/asr/models/faster-whisper-tiny"),
    CLAWSENSE_WHISPERX_ALIGN: "0",
    CLAWSENSE_WHISPERX_DEVICE: "cpu",
    CLAWSENSE_WHISPERX_COMPUTE_TYPE: "int8",
    CLAWSENSE_ASR_LANGUAGE: "en",
    CLAWSENSE_FUNASR_PUNC_MODEL: process.env.CLAWSENSE_FUNASR_PUNC_MODEL || "none",
  };
  const res = spawnSync(path.join(projectRoot, "scripts/local-asr/hybrid-whisper-funasr.py"), [clipPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
    maxBuffer: 128 * 1024 * 1024,
    timeout: Number(process.env.CLAWSENSE_PUBLIC_WAV_ASR_TIMEOUT_MS || 900000),
  });
  fs.writeFileSync(outputPath, res.stdout);
  fs.writeFileSync(stderrPath, res.stderr);
  if (res.status !== 0) {
    throw Object.assign(new Error("hybrid ASR command failed"), {
      details: { status: res.status, outputPath, stderrPath, stderr: res.stderr.slice(-4000) },
    });
  }
  return outputPath;
}

function readResult(resultPath) {
  const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const speakerTimelineSegments = Array.isArray(payload.speakerTimelineSegments)
    ? payload.speakerTimelineSegments
    : [];
  const labels = new Set(
    segments
      .concat(speakerTimelineSegments)
      .map((segment) => segment.speakerLabel)
      .filter(Boolean),
  );
  return {
    resultPath,
    language: payload.language,
    transcriptLength: String(payload.transcript || "").length,
    segmentCount: segments.length,
    speakerTimelineSegmentCount: speakerTimelineSegments.length,
    speakerLabels: Array.from(labels).sort(),
    assignedSpeakerSegmentCount: Number(payload.hybrid?.assignedSpeakerSegmentCount || 0),
    speakerTimelineLabels: payload.hybrid?.speakerTimelineLabels || [],
  };
}

async function main() {
  const downloaded = await downloadIfMissing(sampleUrl, fullWavPath);
  const fullInfo = readWavInfo(fullWavPath);
  const clip = ensureClip(fullWavPath, clipWavPath, 60, 300);
  const resultPath = runAsr ? runHybridAsr(clipWavPath) : newestExistingResult();
  assert(resultPath, "no cached AMI hybrid result found; rerun with CLAWSENSE_PUBLIC_WAV_RUN_ASR=1");
  const result = readResult(resultPath);

  assert(fullInfo.durationSec > 1000, "AMI full wav should be a long meeting", fullInfo);
  assert(Math.abs(clip.info.durationSec - 300) < 0.1, "AMI smoke clip should be 300 seconds", clip.info);
  assert(result.transcriptLength > 1000, "ASR transcript should be non-trivial", result);
  assert(result.segmentCount > 10, "ASR should produce multiple transcript segments", result);
  assert(result.speakerTimelineSegmentCount > 2, "speaker timeline should contain multiple segments", result);
  assert(result.speakerLabels.length >= 2, "speaker labels should contain at least two speakers", result);

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        source: {
          name: "AMI ES2004a Mix-Headset",
          url: sampleUrl,
          fullWavPath,
          clipWavPath,
          downloaded,
          clipCreated: clip.created,
        },
        fullWav: fullInfo,
        clipWav: clip.info,
        mode: runAsr ? "fresh-asr" : "cached-asr-result",
        result,
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
