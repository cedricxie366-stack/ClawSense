#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ClawSenseStateStore, toLocalDateKey } from "../dist/src/state-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixtureId = "ami-es2002a";
const fixtureRoot = path.join(repoRoot, ".local", "test-fixtures", fixtureId);
const annotationRoot = path.join(fixtureRoot, "annotations");
const rawRoot = path.join(fixtureRoot, "raw");
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(repoRoot, ".local", "openclaw", "state");
const force = process.argv.includes("--force");
const reset = process.argv.includes("--reset");

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

function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function attrValue(attrs, name) {
  return attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function formatClock(seconds) {
  const value = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(value / 60);
  const secs = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatTokens(tokens) {
  let text = "";
  for (const token of tokens) {
    if (/^[,.;:!?)]$/.test(token)) {
      text += token;
    } else if (/^[(]$/.test(token)) {
      text += text ? ` ${token}` : token;
    } else {
      text += text ? ` ${token}` : token;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

async function parseWords() {
  const wordsDir = path.join(annotationRoot, "words");
  const files = (await fs.readdir(wordsDir))
    .filter((file) => /^ES2002a\.[A-D]\.words\.xml$/.test(file))
    .sort();
  const words = [];

  for (const file of files) {
    const speaker = file.match(/^ES2002a\.([A-D])\.words\.xml$/)?.[1] ?? "?";
    const xml = await fs.readFile(path.join(wordsDir, file), "latin1");
    const regex = /<w\b([^>]*)>([\s\S]*?)<\/w>/g;
    for (const match of xml.matchAll(regex)) {
      const start = Number(attrValue(match[1], "starttime"));
      const end = Number(attrValue(match[1], "endtime"));
      const token = decodeXml(match[2]).trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || !token) {
        continue;
      }
      words.push({ speaker, start, end, token });
    }
  }

  return words.sort((a, b) => a.start - b.start || a.end - b.end || a.speaker.localeCompare(b.speaker));
}

function toUtterances(words) {
  const utterances = [];
  let current = null;

  for (const word of words) {
    const isPunctuation = /^[,.;:!?]$/.test(word.token);
    const gap = current ? word.start - current.lastEnd : 0;
    const shouldBreak =
      current &&
      !isPunctuation &&
      (current.speaker !== word.speaker ||
        gap > 2.5 ||
        (current.tokens.length >= 45 && /[.!?]$/.test(current.tokens.at(-1) ?? "")));

    if (!current || shouldBreak) {
      if (current?.tokens.length) {
        utterances.push({
          speaker: current.speaker,
          start: current.start,
          end: current.lastEnd,
          text: formatTokens(current.tokens),
        });
      }
      current = {
        speaker: word.speaker,
        start: word.start,
        lastEnd: word.end,
        tokens: [word.token],
      };
      continue;
    }

    current.tokens.push(word.token);
    current.lastEnd = Math.max(current.lastEnd, word.end);
  }

  if (current?.tokens.length) {
    utterances.push({
      speaker: current.speaker,
      start: current.start,
      end: current.lastEnd,
      text: formatTokens(current.tokens),
    });
  }

  return utterances.filter((utterance) => utterance.text.length > 0);
}

function extractSentences(xml) {
  return Array.from(xml.matchAll(/<sentence\b[^>]*>([\s\S]*?)<\/sentence>/g), (match) =>
    decodeXml(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
  ).filter(Boolean);
}

async function parseMeetingGoldSummary() {
  const file = path.join(annotationRoot, "abstractive", "ES2002a.abssumm.xml");
  const xml = await fs.readFile(file, "latin1");
  const abstract = xml.match(/<abstract\b[\s\S]*?<\/abstract>/)?.[0] ?? "";
  const actions = xml.match(/<actions\b[\s\S]*?<\/actions>/)?.[0] ?? "";
  const decisions = xml.match(/<decisions\b[\s\S]*?<\/decisions>/)?.[0] ?? "";
  const problems = xml.match(/<problems\b[\s\S]*?<\/problems>/)?.[0] ?? "";

  return {
    abstract: extractSentences(abstract),
    actions: extractSentences(actions),
    decisions: extractSentences(decisions),
    problems: extractSentences(problems),
  };
}

function buildTranscriptWindow(utterances, startSec, endSec) {
  return utterances
    .filter((utterance) => utterance.start >= startSec && utterance.start < endSec)
    .map(
      (utterance) =>
        `[${formatClock(utterance.start)}-${formatClock(utterance.end)} speaker_${utterance.speaker}] ${utterance.text}`,
    )
    .join("\n");
}

function summarizeTranscript(transcript) {
  const compact = transcript
    .split(/\n+/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 360 ? `${compact.slice(0, 357)}...` : compact;
}

function startOfTodayAt(hour, minute = 0) {
  const value = new Date();
  value.setHours(hour, minute, 0, 0);
  return value.getTime();
}

async function ensureFixtureCanReplay() {
  const required = [
    path.join(rawRoot, "ES2002a.Mix-Headset.wav"),
    path.join(rawRoot, "instrumented_meeting_room_300.jpg"),
    path.join(annotationRoot, "words", "ES2002a.A.words.xml"),
    path.join(annotationRoot, "abstractive", "ES2002a.abssumm.xml"),
  ];
  for (const file of required) {
    try {
      await fs.access(file);
    } catch {
      throw new Error(`missing_fixture_file:${path.relative(repoRoot, file)}`);
    }
  }
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
  await ensureFixtureCanReplay();

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

  const runId = `${fixtureId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const words = await parseWords();
  const utterances = toUtterances(words);
  const gold = await parseMeetingGoldSummary();
  const firstWordAt = Math.floor(Math.min(...words.map((word) => word.start)));
  const chunkSeconds = 5 * 60;
  const windowCount = 4;
  const replayStartedAt = Math.max(Date.now() - 75 * 60_000, startOfTodayAt(9, 30));
  const audioPath = path.join(rawRoot, "ES2002a.Mix-Headset.wav");
  const imagePath = path.join(rawRoot, "instrumented_meeting_room_300.jpg");
  const audioStat = await fs.stat(audioPath);
  const imageStat = await fs.stat(imagePath);
  const firstAudioCapturedAt = replayStartedAt + 30_000;

  const device = await store.registerDevice({
    name: "AMI ES2002a fixture",
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

  const retentionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const image = await store.recordCapture({
    memoryId: randomUUID(),
    namespace: "clawsense",
    deviceId: device.deviceId,
    modality: "image",
    summary:
      "Fixture image from the AMI instrumented meeting room: a multi-person office meeting environment with cameras, microphones, table workspace, and presentation/whiteboard context.",
    note: `fixture=${fixtureId} run=${runId} scenario=office-meeting source=AMI baseline-snapshot`,
    createdAt: replayStartedAt,
    capturedAt: replayStartedAt,
    sourcePath: imagePath,
    fileName: "instrumented_meeting_room_300.jpg",
    mime: "image/jpeg",
    sizeBytes: imageStat.size,
    storageRelPath: `fixtures/${fixtureId}/instrumented_meeting_room_300.jpg`,
    retentionExpiresAt,
    analysisMode: "multimodal-preview",
    analysisProvider: "fixture-image:ami",
    analysisStatus: "succeeded",
    tags: ["fixture", "office", "meeting", "image"],
  });

  const audioEvents = [];
  for (let index = 0; index < windowCount; index += 1) {
    const sourceStart = firstWordAt + index * chunkSeconds;
    const sourceEnd = sourceStart + chunkSeconds;
    const transcript = buildTranscriptWindow(utterances, sourceStart, sourceEnd);
    if (!transcript.trim()) {
      continue;
    }
    const capturedAt = firstAudioCapturedAt + index * chunkSeconds * 1000;
    const windowTopic =
      index === 0
        ? "introductions and project setup"
        : index === 1
          ? "remote-control concept discussion and early feature ideas"
          : index === 2
            ? "finance, selling price, and product requirements"
            : "role ownership, decisions, and follow-up items";
    const result = await store.recordCapture({
      memoryId: randomUUID(),
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: `AMI ES2002a meeting transcript window ${index + 1}: ${windowTopic}. ${summarizeTranscript(transcript)}`,
      transcript,
      note: `csAudio:v2 session=${runId} segment=${
        index + 1
      } sessionStart=${firstAudioCapturedAt} boundary=fixture clipMs=${
        chunkSeconds * 1000
      } continued=${index === 0 ? 0 : 1} fixture=${fixtureId} run=${runId} scenario=office-meeting source=AMI sourceRange=${formatClock(
        sourceStart,
      )}-${formatClock(sourceEnd)}`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath: audioPath,
      fileName: `ES2002a.Mix-Headset.window-${index + 1}.wav`,
      mime: "audio/wav",
      sizeBytes: audioStat.size,
      storageRelPath: `fixtures/${fixtureId}/ES2002a.Mix-Headset.wav`,
      retentionExpiresAt,
      analysisMode: "runtime-stt",
      analysisProvider: "fixture-transcript:ami-manual",
      analysisStatus: "succeeded",
      sttProvider: "runtime",
      projectRefs: ["project:remote-control"],
      tags: ["fixture", "office", "meeting", "audio", "transcript-ready", "remote-control"],
    });
    audioEvents.push(result.event);
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
        device: {
          deviceId: device.deviceId,
          name: device.name,
        },
        recorded: {
          imageEvents: 1,
          audioEvents: audioEvents.length,
          transcriptUtterances: utterances.length,
          transcriptWords: words.length,
        },
        evidenceExpectations: {
          shouldMention: [
            "remote-control project",
            "project roles",
            "selling price / production cost",
            "requirements or features",
          ],
          gold,
        },
        eventIds: [image.event.eventId, ...audioEvents.map((event) => event.eventId)],
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
