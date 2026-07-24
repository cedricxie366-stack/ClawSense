#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ClawSenseStateStore } from "../dist/src/state-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const localOpenClaw = path.join(projectRoot, "scripts", "local-openclaw.sh");
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(projectRoot, ".local/openclaw/state");
const stateFile = path.join(stateDir, "plugins", "clawsense", "state.json");
const fixtureId = "public-zh-alimeeting";
const fixtureDate = process.env.CLAWSENSE_PUBLIC_ZH_REPLAY_DATE || "2026-01-16";
const fixtureQuestion =
  process.env.CLAWSENSE_PUBLIC_ZH_REPLAY_QUESTION || `${fixtureDate} 中文会议里，刚才讨论的重点是什么？`;
const speakerQuestion =
  process.env.CLAWSENSE_PUBLIC_ZH_REPLAY_SPEAKER_QUESTION || `${fixtureDate} 中文会议里，同事A 说了什么？`;
const resultPath = process.env.CLAWSENSE_PUBLIC_ZH_RESULT_PATH || newestChineseMeetingResultPath();
const clipWavPath =
  process.env.CLAWSENSE_PUBLIC_ZH_CLIP_PATH ||
  path.join(projectRoot, ".local/asr/external/alimeeting/R8002_M8002_MS802.far-mono.120s.wav");

