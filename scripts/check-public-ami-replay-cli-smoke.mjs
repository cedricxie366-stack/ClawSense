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
const fixtureId = "public-ami-hybrid";
const fixtureDate = process.env.CLAWSENSE_PUBLIC_AMI_REPLAY_DATE || "2026-01-15";
const fixtureQuestion = process.env.CLAWSENSE_PUBLIC_AMI_REPLAY_QUESTION || `${fixtureDate} 公开 AMI 会议里，刚才讨论的重点是什么？`;
const speakerQuestion = process.env.CLAWSENSE_PUBLIC_AMI_REPLAY_SPEAKER_QUESTION || `${fixtureDate} 公开 AMI 会议里，Sarah 说了什么？`;
const resultPath =
  process.env.CLAWSENSE_PUBLIC_AMI_RESULT_PATH || newestAmiHybridResultPath();
const clipWavPath = path.join(projectRoot, ".local/asr/external/ami-full/ES2004a.Mix-Headset.60-360s.wav");

const logger = {
  info: (message) => console.error(message),
  warn: (message) => console.error(message),
  error: (message) => console.error(message),
};

const store = new ClawSenseStateStore({
  resolveStateDir: () => stateDir,
  logger,
});

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function newestAmiHybridResultPath() {
  const resultsDir = path.join(projectRoot, ".local/asr/results");
  if (!fs.existsSync(resultsDir)) {
    return undefined;
  }
  return fs
    .readdirSync(resultsDir)
    .filter((name) => /(?:evidence-v2-ami-hybrid|hybrid-ami-es2004a-60-360s|public-wav-ami-hybrid).*\.json$/.test(name))
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
  const res = spawnSync(localOpenClaw, ["openclaw", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw Object.assign(new Error(`${label} failed`), {
      details: {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        args,
      },
    });
  }
  return parseJsonObject(res.stdout, label);
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
  const segments = Array.isArray(result.segments) ? result.segments : [];
  const selected = segments
    .filter((segment) => typeof segment.text === "string" && segment.text.trim())
    .slice(0, 36);
  assert(selected.length >= 12, "AMI hybrid result does not contain enough transcript segments", {
    resultPath,
    segmentCount: segments.length,
  });
  return selected;
}

async function replayPublicAmi() {
  assert(resultPath && fs.existsSync(resultPath), "missing AMI hybrid result; run npm run check:public-wav first", {
    resultPath,
  });
  assert(fs.existsSync(clipWavPath), "missing AMI 5-minute clip; run npm run check:public-wav first", {
    clipWavPath,
  });
  const result = JSON.parse(await fsp.readFile(resultPath, "utf8"));
  const selectedSegments = selectSegments(result);
  const reset = await resetFixtureState();
  const clipStat = await fsp.stat(clipWavPath);
  const device = await store.registerDevice({
    name: "Public AMI hybrid fixture",
    platform: "fixture",
    appVersion: "public-replay-2026-07-03",
    fingerprint: `fixture:${fixtureId}`,
  });
  await store.updateHeartbeat(device.deviceId, {
    batteryPct: 100,
    network: "fixture",
    appState: "host-replay",
    raw: { fixtureId, fixtureDate, resultPath },
  });

  const session = `${fixtureId}-${fixtureDate}`;
  const startAt = new Date(`${fixtureDate}T09:58:00+08:00`).getTime();
  const retentionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const eventIds = [];
  let windowId;

  for (const [index, segment] of selectedSegments.entries()) {
    const startMs = Number(segment.startMs ?? index * 5000);
    const endMs = Number(segment.endMs ?? startMs + 3000);
    const capturedAt = startAt + Math.max(0, startMs);
    const memoryId = randomUUID();
    const created = await store.recordCapture({
      memoryId,
      namespace: "clawsense",
      deviceId: device.deviceId,
      modality: "audio",
      summary: `Public AMI hybrid replay segment ${index + 1}: ${segment.text}`,
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
      note: `csAudio:v2 session=${session} segment=${index + 1} sessionStart=${startAt} boundary=fixture clipMs=${Math.max(1, endMs - startMs)} continued=${index === 0 ? 0 : 1} fixture=${fixtureId} source=AMI sourceFile=ES2004a.Mix-Headset.60-360s.wav`,
      createdAt: capturedAt,
      capturedAt,
      sourcePath: clipWavPath,
      fileName: `ES2004a.Mix-Headset.60-360s.segment-${index + 1}.wav`,
      mime: "audio/wav",
      sizeBytes: clipStat.size,
      storageRelPath: `fixtures/${fixtureId}/ES2004a.Mix-Headset.60-360s.wav`,
      retentionExpiresAt,
      analysisMode: "local-asr",
      analysisProvider: "local-asr:hybrid-whisper-funasr:public-replay",
      analysisStatus: "succeeded",
      sttProvider: "local-asr",
      projectRefs: ["project:ami-public-meeting", "project:public-replay"],
      tags: ["fixture", "public-ami", "office", "meeting", "transcript-ready"],
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
  const replay = await replayPublicAmi();
  const contextBefore = runOpenClaw(
    ["clawsense", "context", fixtureDate, "--question", fixtureQuestion, "--focus", "what_happened"],
    "context-before-annotation",
  );
  const beforeSummary = summarizeContext(contextBefore);
  assert(beforeSummary.date === fixtureDate, "context should use the fixture date", beforeSummary);
  assert(beforeSummary.transcriptSpanCount >= 10, "replayed AMI state should expose transcript spans", beforeSummary);
  assert(beforeSummary.topicSegmentCount >= 1, "replayed AMI state should expose topic segments", beforeSummary);
  assert(beforeSummary.evidenceFollowUpTargetCount >= 1, "replayed AMI state should expose followup targets", beforeSummary);
  assert(
    beforeSummary.speakerSlots.some((slot) => slot.slotLabel === "speaker_2" && !slot.displayName),
    "speaker_2 should be available but unlabeled before annotation",
    beforeSummary.speakerSlots,
  );

  const speaker2 = beforeSummary.speakerSlots.find((slot) => slot.slotLabel === "speaker_2") ?? beforeSummary.speakerSlots[0];
  assert(speaker2?.speakerRef, "expected a speaker slot to annotate", beforeSummary.speakerSlots);
  const annotation = runOpenClaw(
    [
      "clawsense",
      "annotate-speaker",
      speaker2.speakerRef,
      "Sarah",
      "--relationship",
      "project manager",
      "--notes",
      `fixture=${fixtureId} public AMI replay speaker annotation`,
      "--windowId",
      speaker2.windowId,
      "--deviceId",
      replay.deviceId,
    ],
    "annotate-speaker",
  );

  const contextAfter = runOpenClaw(
    ["clawsense", "context", fixtureDate, "--question", speakerQuestion, "--focus", "what_happened"],
    "context-after-annotation",
  );
  const followups = runOpenClaw(
    ["clawsense", "followups", fixtureDate, "--question", speakerQuestion, "--focus", "what_happened"],
    "followups-after-annotation",
  );
  const afterSummary = summarizeContext(contextAfter);
  assert(
    afterSummary.speakerSlots.some((slot) => slot.speakerRef === speaker2.speakerRef && slot.displayName === "Sarah"),
    "speaker annotation should be visible in later context",
    afterSummary.speakerSlots,
  );
  assert(
    String(contextAfter.text ?? "").includes("Sarah") ||
      JSON.stringify(contextAfter.responseHints ?? {}).includes("Sarah"),
    "post-annotation context should surface Sarah",
    { textPreview: afterSummary.textPreview, responseHints: contextAfter.responseHints },
  );
  const followupTargets =
    followups.responseHints?.evidenceFollowUpTargets ??
    followups.evidenceFollowUpTargets ??
    [];
  assert(Array.isArray(followupTargets) && followupTargets.length >= 1, "followups should remain available after annotation", followups);

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        replay,
        before: beforeSummary,
        annotation: {
          ok: annotation.ok,
          speakerRef: annotation.annotation?.speakerRef,
          displayName: annotation.annotation?.displayName,
          relationship: annotation.annotation?.relationship,
        },
        after: afterSummary,
        followups: {
          evidenceFollowUpTargetCount: followupTargets.length,
          firstPrompt: followupTargets[0]?.prompt,
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
