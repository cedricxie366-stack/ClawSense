#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClawSenseContext } from "../dist/src/assistant-tool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const resultsDir = path.join(projectRoot, ".local/asr/results");

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function toTimeLabel(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function newestAmiHybridResult() {
  if (!fs.existsSync(resultsDir)) {
    return undefined;
  }
  return fs
    .readdirSync(resultsDir)
    .filter((name) => /(?:evidence-v2-ami-hybrid|hybrid-ami-es2004a-60-360s|public-wav-ami-hybrid).*\.json$/.test(name))
    .map((name) => path.join(resultsDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
}

function createBasePayload(params) {
  const windows = params.windows ?? [];
  const events = windows.flatMap((window) => window.events ?? []);
  const startAt = params.startAt ?? Math.min(...windows.map((window) => window.startedAt));
  const endAt = params.endAt ?? Math.max(...windows.map((window) => window.endedAt));
  const date = params.date ?? formatDateKey(new Date(startAt));
  return {
    scope: params.scope ?? "today",
    date,
    startAt,
    endAt,
    counts: {
      events: events.length,
      windows: windows.length,
      artifacts: events.filter((event) => event.artifact).length,
      devices: 1,
    },
    summary: params.summary ?? "ClawSense 聚合到一段会议型 evidence，用于验证对话回答路由。",
    recentActivity: {
      lookbackDays: 7,
      priorEventCount: events.length,
      priorWindowCount: windows.length,
      priorActiveDays: windows.length > 0 ? 1 : 0,
      sampleWindows: [],
    },
    review: params.review ?? {
      reviewId: `review-${date}`,
      date,
      generatedAt: endAt,
      mode: "multimodal",
      summary: params.summary ?? "会议里出现了可引用音频转写和场景证据。",
      sections: [
        { title: "Today at a glance", items: [params.summary ?? "会议证据已进入 ClawSense。"] },
        { title: "时间线回顾", items: windows.map((window) => `${toTimeLabel(window.startedAt)}-${toTimeLabel(window.endedAt)}：${window.primarySummary}`) },
        { title: "关键人物", items: params.speakerSummaryItems ?? [] },
        { title: "关键项目 / 主题", items: params.projectSummaryItems ?? [] },
        { title: "值得注意的细节", items: params.watchItems ?? [] },
        { title: "今天遗漏但值得追问的点", items: params.gapItems ?? [] },
        { title: "明天建议关注的事情", items: params.nextItems ?? [] },
      ],
      keyEventIds: events.slice(0, 4).map((event) => event.eventId),
      keyArtifactIds: events.flatMap((event) => event.artifact?.artifactId ? [event.artifact.artifactId] : []).slice(0, 4),
    },
    windows,
    highlights: {
      keyWindowIds: windows.slice(0, 3).map((window) => window.windowId),
      audioCoverage: {
        totalAudioWindows: windows.filter((window) => window.audioCount > 0).length,
        transcriptReadyWindows: windows.filter((window) => Boolean(window.transcriptText)).length,
        pendingAudioWindows: 0,
        degradedAudioEvents: 0,
      },
      recentImages: params.recentImages ?? [],
      recentConversations: windows
        .filter((window) => window.transcriptText)
        .slice(0, 3)
        .map((window) => ({
          windowId: window.windowId,
          startedAt: window.startedAt,
          endedAt: window.endedAt,
          summary: window.primarySummary,
          transcriptExcerpt: window.transcriptText.slice(0, 260),
        })),
      people: params.people ?? [],
      speakers: params.speakers ?? [],
    },
  };
}

async function resolveWithPayload(payloadFactory, question) {
  let buildCall;
  const reviewEngine = {
    normalizeDateInput: (input) => input ?? formatDateKey(new Date()),
    buildAssistantContext: async (call) => {
      buildCall = call;
      return payloadFactory(call);
    },
    recheckAudioEvidence: async () => [],
  };
  const resolved = await resolveClawSenseContext(
    {
      reviewEngine,
      artifactUrlBase: () => "http://claw/api/clawsense/artifacts",
    },
    { question },
  );
  assert(resolved.ok, "context resolution should succeed", resolved);
  return {
    buildCall,
    resolved,
    details: resolved.details,
    evidence: resolved.details.evidenceBundle,
  };
}

function createPublicAmiPayload() {
  const resultPath = newestAmiHybridResult();
  assert(resultPath, "no AMI hybrid result found; run npm run check:public-wav first");
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const segments = Array.isArray(result.segments) ? result.segments : [];
  const timeline = Array.isArray(result.speakerTimelineSegments) ? result.speakerTimelineSegments : [];
  assert(segments.length >= 20, "AMI result should contain enough transcript segments", { resultPath, segmentCount: segments.length });
  assert(timeline.length >= 3, "AMI result should contain speaker timeline segments", { resultPath, speakerTimelineSegmentCount: timeline.length });

  const date = "2026-06-25";
  const startAt = new Date("2026-06-25T09:58:00+08:00").getTime();
  const endAt = startAt + 5 * 60 * 1000;
  const selectedSegments = segments.slice(0, 42);
  const selectedTimeline = timeline.slice(0, 12);
  const transcriptText = selectedSegments.map((segment) => segment.text).join(" ");
  const windowId = "audio-session::public-ami-es2004a-60-360";
  const audioEvents = selectedSegments.map((segment, index) => ({
    eventId: `ami-audio-${index + 1}`,
    modality: "audio",
    capturedAt: startAt + Math.max(0, Number(segment.startMs ?? 0)),
    summary: `AMI 会议转写片段 ${index + 1}。`,
    transcript: segment.text,
    transcriptSegments: [
      {
        startMs: Number(segment.startMs ?? 0),
        endMs: Number(segment.endMs ?? segment.startMs ?? 0),
        text: segment.text,
        speakerLabel: segment.speakerLabel,
        confidence: segment.confidence,
      },
    ],
    speakerTimelineSegments: [
      {
        startMs: Number(segment.startMs ?? 0),
        endMs: Number(segment.endMs ?? segment.startMs ?? 0),
        text: segment.text,
        speakerLabel: segment.speakerLabel,
      },
    ],
    captureContext: "audio-window",
    analysisMode: "local-asr",
    analysisProvider: "local-asr:hybrid-whisper-funasr",
    analysisStatus: "succeeded",
    artifact:
      index === 0
        ? {
            artifactId: "ami-public-wav-clip",
            fileName: "ES2004a.Mix-Headset.60-360s.wav",
            mime: "audio/wav",
            available: true,
            sizeBytes: 9600044,
            url: "http://claw/api/clawsense/artifacts?id=ami-public-wav-clip",
          }
        : undefined,
  }));
  const imageEvent = {
    eventId: "ami-room-image-1",
    modality: "image",
    capturedAt: startAt + 60_000,
    summary: "会议室画面中可以看到多人围绕项目计划做讨论，视觉证据只作为会议环境背景。",
    captureContext: "active-window",
    analysisMode: "multimodal-preview",
    analysisProvider: "primary-multimodal:runtime-primary",
    analysisStatus: "succeeded",
  };

  return createBasePayload({
    scope: "custom-range",
    date,
    startAt,
    endAt,
    summary: "公开 AMI 会议样例里，参会者在介绍会议议程、项目计划和后续讨论事项。",
    projectSummaryItems: ["AMI meeting", "project plan", "agenda discussion"],
    speakerSummaryItems: ["公开 AMI 样例中出现多个 speaker，占位标签用于验证 speaker timeline。"],
    watchItems: ["回答会议问题时应优先引用音频转写，而不是只看会议室图片。"],
    windows: [
      {
        windowId,
        deviceId: "public-ami",
        startedAt: startAt,
        endedAt: endAt,
        primarySummary: "公开 AMI 会议片段：项目经理介绍议程，并进入项目计划讨论。",
        transcriptText,
        imageCount: 1,
        videoCount: 0,
        audioCount: selectedSegments.length,
        captureContexts: ["audio-window", "active-window"],
        peopleRefs: [],
        projectRefs: ["AMI meeting", "project plan"],
        tags: ["meeting", "office", "project"],
        events: audioEvents.concat(imageEvent),
      },
    ],
    speakers: Array.from(new Set(selectedTimeline.map((segment) => segment.speakerLabel).filter(Boolean)))
      .slice(0, 2)
      .map((speakerLabel) => {
        const index = String(speakerLabel).replace(/\D+/g, "") || "1";
        return {
          speakerRef: `speaker:${windowId}:${index}`,
          displayName: String(speakerLabel),
          relationship: "公开样例说话人",
          windowId,
          deviceId: "public-ami",
        };
      }),
  });
}

function createRangePayload(call) {
  const now = new Date();
  const startAt = call.startAt ?? (call.scope === "last-hour" ? now.getTime() - 60 * 60 * 1000 : new Date(`${call.date ?? formatDateKey(now)}T09:00:00+08:00`).getTime());
  const endAt = call.endAt ?? (call.scope === "last-hour" ? now.getTime() : startAt + 60 * 60 * 1000);
  const date = call.date ?? formatDateKey(new Date(startAt));
  return createBasePayload({
    scope: call.scope ?? "today",
    date,
    startAt,
    endAt,
    summary: `范围路由验证 payload：${call.scope ?? "today"} ${date}`,
    windows: [],
  });
}

function createSpeakerTaskPayload(params) {
  const date = "2026-06-25";
  const startAt = new Date("2026-06-25T10:12:00+08:00").getTime();
  const windowId = "audio-session::speaker-annotation-loop";
  const firstText = "我负责整理会议纪要，明天上午发给大家。";
  const secondText = "产品团队需要确认接口方案，7月30日前给出技术路径。";
  const events = [
    {
      eventId: "speaker-task-pronoun",
      modality: "audio",
      capturedAt: startAt,
      summary: "speaker_1 使用第一人称认领整理会议纪要。",
      transcript: firstText,
      transcriptSegments: [{ startMs: 0, endMs: 1800, text: firstText, speakerLabel: "speaker_1" }],
      speakerTimelineSegments: [{ startMs: 0, endMs: 1800, text: firstText, speakerLabel: "speaker_1" }],
      captureContext: "audio-window",
      analysisMode: "local-asr",
      analysisProvider: "local-asr:hybrid-whisper-funasr",
      analysisStatus: "succeeded",
    },
    {
      eventId: "speaker-task-team",
      modality: "audio",
      capturedAt: startAt + 90_000,
      summary: "speaker_2 提到产品团队需要确认接口方案。",
      transcript: secondText,
      transcriptSegments: [{ startMs: 0, endMs: 2400, text: secondText, speakerLabel: "speaker_2" }],
      speakerTimelineSegments: [{ startMs: 0, endMs: 2400, text: secondText, speakerLabel: "speaker_2" }],
      captureContext: "audio-window",
      analysisMode: "local-asr",
      analysisProvider: "local-asr:hybrid-whisper-funasr",
      analysisStatus: "succeeded",
    },
  ];
  const speakers = params.speakerOneDisplayName
    ? [
        {
          speakerRef: `speaker:${windowId}:1`,
          displayName: params.speakerOneDisplayName,
          relationship: params.speakerOneRelationship ?? "用户",
          windowId,
          deviceId: "device-speaker-loop",
        },
      ]
    : [];
  return createBasePayload({
    scope: "today",
    date,
    startAt,
    endAt: startAt + 5 * 60 * 1000,
    summary: "会议中出现第一人称任务认领和产品团队待办，适合验证 speaker 标注前后的任务归属变化。",
    projectSummaryItems: ["接口方案", "会议纪要"],
    watchItems: ["第一人称任务必须依赖 speaker 身份，不能在未标注时直接归给用户。"],
    nextItems: ["整理会议纪要", "确认接口方案"],
    windows: [
      {
        windowId,
        deviceId: "device-speaker-loop",
        startedAt: startAt,
        endedAt: startAt + 5 * 60 * 1000,
        primarySummary: "会议里确认会议纪要和接口方案两个待办。",
        transcriptText: `${firstText} ${secondText}`,
        imageCount: 0,
        videoCount: 0,
        audioCount: events.length,
        captureContexts: ["audio-window"],
        peopleRefs: [],
        projectRefs: ["接口方案", "会议纪要"],
        tags: ["meeting", "office", "task"],
        events,
      },
    ],
    speakers,
  });
}

async function checkPublicAmiQuestionPack() {
  const question = "刚才讨论的重点是什么？";
  const { resolved, details, evidence } = await resolveWithPayload(() => createPublicAmiPayload(), question);
  const firstEvent = details.windows[0]?.events.find((event) => event.modality === "audio");
  const audioDiagnostics = evidence.audioDiagnostics;
  const responseHintAudioDiagnostics = details.responseHints.audioDiagnostics;
  assert(evidence.timeRange.scope === "custom-range" || details.scope === "custom-range", "public AMI payload should expose a custom-range evidence bundle", evidence.timeRange);
  assert(evidence.transcriptSpans.length >= 10, "public AMI question pack should expose many transcript spans", {
    transcriptSpanCount: evidence.transcriptSpans.length,
  });
  assert(evidence.topicSegments.length >= 1, "public AMI question pack should build meeting topic segments", evidence.topicSegments);
  assert(evidence.conversationDigest?.topicIndex?.length >= 1, "public AMI question pack should expose a long-conversation digest", evidence.conversationDigest);
  assert(
    details.responseHints.conversationDigest?.followupPrompts?.length >= 1,
    "public AMI response hints should expose conversation digest followups",
    details.responseHints.conversationDigest,
  );
  assert(evidence.audioCoverage.transcriptReadyWindows >= 1, "public AMI question pack should report transcript-ready audio", evidence.audioCoverage);
  assert(
    audioDiagnostics?.verdict?.rawAudioArtifacts === "available",
    "public AMI question pack should expose available raw audio diagnostics",
    audioDiagnostics,
  );
  assert(
    responseHintAudioDiagnostics?.verdict?.rawAudioArtifacts === "available",
    "public AMI response hints should expose raw audio diagnostics to the chat page",
    responseHintAudioDiagnostics,
  );
  assert(
    audioDiagnostics.counts?.transcriptReadyEvents >= 10,
    "public AMI diagnostics should count transcript-ready audio events",
    audioDiagnostics,
  );
  assert(
    audioDiagnostics.counts?.speakerTimelineReadyEvents >= 10,
    "public AMI diagnostics should count speaker timeline-ready audio events",
    audioDiagnostics,
  );
  assert(
    audioDiagnostics.blockerIds?.includes("audio-ready") ||
      audioDiagnostics.blockerIds?.includes("diarization-runnable"),
    "public AMI diagnostics should expose an audio-ready or diarization-runnable note",
    audioDiagnostics,
  );
  assert(firstEvent?.speakerTimelineSegments?.length >= 1, "public AMI details should expose speaker timeline evidence", firstEvent);
  assert(
    details.responseHints.evidenceFollowUpTargets.some((target) => target.source === "topic" || target.source === "audio"),
    "public AMI response hints should expose clickable audio/topic followups",
    details.responseHints.evidenceFollowUpTargets,
  );
  assert(resolved.text.includes("对话优先说明"), "tool text should instruct the model to prioritize transcript for meeting questions");
  assert(resolved.text.includes("音频转写证据"), "tool text should include transcript evidence section");
  return {
    transcriptSpanCount: evidence.transcriptSpans.length,
    topicSegmentCount: evidence.topicSegments.length,
    conversationDigestTopicCount: evidence.conversationDigest?.topicIndex?.length ?? 0,
    speakerTimelineSegmentCount: firstEvent?.speakerTimelineSegments?.length ?? 0,
    rawAudioArtifacts: audioDiagnostics.verdict.rawAudioArtifacts,
    audioEvents: audioDiagnostics.counts.audioEvents,
    transcriptReadyEvents: audioDiagnostics.counts.transcriptReadyEvents,
    speakerTimelineReadyEvents: audioDiagnostics.counts.speakerTimelineReadyEvents,
    audioBlockerIds: audioDiagnostics.blockerIds,
    evidenceFollowUpTargetCount: details.responseHints.evidenceFollowUpTargets.length,
    firstTopicTitle: evidence.topicSegments[0]?.title,
  };
}

async function checkTimeRangeRouting() {
  const cases = [];
  const now = new Date();
  const expectedYesterday = formatDateKey(addDays(now, -1));

  const pastFour = await resolveWithPayload(createRangePayload, "过去4小时我们聊了什么？");
  assert(pastFour.buildCall.scope === "custom-range", "past 4 hours should infer custom-range", pastFour.buildCall);
  assert(
    Math.abs((pastFour.buildCall.endAt - pastFour.buildCall.startAt) - 4 * 60 * 60 * 1000) < 10_000,
    "past 4 hours should request a 4h range",
    pastFour.buildCall,
  );
  cases.push({ question: "过去4小时我们聊了什么？", call: pastFour.buildCall });

  const yesterday = await resolveWithPayload(createRangePayload, "昨天发生了什么？");
  assert(yesterday.buildCall.scope === "today", "yesterday should infer day scope", yesterday.buildCall);
  assert(yesterday.buildCall.date === expectedYesterday, "yesterday should infer previous local date", {
    expectedYesterday,
    call: yesterday.buildCall,
  });
  cases.push({ question: "昨天发生了什么？", call: yesterday.buildCall });

  const explicitDate = await resolveWithPayload(createRangePayload, "6月25日发生了什么？");
  assert(explicitDate.buildCall.scope === "today", "explicit date should infer day scope", explicitDate.buildCall);
  assert(explicitDate.buildCall.date === "2026-06-25", "explicit 6月25日 should infer 2026-06-25", explicitDate.buildCall);
  cases.push({ question: "6月25日发生了什么？", call: explicitDate.buildCall });

  const lastHour = await resolveWithPayload(createRangePayload, "过去一小时有什么需要注意？");
  assert(
    lastHour.buildCall.scope === "last-hour" ||
      (lastHour.buildCall.scope === "custom-range" &&
        Math.abs((lastHour.buildCall.endAt - lastHour.buildCall.startAt) - 60 * 60 * 1000) < 10_000),
    "past one hour should request a one-hour evidence window",
    lastHour.buildCall,
  );
  cases.push({ question: "过去一小时有什么需要注意？", call: lastHour.buildCall });

  return cases.map((item) => ({
    question: item.question,
    scope: item.call.scope,
    date: item.call.date,
    durationMs: item.call.startAt && item.call.endAt ? item.call.endAt - item.call.startAt : undefined,
  }));
}

async function checkSpeakerAnnotationLoop() {
  const question = "这段会议里，有哪些明确分配给我的任务？哪些只是别人提到但没有落到我身上的？";
  const unresolved = await resolveWithPayload(() => createSpeakerTaskPayload({}), question);
  const unresolvedCandidates = unresolved.evidence.taskAttribution.candidates;
  const unresolvedBuckets = unresolved.evidence.taskAttribution.buckets;
  assert(unresolved.evidence.taskAttribution.status === "needs-speaker-labels", "unlabeled pronoun task should require speaker labels", unresolved.evidence.taskAttribution);
  assert(
    unresolvedCandidates.some(
      (candidate) =>
        candidate.text.includes("我负责整理会议纪要") &&
        candidate.speakerLabel === "speaker_1" &&
        candidate.userAssignmentStatus === "needs-speaker-label",
    ),
    "unlabeled speaker_1 first-person task should not be assigned to user yet",
    unresolvedCandidates,
  );
  assert(
    unresolvedBuckets.needsSpeakerLabel.some((candidate) => candidate.text.includes("我负责整理会议纪要")),
    "unlabeled first-person task should be bucketed as needsSpeakerLabel",
    unresolvedBuckets,
  );
  assert(
    unresolved.evidence.conversationDigest?.taskMatches?.some(
      (candidate) =>
        candidate.text.includes("我负责整理会议纪要") &&
        candidate.userAssignmentStatus === "needs-speaker-label" &&
        candidate.resolutionMode === "exact-speaker-label" &&
        candidate.requiresDiarization === false &&
        typeof candidate.selfCommandTemplate === "string",
    ),
    "unlabeled first-person task should appear in taskMatches with an exact speaker annotation hint",
    unresolved.evidence.conversationDigest,
  );
  assert(
    unresolved.evidence.taskAttribution.speakerResolutionPrompts.some(
      (prompt) =>
        prompt.speakerLabel === "speaker_1" &&
        prompt.resolutionMode === "exact-speaker-label" &&
        prompt.requiresDiarization === false &&
        prompt.selfSentenceTemplate.includes("我本人"),
    ),
    "unlabeled first-person task should expose a speaker resolution prompt",
    unresolved.evidence.taskAttribution.speakerResolutionPrompts,
  );

  const labeledAsUser = await resolveWithPayload(
    () => createSpeakerTaskPayload({ speakerOneDisplayName: "我", speakerOneRelationship: "用户" }),
    question,
  );
  const userCandidates = labeledAsUser.evidence.taskAttribution.candidates;
  const userBuckets = labeledAsUser.evidence.taskAttribution.buckets;
  assert(labeledAsUser.evidence.taskAttribution.status === "ready", "speaker_1 labeled as user should make attribution ready", labeledAsUser.evidence.taskAttribution);
  assert(
    userCandidates.some(
      (candidate) =>
        candidate.text.includes("我负责整理会议纪要") &&
        candidate.speakerDisplayName === "我" &&
        candidate.userAssignmentStatus === "assigned-to-user",
    ),
    "speaker_1 labeled as user should assign first-person task to user",
    userCandidates,
  );
  assert(
    userBuckets.assignedToUser.some((candidate) => candidate.text.includes("我负责整理会议纪要")),
    "speaker_1 labeled as user should move first-person task into assignedToUser bucket",
    userBuckets,
  );
  assert(
    userCandidates.some(
      (candidate) =>
        candidate.text.includes("产品团队需要确认接口方案") &&
        candidate.userAssignmentStatus === "not-user-unless-role-matches",
    ),
    "named team task should remain separate from user assignment",
    userCandidates,
  );
  assert(
    userBuckets.assignedToOthersOrTeams.some((candidate) => candidate.text.includes("产品团队需要确认接口方案")),
    "named team task should be bucketed outside assignedToUser",
    userBuckets,
  );
  assert(
    labeledAsUser.evidence.conversationDigest?.taskMatches?.some(
      (candidate) =>
        candidate.text.includes("我负责整理会议纪要") &&
        candidate.userAssignmentStatus === "assigned-to-user" &&
        candidate.resolutionMode === undefined &&
        candidate.requiresDiarization === undefined,
    ),
    "speaker_1 labeled as user should appear as assigned-to-user in taskMatches",
    labeledAsUser.evidence.conversationDigest,
  );
  assert(
    labeledAsUser.evidence.taskAttribution.speakerResolutionPrompts.length === 0,
    "speaker_1 labeled as user should clear speaker resolution prompts",
    labeledAsUser.evidence.taskAttribution.speakerResolutionPrompts,
  );

  return {
    unresolvedStatus: unresolved.evidence.taskAttribution.status,
    labeledStatus: labeledAsUser.evidence.taskAttribution.status,
    unresolvedBucketCounts: Object.fromEntries(
      Object.entries(unresolvedBuckets).map(([key, value]) => [key, value.length]),
    ),
    labeledBucketCounts: Object.fromEntries(
      Object.entries(userBuckets).map(([key, value]) => [key, value.length]),
    ),
    unresolvedFirstTask: unresolvedCandidates.find((candidate) => candidate.text.includes("我负责整理会议纪要")),
    labeledFirstTask: userCandidates.find((candidate) => candidate.text.includes("我负责整理会议纪要")),
    namedTeamTask: userCandidates.find((candidate) => candidate.text.includes("产品团队需要确认接口方案")),
    unresolvedSpeakerResolutionPrompt: unresolved.evidence.taskAttribution.speakerResolutionPrompts[0],
  };
}

async function main() {
  const publicAmi = await checkPublicAmiQuestionPack();
  const timeRangeRouting = await checkTimeRangeRouting();
  const speakerAnnotationLoop = await checkSpeakerAnnotationLoop();
  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        publicAmi,
        timeRangeRouting,
        speakerAnnotationLoop,
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
