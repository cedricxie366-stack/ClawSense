#!/usr/bin/env node
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ClawSenseStateStore, toLocalDateKey } from "../dist/src/state-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixtureId = "mit-18-085-l31-video";
const fixtureRoot = path.join(repoRoot, ".local", "test-fixtures", fixtureId);
const rawRoot = path.join(fixtureRoot, "raw");
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(repoRoot, ".local", "openclaw", "state");
const force = process.argv.includes("--force");
const reset = process.argv.includes("--reset");

const source = {
  ocwUrl:
    "https://ocw.mit.edu/courses/18-085-computational-science-and-engineering-i-fall-2008/resources/lecture-videos/",
  archiveUrl: "https://archive.org/details/MIT18.085F08",
  mp4Url: "https://archive.org/download/MIT18.085F08/ocw-18.085-f08-lec31_300k.mp4",
  srtUrl: "https://archive.org/download/MIT18.085F08/ocw-18.085-f08-lec31_300k.srt",
  keyframes: [
    {
      url: "https://archive.org/download/MIT18.085F08/MIT18.085F08.thumbs/ocw-18.085-f08-lec31_300k_000001.jpg",
      fileName: "ocw-18.085-f08-lec31_300k_000001.jpg",
      offsetMs: 1_000,
      caption: "Professor Gilbert Strang stands at the classroom board at the start of MIT 18.085 Lecture 31.",
      ocrHints: ["MIT 18.085", "Lecture 31", "Convolution"],
    },
    {
      url: "https://archive.org/download/MIT18.085F08/MIT18.085F08.thumbs/ocw-18.085-f08-lec31_300k_001550.jpg",
      fileName: "ocw-18.085-f08-lec31_300k_001550.jpg",
      offsetMs: 1_550_000,
      caption: "The classroom video shows board work during the convolution and Fourier transform explanation.",
      ocrHints: ["convolution", "Fourier", "FFT"],
    },
    {
      url: "https://archive.org/download/MIT18.085F08/MIT18.085F08.thumbs/ocw-18.085-f08-lec31_300k_002584.jpg",
      fileName: "ocw-18.085-f08-lec31_300k_002584.jpg",
      offsetMs: 2_584_000,
      caption: "The professor continues the board derivation near the end of the lecture video.",
      ocrHints: ["cyclic convolution", "polynomial multiplication", "signal processing"],
    },
  ],
};

const videoPath = path.join(rawRoot, "ocw-18.085-f08-lec31_300k.mp4");
const srtPath = path.join(rawRoot, "ocw-18.085-f08-lec31_300k.srt");

const logger = {
  info(message) {
    console.error(message);
  },
  warn(message) {
    console.error(message);
  },
  error(message) {
    console.error(message);
  },
};

const store = new ClawSenseStateStore({
  resolveStateDir: () => stateDir,
  logger,
});

