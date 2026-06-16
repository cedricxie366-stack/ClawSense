#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ClawSenseStateStore, toLocalDateKey } from "../dist/src/state-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixtureId = "mit-18-085-l31";
const fixtureRoot = path.join(repoRoot, ".local", "test-fixtures", fixtureId);
const rawRoot = path.join(fixtureRoot, "raw");
const transcriptPdfPath = path.join(rawRoot, "transcript.pdf");
const transcriptTextPath = path.join(rawRoot, "transcript.txt");
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(repoRoot, ".local", "openclaw", "state");
const force = process.argv.includes("--force");
const reset = process.argv.includes("--reset");

const source = {
  url: "https://ocw.mit.edu/courses/18-085-computational-science-and-engineering-i-fall-2008/resources/18-085f08-l31/",
  pdfUrl:
    "https://ocw.mit.edu/courses/18-085-computational-science-and-engineering-i-fall-2008/0ec33a3d684fc8c6426554d5ec4888bf_18-085F08-L31.pdf",
};

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
  if (!response.ok) {
    throw new Error(`download_failed:${response.status}:${url}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, body);
  return true;
}

async function ensureTranscriptText() {
  await downloadIfMissing(source.pdfUrl, transcriptPdfPath);
  try {
    const existing = await fs.readFile(transcriptTextPath, "utf8");
    if (existing.split(/\s+/).filter(Boolean).length >= 1000) {
      return { extracted: false };
    }
  } catch {
    // continue
  }

  const script = [
    "from PyPDF2 import PdfReader",
    `reader = PdfReader(${JSON.stringify(transcriptPdfPath)})`,
    `out = open(${JSON.stringify(transcriptTextPath)}, "w", encoding="utf-8")`,
    "for page in reader.pages:",
    "    out.write((page.extract_text() or '') + '\\n')",
    "out.close()",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        "mit_transcript_extract_failed",
        "Install PyPDF2 for local fixture prep: python3 -m pip install --user PyPDF2",
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return { extracted: true };
}

function normalizeTranscript(raw) {
  const start = raw.indexOf("PROFESSOR STRANG:");
  const body = start >= 0 ? raw.slice(start) : raw;
  return body
    .replace(/\s+/g, " ")
    .replace(/MIT OpenCourseWare.*?Transcript – Lecture 31/g, "")
    .trim();
}

function chunkWords(text, chunkSize, maxChunks) {
  const words = text.split(/\s+/).filter(Boolean).slice(0, chunkSize * maxChunks);
  const chunks = [];
  for (let index = 0; index < maxChunks; index += 1) {
    const chunk = words.slice(index * chunkSize, (index + 1) * chunkSize).join(" ");
    if (chunk.trim()) {
      chunks.push(chunk);
    }
  }
  return { words, chunks };
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

async function main() {
  const today = toLocalDateKey(Date.now());
  const resetResult = reset ? await resetFixtureState(today) : null;
  const existing = (await store.listEvents()).filter(
    (event) => event.note?.includes(`fixture=${fixtureId}`) && toLocalDateKey(event.capturedAt) === today,
  );
  if (existing.length > 0 && !force) {
    const refreshedDevices = await refreshFixtureHeartbeats("fixture-replay-skip");
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

  const preparation = await ensureTranscriptText();
  const transcript = normalizeTranscript(await fs.readFile(transcriptTextPath, "utf8"));
  const { words, chunks } = chunkWords(transcript, 800, 4);
  if (chunks.length === 0) {
    throw new Error("empty_mit_transcript_fixture");
  }

  const runId = `${fixtureId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const device = await store.registerDevice({
    name: "MIT 18.085 Lecture 31 fixture",
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

  const firstAudioCapturedAt = Date.now() - 45 * 60_000;
  const clipMs = 5 * 60_000;
  const transcriptStat = await fs.stat(transcriptTextPath);
  const retentionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const summaries = [
    "Fast Fourier transform and convolution lecture setup: convolution as the central operation for signal processing and filtering.",
    "Convolution algebra with Fourier coefficients, z-transform intuition, and polynomial multiplication analogy.",
    "Connection between multiplication in one domain and convolution in the other, with attention to cyclic/discrete cases.",
    "Learning focus: use convolution rules to understand filtering, signal processing, and FFT-style computation.",
  ];
  const events = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const capturedAt = firstAudioCapturedAt + index * clipMs;
    const result = await store.recordCapture({
      memoryId: randomUUID(),
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: `MIT 18.085 Lecture 31 transcript window ${index + 1}: ${summaries[index] ?? summaries.at(-1)}`,
      transcript: `[lecture_window_${index + 1}] ${chunks[index]}`,
      note: `csAudio:v2 session=${runId} segment=${
        index + 1
      } sessionStart=${firstAudioCapturedAt} boundary=fixture clipMs=${clipMs} continued=${
        index === 0 ? 0 : 1
      } fixture=${fixtureId} scenario=school-lecture source=MIT-OCW topic=fast-fourier-transform-convolution`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath: transcriptTextPath,
      fileName: `mit-18-085-l31-transcript-window-${index + 1}.txt`,
      mime: "text/plain",
      sizeBytes: transcriptStat.size,
      storageRelPath: `fixtures/${fixtureId}/transcript.txt`,
      retentionExpiresAt,
      analysisMode: "runtime-stt",
      analysisProvider: "fixture-transcript:mit-ocw",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
      projectRefs: ["course:18.085", "topic:fast-fourier-transform", "topic:convolution"],
      tags: ["fixture", "school", "classroom", "lecture", "learning", "math", "transcript-ready", "convolution", "fft"],
    });
    events.push(result.event);
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
        preparation,
        reset: resetResult,
        source,
        device: {
          deviceId: device.deviceId,
          name: device.name,
        },
        recorded: {
          audioEvents: events.length,
          transcriptWords: words.length,
        },
        evidenceExpectations: {
          shouldMention: ["convolution", "Fourier coefficients", "signal processing", "filtering", "FFT"],
          shouldNotInvent: ["homework deadline", "student names", "exam date"],
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
