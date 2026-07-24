#!/usr/bin/env node
import { resolveClawSenseContext } from "../dist/src/assistant-tool.js";

const startedAt = new Date("2026-06-25T10:12:00+08:00").getTime();
const endedAt = new Date("2026-06-25T10:18:00+08:00").getTime();
const windowId = "audio-session::evidence-v2-smoke";
const question = "6 月 25 日会议里，有哪些明确分配给我的任务？哪些只是别人提到但没有落到我身上的？";

function assert(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function createPayload() {
  return {
    scope: "today",
    date: "2026-06-25",
    startAt: new Date("2026-06-25T00:00:00+08:00").getTime(),
    endAt: new Date("2026-06-26T00:00:00+08:00").getTime(),
    counts: { events: 4, windows: 1, artifacts: 4, devices: 1 },
    summary: "当天主要围绕 AI 陪练系统、数据同步、考核报表和培训安排展开。",
    recentActivity: {
      lookbackDays: 7,
      priorEventCount: 12,
      priorWindowCount: 3,
      priorActiveDays: 2,
      sampleWindows: [],
    },
    review: {
      reviewId: "review-evidence-v2-smoke",
      date: "2026-06-25",
      generatedAt: endedAt,
      mode: "multimodal",
      summary: "会议里讨论了 AI 陪练系统功能演示、实时语料库同步、报表验证和培训安排。",
      sections: [
        { title: "Today at a glance", items: ["上午围绕 AI 陪练系统做功能演示和优化需求讨论。"] },
        { title: "时间线回顾", items: ["10:12-10:18 讨论培训安排、考核报表和下一步跟进。"] },
        { title: "关键人物", items: ["Amy 被标注为 speaker_2。"] },
        { title: "关键项目 / 主题", items: ["AI 陪练系统、培训安排、报表验证。"] },
        { title: "值得注意的细节", items: ["需要区分明确 owner、speaker 依赖任务和泛讨论事项。"] },
        { title: "今天遗漏但值得追问的点", items: ["speaker_1 是否是用户本人仍待确认。"] },
        { title: "明天建议关注的事情", items: ["确认培训安排和报表验收 owner。"] },
      ],
      keyEventIds: ["event-speaker-task-1"],
      keyArtifactIds: ["audio-clip-1"],
    },
    windows: [
      {
        windowId,
        deviceId: "device-1",
        startedAt,
        endedAt,
        primarySummary: "会议里确认培训安排和报表验收的后续动作。",
        transcriptText: [
          "我负责同步培训安排，明天上午先给你们一版。",
          "产品团队需要在7月30日前提供实时语料库同步方案。",
          "后面还要确认考核点通过率与缺陷项汇总逻辑。",
        ].join(" "),
        imageCount: 1,
        videoCount: 0,
        audioCount: 3,
        captureContexts: ["audio-window", "active-window"],
        peopleRefs: [],
        projectRefs: ["AI 陪练系统"],
        tags: ["meeting", "ai-training", "training"],
        events: [
          {
            eventId: "event-speaker-task-1",
            modality: "audio",
            capturedAt: startedAt,
            summary: "Amy 说自己负责同步培训安排。",
            transcript: "我负责同步培训安排，明天上午先给你们一版。",
            transcriptSegments: [
              {
                startMs: 0,
                endMs: 2600,
                text: "我负责同步培训安排，明天上午先给你们一版。",
              },
            ],
            speakerTimelineSegments: [
              {
                startMs: 0,
                endMs: 2600,
                text: "我负责同步培训安排，明天上午先给你们一版。",
                speakerLabel: "speaker_2",
              },
            ],
            captureContext: "audio-window",
            analysisMode: "local-asr",
            analysisProvider: "local-asr:hybrid-whisper-funasr",
            analysisStatus: "succeeded",
            artifact: {
              artifactId: "audio-clip-1",
              fileName: "capture-1.wav",
              mime: "audio/wav",
              available: true,
              sizeBytes: 4096,
              url: "http://claw/api/clawsense/artifacts?id=audio-clip-1",
            },
          },
          {
            eventId: "event-named-team-task-1",
            modality: "audio",
            capturedAt: startedAt + 120000,
            summary: "讨论实时语料库同步方案。",
            transcript: "产品团队需要在7月30日前提供实时语料库同步方案。",
            transcriptSegments: [
              {
                startMs: 0,
                endMs: 2600,
                text: "产品团队需要在7月30日前提供实时语料库同步方案。",
              },
            ],
            speakerTimelineSegments: [
              {
                startMs: 0,
                endMs: 2600,
                text: "产品团队需要在7月30日前提供实时语料库同步方案。",
                speakerLabel: "speaker_1",
              },
            ],
            captureContext: "audio-window",
            analysisMode: "local-asr",
            analysisProvider: "local-asr:hybrid-whisper-funasr",
            analysisStatus: "succeeded",
          },
          {
            eventId: "event-discussion-1",
            modality: "audio",
            capturedAt: startedAt + 240000,
            summary: "泛讨论考核报表验证。",
            transcript: "后面还要确认考核点通过率与缺陷项汇总逻辑。",
            transcriptSegments: [
              {
                startMs: 0,
                endMs: 2200,
                text: "后面还要确认考核点通过率与缺陷项汇总逻辑。",
              },
            ],
            speakerTimelineSegments: [
              {
                startMs: 0,
                endMs: 2200,
                text: "后面还要确认考核点通过率与缺陷项汇总逻辑。",
                speakerLabel: "speaker_1",
              },
            ],
            captureContext: "audio-window",
            analysisMode: "local-asr",
            analysisProvider: "local-asr:hybrid-whisper-funasr",
            analysisStatus: "succeeded",
          },
          {
            eventId: "image-context-1",
            modality: "image",
            capturedAt: startedAt + 300000,
            summary: "会议桌上可见电脑屏幕，正在展示 AI 陪练系统页面。",
            captureContext: "active-window",
            analysisMode: "multimodal-preview",
            analysisProvider: "primary-multimodal:runtime-primary",
            analysisStatus: "succeeded",
          },
        ],
      },
    ],
    highlights: {
      keyWindowIds: [windowId],
      audioCoverage: {
        totalAudioWindows: 1,
        transcriptReadyWindows: 1,
        pendingAudioWindows: 0,
        degradedAudioEvents: 0,
      },
      recentImages: [],
      recentConversations: [
        {
          windowId,
          startedAt,
          endedAt,
          summary: "会议里确认培训安排和报表验收的后续动作。",
          transcriptExcerpt: "我负责同步培训安排，明天上午先给你们一版。产品团队需要在7月30日前提供实时语料库同步方案。",
        },
      ],
      people: [],
      speakers: [
        {
          speakerRef: `speaker:${windowId}:2`,
          displayName: "Amy",
          relationship: "同事",
          windowId,
          deviceId: "device-1",
        },
      ],
    },
  };
}

async function main() {
  let buildAssistantContextCall;
  const reviewEngine = {
    normalizeDateInput: (input) => input ?? "2026-06-25",
    buildAssistantContext: async (call) => {
      buildAssistantContextCall = call;
      return createPayload();
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
  assert(buildAssistantContextCall?.scope === "today", "question should infer a day-level 2026-06-25 scope", buildAssistantContextCall);
  assert(buildAssistantContextCall?.date === "2026-06-25", "question should infer 2026-06-25", buildAssistantContextCall);

  const details = resolved.details;
  const evidence = details.evidenceBundle;
  const firstEvent = details.windows[0]?.events[0];
  const taskCandidates = evidence.taskAttribution.candidates;
  const taskBuckets = evidence.taskAttribution.buckets;
  const topicTargets = details.responseHints.topicFollowUpTargets;
  const evidenceTargets = details.responseHints.evidenceFollowUpTargets;
  const audioDiagnostics = evidence.audioDiagnostics;
  const responseHintAudioDiagnostics = details.responseHints.audioDiagnostics;

  assert(firstEvent?.speakerTimelineSegments?.length === 1, "speakerTimelineSegments should be exposed in tool details", firstEvent);
  assert(evidence.topicSegments.length >= 1, "long-audio topic segments should be built", evidence.topicSegments);
  assert(topicTargets.length >= 1, "topic follow-up targets should be available", topicTargets);
  assert(evidenceTargets.some((target) => target.source === "topic"), "unified evidence follow-up targets should include topic targets", evidenceTargets);
  assert(audioDiagnostics?.verdict?.rawAudioArtifacts === "available", "evidence bundle should expose available raw audio artifacts", audioDiagnostics);
  assert(
    responseHintAudioDiagnostics?.verdict?.rawAudioArtifacts === "available",
    "response hints should expose available raw audio artifacts to the chat page",
    responseHintAudioDiagnostics,
  );
  assert(audioDiagnostics.counts?.audioEvents >= 3, "audio diagnostics should count transcript-backed audio events", audioDiagnostics);
  assert(
    audioDiagnostics.counts?.speakerTimelineReadyEvents >= 3,
    "audio diagnostics should count speaker timeline-ready audio events",
    audioDiagnostics,
  );
  assert(
    audioDiagnostics.blockerIds?.includes("audio-ready") ||
      audioDiagnostics.blockerIds?.includes("diarization-runnable"),
    "active raw audio should expose an audio-ready or diarization-runnable diagnostic note",
    audioDiagnostics,
  );
  assert(
    taskCandidates.some(
      (candidate) =>
        candidate.category === "speaker-dependent" &&
        candidate.speakerDisplayName === "Amy" &&
        candidate.userAssignmentStatus === "assigned-to-known-speaker",
    ),
    "speaker-dependent pronoun task should be attributed to known speaker Amy, not to the user",
    taskCandidates,
  );
  assert(
    taskCandidates.some(
      (candidate) =>
        candidate.category === "named-assignee" &&
        candidate.assigneeHint === "产品团队" &&
        candidate.userAssignmentStatus === "not-user-unless-role-matches",
    ),
    "named team task should not be assigned to user unless role matches",
    taskCandidates,
  );
  assert(
    !taskCandidates.some(
      (candidate) =>
        candidate.text === "我负责同步培训安排" &&
        candidate.userAssignmentStatus === "needs-speaker-label",
    ),
    "weaker duplicate pronoun task should be suppressed when speaker-timeline attribution is available",
    taskCandidates,
  );
  assert(
    taskBuckets.assignedToOthersOrTeams.some(
      (candidate) =>
        candidate.speakerDisplayName === "Amy" &&
        candidate.userAssignmentStatus === "assigned-to-known-speaker",
    ),
    "bucketed task attribution should separate known-speaker tasks from user's tasks",
    taskBuckets,
  );
  assert(
    taskBuckets.assignedToUser.length === 0,
    "bucketed task attribution should not put Amy's first-person task into assignedToUser",
    taskBuckets,
  );
  assert(
    details.responseHints.taskAttributionBuckets?.assignedToOthersOrTeams?.length >= 1,
    "response hints should expose task attribution buckets for chat-page followups",
    details.responseHints.taskAttributionBuckets,
  );
  assert(resolved.text.includes("会议 / 长音频话题段"), "tool text should include topic segment guidance");
  assert(resolved.text.includes("任务归属候选"), "tool text should include task attribution guidance");
  assert(resolved.text.includes("任务归属分桶"), "tool text should include task attribution buckets");
  assert(
    resolved.text.includes("Amy") && resolved.text.includes("speaker_2"),
    "tool text should surface labeled speaker",
  );
  assert(resolved.text.includes("音频诊断"), "tool text should expose audio diagnostic guidance");

  const summary = {
    ok: true,
    checkedAt: new Date().toISOString(),
    inferredScope: buildAssistantContextCall,
    topicSegmentCount: evidence.topicSegments.length,
    taskCandidateCount: taskCandidates.length,
    speakerTimelineSegmentCount: firstEvent.speakerTimelineSegments.length,
    rawAudioArtifacts: audioDiagnostics.verdict.rawAudioArtifacts,
    audioEvents: audioDiagnostics.counts.audioEvents,
    transcriptReadyEvents: audioDiagnostics.counts.transcriptReadyEvents,
    speakerTimelineReadyEvents: audioDiagnostics.counts.speakerTimelineReadyEvents,
    audioBlockerIds: audioDiagnostics.blockerIds,
    firstTopicFollowUp: topicTargets[0]?.prompt,
    taskCandidates: taskCandidates.map((candidate) => ({
      category: candidate.category,
      assigneeHint: candidate.assigneeHint,
      speakerDisplayName: candidate.speakerDisplayName,
      userAssignmentStatus: candidate.userAssignmentStatus,
      text: candidate.text,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
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