const store = new ClawSenseStateStore({
  resolveStateDir: () => stateDir,
  logger: {
    info: (message) => console.error(message),
    warn: (message) => console.error(message),
    error: (message) => console.error(message),
  },
});

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function newestChineseMeetingResultPath() {
  const resultsDir = path.join(projectRoot, ".local/asr/results");
  if (!fs.existsSync(resultsDir)) return undefined;
  return fs
    .readdirSync(resultsDir)
    .filter((name) => /^public-zh-alimeeting-(?:funasr|whisper)-primary-.*\.json$/.test(name))
    .map((name) => path.join(resultsDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
}

function parseJsonObject(stdout, label) {
  const text = stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  assert(start >= 0 && end > start, `${label} did not output JSON`, text.slice(0, 2000));
  return JSON.parse(text.slice(start, end + 1));
}

function runOpenClaw(args, label) {
  const result = spawnSync(localOpenClaw, ["openclaw", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw Object.assign(new Error(`${label} failed`), {
      details: {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        args,
      },
    });
  }
  return parseJsonObject(result.stdout, label);
}

function summarizeContext(payload) {
  const evidence = payload.evidenceBundle ?? {};
  const hints = payload.responseHints ?? {};
  return {
    date: payload.date ?? evidence.timeRange?.date,
    scope: payload.scope ?? evidence.timeRange?.scope,
    windowCount: payload.windows?.length ?? evidence.windows?.length ?? 0,
    transcriptSpanCount: evidence.transcriptSpans?.length ?? 0,
    topicSegmentCount: evidence.topicSegments?.length ?? 0,
    evidenceFollowUpTargetCount: hints.evidenceFollowUpTargets?.length ?? 0,
    speakerSlots: evidence.speakerLayer?.suggestedSlots ?? [],
    taskAttributionStatus: evidence.taskAttribution?.status,
    textPreview: String(payload.text ?? "").slice(0, 500),
  };
}

async function resetFixtureState() {
  let state;
  try {
    state = JSON.parse(await fsp.readFile(stateFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { removedEvents: 0, removedArtifacts: 0, removedSpeakers: 0, removedJournal: 0, removedReviews: 0, removedConsolidations: 0 };
    }
    throw error;
  }

  const fixtureEventIds = new Set(
    (Array.isArray(state.events) ? state.events : [])
      .filter((event) => String(event.note ?? "").includes(`fixture=${fixtureId}`))
      .map((event) => event.eventId),
  );
  const fixtureArtifactIds = new Set(
    (Array.isArray(state.artifacts) ? state.artifacts : [])
      .filter((artifact) => String(artifact.storageRelPath ?? "").includes(`fixtures/${fixtureId}/`))
      .map((artifact) => artifact.artifactId),
  );
  const before = {
    events: state.events?.length ?? 0,
    artifacts: state.artifacts?.length ?? 0,
    speakers: state.speakers?.length ?? 0,
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
  state.speakers = (Array.isArray(state.speakers) ? state.speakers : []).filter(
    (speaker) =>
      !String(speaker.speakerRef ?? "").includes(fixtureId) &&
      !String(speaker.windowId ?? "").includes(fixtureId) &&
      !String(speaker.notes ?? "").includes(`fixture=${fixtureId}`),
  );
  state.reviews = (Array.isArray(state.reviews) ? state.reviews : []).filter((review) => review.date !== fixtureDate);
  state.consolidations = (Array.isArray(state.consolidations) ? state.consolidations : []).filter(
    (consolidation) => consolidation.date !== fixtureDate,
  );

  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  await fsp.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return {
    removedEvents: before.events - state.events.length,
    removedArtifacts: before.artifacts - state.artifacts.length,
    removedSpeakers: before.speakers - state.speakers.length,
    removedJournal: before.journal - state.journal.length,
    removedReviews: before.reviews - state.reviews.length,
    removedConsolidations: before.consolidations - state.consolidations.length,
  };
}

function selectSegments(result) {
  const primary = Array.isArray(result.segments) ? result.segments : [];
  const timeline = Array.isArray(result.speakerTimelineSegments) ? result.speakerTimelineSegments : [];
  const selected = (primary.length > 0 ? primary : timeline)
    .filter((segment) => typeof segment.text === "string" && segment.text.trim())
    .slice(0, 12);
  assert(selected.length >= 3, "Chinese meeting result does not contain enough transcript segments", {
    resultPath,
    primarySegments: primary.length,
    speakerTimelineSegments: timeline.length,
  });
  return selected;
}

async function replayChineseMeeting() {
  assert(resultPath && fs.existsSync(resultPath), "missing Chinese meeting ASR result; run CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting first", {
    resultPath,
  });
  assert(fs.existsSync(clipWavPath), "missing Chinese meeting clip; run CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting first", {
    clipWavPath,
  });
  const result = JSON.parse(await fsp.readFile(resultPath, "utf8"));
  const selectedSegments = selectSegments(result);
  const reset = await resetFixtureState();
  const clipStat = await fsp.stat(clipWavPath);
  const device = await store.registerDevice({
    name: "Public AliMeeting Chinese fixture",
    platform: "fixture",
    appVersion: "public-zh-replay-2026-07-03",
    fingerprint: `fixture:${fixtureId}`,
  });
  await store.updateHeartbeat(device.deviceId, {
    batteryPct: 100,
    network: "fixture",
    appState: "host-replay",
    raw: { fixtureId, fixtureDate, resultPath },
  });

  const session = `${fixtureId}-${fixtureDate}`;
  const startAt = new Date(`${fixtureDate}T10:00:00+08:00`).getTime();
  const retentionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const eventIds = [];
  let windowId;

  for (const [index, segment] of selectedSegments.entries()) {
    const startMs = Number(segment.startMs ?? index * 10_000);
    const endMs = Number(segment.endMs ?? startMs + 8000);
    const capturedAt = startAt + Math.max(0, startMs);
    const created = await store.recordCapture({
      memoryId: randomUUID(),
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: `Public Chinese AliMeeting replay segment ${index + 1}: ${segment.text}`,
      transcript: segment.text,
      transcriptSegments: [
        {
          startMs,
          endMs,
          text: segment.text,
          speakerLabel: segment.speakerLabel,
          confidence: segment.confidence,
        },
      ],
      speakerTimelineSegments: [
        {
          startMs,
          endMs,
          text: segment.text,
          speakerLabel: segment.speakerLabel,
        },
      ],
      note: `csAudio:v2 session=${session} segment=${index + 1} sessionStart=${startAt} boundary=fixture clipMs=${Math.max(1, endMs - startMs)} continued=${index === 0 ? 0 : 1} fixture=${fixtureId} source=AliMeeting sourceFile=R8002_M8002_MS802.far-mono.120s.wav`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath: clipWavPath,
      fileName: `R8002_M8002_MS802.far-mono.120s.segment-${index + 1}.wav`,
      mime: "audio/wav",
      sizeBytes: clipStat.size,
      storageRelPath: `fixtures/${fixtureId}/R8002_M8002_MS802.far-mono.120s.wav`,
      retentionExpiresAt,
      analysisMode: "local-asr",
      analysisProvider: "local-asr:funasr-primary-hybrid:public-zh-replay",
      analysisStatus: "succeeded",
      sttProvider: "local-asr",
      projectRefs: ["project:alimeeting-public-meeting", "project:public-zh-replay"],
      tags: ["fixture", "public-zh", "office", "meeting", "transcript-ready"],
    });
    windowId = windowId ?? created.event.windowId;
    eventIds.push(created.event.eventId);
  }

  return {
    reset,
    deviceId: device.deviceId,
    windowId,
    eventIds,
    segmentCount: selectedSegments.length,
    resultPath,
    clipWavPath,
    fixtureDate,
  };
}

async function main() {
  const replay = await replayChineseMeeting();
  const contextBefore = runOpenClaw(
    ["clawsense", "context", fixtureDate, "--question", fixtureQuestion, "--focus", "what_happened"],
    "context-before-annotation",
  );
  const before = summarizeContext(contextBefore);
  assert(before.date === fixtureDate, "context should use the fixture date", before);
  assert(before.transcriptSpanCount >= 3, "replayed Chinese meeting state should expose transcript spans", before);
  assert(before.topicSegmentCount >= 1, "replayed Chinese meeting state should expose topic segments", before);
  assert(before.evidenceFollowUpTargetCount >= 1, "replayed Chinese meeting state should expose followup targets", before);

  const speakerSlot =
    before.speakerSlots.find((slot) => slot.slotLabel === "speaker_2") ??
    before.speakerSlots.find((slot) => slot.speakerRef) ??
    null;
  assert(speakerSlot?.speakerRef, "expected a Chinese meeting speaker slot to annotate", before.speakerSlots);
  const annotation = runOpenClaw(
    [
      "clawsense",
      "annotate-speaker",
      speakerSlot.speakerRef,
      "同事A",
      "--relationship",
      "meeting participant",
      "--notes",
      `fixture=${fixtureId}; public Chinese meeting replay smoke`,
      "--windowId",
      speakerSlot.windowId,
    ],
    "annotate-speaker",
  );
  assert(annotation.annotation?.displayName === "同事A", "speaker annotation did not persist displayName", annotation);

  const contextAfter = runOpenClaw(
    ["clawsense", "context", fixtureDate, "--question", speakerQuestion, "--focus", "people"],
    "context-after-annotation",
  );
  const after = summarizeContext(contextAfter);
  assert(after.transcriptSpanCount >= 3, "speaker follow-up should keep transcript spans", after);
  assert(
    after.speakerSlots.some((slot) => slot.displayName === "同事A") || String(contextAfter.text ?? "").includes("同事A"),
    "speaker follow-up should expose the annotated Chinese displayName",
    after,
  );

  const followups = runOpenClaw(
    ["clawsense", "followups", fixtureDate, "--question", fixtureQuestion, "--focus", "what_happened"],
    "followups",
  );
  assert((followups.evidenceFollowUpTargets?.length ?? 0) >= 1, "Chinese replay followups should not be empty", followups);

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        replay,
        before,
        annotation,
        after,
        followups: {
          evidenceFollowUpTargetCount: followups.evidenceFollowUpTargets?.length ?? 0,
          firstPrompt: followups.followUps?.[0]?.prompt ?? null,
        },
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