async function downloadIfMissing(url, filePath) {
  try {
    await fs.access(filePath);
    return false;
  } catch {
    // continue
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download_failed:${response.status}:${url}`);
  }
  await pipeline(response.body, createWriteStream(filePath));
  return true;
}

function parseSrtTimestamp(value) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (!match) {
    return 0;
  }
  const [, hours, minutes, seconds, millis] = match;
  const paddedMillis = String(millis ?? "0").padEnd(3, "0").slice(0, 3);
  return (
    Number(hours) * 60 * 60 * 1000 +
    Number(minutes) * 60 * 1000 +
    Number(seconds) * 1000 +
    Number(paddedMillis)
  );
}

function parseSrt(raw) {
  return raw
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) {
        return null;
      }
      const [startRaw, endRaw] = lines[timingIndex].split("-->").map((part) => part.trim());
      const text = lines
        .slice(timingIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) {
        return null;
      }
      return {
        startMs: parseSrtTimestamp(startRaw),
        endMs: parseSrtTimestamp(endRaw),
        text,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function buildTranscriptWindow(cues, centerOffsetMs) {
  const left = Math.max(0, centerOffsetMs - 120_000);
  const right = centerOffsetMs + 180_000;
  const selected = cues.filter((cue) => cue.endMs >= left && cue.startMs <= right);
  const fallback = cues.filter((cue) => cue.startMs <= right).slice(-18);
  const rows = (selected.length ? selected : fallback).slice(0, 42);
  return rows
    .map((cue) => `[${formatClock(cue.startMs)}-${formatClock(cue.endMs)} Professor Strang] ${cue.text}`)
    .join("\n");
}

async function resetFixtureState(date) {
  const stateFile = path.join(stateDir, "plugins", "clawsense", "state.json");
  let state;
  try {
    state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { removedEvents: 0, removedArtifacts: 0, removedJournal: 0, removedReviews: 0, removedConsolidations: 0 };
    }
    throw error;
  }

  const fixtureEventIds = new Set(
    (Array.isArray(state.events) ? state.events : [])
      .filter((event) => event.note?.includes(`fixture=${fixtureId}`))
      .map((event) => event.eventId),
  );
  const fixtureArtifactIds = new Set(
    (Array.isArray(state.artifacts) ? state.artifacts : [])
      .filter((artifact) => artifact.storageRelPath?.includes(`fixtures/${fixtureId}/`))
      .map((artifact) => artifact.artifactId),
  );

  const before = {
    events: state.events?.length ?? 0,
    artifacts: state.artifacts?.length ?? 0,
    journal: state.journal?.length ?? 0,
    reviews: state.reviews?.length ?? 0,
    consolidations: state.consolidations?.length ?? 0,
  };
  state.events = (Array.isArray(state.events) ? state.events : []).filter((event) => !fixtureEventIds.has(event.eventId));
  state.artifacts = (Array.isArray(state.artifacts) ? state.artifacts : []).filter(
    (artifact) => !fixtureArtifactIds.has(artifact.artifactId),
  );
  state.journal = (Array.isArray(state.journal) ? state.journal : []).filter(
    (entry) => !fixtureEventIds.has(entry.eventId) && !fixtureArtifactIds.has(entry.artifactId),
  );
  state.reviews = (Array.isArray(state.reviews) ? state.reviews : []).filter((review) => review.date !== date);
  state.consolidations = (Array.isArray(state.consolidations) ? state.consolidations : []).filter(
    (consolidation) => consolidation.date !== date,
  );

  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return {
    removedEvents: before.events - state.events.length,
    removedArtifacts: before.artifacts - state.artifacts.length,
    removedJournal: before.journal - state.journal.length,
    removedReviews: before.reviews - state.reviews.length,
    removedConsolidations: before.consolidations - state.consolidations.length,
  };
}

async function refreshFixtureHeartbeats(runId) {
  const devices = (await store.listDevices()).filter(
    (device) => device.platform === "fixture" && device.fingerprint === `fixture:${fixtureId}`,
  );
  for (const device of devices) {
    await store.updateHeartbeat(device.deviceId, {
      batteryPct: 100,
      network: "fixture",
      appState: "host-replay",
      raw: { fixtureId, runId, refreshed: true },
    });
  }
  return devices.length;
}

function encodeNoteField(value) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

async function main() {
  const today = toLocalDateKey(Date.now());
  const resetResult = reset ? await resetFixtureState(today) : null;
  const existing = (await store.listEvents()).filter(
    (event) => event.note?.includes(`fixture=${fixtureId}`) && toLocalDateKey(event.capturedAt) === today,
  );
  if (existing.length > 0 && !force) {
    const refreshedDevices = await refreshFixtureHeartbeats("fixture-video-replay-skip");
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason: "fixture_already_replayed_today",
          fixtureId,
          date: today,
          existingEvents: existing.length,
          refreshedDevices,
          hint: "pass --force to append another fixture replay run",
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const downloads = {
    video: await downloadIfMissing(source.mp4Url, videoPath),
    srt: await downloadIfMissing(source.srtUrl, srtPath),
    keyframes: [],
  };
  for (const keyframe of source.keyframes) {
    const downloaded = await downloadIfMissing(keyframe.url, path.join(rawRoot, keyframe.fileName));
    downloads.keyframes.push({ fileName: keyframe.fileName, downloaded });
  }

  const cues = parseSrt(await fs.readFile(srtPath, "utf8"));
  if (cues.length < 100) {
    throw new Error("empty_or_too_short_srt_fixture");
  }

  const runId = `${fixtureId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const device = await store.registerDevice({
    name: "MIT 18.085 Lecture 31 video fixture",
    platform: "fixture",
    appVersion: "fixture-replay-2026-05-31",
    fingerprint: `fixture:${fixtureId}`,
  });
  await store.updateHeartbeat(device.deviceId, {
    batteryPct: 100,
    network: "fixture",
    appState: "host-replay",
    raw: { fixtureId, runId },
  });

  const videoCapturedAt = Date.now() - 75 * 60_000;
  const retentionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const videoStat = await fs.stat(videoPath);
  const srtStat = await fs.stat(srtPath);
  const video = await store.recordCapture({
    memoryId: randomUUID(),
    namespace: "clawsense",
    deviceId: device.deviceId,
    modality: "video",
    summary:
      "MIT 18.085 Lecture 31 video: Professor Gilbert Strang teaches convolution, Fourier coefficients, signal processing, filtering, and FFT-related computation at the classroom board.",
    transcript: cues
      .slice(0, 24)
      .map((cue) => `[${formatClock(cue.startMs)}-${formatClock(cue.endMs)} Professor Strang] ${cue.text}`)
      .join("\n"),
    note: `videoRequestId=${runId} fixture=${fixtureId} scenario=classroom-video source=MIT-OCW topic=convolution-fft sourceUrl=${source.archiveUrl}`,
    createdAt: videoCapturedAt,
    capturedAt: videoCapturedAt,
    sourcePath: videoPath,
    fileName: "mit-18-085-l31-video.mp4",
    mime: "video/mp4",
    sizeBytes: videoStat.size,
    storageRelPath: `fixtures/${fixtureId}/ocw-18.085-f08-lec31_300k.mp4`,
    retentionExpiresAt,
    analysisMode: "metadata-only",
    analysisProvider: "fixture-video:mit-ocw",
    analysisStatus: "degraded",
    analysisFailureReason: "fixture_uses_keyframes_and_public_srt_transcript",
    projectRefs: ["course:18.085", "topic:convolution", "topic:fft", "source:mit-ocw"],
    tags: ["fixture", "video", "school", "classroom", "lecture", "learning", "convolution", "fft"],
  });

  const events = [video.event];
  for (let index = 0; index < source.keyframes.length; index += 1) {
    const keyframe = source.keyframes[index];
    const keyframePath = path.join(rawRoot, keyframe.fileName);
    const keyframeStat = await fs.stat(keyframePath);
    const capturedAt = videoCapturedAt + keyframe.offsetMs;
    const transcript = buildTranscriptWindow(cues, keyframe.offsetMs);

    const audio = await store.recordCapture({
      memoryId: randomUUID(),
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: `Video transcript window near ${formatClock(keyframe.offsetMs)}: the lecture discusses convolution, Fourier coefficients, filtering, signal processing, and FFT-style computation.`,
      transcript: `[video_transcript_window_${index + 1}]\n${transcript}`,
      note: `csAudio:v2 session=${runId} segment=${index + 1} sessionStart=${videoCapturedAt} boundary=fixture clipMs=300000 continued=${index === 0 ? 0 : 1} videoRequestId=${runId} fixture=${fixtureId} scenario=classroom-video source=MIT-OCW topic=convolution-fft`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath: srtPath,
      fileName: `mit-18-085-l31-video-transcript-${index + 1}.srt`,
      mime: "text/plain",
      sizeBytes: srtStat.size,
      storageRelPath: `fixtures/${fixtureId}/ocw-18.085-f08-lec31_300k.srt`,
      retentionExpiresAt,
      analysisMode: "runtime-stt",
      analysisProvider: "fixture-transcript:internet-archive-srt",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
      projectRefs: ["course:18.085", "topic:convolution", "topic:fft", "source:mit-ocw"],
      tags: ["fixture", "audio", "video-transcript", "school", "lecture", "learning", "transcript-ready"],
    });
    events.push(audio.event);

    const caption = keyframe.caption;
    const ocr = keyframe.ocrHints.join("|");
    const frame = await store.recordCapture({
      memoryId: randomUUID(),
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "image",
      summary: `${caption} Visible board/context hints: ${keyframe.ocrHints.join(", ")}.`,
      note: `active-window videoRequestId=${runId} videoKeyframe=1 keyframe=${index + 1} videoOffsetMs=${keyframe.offsetMs} caption=${encodeNoteField(caption)} ocr=${encodeNoteField(ocr)} fixture=${fixtureId} scenario=classroom-video source=MIT-OCW`,
      createdAt: capturedAt + 1_000,
      capturedAt: capturedAt + 1_000,
      sourcePath: keyframePath,
      fileName: keyframe.fileName,
      mime: "image/jpeg",
      sizeBytes: keyframeStat.size,
      storageRelPath: `fixtures/${fixtureId}/${keyframe.fileName}`,
      retentionExpiresAt,
      analysisMode: "multimodal-preview",
      analysisProvider: "fixture-keyframe:internet-archive-thumbnail",
      analysisStatus: "succeeded",
      projectRefs: ["course:18.085", "topic:convolution", "topic:fft", "source:mit-ocw"],
      tags: ["fixture", "video-keyframe", "image", "school", "classroom", "lecture", "ocr-ready"],
    });
    events.push(frame.event);
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        skipped: false,
        fixtureId,
        runId,
        date: today,
        stateDir,
        reset: resetResult,
        source,
        downloads,
        device: {
          deviceId: device.deviceId,
          name: device.name,
        },
        recorded: {
          videoEvents: 1,
          audioTranscriptEvents: source.keyframes.length,
          keyframeEvents: source.keyframes.length,
          totalEvents: events.length,
          transcriptCues: cues.length,
          videoBytes: videoStat.size,
        },
        evidenceExpectations: {
          shouldMention: ["video clip", "keyframes", "convolution", "Fourier", "signal processing", "FFT"],
          shouldNotInvent: ["homework deadline", "exam date", "student names"],
        },
        eventIds: events.map((event) => event.eventId),
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
