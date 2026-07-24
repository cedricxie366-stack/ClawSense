import { Type, type Static } from "@sinclair/typebox";
import type { ClawSenseReviewEngine } from "./review-engine.js";
import { isUsableVisualSummaryText } from "./utils.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

const TOOL_SCOPE = ["today", "last-hour"] as const;
const TOOL_FOCUS = ["general", "what_happened", "watch_for"] as const;
const TOOL_MODALITY = ["audio", "image", "video"] as const;
const EVIDENCE_BUNDLE_SCHEMA_VERSION = "2026-07-08";
const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function enumString<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

export const ClawSenseContextToolSchema = Type.Object(
  {
    scope: Type.Optional(enumString(TOOL_SCOPE, "Time scope: today or last-hour. Leave empty when question/date/range should be inferred from natural language.")),
    date: Type.Optional(
      Type.String({
        description: "Optional date in YYYY-MM-DD format. Only applies when scope=today.",
      }),
    ),
    focus: Type.Optional(
      enumString(
        TOOL_FOCUS,
        "Answering mode: general overview, what_happened timeline, or watch_for follow-ups.",
      ),
    ),
    deviceId: Type.Optional(Type.String({ description: "Optional device id filter." })),
    modality: Type.Optional(
      enumString(TOOL_MODALITY, "Optional modality filter: audio, image, or video."),
    ),
    startAt: Type.Optional(
      Type.Number({
        description:
          "Optional custom range start timestamp in milliseconds. Use together with endAt to export a standard evidence bundle for any window.",
      }),
    ),
    endAt: Type.Optional(
      Type.Number({
        description:
          "Optional custom range end timestamp in milliseconds. Must be greater than startAt.",
      }),
    ),
    lookbackDays: Type.Optional(
      Type.Number({
        description:
          "Optional rolling lookback window in days (2-30). When provided without explicit startAt/endAt or scope/date, ClawSense will use a custom-range from now - lookbackDays to now.",
      }),
    ),
    question: Type.Optional(
      Type.String({
        description:
          "Optional original user question. Helps ClawSense infer dates/ranges such as 昨天, 6月25日, 过去4小时, and prioritize transcript/video/image evidence for the host model.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ClawSenseContextToolParams = Static<typeof ClawSenseContextToolSchema>;
export type ClawSenseContextFocus = (typeof TOOL_FOCUS)[number];
type AssistantContextPayload = Awaited<ReturnType<ClawSenseReviewEngine["buildAssistantContext"]>>;
type AudioRecheckResult = Awaited<ReturnType<ClawSenseReviewEngine["recheckAudioEvidence"]>>[number];
type IdentityHistoryEntry = Awaited<ReturnType<ClawSenseReviewEngine["buildIdentityHistory"]>>[number];
type ProjectHistoryEntry = Awaited<ReturnType<ClawSenseReviewEngine["buildProjectHistory"]>>[number];
type EvidenceMemoryCardMatch = AssistantContextPayload["memoryCards"][number] & {
  matchedTerms: string[];
  matchReasons: string[];
  retrievalRank: number;
  score: number;
};
type EvidenceBundleWindow = {
  windowId: string;
  timeRange: string;
  startedAt: number;
  endedAt: number;
  summary: string;
  transcriptExcerpt?: string;
  audioCount: number;
  imageCount: number;
  videoCount: number;
  projectRefs: string[];
  tags: string[];
  peopleHints: string[];
  captureContexts: string[];
  audioArtifacts: Array<{
    eventId: string;
    capturedAt: number;
    url: string;
  }>;
  degradedCount: number;
  score: number;
};
type EvidenceBundleVideoGroup = {
  videoRequestId: string;
  startedAt: number;
  endedAt: number;
  timeRange: string;
  windowIds: string[];
  videoEventIds: string[];
  keyframeEventIds: string[];
  videoArtifactUrls: string[];
  keyframeArtifactUrls: string[];
  videoDetails: Array<{
    eventId: string;
    windowId: string;
    capturedAt: number;
    time: string;
    summary: string;
    caption: string;
    ocrHints: string[];
    artifactId?: string;
    url?: string;
  }>;
  keyframeDetails: Array<{
    eventId: string;
    windowId: string;
    capturedAt: number;
    time: string;
    keyframeIndex?: number;
    videoOffsetMs?: number;
    videoOffsetLabel?: string;
    summary: string;
    caption: string;
    ocrHints: string[];
    linkedVideoEventId?: string;
    linkedVideoArtifactId?: string;
    linkedVideoUrl?: string;
    linkedVideoTime?: string;
    linkedDeltaMs?: number;
    linkMethod: "offset-marker" | "nearest-clip" | "fallback-first-clip" | "no-clip";
    artifactId?: string;
    url?: string;
  }>;
  transcriptSpans: Array<{
    eventId: string;
    windowId: string;
    capturedAt: number;
    time: string;
    text: string;
    artifactUrl?: string;
  }>;
  semanticSignals: {
    captions: string[];
    ocrHints: string[];
    linkedKeyframes: number;
    totalKeyframes: number;
  };
  summary: string;
};

type EvidenceAudioDiagnostics = {
  counts: {
    audioEvents: number;
    audioArtifactRecords: number;
    activeAudioArtifactRecords: number;
    deletedAudioArtifactRecords: number;
    missingAudioArtifactRecords: number;
    transcriptReadyEvents: number;
    transcriptSegmentReadyEvents: number;
    speakerTimelineReadyEvents: number;
    degradedAudioEvents: number;
    backfillNeededEvents: number;
    diarizationNeededEvents: number;
  };
  coverage: {
    transcriptCoverage: number;
    transcriptSegmentCoverage: number;
    speakerTimelineCoverage: number;
  };
  verdict: {
    transcriptLayer: "ready" | "missing" | "no-audio";
    diarizationLayer: "ready" | "missing" | "no-audio";
    needsBackfill: boolean;
    needsDiarization: boolean;
    rawAudioArtifacts: "available" | "deleted" | "missing-record" | "no-audio";
  };
  blockers: Array<{
    id: string;
    severity: "info" | "warning" | "blocked";
    message: string;
  }>;
  blockerIds: string[];
  nextActions: string[];
};

type EvidenceTopicSegment = {
  segmentId: string;
  windowId: string;
  startedAt: number;
  endedAt: number;
  timeRange: string;
  title: string;
  summary: string;
  transcriptExcerpt: string;
  keywordHints: string[];
  sourceEventIds: string[];
  taskSignals: Array<{
    text: string;
    attribution: "named-assignee" | "speaker-dependent" | "unassigned-action";
    assigneeHint?: string;
    speakerLabel?: string;
    speakerRef?: string;
    speakerDisplayName?: string;
    speakerRelationship?: string;
    reason: string;
  }>;
};

type EvidenceTaskCandidate = {
  signalId: string;
  category: "named-assignee" | "speaker-dependent" | "unassigned-action" | "discussion-only";
  timeRange: string;
  text: string;
  assigneeHint?: string;
  speakerLabel?: string;
  speakerRef?: string;
  speakerDisplayName?: string;
  speakerRelationship?: string;
  userAssignmentStatus:
    | "assigned-to-user"
    | "assigned-to-known-speaker"
    | "not-user-unless-role-matches"
    | "needs-speaker-label"
    | "unknown-owner"
    | "not-an-assignment";
  confidence: "medium" | "low";
  reason: string;
};

type EvidenceTaskAttribution = {
  status: "ready" | "needs-speaker-labels" | "no-task-signals";
  note: string;
  candidates: EvidenceTaskCandidate[];
  buckets: {
    assignedToUser: EvidenceTaskCandidate[];
    assignedToOthersOrTeams: EvidenceTaskCandidate[];
    needsSpeakerLabel: EvidenceTaskCandidate[];
    unassignedActions: EvidenceTaskCandidate[];
    discussionOnly: EvidenceTaskCandidate[];
  };
  speakerResolutionPrompts: Array<{
    speakerLabel: string;
    speakerRef?: string;
    windowId?: string;
    timeRange: string;
    resolutionMode: "exact-speaker-label" | "window-context-only";
    requiresDiarization: boolean;
    taskCount: number;
    sampleTasks: string[];
    reason: string;
    prompt: string;
    selfSentenceTemplate: string;
    sentenceTemplate: string;
    selfCommandTemplate?: string;
    commandTemplate?: string;
    candidateSpeakerSlots: Array<{
      speakerRef: string;
      slotLabel: string;
      windowId: string;
      timeRange: string;
      displayName?: string;
      relationship?: string;
      selfSentenceTemplate: string;
      sentenceTemplate: string;
      selfCommandTemplate: string;
      commandTemplate: string;
    }>;
  }>;
};

type EvidenceConversationDigest = {
  status: "available";
  coverage: {
    windowCount: number;
    transcriptWindowCount: number;
    topicSegmentCount: number;
    firstTimeRange?: string;
    lastTimeRange?: string;
  };
  overview: string;
  topicIndex: Array<{
    index: number;
    segmentId: string;
    windowId: string;
    timeRange: string;
    title: string;
    summary: string;
    keywordHints: string[];
    taskSignalCount: number;
  }>;
  queryMatches: Array<{
    index: number;
    segmentId: string;
    windowId: string;
    timeRange: string;
    title: string;
    summary: string;
    matchedTerms: string[];
    score: number;
  }>;
  taskMatches: Array<{
    signalId: string;
    timeRange: string;
    text: string;
    category: EvidenceTaskCandidate["category"];
    userAssignmentStatus: EvidenceTaskCandidate["userAssignmentStatus"];
    assigneeHint?: string;
    speakerLabel?: string;
    speakerRef?: string;
    speakerDisplayName?: string;
    speakerRelationship?: string;
    resolutionMode?: EvidenceTaskAttribution["speakerResolutionPrompts"][number]["resolutionMode"];
    requiresDiarization?: boolean;
    speakerResolutionPrompt?: string;
    selfSentenceTemplate?: string;
    selfCommandTemplate?: string;
    matchedTerms: string[];
    score: number;
    reason: string;
  }>;
  keywordIndex: Array<{
    keyword: string;
    topicIndexes: number[];
  }>;
  taskBucketCounts: Record<keyof EvidenceTaskAttribution["buckets"], number>;
  followupPrompts: string[];
};

type EvidenceRollingDigestMatch = {
  digestId: string;
  digestSummary: string;
  index: number;
  windowId: string;
  timeRange: string;
  title: string;
  summary: string;
  matchedTerms: string[];
  keywordHints: string[];
  taskHints: string[];
  score: number;
};

type EvidenceFragmentKind = "transcript" | "image-observation" | "audio-observation" | "video-observation" | "gap";
type EvidenceAnnotationSuggestions = {
  speakers: Array<{
    suggestionId: string;
    speakerRef: string;
    slotLabel: string;
    windowId: string;
    timeRange: string;
    relationshipHint?: string;
    confidence: "medium";
    sentenceTemplate: string;
    commandTemplate: string;
    selfSentenceTemplate: string;
    selfCommandTemplate: string;
  }>;
  people: Array<{
    suggestionId: string;
    personRef: string;
    displayName: string;
    timeRange?: string;
    sourceHint: string;
    relationshipHint?: string;
    confidence: "high" | "medium";
    autoApplyEligible: boolean;
    sentenceTemplate: string;
    commandTemplate: string;
  }>;
};

type EvidenceBundle = {
  schemaVersion: string;
  timeRange: {
    scope: AssistantContextPayload["scope"];
    date: string;
    startAt: number;
    endAt: number;
    label: string;
  };
  recentActivity: {
    lookbackDays: number;
    priorEventCount: number;
    priorWindowCount: number;
    priorActiveDays: number;
    lastSeenAt?: number;
    lastSeenDate?: string;
    sampleWindows: Array<{
      windowId: string;
      startedAt: number;
      endedAt: number;
      timeRange: string;
      summary: string;
      audioCount: number;
      imageCount: number;
      videoCount: number;
    }>;
  };
  question: string | null;
  keyWindowIds: string[];
  confirmedFindings: string[];
  scenarioProfile: {
    candidate: "work" | "study" | "social" | "general";
    confidence: "high" | "medium" | "low";
    reasons: string[];
  };
  practicalOutputs: {
    tasks: string[];
    people: string[];
    roleHints: string[];
    learningPoints: string[];
    environmentHints: string[];
    attentionItems: string[];
  };
  projects: Array<{
    ref: string;
    label: string;
    source: "project-ref" | "tag" | "review-section";
    evidenceCount: number;
    windowIds: string[];
  }>;
  audioCoverage: AssistantContextPayload["highlights"]["audioCoverage"];
  audioDiagnostics: EvidenceAudioDiagnostics;
  videoCoverage: {
    totalVideoGroups: number;
    groupsWithVideoArtifacts: number;
    groupsWithKeyframes: number;
    groupsWithSemanticSummary: number;
    groupsNeedingFollowUp: number;
    groupsWithOcrHints: number;
    linkedKeyframes: number;
    totalKeyframes: number;
  };
  speakerLayer: {
    status: "pending-diarization" | "no-audio" | "ready-for-labeling";
    suggestedSlots: Array<{
      speakerRef: string;
      slotLabel: string;
      windowId: string;
      timeRange: string;
      displayName?: string;
      relationship?: string;
    }>;
    note: string;
  };
  windows: EvidenceBundleWindow[];
  signalProfile: {
    transcriptWindowCount: number;
    darkImageHintCount: number;
    degradedEventCount: number;
  };
  fragments: Array<{
    fragmentId: string;
    kind: EvidenceFragmentKind;
    status: "confirmed" | "degraded" | "missing";
    windowId?: string;
    eventId?: string;
    artifactId?: string;
    videoRequestId?: string;
    keyframeIndex?: number;
    timeRange?: string;
    text: string;
    artifactUrl?: string;
  }>;
  topEvidence: Array<{
    fragmentId: string;
    kind: EvidenceFragmentKind;
    status: "confirmed" | "degraded" | "missing";
    text: string;
    windowId?: string;
    eventId?: string;
    artifactId?: string;
    videoRequestId?: string;
    keyframeIndex?: number;
    timeRange?: string;
    artifactUrl?: string;
  }>;
  topicSegments: EvidenceTopicSegment[];
  conversationDigest?: EvidenceConversationDigest;
  taskAttribution: EvidenceTaskAttribution;
  transcriptSpans: Array<{
    spanId: string;
    windowId: string;
    eventId: string;
    capturedAt: number;
    text: string;
    source: "event-transcript";
    artifactUrl?: string;
  }>;
  artifactRefs: Array<{
    artifactId: string;
    modality: "audio" | "image" | "video";
    windowId: string;
    eventId: string;
    videoRequestId?: string;
    keyframeIndex?: number;
    capturedAt: number;
    fileName: string;
    mime?: string;
    sizeBytes: number;
    url: string;
  }>;
  videoEvidenceGroups: EvidenceBundleVideoGroup[];
  annotationSuggestions: EvidenceAnnotationSuggestions;
  gaps: string[];
  watchItems: string[];
  recentImages: Array<{
    eventId: string;
    capturedAt: number;
    summary: string;
    artifact?: AssistantContextPayload["highlights"]["recentImages"][number]["artifact"];
  }>;
  people: AssistantContextPayload["highlights"]["people"];
  identityHistory: IdentityHistoryEntry[];
  projectHistory: ProjectHistoryEntry[];
  rollingDigests: AssistantContextPayload["rollingDigests"];
  rollingDigestMatches: EvidenceRollingDigestMatch[];
  memoryCards: AssistantContextPayload["memoryCards"];
  memoryCardMatches: EvidenceMemoryCardMatch[];
};

export type ClawSenseContextResolutionSuccess = {
  ok: true;
  payload: AssistantContextPayload;
  focus: ClawSenseContextFocus;
  question?: string;
  audioRechecks: AudioRecheckResult[];
  identityHistory: IdentityHistoryEntry[];
  projectHistory: ProjectHistoryEntry[];
  text: string;
  details: ReturnType<typeof buildClawSenseContextToolDetails>;
};

export type ClawSenseContextResolutionFailure = {
  ok: false;
  text: string;
  details: {
    ok: false;
    error: "invalid_time_range";
    startAt?: number;
    endAt?: number;
  };
};

export type ClawSenseContextResolution = ClawSenseContextResolutionSuccess | ClawSenseContextResolutionFailure;

export const ClawSenseAnnotatePersonToolSchema = Type.Object(
  {
    personRef: Type.String({
      description: "Stable person reference from ClawSense context, for example person_001.",
    }),
    displayName: Type.String({
      description: "Human-friendly name to use in later reviews, such as 小李 or 王老师.",
    }),
    relationship: Type.Optional(
      Type.String({
        description: "Optional relationship such as 同事, 朋友, 家人, 客户.",
      }),
    ),
    notes: Type.Optional(
      Type.String({
        description: "Optional grounding notes. Keep factual and concrete.",
      }),
    ),
    nextWatchFor: Type.Optional(
      Type.String({
        description: "Optional note about what to pay attention to next time you meet this person.",
      }),
    ),
    eventIds: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional list of related event IDs from the current ClawSense context.",
      }),
    ),
  },
  { additionalProperties: false },
);

type ClawSenseAnnotatePersonToolParams = Static<typeof ClawSenseAnnotatePersonToolSchema>;

export const ClawSenseAnnotateSpeakerToolSchema = Type.Object(
  {
    speakerRef: Type.String({
      description: "Stable speaker reference from ClawSense context, for example speaker:audio-session::123:1.",
    }),
    displayName: Type.String({
      description: "Human-friendly identity label, such as 李三, Amy, 班主任.",
    }),
    relationship: Type.Optional(
      Type.String({
        description: "Optional relationship such as 同事, 老板, 老师, 同学.",
      }),
    ),
    notes: Type.Optional(
      Type.String({
        description: "Optional factual note about why this speaker matters.",
      }),
    ),
    windowId: Type.Optional(Type.String({ description: "Optional source window id." })),
    deviceId: Type.Optional(Type.String({ description: "Optional source device id." })),
    eventIds: Type.Optional(
      Type.Array(Type.String(), {
        description: "Optional related audio event IDs.",
      }),
    ),
  },
  { additionalProperties: false },
);

type ClawSenseAnnotateSpeakerToolParams = Static<typeof ClawSenseAnnotateSpeakerToolSchema>;

export async function resolveClawSenseContext(
  params: {
    reviewEngine: ClawSenseReviewEngine;
    artifactUrlBase: () => string;
  },
  rawParams: ClawSenseContextToolParams,
): Promise<ClawSenseContextResolution> {
  const question = rawParams.question?.trim() || undefined;
  const hasRangeStart = typeof rawParams.startAt === "number" && Number.isFinite(rawParams.startAt);
  const hasRangeEnd = typeof rawParams.endAt === "number" && Number.isFinite(rawParams.endAt);
  if ((hasRangeStart || hasRangeEnd) && !(hasRangeStart && hasRangeEnd && rawParams.endAt! > rawParams.startAt!)) {
    return {
      ok: false,
      text: "时间窗参数无效：请同时提供 startAt 和 endAt（毫秒时间戳），且 endAt 必须大于 startAt。",
      details: {
        ok: false,
        error: "invalid_time_range",
        startAt: rawParams.startAt,
        endAt: rawParams.endAt,
      },
    };
  }

  const customRange = hasRangeStart && hasRangeEnd
    ? { startAt: Number(rawParams.startAt), endAt: Number(rawParams.endAt) }
    : undefined;
  const normalizedLookbackDays =
    typeof rawParams.lookbackDays === "number" && Number.isFinite(rawParams.lookbackDays)
      ? Math.max(1, Math.min(30, Math.floor(rawParams.lookbackDays)))
      : undefined;
  const lookbackRange =
    !customRange &&
    !rawParams.scope &&
    !rawParams.date &&
    normalizedLookbackDays &&
    normalizedLookbackDays > 1
      ? {
          startAt: Date.now() - normalizedLookbackDays * 24 * 60 * 60 * 1000,
          endAt: Date.now(),
        }
      : undefined;
  const inferredDateFromQuestion = !rawParams.date ? inferDateFromQuestion(question) : undefined;
  const inferredRange =
    !rawParams.scope && !customRange && !lookbackRange ? inferCustomRangeFromQuestion(question) : undefined;
  const recentMeetingLookbackRange =
    !customRange &&
    !lookbackRange &&
    !inferredRange &&
    !rawParams.scope &&
    !rawParams.date &&
    !inferredDateFromQuestion &&
    shouldDefaultToRecentMeetingLookback(question)
      ? {
          startAt: startOfDay(addDays(new Date(), -6)).getTime(),
          endAt: Date.now(),
        }
      : undefined;
  const effectiveRange = customRange ?? lookbackRange ?? inferredRange ?? recentMeetingLookbackRange;
  const inferredScope = rawParams.scope
    ? undefined
    : inferScopeFromQuestion(question);
  const scope =
    effectiveRange
      ? "custom-range"
      : rawParams.scope === "last-hour" || inferredScope === "last-hour"
        ? "last-hour"
        : "today";
  const focus = rawParams.focus ?? inferFocusFromQuestion(question) ?? "general";
  const inferredDate =
    scope === "today" && !rawParams.date ? inferredDateFromQuestion : undefined;
  const date =
    scope === "today"
      ? params.reviewEngine.normalizeDateInput(rawParams.date ?? inferredDate)
      : undefined;

  let payload = await params.reviewEngine.buildAssistantContext({
    scope,
    date,
    startAt: effectiveRange?.startAt,
    endAt: effectiveRange?.endAt,
    question,
    deviceId: rawParams.deviceId || undefined,
    modality: rawParams.modality || undefined,
    artifactUrlBase: params.artifactUrlBase(),
  });
  const audioRechecks =
    shouldAttemptQueryTimeAudioReview(payload, focus, question) &&
    typeof (params.reviewEngine as { recheckAudioEvidence?: unknown }).recheckAudioEvidence === "function"
      ? await params.reviewEngine.recheckAudioEvidence({
          scope,
          date,
          startAt: effectiveRange?.startAt,
          endAt: effectiveRange?.endAt,
          deviceId: rawParams.deviceId || undefined,
          artifactUrlBase: params.artifactUrlBase(),
          question,
          maxWindows: resolveQueryTimeAudioReviewMaxWindows(payload, focus, question),
        })
      : [];

  if (audioRechecks.some((item) => Boolean(item.transcript?.trim() || item.summary?.trim()))) {
    payload = await params.reviewEngine.buildAssistantContext({
      scope,
      date,
      startAt: effectiveRange?.startAt,
      endAt: effectiveRange?.endAt,
      question,
      deviceId: rawParams.deviceId || undefined,
      modality: rawParams.modality || undefined,
      artifactUrlBase: params.artifactUrlBase(),
    });
  }

  const identityHistory =
    shouldAttemptIdentityHistory(question) &&
    typeof (params.reviewEngine as { buildIdentityHistory?: unknown }).buildIdentityHistory === "function"
      ? await params.reviewEngine.buildIdentityHistory({
          question,
          artifactUrlBase: params.artifactUrlBase(),
          currentPersonRefs: uniqueItems(
            payload.windows.flatMap((window) => window.peopleRefs).concat(
              payload.highlights.people.map((person) => person.personRef),
            ),
          ),
          currentSpeakerRefs: payload.highlights.speakers.map((speaker) => speaker.speakerRef),
        })
      : [];
  const projectHistory =
    shouldAttemptProjectHistory(question) &&
    typeof (params.reviewEngine as { buildProjectHistory?: unknown }).buildProjectHistory === "function"
      ? await params.reviewEngine.buildProjectHistory({
          question,
          artifactUrlBase: params.artifactUrlBase(),
          currentProjectRefs: uniqueItems(payload.windows.flatMap((window) => window.projectRefs)),
          currentTags: uniqueItems(payload.windows.flatMap((window) => window.tags)),
        })
      : [];

  const text = buildClawSenseContextToolText(
    payload,
    focus,
    question,
    audioRechecks,
    identityHistory,
    projectHistory,
  );
  const details = buildClawSenseContextToolDetails(
    payload,
    focus,
    question,
    audioRechecks,
    identityHistory,
    projectHistory,
  );
  return {
    ok: true,
    payload,
    focus,
    question,
    audioRechecks,
    identityHistory,
    projectHistory,
    text,
    details,
  };
}

export function createClawSenseContextTool(params: {
  reviewEngine: ClawSenseReviewEngine;
  artifactUrlBase: () => string;
}) {
  return {
    name: "clawsense_context",
    label: "ClawSense Context",
    description:
      "Retrieve ClawSense's controlled summary of today or the last hour. Use for questions like '今天发生了什么', '过去一个小时有什么需要注意的', or '最近有哪些值得回看的对话或图片'.",
    parameters: ClawSenseContextToolSchema,
    async execute(_toolCallId: string, rawParams: ClawSenseContextToolParams): Promise<ToolResult> {
      const resolved = await resolveClawSenseContext(params, rawParams);
      return {
        content: [{
          type: "text",
          text: resolved.text,
        }],
        details: resolved.details,
      };
    },
  };
}

export function createClawSenseAnnotatePersonTool(params: {
  reviewEngine: ClawSenseReviewEngine;
}) {
  return {
    name: "clawsense_annotate_person",
    label: "ClawSense Annotate Person",
    description:
      "Save a person's display name and practical notes back into ClawSense so future reviews can mention them more naturally. Use only when the user has identified who the person is.",
    parameters: ClawSenseAnnotatePersonToolSchema,
    async execute(
      _toolCallId: string,
      rawParams: ClawSenseAnnotatePersonToolParams,
    ): Promise<ToolResult> {
      const personRef = rawParams.personRef.trim();
      const displayName = rawParams.displayName.trim();
      if (!personRef || !displayName) {
        return {
          content: [{ type: "text", text: "人物标注失败：personRef 和 displayName 都不能为空。" }],
          details: { ok: false, error: "personRef and displayName required" },
        };
      }

      const annotation = await params.reviewEngine.annotatePerson({
        personRef,
        displayName,
        relationship: rawParams.relationship?.trim() || undefined,
        notes: rawParams.notes?.trim() || undefined,
        nextWatchFor: rawParams.nextWatchFor?.trim() || undefined,
        eventIds: rawParams.eventIds?.map((eventId) => eventId.trim()).filter(Boolean),
      });

      return {
        content: [{ type: "text", text: buildPersonAnnotationText(annotation) }],
        details: { ok: true, annotation },
      };
    },
  };
}

export function createClawSenseAnnotateSpeakerTool(params: {
  reviewEngine: ClawSenseReviewEngine;
}) {
  return {
    name: "clawsense_annotate_speaker",
    label: "ClawSense Annotate Speaker",
    description:
      "Save a speaker placeholder label back into ClawSense so future audio windows can mention speaker_1 / speaker_2 with a human-friendly identity.",
    parameters: ClawSenseAnnotateSpeakerToolSchema,
    async execute(
      _toolCallId: string,
      rawParams: ClawSenseAnnotateSpeakerToolParams,
    ): Promise<ToolResult> {
      const speakerRef = rawParams.speakerRef.trim();
      const displayName = rawParams.displayName.trim();
      if (!speakerRef || !displayName) {
        return {
          content: [{ type: "text", text: "说话人标注失败：speakerRef 和 displayName 都不能为空。" }],
          details: { ok: false, error: "speakerRef and displayName required" },
        };
      }

      const annotation = await params.reviewEngine.annotateSpeaker({
        speakerRef,
        displayName,
        relationship: rawParams.relationship?.trim() || undefined,
        notes: rawParams.notes?.trim() || undefined,
        windowId: rawParams.windowId?.trim() || undefined,
        deviceId: rawParams.deviceId?.trim() || undefined,
        eventIds: rawParams.eventIds?.map((eventId) => eventId.trim()).filter(Boolean),
      });

      return {
        content: [{ type: "text", text: buildSpeakerAnnotationText(annotation) }],
        details: { ok: true, annotation },
      };
    },
  };
}

export function buildClawSenseContextToolText(
  payload: AssistantContextPayload,
  focus: "general" | "what_happened" | "watch_for",
  question?: string,
  audioRechecks: AudioRecheckResult[] = [],
  identityHistory: IdentityHistoryEntry[] = [],
  projectHistory: ProjectHistoryEntry[] = [],
): string {
  const periodLabel =
    payload.scope === "last-hour"
      ? "过去一小时"
      : payload.scope === "custom-range"
        ? `${formatDateTime(payload.startAt)}-${formatDateTime(payload.endAt)} 这个时间窗`
        : `${payload.date} 这一天`;
  const evidence = buildEvidenceBundle(payload, focus, question, identityHistory, projectHistory);
  const confirmedFindings = buildConfirmedFindings(payload, evidence, focus);
  const questionIntent = inferQuestionIntent(question);
  const lines = [`ClawSense ${periodLabel}证据包`];
  if (questionIntent.conversation && evidence.transcriptSpans.length > 0) {
    lines.push(
      `对话优先说明：当前问题属于对话/会议/过去几小时追问；回答时以 ${evidence.transcriptSpans.length} 条音频转写证据为主，黑屏、静态图片或视觉窗口摘要只能作为环境背景，不能覆盖对话内容。`,
    );
  }
  lines.push(`${questionIntent.conversation && evidence.transcriptSpans.length > 0 ? "原始聚合总览（对话问题仅作背景）" : "总览"}：${payload.summary}`);
  lines.push(
    `素材覆盖：${payload.counts.events} 条事件 / ${payload.counts.windows} 个时间窗 / ${payload.counts.artifacts} 个媒体文件 / ${payload.counts.devices} 台设备。`,
  );
  if (evidence.audioCoverage.totalAudioWindows > 0) {
    lines.push(
      `音频覆盖：${evidence.audioCoverage.transcriptReadyWindows}/${evidence.audioCoverage.totalAudioWindows} 个音频窗口已有可引用转写，仍有 ${evidence.audioCoverage.pendingAudioWindows} 个待补强窗口。`,
    );
  }
  if (evidence.audioDiagnostics.counts.audioEvents > 0) {
    lines.push(
      `音频诊断：${evidence.audioDiagnostics.counts.transcriptReadyEvents}/${evidence.audioDiagnostics.counts.audioEvents} 条音频已有转写，${evidence.audioDiagnostics.counts.speakerTimelineReadyEvents} 条已有 speaker timeline；raw 音频状态：${formatRawAudioArtifactStatus(evidence.audioDiagnostics.verdict.rawAudioArtifacts)}。`,
    );
    if (evidence.audioDiagnostics.blockers.some((blocker) => blocker.severity === "blocked")) {
      lines.push(
        `音频补强边界：${evidence.audioDiagnostics.blockers
          .filter((blocker) => blocker.severity === "blocked")
          .map((blocker) => blocker.message)
          .join("；")}。`,
      );
    }
  }
  if (
    payload.counts.events === 0 &&
    typeof payload.recentActivity?.lastSeenAt === "number" &&
    payload.recentActivity.priorEventCount > 0
  ) {
    lines.push(
      `最近一次有效记录：${formatDateTime(payload.recentActivity.lastSeenAt)}（过去 ${payload.recentActivity.lookbackDays} 天累计 ${payload.recentActivity.priorWindowCount} 个窗口 / ${payload.recentActivity.priorEventCount} 条事件）`,
    );
    if (payload.recentActivity.sampleWindows.length > 0) {
      lines.push("最近历史窗口（便于继续追问）：");
      for (const window of payload.recentActivity.sampleWindows.slice(0, 2)) {
        lines.push(
          `- ${window.timeRange} | 音频 ${window.audioCount} / 图片 ${window.imageCount} / 视频 ${window.videoCount ?? 0} | ${window.summary}`,
        );
      }
    }
  }
  if (question) {
    lines.push(`用户问题：${question}`);
  }
  lines.push("回答要求：请优先引用下面的日级回顾、关键时间窗、转写摘录和图片线索回答，不要把降级摘要当成已确认事实。");
  lines.push("整天/昨天类问题规则：先用日级 review 和素材覆盖回答全局发生了什么，再用关键时间窗举证；不要只根据最近图片或少数窗口下结论。");
  lines.push("对话/会议/过去几小时类问题规则：优先使用“音频转写证据”和带 transcriptExcerpt 的时间窗；图片/视频帧只用于补充环境和屏幕内容，不能替代对话内容。");
  lines.push("视频/访谈类问题规则：先结合视频关键帧、OCR/字幕线索和同窗音频转写；如果只有画面没有转写，要明确说音频细节不足。");
  lines.push("额外约束：如果画面全黑或疑似被遮挡，只能说“黑暗环境 / 镜头可能被遮挡，待确认”，不要推断设备关闭、故障或休眠。");
  lines.push("如果下面提供了原始音频 URL，且当前主模型支持音频理解，请优先结合原始音频复核，再回答具体对话或学习/会议内容。");
  lines.push("人物处理规则：把“已确认人物”“待确认视觉人物”“待确认角色线索”“speaker 占位”分开；不要把待确认角色写成已确认身份，也不要写“可能是你/同事/演讲参与者”这类猜测。");
  lines.push("任务归属规则：只有在 speaker 已标注为用户本人，或转写明确点名用户/用户角色时，才能说“这是分配给你的任务”；否则应分成“明确指向他人/团队”“需要 speaker 标注后判断”“无明确 owner 的行动项”“只是讨论主题”。");
  lines.push("建议回答骨架：先给一句结论，再列 2 到 4 条已确认的证据，最后单列仍待确认的缺口。");
  lines.push(`场景化回答桶：${buildScenarioBucketsHint(evidence.scenarioProfile.candidate).join(" / ")}`);
  if (focus === "what_happened") {
    lines.push(
      "回答风格：先用 2 到 4 句概括今天真正记录到的变化或活动；如果只有静态场景，就直接说明“目前只记录到静态画面，没有明确对话或行动证据”。然后再引用证据。",
    );
  } else if (focus === "watch_for") {
    lines.push("回答风格：先给 1 到 3 条最值得注意的点，再说明支撑证据和仍需确认的缺口。");
  } else {
    lines.push("回答风格：先给简洁结论，再分别说明关键证据和信息缺口。");
  }
  const todayAtGlance = readSectionItems(payload, "Today at a glance");
  const timeline = readSectionItems(payload, "时间线回顾");
  const followUps = readSectionItems(payload, "今天遗漏但值得追问的点");
  const nextSteps = readSectionItems(payload, "明天建议关注的事情");

  if (confirmedFindings.length > 0) {
    lines.push("", "已确认的证据：");
    for (const item of confirmedFindings) {
      lines.push(`- ${item}`);
    }
  }

  if (focus !== "watch_for") {
    const happenedItems = todayAtGlance.concat(timeline).slice(0, focus === "what_happened" ? 6 : 4);
    if (happenedItems.length > 0) {
      lines.push("", "日级回顾（回答整天/昨天问题时优先使用）：");
      for (const item of happenedItems) {
        lines.push(`- ${item}`);
      }
    } else {
      const fallbackItems = payload.highlights.recentConversations
        .slice(0, 3)
        .map((conversation) => conversation.summary)
        .filter(Boolean);
      if (fallbackItems.length > 0) {
        lines.push("", "最近的对话线索：");
        for (const item of fallbackItems) {
          lines.push(`- ${item}`);
        }
      }
    }
  }

  if (evidence.windows.length > 0) {
    lines.push("", "关键时间窗：");
    for (const window of evidence.windows) {
      lines.push(
        `- ${window.timeRange} | 音频 ${window.audioCount} 段 / 图片 ${window.imageCount} 张 / 视频 ${window.videoCount} 段 | ${window.summary}`,
      );
      if (window.transcriptExcerpt) {
        lines.push(`  转写摘录：${window.transcriptExcerpt}`);
      }
      if (window.audioArtifacts.length > 0) {
        lines.push(`  原始音频：${window.audioArtifacts.slice(0, 2).map((artifact) => artifact.url).join(" ，")}`);
      }
      if (window.tags.length > 0) {
        lines.push(`  主题线索：${window.tags.join("、")}`);
      }
      if (window.peopleHints.length > 0) {
        lines.push(`  人物线索：${window.peopleHints.join("、")}`);
      }
    }
  }

  if (evidence.transcriptSpans.length > 0) {
    lines.push("", "音频转写证据（对话/会议/过去几小时类问题优先引用）：");
    for (const span of evidence.transcriptSpans.slice(0, 10)) {
      const suffix = span.artifactUrl ? ` (${span.artifactUrl})` : "";
      lines.push(`- ${formatTime(span.capturedAt)} [${span.windowId}] ${span.text}${suffix}`);
    }
  }

  if (evidence.rollingDigests.length > 0) {
    lines.push("", "持久化长对话索引（跨小时/整天追问时先用这里做全局目录，再回到具体转写举证）：");
    if (evidence.rollingDigestMatches.length > 0) {
      lines.push("  与当前问题最相关的持久索引段：");
      for (const match of evidence.rollingDigestMatches.slice(0, 5)) {
        const matched = match.matchedTerms.length > 0 ? `；匹配：${match.matchedTerms.join("、")}` : "";
        const tasks = match.taskHints.length > 0 ? `；任务线索：${match.taskHints.slice(0, 2).join("；")}` : "";
        lines.push(`  - 第 ${match.index} 段 ${match.timeRange} [${match.windowId}] ${match.title}${matched}${tasks}`);
      }
    }
    for (const digest of evidence.rollingDigests.slice(0, 2)) {
      lines.push(`- ${digest.summary}`);
      for (const topic of digest.topicIndex.slice(0, 6)) {
        const keywords = topic.keywordHints.length > 0 ? `；关键词：${topic.keywordHints.join("、")}` : "";
        const tasks = topic.taskHints.length > 0 ? `；任务线索：${topic.taskHints.slice(0, 2).join("；")}` : "";
        lines.push(`  - 第 ${topic.index} 段 ${topic.timeRange} [${topic.windowId}] ${topic.title}：${topic.summary}${keywords}${tasks}`);
      }
      if (digest.keywordIndex.length > 0) {
        lines.push(
          `  持久关键词索引：${digest.keywordIndex
            .slice(0, 6)
            .map((item) => `${item.keyword}->第${item.topicIndexes.join("/")}段`)
            .join("；")}`,
        );
      }
    }
  }

  if (evidence.memoryCards.length > 0) {
    lines.push("", "长期记忆卡片（用于沉淀任务、人物/话题、学习点和后续追问；回答时仍需回链具体证据）：");
    if (evidence.memoryCardMatches.length > 0) {
      lines.push("  与当前问题最相关的记忆卡片：");
      for (const card of evidence.memoryCardMatches.slice(0, 6)) {
        const matched = card.matchedTerms.length > 0 ? `；匹配：${card.matchedTerms.join("、")}` : "";
        const reasons = card.matchReasons.length > 0 ? `；排序理由：${card.matchReasons.join("、")}` : "";
        const keywords = card.keywords.length > 0 ? `；关键词：${card.keywords.slice(0, 4).join("、")}` : "";
        lines.push(
          `  - #${card.retrievalRank} score=${card.score} ${formatMemoryCardKind(card.kind)} | ${card.title}${matched}${reasons}${keywords}：${card.summary}`,
        );
      }
    }
    for (const card of evidence.memoryCards.slice(0, 8)) {
      const evidenceLabel = card.evidence.timeRanges.length > 0 ? `（${card.evidence.timeRanges.join("、")}）` : "";
      lines.push(`- ${formatMemoryCardKind(card.kind)} ${card.title}${evidenceLabel}：${card.summary}`);
    }
  }

  if (evidence.conversationDigest) {
    lines.push("", "长对话索引（回答“过去几小时聊了什么 / 会议纪要 / 按段追问”时先用这里组织全局结构）：");
    lines.push(`- ${evidence.conversationDigest.overview}`);
    for (const topic of evidence.conversationDigest.topicIndex.slice(0, 8)) {
      const keywords = topic.keywordHints.length > 0 ? `；关键词：${topic.keywordHints.join("、")}` : "";
      const tasks = topic.taskSignalCount > 0 ? `；任务信号 ${topic.taskSignalCount} 条` : "";
      lines.push(`- 第 ${topic.index} 段 ${topic.timeRange} [${topic.segmentId}] ${topic.title}：${topic.summary}${keywords}${tasks}`);
    }
    if (evidence.conversationDigest.queryMatches.length > 0) {
      lines.push("  与当前问题最相关的话题段：");
      for (const match of evidence.conversationDigest.queryMatches.slice(0, 4)) {
        const matched = match.matchedTerms.length > 0 ? `；匹配：${match.matchedTerms.join("、")}` : "";
        lines.push(`  - 第 ${match.index} 段 ${match.timeRange} [${match.segmentId}] ${match.title}${matched}`);
      }
    }
    if (evidence.conversationDigest.taskMatches.length > 0) {
      lines.push("  与当前问题相关的任务候选（回答“我的任务/别人只是提到”时先看这里）：");
      for (const match of evidence.conversationDigest.taskMatches.slice(0, 5)) {
        const speaker = formatTaskCandidateSpeaker(match);
        const matched = match.matchedTerms.length > 0 ? `；匹配：${match.matchedTerms.join("、")}` : "";
        lines.push(
          `  - ${match.timeRange} ${match.text}${speaker}；判断：${formatUserAssignmentStatus(match.userAssignmentStatus)}${matched}`,
        );
      }
    }
    if (evidence.conversationDigest.keywordIndex.length > 0) {
      lines.push(
        `  关键词索引：${evidence.conversationDigest.keywordIndex
          .slice(0, 6)
          .map((item) => `${item.keyword}->第${item.topicIndexes.join("/")}段`)
          .join("；")}`,
      );
    }
    if (evidence.conversationDigest.followupPrompts.length > 0) {
      lines.push(`  可继续追问：${evidence.conversationDigest.followupPrompts.slice(0, 3).join(" / ")}`);
    }
  }

  if (evidence.topicSegments.length > 0) {
    lines.push("", "会议 / 长音频话题段（用于“第二段/那段/按话题分段”追问）：");
    for (const segment of evidence.topicSegments.slice(0, 8)) {
      lines.push(`- ${segment.timeRange} [${segment.segmentId}] ${segment.title}：${segment.summary}`);
      if (segment.keywordHints.length > 0) {
        lines.push(`  关键词：${segment.keywordHints.join("、")}`);
      }
      if (segment.taskSignals.length > 0) {
        lines.push(`  任务信号：${segment.taskSignals.slice(0, 2).map((signal) => signal.text).join("；")}`);
      }
    }
  }

  if (evidence.taskAttribution.candidates.length > 0) {
    lines.push("", "任务归属候选（未标注 speaker 前禁止直接认定为“你的任务”）：");
    lines.push(`- 归属状态：${evidence.taskAttribution.note}`);
    for (const candidate of evidence.taskAttribution.candidates.slice(0, 8)) {
      const assignee = candidate.assigneeHint ? ` | 指向：${candidate.assigneeHint}` : "";
      const speaker = formatTaskCandidateSpeaker(candidate);
      const category = formatTaskAttributionCategory(candidate.category);
      lines.push(`- ${candidate.timeRange} [${category}] ${candidate.text}${assignee}${speaker}；判断：${formatUserAssignmentStatus(candidate.userAssignmentStatus)}`);
    }
    const bucketLines = buildTaskAttributionBucketLines(evidence.taskAttribution.buckets);
    if (bucketLines.length > 0) {
      lines.push("", "任务归属分桶（回答“哪些分配给我 / 哪些没落到我身上”时优先使用）：");
      lines.push(...bucketLines);
    }
    if (evidence.taskAttribution.speakerResolutionPrompts.length > 0) {
      lines.push("", "speaker 归属追问（回答无法判断“是不是分配给我”时优先问这些）：");
      for (const item of evidence.taskAttribution.speakerResolutionPrompts.slice(0, 3)) {
        lines.push(`- ${item.prompt} 样例任务：${item.sampleTasks.slice(0, 2).join("；")}`);
      }
    }
  }

  if (evidence.videoEvidenceGroups.length > 0) {
    lines.push("", "视频证据组（同次上传聚合）：");
    for (const group of evidence.videoEvidenceGroups.slice(0, 3)) {
      lines.push(
        `- ${group.timeRange} | 视频 ${group.videoEventIds.length} 段 / 关键帧 ${group.keyframeEventIds.length} 张 | ${group.summary}`,
      );
      if (group.videoArtifactUrls.length > 0) {
        lines.push(`  原始视频：${group.videoArtifactUrls.slice(0, 2).join(" ，")}`);
      }
      if (group.keyframeArtifactUrls.length > 0) {
        lines.push(`  关键帧：${group.keyframeArtifactUrls.slice(0, 3).join(" ，")}`);
      }
      if (group.keyframeDetails.length > 0) {
        for (const frame of group.keyframeDetails.slice(0, 2)) {
          const indexPrefix = frame.keyframeIndex ? `#${frame.keyframeIndex} ` : "";
          const suffix = frame.url ? ` (${frame.url})` : "";
          const offsetSuffix = frame.videoOffsetLabel ? `（片段内 ${frame.videoOffsetLabel}）` : "";
          lines.push(
            `  关键帧细节 ${indexPrefix}${frame.time}${offsetSuffix}：${truncateText(toSingleLine(frame.summary), 140)}${suffix}`,
          );
          if (frame.ocrHints.length > 0) {
            lines.push(`  OCR / 板书线索：${frame.ocrHints.join("、")}`);
          }
          if (frame.linkedVideoTime) {
            const offsetLabel = frame.videoOffsetLabel ? ` / 片段内 ${frame.videoOffsetLabel}` : "";
            lines.push(`  关联视频片段：${frame.linkedVideoTime}${offsetLabel}${frame.linkedDeltaMs ? `（相差 ${Math.round(frame.linkedDeltaMs / 1000)} 秒）` : ""}`);
          }
        }
      }
      if (group.semanticSignals.ocrHints.length > 0) {
        lines.push(`  本组 OCR 汇总：${group.semanticSignals.ocrHints.slice(0, 3).join("、")}`);
      }
    }
  }

  if (evidence.fragments.length > 0) {
    lines.push("", "可直接引用的证据片段：");
    for (const fragment of evidence.fragments.slice(0, 5)) {
      const label =
        fragment.kind === "transcript"
          ? "转写"
          : fragment.kind === "image-observation"
            ? "图片"
            : fragment.kind === "audio-observation"
              ? "音频"
              : fragment.kind === "video-observation"
                ? "视频"
              : "缺口";
      const suffix = fragment.artifactUrl ? ` (${fragment.artifactUrl})` : "";
      lines.push(`- [${label}/${fragment.status}] ${fragment.text}${suffix}`);
    }
  }

  if (audioRechecks.length > 0) {
    lines.push("", "查询时音频复核：");
    for (const item of audioRechecks.slice(0, 3)) {
      const result =
        item.transcript?.trim() || item.summary?.trim()
          ? `${item.transcript?.trim() ? `转写：${item.transcript.trim()}` : `复核结论：${item.summary?.trim()}`}`
          : `仍未得到可靠音频理解（${item.analysisFailureReason ?? "unknown"}）`;
      lines.push(`- ${item.timeRange} | ${result} (${item.artifact.url})`);
    }
  }

  if (identityHistory.length > 0) {
    lines.push("", "相关人物 / 发言者的历史记忆：");
    for (const entry of identityHistory.slice(0, 2)) {
      const label = `${entry.displayName}${entry.relationship ? `（${entry.relationship}）` : ""}`;
      lines.push(
        `- ${label}：历史上出现过 ${entry.occurrenceCount} 个时间窗，涉及 ${entry.relatedDates.length} 天；最近一次 ${formatDateTime(entry.lastSeenAt)}。`,
      );
      if (entry.notes) {
        lines.push(`  既有备注：${entry.notes}`);
      }
      if (entry.nextWatchFor) {
        lines.push(`  下次留意：${entry.nextWatchFor}`);
      }
      for (const moment of entry.recentMoments.slice(0, 3)) {
        const transcript = moment.transcriptExcerpt ? `；转写摘录：${moment.transcriptExcerpt}` : "";
        lines.push(`  - ${moment.date} ${moment.timeRange} | ${moment.summary}${transcript}`);
      }
      const memoryCards = entry.memoryCards ?? [];
      if (memoryCards.length > 0) {
        lines.push("  关联记忆卡片：");
        for (const card of memoryCards.slice(0, 3)) {
          const ranges = card.timeRanges.length > 0 ? `（${card.timeRanges.join("、")}）` : "";
          const tasks = card.taskHints.length > 0 ? `；任务线索：${card.taskHints.slice(0, 2).join("；")}` : "";
          lines.push(`  - ${formatMemoryCardKind(card.kind)} ${card.title}${ranges}：${card.summary}${tasks}`);
        }
      }
      lines.push(`  可继续追问：${buildIdentityHistoryFollowUpPrompt(entry)}`);
    }
  }

  if (projectHistory.length > 0) {
    lines.push("", "相关项目 / 主题的历史记忆：");
    for (const entry of projectHistory.slice(0, 2)) {
      lines.push(
        `- ${entry.label}：历史上出现过 ${entry.occurrenceCount} 个时间窗，涉及 ${entry.relatedDates.length} 天；最近一次 ${formatDateTime(entry.lastSeenAt)}。`,
      );
      for (const moment of entry.recentMoments.slice(0, 3)) {
        const transcript = moment.transcriptExcerpt ? `；转写摘录：${moment.transcriptExcerpt}` : "";
        lines.push(`  - ${moment.date} ${moment.timeRange} | ${moment.summary}${transcript}`);
      }
      const memoryCards = entry.memoryCards ?? [];
      if (memoryCards.length > 0) {
        lines.push("  关联记忆卡片：");
        for (const card of memoryCards.slice(0, 3)) {
          const ranges = card.timeRanges.length > 0 ? `（${card.timeRanges.join("、")}）` : "";
          const tasks = card.taskHints.length > 0 ? `；任务线索：${card.taskHints.slice(0, 2).join("；")}` : "";
          lines.push(`  - ${formatMemoryCardKind(card.kind)} ${card.title}${ranges}：${card.summary}${tasks}`);
        }
      }
    }
  }

  if (payload.consolidation) {
    lines.push("", "日级 consolidation：");
    lines.push(`- 结构化摘要：${payload.consolidation.summary}`);
    if (payload.consolidation.tasks.length > 0) {
      lines.push(`- 今日任务候选：${payload.consolidation.tasks.slice(0, 3).join("；")}`);
    }
    if (payload.consolidation.learningPoints.length > 0) {
      lines.push(`- 学习要点候选：${payload.consolidation.learningPoints.slice(0, 3).join("；")}`);
    }
    if (payload.consolidation.attentionItems.length > 0) {
      lines.push(`- 待追问缺口：${payload.consolidation.attentionItems.slice(0, 3).join("；")}`);
    }
  }

  lines.push("", "更有用的整理角度：");
  lines.push(
    `- 场景判断：${formatScenarioLabel(evidence.scenarioProfile.candidate)}（${formatScenarioConfidence(evidence.scenarioProfile.confidence)}）`,
  );
  lines.push(`- 回答优先级：${buildScenarioPriorityHint(evidence.scenarioProfile.candidate)}`);
  const scenarioTemplate = buildScenarioAnswerTemplate(evidence);
  if (scenarioTemplate.length > 0) {
    lines.push(`- 推荐回答模板：${scenarioTemplate[0]}`);
    for (const templateLine of scenarioTemplate.slice(1, 4)) {
      lines.push(`  ${templateLine}`);
    }
  }
  for (const reason of evidence.scenarioProfile.reasons.slice(0, 2)) {
    lines.push(`  依据：${reason}`);
  }
  if (evidence.practicalOutputs.tasks.length > 0) {
    lines.push(`- 任务候选：${evidence.practicalOutputs.tasks.slice(0, 3).join("；")}`);
  }
  if (evidence.projects.length > 0) {
    lines.push(`- 项目 / 主题主线：${evidence.projects.slice(0, 3).map((item) => item.label).join("；")}`);
  }
  if (evidence.practicalOutputs.people.length > 0) {
    lines.push(`- 已确认人物：${evidence.practicalOutputs.people.slice(0, 3).join("；")}`);
  } else if (evidence.practicalOutputs.roleHints.length > 0 || evidence.speakerLayer.suggestedSlots.length > 0) {
    lines.push("- 已确认人物：当前暂无稳定身份标注。");
  }
  if (evidence.practicalOutputs.roleHints.length > 0) {
    lines.push(`- 角色线索：${evidence.practicalOutputs.roleHints.slice(0, 3).join("；")}`);
  }
  if (evidence.practicalOutputs.learningPoints.length > 0) {
    lines.push(`- 学习要点：${evidence.practicalOutputs.learningPoints.slice(0, 3).join("；")}`);
  }
  if (evidence.practicalOutputs.environmentHints.length > 0) {
    lines.push(`- 环境线索：${evidence.practicalOutputs.environmentHints.slice(0, 2).join("；")}`);
  }
  if (evidence.practicalOutputs.attentionItems.length > 0) {
    lines.push(`- 待确认重点：${evidence.practicalOutputs.attentionItems.slice(0, 3).join("；")}`);
  }
  if (evidence.audioCoverage.totalAudioWindows > 0) {
    lines.push(
      `- 音频细节覆盖：已补强 ${evidence.audioCoverage.transcriptReadyWindows} / ${evidence.audioCoverage.totalAudioWindows} 个音频窗口，仍有 ${evidence.audioCoverage.pendingAudioWindows} 个待补转写窗口。`,
    );
    const audioFollowUps = buildAudioFollowUps(evidence.windows);
    if (audioFollowUps.length > 0) {
      lines.push(`- 音频追问建议：${audioFollowUps[0]}`);
    }
  }
  if (evidence.videoCoverage.totalVideoGroups > 0) {
    lines.push(
      `- 视频证据覆盖：共 ${evidence.videoCoverage.totalVideoGroups} 组，含原始视频 ${evidence.videoCoverage.groupsWithVideoArtifacts} 组、关键帧 ${evidence.videoCoverage.groupsWithKeyframes} 组、OCR 线索 ${evidence.videoCoverage.groupsWithOcrHints} 组；关键帧关联片段 ${evidence.videoCoverage.linkedKeyframes}/${evidence.videoCoverage.totalKeyframes}，待补细节 ${evidence.videoCoverage.groupsNeedingFollowUp} 组。`,
    );
    const videoFollowUps = buildVideoFollowUps(evidence.videoEvidenceGroups);
    if (videoFollowUps.length > 0) {
      lines.push(`- 视频追问建议：${videoFollowUps[0]}`);
    }
  }
  const evidenceFollowUps = uniqueItems(
    buildHistoryFollowUps(identityHistory, projectHistory)
      .concat(buildTopicFollowUps(evidence.topicSegments))
      .concat(buildAudioFollowUps(evidence.windows))
      .concat(buildVideoFollowUps(evidence.videoEvidenceGroups)),
  )
    .slice(0, 2);
  if (evidenceFollowUps.length > 0) {
    lines.push(`- 快捷追问入口：${evidenceFollowUps.join(" / ")}`);
  }
  lines.push(`- 说话人层：${evidence.speakerLayer.note}`);
  for (const slot of evidence.speakerLayer.suggestedSlots.slice(0, 3)) {
    lines.push(
      `  ${slot.slotLabel} @ ${slot.timeRange}${slot.displayName ? ` -> ${slot.displayName}${slot.relationship ? `（${slot.relationship}）` : ""}` : ""}`,
    );
  }
  if (evidence.speakerLayer.suggestedSlots.some((slot) => !slot.displayName || looksPendingIdentityLabel(slot.displayName))) {
    lines.push("  可继续动作：如果你知道某个 speaker 是谁，可以直接说“speaker_1 是我同事李三”这类标注；但精确任务归属仍需要后续补齐句级说话人。");
  }
  const annotationPrompts = buildAnnotationPrompts(evidence);
  if (annotationPrompts.length > 0) {
    lines.push("- 标注快捷句：");
    for (const prompt of annotationPrompts.slice(0, 3)) {
      lines.push(`  ${prompt}`);
    }
  }
  const annotationCommands = buildAnnotationCommandHints(evidence);
  if (annotationCommands.length > 0) {
    lines.push("- 标注命令（可直接执行）：");
    for (const command of annotationCommands.slice(0, 3)) {
      lines.push(`  ${command}`);
    }
  }

  if (focus !== "what_happened") {
    const watchItems = followUps.concat(nextSteps).slice(0, 4);
    if (watchItems.length > 0) {
      lines.push("", "现在值得注意：");
      for (const item of watchItems) {
        lines.push(`- ${item}`);
      }
    } else {
      const peopleWatch = payload.highlights.people
        .map((person) =>
          person.nextWatchFor
            ? `${person.displayName}${person.relationship ? `（${person.relationship}）` : ""}：${person.nextWatchFor}`
            : "",
        )
        .filter(Boolean)
        .slice(0, 2);
      if (peopleWatch.length > 0) {
        lines.push("", "人物上值得继续留意：");
        for (const item of peopleWatch) {
          lines.push(`- ${item}`);
        }
      }
    }
  }

  if (evidence.gaps.length > 0) {
    lines.push("", "当前缺口：");
    for (const gap of evidence.gaps) {
      lines.push(`- ${gap}`);
    }
  }

  const recentImages = payload.highlights.recentImages.slice(0, 2);
  if (recentImages.length > 0) {
    lines.push("", "最近值得回看的图片：");
    for (const image of recentImages) {
      const url = image.artifact?.url ? ` (${image.artifact.url})` : "";
      lines.push(`- ${image.summary}${url}`);
    }
  }

  const degradedEvents = payload.windows.reduce(
    (count, window) => count + window.events.filter((event) => event.analysisStatus === "degraded").length,
    0,
  );
  if (degradedEvents > 0) {
    lines.push(
      "",
      `素材限制：当前有 ${degradedEvents} 条事件仍是降级摘要。回答时应优先引用已有线索，不要把推断说成事实。`,
    );
  }

  return lines.join("\n");
}

export function buildClawSenseContextToolDetails(
  payload: AssistantContextPayload,
  focus: "general" | "what_happened" | "watch_for",
  question?: string,
  audioRechecks: AudioRecheckResult[] = [],
  identityHistory: IdentityHistoryEntry[] = [],
  projectHistory: ProjectHistoryEntry[] = [],
) {
  const degradedEvents = payload.windows.flatMap((window) => window.events).filter((event) => event.analysisStatus === "degraded");
  const evidence = buildEvidenceBundle(payload, focus, question, identityHistory, projectHistory);
  const audioFollowUpTargets = buildAudioFollowUpTargets(evidence.windows);
  const audioFollowUps = audioFollowUpTargets.map((item) => item.prompt);
  const videoFollowUpTargets = buildVideoFollowUpTargets(evidence.videoEvidenceGroups);
  const videoFollowUps = videoFollowUpTargets.map((item) => item.prompt);
  const historyFollowUps = buildHistoryFollowUps(identityHistory, projectHistory);
  const topicFollowUpTargets = buildTopicFollowUpTargets(evidence.topicSegments);
  const topicFollowUps = topicFollowUpTargets.map((item) => item.prompt);
  const evidenceFollowUpTargets = buildEvidenceFollowUpTargets({
    audioFollowUpTargets,
    videoFollowUpTargets,
    historyFollowUps,
    topicFollowUpTargets,
  });

  return {
    scope: payload.scope,
    date: payload.date,
    question,
    focus,
    counts: payload.counts,
    summary: payload.summary,
    recentActivity: payload.recentActivity,
    review: payload.review
      ? {
          reviewId: payload.review.reviewId,
          generatedAt: payload.review.generatedAt,
          summary: payload.review.summary,
          sections: payload.review.sections,
        }
      : undefined,
    consolidation: payload.consolidation,
    highlights: payload.highlights,
    windows: payload.windows.slice(0, focus === "what_happened" ? 6 : 4).map((window) => ({
      windowId: window.windowId,
      deviceId: window.deviceId,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      primarySummary: window.primarySummary,
      transcriptText: window.transcriptText,
      imageCount: window.imageCount,
      videoCount: window.videoCount,
      audioCount: window.audioCount,
      captureContexts: window.captureContexts,
      peopleRefs: window.peopleRefs,
      projectRefs: window.projectRefs,
      tags: window.tags,
      events: window.events.map((event) => ({
        eventId: event.eventId,
        modality: event.modality,
        capturedAt: event.capturedAt,
        summary: event.summary,
        transcript: event.transcript,
        captureContext: event.captureContext,
        analysisMode: event.analysisMode,
        analysisProvider: event.analysisProvider,
        analysisStatus: event.analysisStatus,
        analysisFailureReason: event.analysisFailureReason,
        transcriptSegments: event.transcriptSegments,
        speakerTimelineSegments: event.speakerTimelineSegments,
        artifact: event.artifact,
      })),
      })),
    limitations:
      degradedEvents.length > 0
        ? {
            degradedEventCount: degradedEvents.length,
            failureReasons: [...new Set(degradedEvents.map((event) => event.analysisFailureReason).filter(Boolean))],
          }
        : undefined,
    responseHints: {
      answerShape: ["一句结论", "2-4 条已确认的证据", "仍待确认的缺口"],
      answerBuckets: buildScenarioBucketsHint(evidence.scenarioProfile.candidate),
      scenarioAnswerTemplate: buildScenarioAnswerTemplate(evidence),
      confirmedFindings: buildConfirmedFindings(payload, evidence, focus),
      watchItems: evidence.watchItems,
      gaps: evidence.gaps,
      audioRechecks,
      audioCoverage: evidence.audioCoverage,
      audioDiagnostics: evidence.audioDiagnostics,
      audioFollowUps,
      audioFollowUpTargets,
      videoCoverage: evidence.videoCoverage,
      videoFollowUps,
      videoFollowUpTargets,
      topicFollowUps,
      topicFollowUpTargets,
      evidenceFollowUpTargets,
      avoidGuessingDarkState: true,
      scenarioProfile: evidence.scenarioProfile,
      practicalOutputs: evidence.practicalOutputs,
      topicSegments: evidence.topicSegments,
      rollingDigests: evidence.rollingDigests,
      rollingDigestMatches: evidence.rollingDigestMatches,
      memoryCards: evidence.memoryCards,
      memoryCardMatches: evidence.memoryCardMatches,
      conversationDigest: evidence.conversationDigest,
      taskAttribution: evidence.taskAttribution,
      taskAttributionBuckets: evidence.taskAttribution.buckets,
      speakerResolutionPrompts: evidence.taskAttribution.speakerResolutionPrompts,
      speakerLayer: evidence.speakerLayer,
      annotationPrompts: buildAnnotationPrompts(evidence),
      annotationSuggestions: evidence.annotationSuggestions,
      historyFollowUps,
      identityHistory,
      projectHistory,
    },
    evidenceBundle: evidence,
    audioRechecks,
    identityHistory,
    projectHistory,
    rollingDigests: Array.isArray(payload.rollingDigests) ? payload.rollingDigests : [],
    rollingDigestMatches: evidence.rollingDigestMatches,
    memoryCards: evidence.memoryCards,
    memoryCardMatches: evidence.memoryCardMatches,
  };
}

function buildEvidenceBundle(
  payload: AssistantContextPayload,
  focus: "general" | "what_happened" | "watch_for",
  question?: string,
  identityHistory: IdentityHistoryEntry[] = [],
  projectHistory: ProjectHistoryEntry[] = [],
): EvidenceBundle {
  const keyWindowIds = new Set(payload.highlights.keyWindowIds);
  const queryTerms = extractQueryTerms(question);
  const questionIntent = inferQuestionIntent(question);
  const peopleByRef = new Map(
    payload.highlights.people.map((person) => [
      person.personRef,
      `${person.displayName}${person.relationship ? `（${person.relationship}）` : ""}`,
    ]),
  );

  const scoredWindows = payload.windows
    .map((window) => {
      const videoCount = window.videoCount ?? 0;
      const evidenceText = [
        window.primarySummary,
        window.transcriptText,
        window.tags.join(" "),
        window.projectRefs.join(" "),
        window.events.map((event) => `${event.summary} ${event.transcript ?? ""}`).join(" "),
      ]
        .filter(Boolean)
        .join(" ");
      const transcriptExcerpt = window.transcriptText
        ? truncateText(toSingleLine(window.transcriptText), questionIntent.conversation ? 360 : 180)
        : undefined;
      const degradedCount = window.events.filter((event) => event.analysisStatus === "degraded").length;
      const audioArtifacts = window.events
        .filter((event) => event.modality === "audio" && event.artifact?.available && Boolean(event.artifact.url))
        .slice()
        .sort((left, right) => left.capturedAt - right.capturedAt)
        .slice(0, 2)
        .map((event) => ({
          eventId: event.eventId,
          capturedAt: event.capturedAt,
          url: event.artifact!.url,
        }));
      const questionBoost =
        queryTerms.length === 0
          ? 0
          : queryTerms.reduce(
              (score, term) => (evidenceText.toLowerCase().includes(term.toLowerCase()) ? score + 8 : score),
              0,
            );
      const mediaScore =
        Math.min(window.audioCount, 12) * 6 +
        Math.min(window.imageCount, 12) * 4 +
        Math.min(videoCount, 4) * 5;
      const transcriptBoost = window.transcriptText.trim() ? 30 : 0;
      const conversationBoost =
        questionIntent.conversation
          ? (window.audioCount > 0 ? 35 : 0) + (window.transcriptText.trim() ? 70 : 0)
          : 0;
      const videoBoost =
        questionIntent.video
          ? (videoCount > 0 ? 45 : 0) +
            (/视频|访谈|播放|字幕|主播|主讲|画面/.test(evidenceText) ? 20 : 0)
          : 0;
      const score =
        (keyWindowIds.has(window.windowId) ? 40 : 0) +
        questionBoost +
        mediaScore +
        transcriptBoost +
        conversationBoost +
        videoBoost -
        degradedCount * 3;
      return {
        windowId: window.windowId,
        timeRange: `${formatTime(window.startedAt)}-${formatTime(window.endedAt)}`,
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        summary: window.primarySummary,
        transcriptExcerpt,
        audioCount: window.audioCount,
        imageCount: window.imageCount,
        videoCount,
        projectRefs: window.projectRefs.slice(0, 4),
        tags: window.tags.slice(0, 4),
        peopleHints: window.peopleRefs
          .map((personRef) => peopleByRef.get(personRef) ?? personRef)
          .slice(0, 3),
        captureContexts: window.captureContexts,
        audioArtifacts,
        degradedCount,
        score,
      };
    })
    .sort((left, right) => right.score - left.score || right.endedAt - left.endedAt);
  const windows = selectEvidenceWindows(scoredWindows, payload, focus, questionIntent);
  const darkImageHintCount = payload.highlights.recentImages.filter((image) => looksDarkOrOccluded(image.summary)).length;
  const degradedEventCount = payload.windows.reduce(
    (count, window) => count + window.events.filter((event) => event.analysisStatus === "degraded").length,
    0,
  );
  const transcriptWindowCount = windows.filter((window) => Boolean(window.transcriptExcerpt)).length;
  const videoEvidenceGroups = buildVideoEvidenceGroups(payload, windows);
  const scenarioProfile = buildScenarioProfile(payload, windows, videoEvidenceGroups);
  const speakerLayer = buildSpeakerLayer(payload, transcriptWindowCount);
  const digestWindows = shouldUseWideConversationDigest(payload, questionIntent) ? scoredWindows : windows;
  const topicSegments = buildTopicSegments(payload, digestWindows, questionIntent, speakerLayer);
  const practicalOutputs = buildPracticalOutputs(payload, scenarioProfile, speakerLayer, windows, videoEvidenceGroups);
  const taskAttribution = buildTaskAttribution(topicSegments, practicalOutputs, speakerLayer);
  const conversationDigest = buildConversationDigest({
    payload,
    windows: digestWindows,
    topicSegments,
    taskAttribution,
    questionIntent,
    question,
  });
  const projects = buildProjectSummaries(payload, windows);
  const fragments = buildEvidenceFragments(payload, windows, videoEvidenceGroups);
  const audioCoverage = resolveAudioCoverage(payload);
  const audioDiagnostics = buildEvidenceAudioDiagnostics(payload);
  const videoCoverage = resolveVideoCoverage(videoEvidenceGroups);
  const transcriptSpans = buildTranscriptSpans(payload, windows);
  const artifactRefs = buildArtifactRefs(payload, windows);
  const annotationSuggestions = buildAnnotationSuggestions({
    speakerLayer,
    roleHints: practicalOutputs.roleHints,
  });
  const topEvidence = buildTopEvidence(fragments);
  const rollingDigestMatches = buildRollingDigestQueryMatches(payload.rollingDigests, question);
  const memoryCards = Array.isArray(payload.memoryCards) ? payload.memoryCards : [];
  const memoryCardMatches = buildMemoryCardQueryMatches(memoryCards, question);

  return {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    timeRange: {
      scope: payload.scope,
      date: payload.date,
      startAt: payload.startAt,
      endAt: payload.endAt,
      label: formatEvidenceWindowLabel(payload),
    },
    recentActivity: payload.recentActivity,
    question: question ?? null,
    keyWindowIds: payload.highlights.keyWindowIds,
    confirmedFindings: buildConfirmedFindings(payload, windows, focus),
    scenarioProfile,
    practicalOutputs,
    projects,
    audioCoverage,
    audioDiagnostics,
    videoCoverage,
    speakerLayer,
    windows,
    signalProfile: {
      transcriptWindowCount,
      darkImageHintCount,
      degradedEventCount,
    },
    fragments,
    topEvidence,
    topicSegments,
    rollingDigests: Array.isArray(payload.rollingDigests) ? payload.rollingDigests : [],
    rollingDigestMatches,
    memoryCards: memoryCards.slice(0, 24),
    memoryCardMatches,
    conversationDigest,
    taskAttribution,
    transcriptSpans,
    artifactRefs,
    videoEvidenceGroups,
    annotationSuggestions,
    gaps: buildEvidenceGaps(payload),
    watchItems: readSectionItems(payload, "今天遗漏但值得追问的点")
      .concat(readSectionItems(payload, "明天建议关注的事情"))
      .slice(0, 4),
    recentImages: payload.highlights.recentImages.slice(0, 3).map((image) => ({
      eventId: image.eventId,
      capturedAt: image.capturedAt,
      summary: image.summary,
      artifact: image.artifact,
    })),
    people: payload.highlights.people.slice(0, 6),
    identityHistory,
    projectHistory,
  };
}

function selectEvidenceWindows(
  scoredWindows: EvidenceBundleWindow[],
  payload: AssistantContextPayload,
  focus: "general" | "what_happened" | "watch_for",
  questionIntent: ReturnType<typeof inferQuestionIntent>,
): EvidenceBundleWindow[] {
  const limit =
    questionIntent.conversation
      ? payload.scope === "custom-range"
        ? 8
        : 6
      : focus === "what_happened"
        ? 6
        : 3;
  const selected = scoredWindows.slice(0, limit);
  if (!questionIntent.conversation || payload.scope !== "custom-range" || selected.length === 0) {
    return selected;
  }

  const transcriptWindows = scoredWindows
    .filter((window) => Boolean(window.transcriptExcerpt))
    .slice()
    .sort((left, right) => left.startedAt - right.startedAt);
  const boundaryWindows = [transcriptWindows[0], transcriptWindows[transcriptWindows.length - 1]].filter(
    (window): window is EvidenceBundleWindow => Boolean(window),
  );
  const boundaryIds = new Set(boundaryWindows.map((window) => window.windowId));
  for (const window of boundaryWindows) {
    if (!selected.some((item) => item.windowId === window.windowId)) {
      selected.push(window);
    }
  }
  while (selected.length > limit) {
    const removable = selected
      .map((window, index) => ({ window, index }))
      .filter((item) => !boundaryIds.has(item.window.windowId))
      .sort((left, right) => left.window.score - right.window.score || left.window.startedAt - right.window.startedAt)[0];
    if (!removable) {
      break;
    }
    selected.splice(removable.index, 1);
  }
  return selected.sort((left, right) => right.score - left.score || right.endedAt - left.endedAt);
}

function shouldUseWideConversationDigest(
  payload: AssistantContextPayload,
  questionIntent: ReturnType<typeof inferQuestionIntent>,
): boolean {
  return questionIntent.conversation || payload.scope === "custom-range";
}

function buildConfirmedFindings(
  payload: AssistantContextPayload,
  evidence: EvidenceBundle | EvidenceBundleWindow[],
  focus: "general" | "what_happened" | "watch_for",
): string[] {
  const windows = Array.isArray(evidence) ? evidence : evidence.windows;
  const sectionItems = focus === "watch_for"
    ? readSectionItems(payload, "值得注意的细节")
    : readSectionItems(payload, "Today at a glance").concat(readSectionItems(payload, "时间线回顾"));

  const windowItems = windows.flatMap((window) => {
    const tags = window.tags.length > 0 ? `（线索：${window.tags.join("、")}）` : "";
    const transcript = window.transcriptExcerpt ? `；转写摘录：${window.transcriptExcerpt}` : "";
    return window.summary ? [`${window.summary}${tags}${transcript}`] : [];
  });

  const imageItems = payload.highlights.recentImages
    .slice(0, 2)
    .map((image) => image.summary)
    .filter(Boolean);

  return uniqueItems([...sectionItems, ...windowItems, ...imageItems]).slice(
    0,
    focus === "what_happened" ? 4 : 3,
  );
}

function buildEvidenceFragments(
  payload: AssistantContextPayload,
  windows: EvidenceBundleWindow[],
  videoGroups: EvidenceBundleVideoGroup[],
): EvidenceBundle["fragments"] {
  const fragments: EvidenceBundle["fragments"] = [];

  for (const window of windows) {
    if (window.transcriptExcerpt) {
      fragments.push({
        fragmentId: `transcript:${window.windowId}`,
        kind: "transcript",
        status: "confirmed",
        windowId: window.windowId,
        timeRange: window.timeRange,
        text: window.transcriptExcerpt,
      });
    }

    if (window.audioArtifacts.length > 0) {
      fragments.push({
        fragmentId: `audio-raw:${window.windowId}`,
        kind: "audio-observation",
        status: window.degradedCount > 0 ? "degraded" : "confirmed",
        windowId: window.windowId,
        timeRange: window.timeRange,
        text: `${window.timeRange} 有可供主模型直接复核的原始音频片段。`,
        artifactUrl: window.audioArtifacts[0]?.url,
      });
    } else if (window.audioCount > 0) {
      fragments.push({
        fragmentId: `audio:${window.windowId}`,
        kind: "audio-observation",
        status: window.degradedCount > 0 ? "degraded" : "missing",
        windowId: window.windowId,
        timeRange: window.timeRange,
        text: `${window.timeRange} 有 ${window.audioCount} 段音频，但目前没有可直接引用的转写。`,
      });
    }
  }

  for (const group of videoGroups.slice(0, 3)) {
    const suffix = group.keyframeEventIds.length > 0
      ? `，并关联 ${group.keyframeEventIds.length} 张关键帧`
      : "";
    const keyframeLead = group.keyframeDetails[0];
    const leadingVideoDetail = group.videoDetails[0];
    const keyframeHint = keyframeLead
      ? ` 关键帧${keyframeLead.keyframeIndex ? `#${keyframeLead.keyframeIndex}` : ""}：${truncateText(toSingleLine(keyframeLead.caption || keyframeLead.summary), 72)}`
      : "";
    const ocrHint = group.semanticSignals.ocrHints[0] ? ` OCR：${group.semanticSignals.ocrHints[0]}` : "";
    fragments.push({
      fragmentId: `video:${group.videoRequestId}`,
      kind: "video-observation",
      status: group.videoArtifactUrls.length > 0 ? "confirmed" : "degraded",
      windowId: group.windowIds[0],
      artifactId: leadingVideoDetail?.artifactId ?? keyframeLead?.artifactId,
      videoRequestId: group.videoRequestId,
      timeRange: group.timeRange,
      text: `${group.timeRange} 记录到 ${group.videoEventIds.length} 段视频${suffix}。${keyframeHint}${ocrHint}`.trim(),
      artifactUrl: group.videoArtifactUrls[0] ?? group.keyframeArtifactUrls[0],
    });
    if (keyframeLead) {
      const offsetSuffix = keyframeLead.videoOffsetLabel ? `（片段内 ${keyframeLead.videoOffsetLabel}）` : "";
      const linkedClip = keyframeLead.linkedVideoTime
        ? `；关联视频 ${keyframeLead.linkedVideoTime}${keyframeLead.videoOffsetLabel ? ` / 片段内 ${keyframeLead.videoOffsetLabel}` : ""}${keyframeLead.linkedDeltaMs ? `（相差 ${Math.round(keyframeLead.linkedDeltaMs / 1000)} 秒）` : ""}`
        : "";
      const ocrSuffix = keyframeLead.ocrHints.length > 0 ? `；OCR：${keyframeLead.ocrHints.slice(0, 2).join("、")}` : "";
      fragments.push({
        fragmentId: `video-keyframe:${group.videoRequestId}:${keyframeLead.eventId}`,
        kind: "video-observation",
        status: "confirmed",
        windowId: keyframeLead.windowId,
        eventId: keyframeLead.eventId,
        artifactId: keyframeLead.artifactId,
        videoRequestId: group.videoRequestId,
        keyframeIndex: keyframeLead.keyframeIndex,
        timeRange: keyframeLead.time,
        text: `${keyframeLead.time}${offsetSuffix} 关键帧${keyframeLead.keyframeIndex ? `#${keyframeLead.keyframeIndex}` : ""}：${truncateText(toSingleLine(keyframeLead.caption || keyframeLead.summary), 120)}${ocrSuffix}${linkedClip}`,
        artifactUrl: keyframeLead.url,
      });
    }
  }

  for (const image of payload.highlights.recentImages.slice(0, 3)) {
    fragments.push({
      fragmentId: `image:${image.eventId}`,
      kind: "image-observation",
      status: looksDarkOrOccluded(image.summary) ? "degraded" : "confirmed",
      eventId: image.eventId,
      text: image.summary,
      artifactUrl: image.artifact?.url,
    });
  }

  for (const gap of buildEvidenceGaps(payload).slice(0, 3)) {
    fragments.push({
      fragmentId: `gap:${gap}`,
      kind: "gap",
      status: "missing",
      text: gap,
    });
  }

  return fragments.slice(0, 10);
}

function buildTopEvidence(
  fragments: EvidenceBundle["fragments"],
): EvidenceBundle["topEvidence"] {
  const statusScore: Record<EvidenceBundle["fragments"][number]["status"], number> = {
    confirmed: 3,
    degraded: 2,
    missing: 1,
  };
  const kindScore: Record<EvidenceBundle["fragments"][number]["kind"], number> = {
    transcript: 5,
    "video-observation": 4,
    "audio-observation": 3,
    "image-observation": 2,
    gap: 1,
  };
  return fragments
    .slice()
    .sort(
      (left, right) =>
        statusScore[right.status] - statusScore[left.status] ||
        kindScore[right.kind] - kindScore[left.kind] ||
        Number(right.kind === "video-observation" && Boolean(right.artifactUrl)) -
          Number(left.kind === "video-observation" && Boolean(left.artifactUrl)) ||
        Number(Boolean(right.artifactUrl)) - Number(Boolean(left.artifactUrl)),
    )
    .slice(0, 6)
    .map((fragment) => ({
      fragmentId: fragment.fragmentId,
      kind: fragment.kind,
      status: fragment.status,
      text: fragment.text,
      windowId: fragment.windowId,
      eventId: fragment.eventId,
      artifactId: fragment.artifactId,
      videoRequestId: fragment.videoRequestId,
      keyframeIndex: fragment.keyframeIndex,
      timeRange: fragment.timeRange,
      artifactUrl: fragment.artifactUrl,
    }));
}

function buildTranscriptSpans(
  payload: AssistantContextPayload,
  windows: EvidenceBundleWindow[],
): EvidenceBundle["transcriptSpans"] {
  const allowedWindowIds = new Set(windows.map((window) => window.windowId));
  const spans = payload.windows
    .filter((window) => allowedWindowIds.has(window.windowId))
    .flatMap((window) =>
      window.events
        .filter((event) => event.modality === "audio" && Boolean(event.transcript?.trim()))
        .map((event) => ({
          spanId: `event:${event.eventId}`,
          windowId: window.windowId,
          eventId: event.eventId,
          capturedAt: event.capturedAt,
          text: truncateText(toSingleLine(event.transcript ?? ""), 240),
          source: "event-transcript" as const,
          artifactUrl: event.artifact?.available ? event.artifact.url : undefined,
        })),
    )
    .sort((left, right) => left.capturedAt - right.capturedAt);
  return spans.slice(0, 12);
}

function buildArtifactRefs(
  payload: AssistantContextPayload,
  windows: EvidenceBundleWindow[],
): EvidenceBundle["artifactRefs"] {
  const allowedWindowIds = new Set(windows.map((window) => window.windowId));
  const refs = payload.windows
    .filter((window) => allowedWindowIds.has(window.windowId))
    .flatMap((window) =>
      window.events.flatMap((event) => {
        const artifact = event.artifact;
        if (!artifact || !artifact.available) {
          return [];
        }
        const videoMarker = parseVideoMarker(event.note);
        const fallbackVideoRequestId =
          videoMarker.videoRequestId ??
          ((event.modality === "video" || videoMarker.isKeyframe)
            ? `video-window:${window.windowId}`
            : undefined);
        return [
          {
            artifactId: artifact.artifactId,
            modality: event.modality,
            windowId: window.windowId,
            eventId: event.eventId,
            videoRequestId: fallbackVideoRequestId,
            keyframeIndex: videoMarker.keyframeIndex,
            capturedAt: event.capturedAt,
            fileName: artifact.fileName,
            mime: artifact.mime,
            sizeBytes: artifact.sizeBytes,
            url: artifact.url,
          },
        ];
      }),
    )
    .sort((left, right) => left.capturedAt - right.capturedAt);
  const deduped = new Map<string, EvidenceBundle["artifactRefs"][number]>();
  for (const ref of refs) {
    if (!deduped.has(ref.artifactId)) {
      deduped.set(ref.artifactId, ref);
    }
  }
  return Array.from(deduped.values()).slice(0, 24);
}

function buildVideoEvidenceGroups(
  payload: AssistantContextPayload,
  windows: EvidenceBundleWindow[],
): EvidenceBundleVideoGroup[] {
  const allowedWindowIds = new Set(windows.map((window) => window.windowId));
  const groups = new Map<
    string,
    {
      videoRequestId: string;
      startedAt: number;
      endedAt: number;
      windowIds: Set<string>;
      videoEventIds: Set<string>;
      keyframeEventIds: Set<string>;
      videoArtifactUrls: Set<string>;
      keyframeArtifactUrls: Set<string>;
      videoDetails: Map<
        string,
        {
          eventId: string;
          windowId: string;
          capturedAt: number;
          summary: string;
          caption: string;
          ocrHints: string[];
          artifactId?: string;
          url?: string;
        }
      >;
      keyframeDetails: Map<
        string,
        {
          eventId: string;
          windowId: string;
          capturedAt: number;
          keyframeIndex?: number;
          videoOffsetMs?: number;
          videoOffsetLabel?: string;
          summary: string;
          caption: string;
          ocrHints: string[];
          artifactId?: string;
          url?: string;
        }
      >;
    }
  >();

  for (const window of payload.windows) {
    if (!allowedWindowIds.has(window.windowId)) {
      continue;
    }
    for (const event of window.events) {
      const marker = parseVideoMarker(event.note);
      const fallbackRequestId =
        marker.videoRequestId ??
        ((event.modality === "video" || marker.isKeyframe)
          ? `video-window:${window.windowId}`
          : undefined);
      if (!fallbackRequestId) {
        continue;
      }
      const existing = groups.get(fallbackRequestId) ?? {
        videoRequestId: fallbackRequestId,
        startedAt: event.capturedAt,
        endedAt: event.capturedAt,
        windowIds: new Set<string>(),
        videoEventIds: new Set<string>(),
        keyframeEventIds: new Set<string>(),
        videoArtifactUrls: new Set<string>(),
        keyframeArtifactUrls: new Set<string>(),
        videoDetails: new Map(),
        keyframeDetails: new Map(),
      };

      existing.startedAt = Math.min(existing.startedAt, event.capturedAt);
      existing.endedAt = Math.max(existing.endedAt, event.capturedAt);
      existing.windowIds.add(window.windowId);
      const normalizedSummary = normalizeEvidenceSummary(event.summary);
      const caption = marker.captionHint || normalizeVisualCaption(event.summary) || normalizedSummary;
      const ocrHints = uniqueItems(marker.ocrHints.concat(extractVisualOcrHints(event.summary))).slice(0, 4);
      if (event.modality === "video") {
        existing.videoEventIds.add(event.eventId);
        if (event.artifact?.url) {
          existing.videoArtifactUrls.add(event.artifact.url);
        }
        existing.videoDetails.set(event.eventId, {
          eventId: event.eventId,
          windowId: window.windowId,
          capturedAt: event.capturedAt,
          summary: normalizedSummary || "视频片段已记录，建议回看确认细节。",
          caption: caption || "视频片段已记录，建议回看确认细节。",
          ocrHints,
          artifactId: event.artifact?.artifactId,
          url: event.artifact?.url,
        });
      }
      if (event.modality === "image" && marker.isKeyframe) {
        existing.keyframeEventIds.add(event.eventId);
        if (event.artifact?.url) {
          existing.keyframeArtifactUrls.add(event.artifact.url);
        }
        existing.keyframeDetails.set(event.eventId, {
          eventId: event.eventId,
          windowId: window.windowId,
          capturedAt: event.capturedAt,
          keyframeIndex: marker.keyframeIndex,
          videoOffsetMs: marker.videoOffsetMs,
          videoOffsetLabel: marker.videoOffsetLabel,
          summary: normalizedSummary || "关键帧已记录，建议回看图像确认细节。",
          caption: caption || "关键帧已记录，建议回看图像确认细节。",
          ocrHints,
          artifactId: event.artifact?.artifactId,
          url: event.artifact?.url,
        });
      }
      groups.set(fallbackRequestId, existing);
    }
  }

  return Array.from(groups.values())
    .filter((group) => group.videoEventIds.size > 0 || group.keyframeEventIds.size > 0)
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((group) => {
      const videoDetails = Array.from(group.videoDetails.values()).sort(
        (left, right) => left.capturedAt - right.capturedAt,
      );
      const keyframeDetails = Array.from(group.keyframeDetails.values()).sort(
        (left, right) => {
          const leftKey = left.keyframeIndex ?? Number.MAX_SAFE_INTEGER;
          const rightKey = right.keyframeIndex ?? Number.MAX_SAFE_INTEGER;
          return leftKey - rightKey || left.capturedAt - right.capturedAt;
        },
      );
      const linkedKeyframeDetails = keyframeDetails.map((detail) => ({
        ...detail,
        ...linkKeyframeToVideoDetail(detail, videoDetails.map((item) => ({
          eventId: item.eventId,
          artifactId: item.artifactId,
          url: item.url,
          capturedAt: item.capturedAt,
          time: formatTime(item.capturedAt),
        }))),
      }));
      const groupCaptions = uniqueItems(
        linkedKeyframeDetails
          .map((frame) => frame.caption)
          .concat(videoDetails.map((video) => video.caption))
          .filter(Boolean),
      ).slice(0, 4);
      const groupOcrHints = uniqueItems(
        linkedKeyframeDetails.flatMap((frame) => frame.ocrHints).concat(videoDetails.flatMap((video) => video.ocrHints)),
      ).slice(0, 6);
      const bestSummary =
        groupOcrHints[0] ??
        linkedKeyframeDetails.find((frame) => !looksDarkOrOccluded(frame.caption || frame.summary))?.caption ??
        linkedKeyframeDetails.find((frame) => !looksDarkOrOccluded(frame.summary))?.summary ??
        videoDetails.find((video) => !looksDarkOrOccluded(video.caption || video.summary))?.caption ??
        videoDetails.find((video) => !looksDarkOrOccluded(video.summary))?.summary ??
        "视频片段已入库，建议回看原始视频与关键帧确认细节。";
      const transcriptSpans = payload.windows
        .filter((window) => group.windowIds.has(window.windowId))
        .flatMap((window) =>
          window.events
            .filter((event) => event.modality === "audio" && Boolean(event.transcript?.trim()))
            .map((event) => ({
              eventId: event.eventId,
              windowId: window.windowId,
              capturedAt: event.capturedAt,
              time: formatTime(event.capturedAt),
              text: truncateText(toSingleLine(event.transcript ?? ""), 180),
              artifactUrl: event.artifact?.available ? event.artifact.url : undefined,
            })),
        )
        .sort((left, right) => left.capturedAt - right.capturedAt)
        .slice(0, 4);
      return {
        videoRequestId: group.videoRequestId,
        startedAt: group.startedAt,
        endedAt: group.endedAt,
        timeRange: `${formatTime(group.startedAt)}-${formatTime(group.endedAt)}`,
        windowIds: Array.from(group.windowIds),
        videoEventIds: Array.from(group.videoEventIds),
        keyframeEventIds: Array.from(group.keyframeEventIds),
        videoArtifactUrls: Array.from(group.videoArtifactUrls),
        keyframeArtifactUrls: Array.from(group.keyframeArtifactUrls),
        videoDetails: videoDetails.map((detail) => ({
          ...detail,
          time: formatTime(detail.capturedAt),
        })),
        keyframeDetails: linkedKeyframeDetails.map((detail) => ({
          ...detail,
          time: formatTime(detail.capturedAt),
        })),
        transcriptSpans,
        semanticSignals: {
          captions: groupCaptions,
          ocrHints: groupOcrHints,
          linkedKeyframes: linkedKeyframeDetails.filter((detail) => Boolean(detail.linkedVideoEventId)).length,
          totalKeyframes: linkedKeyframeDetails.length,
        },
        summary: bestSummary,
      };
    })
    .slice(0, 6);
}

function parseVideoMarker(
  note: string | undefined,
): {
  videoRequestId?: string;
  isKeyframe: boolean;
  keyframeIndex?: number;
  videoOffsetMs?: number;
  videoOffsetLabel?: string;
  captionHint?: string;
  ocrHints: string[];
} {
  const text = (note ?? "").trim();
  if (!text) {
    return { isKeyframe: false, ocrHints: [] };
  }
  const videoRequestId = text.match(/\bvideoRequestId=([^\s]+)/i)?.[1]?.trim();
  const keyframeToken = text.match(/\bkeyframe=(\d+)\b/i)?.[1];
  const keyframeIndex = keyframeToken ? Number.parseInt(keyframeToken, 10) : undefined;
  const videoOffsetMs = parseVideoOffsetMs(text);
  const captionHint = readVideoNoteField(text, ["caption", "keyframeCaption", "frameCaption"]);
  const ocrText = readVideoNoteField(text, ["ocr", "ocrText", "ocrHints", "frameOcr"]);
  const ocrHints = ocrText
    ? uniqueItems(
        ocrText
          .split(/[|｜、;,，]/u)
          .map((item) => normalizePotentialOcrChunk(item))
          .filter(Boolean),
      ).slice(0, 4)
    : [];
  return {
    videoRequestId: videoRequestId || undefined,
    isKeyframe: /\bvideoKeyframe=1\b/i.test(text) || Boolean(keyframeToken),
    keyframeIndex: Number.isFinite(keyframeIndex) ? keyframeIndex : undefined,
    videoOffsetMs,
    videoOffsetLabel: typeof videoOffsetMs === "number" ? formatDurationOffset(videoOffsetMs) : undefined,
    captionHint: captionHint ? truncateText(toSingleLine(captionHint), 140) : undefined,
    ocrHints,
  };
}

function parseVideoOffsetMs(note: string): number | undefined {
  const explicitMs = readVideoNoteField(note, ["videoOffsetMs", "offsetMs", "frameOffsetMs", "timeMs"]);
  if (explicitMs) {
    const parsed = Number.parseInt(explicitMs.replace(/ms$/i, ""), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  const explicitSec = readVideoNoteField(note, ["videoOffsetSec", "offsetSec", "frameOffsetSec", "timeSec"]);
  if (explicitSec) {
    const parsed = Number.parseFloat(explicitSec.replace(/s$/i, ""));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed * 1000);
    }
  }
  const durationValue = readVideoNoteField(note, ["videoOffset", "frameOffset", "offset", "time"]);
  return durationValue ? parseDurationOffsetMs(durationValue) : undefined;
}

function parseDurationOffsetMs(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?ms$/i.test(normalized)) {
    const parsed = Number.parseFloat(normalized.replace(/ms$/i, ""));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
  }
  if (/^\d+(?:\.\d+)?s$/i.test(normalized)) {
    const parsed = Number.parseFloat(normalized.replace(/s$/i, ""));
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : undefined;
  }
  const colonParts = normalized.split(":");
  if (colonParts.length >= 2 && colonParts.length <= 3 && colonParts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) {
    const numbers = colonParts.map((part) => Number.parseFloat(part));
    const seconds =
      numbers.length === 3
        ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
        : numbers[0] * 60 + numbers[1];
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  return undefined;
}

function formatDurationOffset(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.round(offsetMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

function readVideoNoteField(text: string, names: string[]): string | undefined {
  for (const name of names) {
    const quoted = new RegExp(`\\b${name}=("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`, "i").exec(text);
    if (quoted?.[1]) {
      const normalized = normalizeVideoNoteFieldValue(quoted[1]);
      if (normalized) {
        return normalized;
      }
    }
    const bare = new RegExp(`\\b${name}=([^\\s]+)`, "i").exec(text);
    if (bare?.[1]) {
      const normalized = normalizeVideoNoteFieldValue(bare[1]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function normalizeVideoNoteFieldValue(value: string): string {
  const unquoted = value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .trim();
  if (!unquoted) {
    return "";
  }
  try {
    return decodeURIComponent(unquoted.replace(/\+/g, "%20")).trim();
  } catch {
    return unquoted;
  }
}

function normalizeEvidenceSummary(summary: string | undefined): string {
  const text = toSingleLine(summary ?? "");
  if (!text) {
    return "";
  }
  return truncateText(text, 180);
}

function formatEvidenceWindowLabel(payload: AssistantContextPayload): string {
  if (payload.scope === "last-hour") {
    return "过去一小时";
  }
  if (payload.scope === "custom-range") {
    return `${formatDateTime(payload.startAt)}-${formatDateTime(payload.endAt)}`;
  }
  return `${payload.date} 这一天`;
}

function buildScenarioProfile(
  payload: AssistantContextPayload,
  windows: EvidenceBundleWindow[],
  videoGroups: EvidenceBundleVideoGroup[],
): EvidenceBundle["scenarioProfile"] {
  const videoEvidenceStatements = collectVideoEvidenceStatements(videoGroups);
  const sourceText = [
    payload.summary,
    ...payload.review?.sections.flatMap((section) => section.items) ?? [],
    ...windows.map((window) => `${window.summary} ${window.transcriptExcerpt ?? ""}`),
    ...videoEvidenceStatements.map((statement) => statement.text),
    ...payload.highlights.recentImages.map((image) => image.summary),
    payload.consolidation?.summary ?? "",
    ...payload.consolidation?.keyInsights ?? [],
    ...payload.consolidation?.tasks ?? [],
    ...payload.consolidation?.learningPoints ?? [],
    ...payload.consolidation?.attentionItems ?? [],
  ]
    .join(" ")
    .toLowerCase();
  const structuredSignals = collectStructuredScenarioSignals(payload, windows);

  const signals = [
    {
      candidate: "work" as const,
      reasons: ["会议、项目、同事、老板、演示、办公、任务、汇报、客户、产品", "meeting, office, demo, project"],
      score: countKeywordHits(sourceText, [
        "会议",
        "项目",
        "同事",
        "老板",
        "演示",
        "办公",
        "任务",
        "汇报",
        "客户",
        "产品",
        "meeting",
        "office",
        "demo",
        "project",
      ]),
      structuredBoost: scoreStructuredScenarioHits(structuredSignals, [
        "office",
        "meeting",
        "demo",
        "quote",
        "report",
        "launch",
        "project",
      ]),
    },
    {
      candidate: "study" as const,
      reasons: ["课堂、老师、课程、作业、复习、学习、讲义、教室、考试、实验", "class, lecture, homework, study"],
      score: countKeywordHits(sourceText, [
        "课堂",
        "老师",
        "课程",
        "作业",
        "复习",
        "学习",
        "讲义",
        "教室",
        "考试",
        "实验",
        "class",
        "lecture",
        "homework",
        "study",
      ]),
      structuredBoost: scoreStructuredScenarioHits(structuredSignals, [
        "study",
        "classroom",
        "homework",
        "exam",
        "experiment",
        "course",
        "lecture",
      ]),
    },
    {
      candidate: "social" as const,
      reasons: ["聚会、朋友、吃饭、聊天、合影、生日、派对", "party, social, dinner"],
      score: countKeywordHits(sourceText, [
        "聚会",
        "朋友",
        "吃饭",
        "聊天",
        "合影",
        "生日",
        "派对",
        "party",
        "social",
        "dinner",
      ]),
      structuredBoost: scoreStructuredScenarioHits(structuredSignals, [
        "social",
        "party",
        "dinner",
        "friend",
      ]),
    },
  ].map((item) => ({
    ...item,
    score: item.score + item.structuredBoost,
  })).sort((left, right) => right.score - left.score);

  const winner = signals[0];
  if (!winner || winner.score === 0) {
    return {
      candidate: "general",
      confidence: "low",
      reasons: ["当前证据还不足以稳定归类为办公、上学或社交场景。"],
    };
  }

  return {
    candidate: winner.candidate,
    confidence: winner.score >= 4 ? "high" : winner.score >= 2 ? "medium" : "low",
    reasons: winner.reasons,
  };
}

function buildPracticalOutputs(
  payload: AssistantContextPayload,
  scenarioProfile: EvidenceBundle["scenarioProfile"],
  speakerLayer: EvidenceBundle["speakerLayer"],
  windows: EvidenceBundleWindow[],
  videoGroups: EvidenceBundleVideoGroup[],
): EvidenceBundle["practicalOutputs"] {
  const consolidation = payload.consolidation;
  const evidenceStatements = collectEvidenceStatements(windows).concat(
    collectVideoEvidenceStatements(videoGroups),
  );
  const taskEvidence = evidenceStatements
    .filter(
      (statement) =>
        looksTaskLike(statement.text) ||
        (scenarioProfile.candidate === "study" && looksStudyActionCue(statement.text)) ||
        (statement.source === "transcript" &&
          (looksActionCue(statement.text) ||
            looksDeadlineCue(statement.text) ||
            (scenarioProfile.candidate === "work" && looksWorkLike(statement.text)))),
    )
    .map((statement) => formatTimedEvidence(statement.timeRange, statement.text));
  const tasks = uniqueItems(
    taskEvidence
      .concat(consolidation?.tasks ?? [])
      .concat(readSectionItems(payload, "明天建议关注的事情"))
      .concat(readSectionItems(payload, "Today at a glance").filter((item) => looksTaskLike(item)))
      .concat(readSectionItems(payload, "时间线回顾").filter((item) => looksTaskLike(item)))
      .map(stripSectionPrefix)
      .filter((item) => !looksQuestionLike(item)),
  ).slice(0, 4);
  const people = uniqueItems(
    (consolidation?.people ?? [])
      .filter((person) => person.status === "confirmed" && !looksPendingIdentityLabel(person.displayName))
      .map((person) => `${person.displayName}${person.relationship ? `（${person.relationship}）` : ""}`)
      .concat(
        payload.highlights.people
          .filter((person) => !looksPendingIdentityLabel(person.displayName))
          .map((person) => `${person.displayName}${person.relationship ? `（${person.relationship}）` : ""}`),
      )
      .concat(
        payload.highlights.speakers
          .filter((speaker) => !looksPendingIdentityLabel(speaker.displayName))
          .map((speaker) => `${speaker.displayName}${speaker.relationship ? `（${speaker.relationship}）` : ""}`),
      ),
  ).slice(0, 4);
  const roleHints = uniqueItems(
    extractPendingIdentityHints(payload, evidenceStatements, speakerLayer, scenarioProfile.candidate),
  ).slice(0, 4);
  const learningPointsSource =
    scenarioProfile.candidate === "study"
      ? evidenceStatements
          .filter(
            (statement) =>
              looksStudyLike(statement.text) ||
              looksClassroomLike(statement.text) ||
              looksTeachingCue(statement.text) ||
              looksLearningOutcomeCue(statement.text),
          )
          .map((statement) => formatTimedEvidence(statement.timeRange, statement.text))
          .concat(readSectionItems(payload, "值得注意的细节"))
          .concat(readSectionItems(payload, "时间线回顾"))
      : readSectionItems(payload, "值得注意的细节")
          .concat(readSectionItems(payload, "时间线回顾"))
          .concat(
            evidenceStatements
              .filter((statement) => looksStudyLike(statement.text) || looksClassroomLike(statement.text))
              .map((statement) => formatTimedEvidence(statement.timeRange, statement.text)),
          )
          .filter((item) => looksStudyLike(item) || looksClassroomLike(item));
  const learningPoints = uniqueItems(
    learningPointsSource
      .concat(consolidation?.learningPoints ?? [])
      .map(stripSectionPrefix)
      .filter(
        (item) =>
          scenarioProfile.candidate === "study" ||
          looksStudyLike(item) ||
          looksClassroomLike(item),
      ),
  ).slice(0, 4);
  const environmentHints = uniqueItems(
    payload.highlights.recentImages.map((image) => image.summary).concat(
      payload.windows
        .map((window) => window.primarySummary)
        .filter((summary) => looksEnvironmentLike(summary)),
    ),
  ).slice(0, 3);
  const attentionItems = uniqueItems(
    readSectionItems(payload, "今天遗漏但值得追问的点")
      .concat(consolidation?.attentionItems ?? [])
      .map(stripSectionPrefix)
      .concat(
        speakerLayer.suggestedSlots
          .filter((slot) => !slot.displayName)
          .map(
            (slot) =>
              `${slot.slotLabel}（${slot.timeRange}）还未标成真实人物；如果这是${scenarioProfile.candidate === "study" ? "课堂" : scenarioProfile.candidate === "work" ? "办公" : "当前"}场景，建议尽快补齐身份。`,
          ),
      )
      .concat(
        windows
          .filter((window) => window.audioCount > 0 && !window.transcriptExcerpt)
          .slice(0, 2)
          .map((window) => `${window.timeRange} 的音频仍待补转写；如果这是${scenarioProfile.candidate === "study" ? "课堂" : scenarioProfile.candidate === "work" ? "会议" : "关键"}片段，建议优先补齐内容。`),
      )
      .concat(
        scenarioProfile.candidate === "work" && tasks.length === 0
          ? ["当前更像办公场景，但还没有稳定提炼出可执行任务，建议回看关键时间窗确认待办。"]
          : [],
      )
      .concat(
        scenarioProfile.candidate === "study" && learningPoints.length === 0
          ? ["当前更像学习场景，但还没有稳定提炼出学习要点，建议回看老师 / 课程相关的音频窗口。"]
          : [],
      )
      .concat(
        (scenarioProfile.candidate === "work" || scenarioProfile.candidate === "study") &&
          people.length === 0
          ? ["当前场景里可能存在关键人物，但身份还不稳定，建议先标注说话人或人物。"]
          : [],
      )
      .filter(Boolean),
  ).slice(0, 4);

  return {
    tasks,
    people,
    roleHints,
    learningPoints,
    environmentHints,
    attentionItems,
  };
}

function buildTopicSegments(
  payload: AssistantContextPayload,
  windows: EvidenceBundleWindow[],
  questionIntent: ReturnType<typeof inferQuestionIntent>,
  speakerLayer: EvidenceBundle["speakerLayer"],
): EvidenceTopicSegment[] {
  const allowedWindows = new Map(windows.map((window) => [window.windowId, window]));
  const maxSegments = questionIntent.conversation
    ? payload.scope === "custom-range"
      ? 24
      : 12
    : payload.scope === "custom-range"
      ? 12
      : 6;
  const segments: EvidenceTopicSegment[] = [];

  for (const rawWindow of payload.windows.slice().sort((left, right) => left.startedAt - right.startedAt)) {
    const selectedWindow = allowedWindows.get(rawWindow.windowId);
    if (!selectedWindow) {
      continue;
    }

    const audioEvents = rawWindow.events
      .filter((event) => event.modality === "audio" && Boolean(getAudioEventTranscriptText(event).trim()))
      .slice()
      .sort((left, right) => left.capturedAt - right.capturedAt);

    if (audioEvents.length === 0 && selectedWindow.transcriptExcerpt) {
      const text = selectedWindow.transcriptExcerpt;
      segments.push({
        segmentId: `${selectedWindow.windowId}::topic-1`,
        windowId: selectedWindow.windowId,
        startedAt: selectedWindow.startedAt,
        endedAt: selectedWindow.endedAt,
        timeRange: selectedWindow.timeRange,
        title: inferTopicTitle(text),
        summary: summarizeTopicText(text),
        transcriptExcerpt: truncateText(toSingleLine(text), 420),
        keywordHints: extractTopicKeywordHints(text),
        sourceEventIds: [],
        taskSignals: extractTaskSignalsFromText(text),
      });
      continue;
    }

    if (audioEvents.length === 0) {
      continue;
    }

    const windowDuration = Math.max(ONE_MINUTE_MS, rawWindow.endedAt - rawWindow.startedAt);
    const estimatedSegments = Math.min(
      8,
      Math.max(1, Math.ceil(audioEvents.length / 12), Math.ceil(windowDuration / (8 * ONE_MINUTE_MS))),
    );
    const minTopicSegmentMs = questionIntent.conversation ? 90_000 : 3 * ONE_MINUTE_MS;
    const targetSegmentMs = Math.max(minTopicSegmentMs, Math.ceil(windowDuration / estimatedSegments));
    let chunk: typeof audioEvents = [];
    let chunkStart = audioEvents[0]?.capturedAt ?? rawWindow.startedAt;
    let chunkChars = 0;

    const flushChunk = () => {
      if (chunk.length === 0) {
        return;
      }
      const chunkText = chunk.map((event) => getAudioEventTranscriptText(event)).filter(Boolean).join(" ");
      if (!chunkText.trim()) {
        chunk = [];
        chunkChars = 0;
        return;
      }
      const startedAt = chunk[0]?.capturedAt ?? rawWindow.startedAt;
      const endedAt = chunk[chunk.length - 1]?.capturedAt ?? startedAt;
      const segmentIndex = segments.filter((segment) => segment.windowId === selectedWindow.windowId).length + 1;
      segments.push({
        segmentId: `${selectedWindow.windowId}::topic-${segmentIndex}`,
        windowId: selectedWindow.windowId,
        startedAt,
        endedAt,
        timeRange: `${formatTime(startedAt)}-${formatTime(endedAt)}`,
        title: inferTopicTitle(chunkText),
        summary: summarizeTopicText(chunkText),
        transcriptExcerpt: truncateText(toSingleLine(chunkText), 520),
        keywordHints: extractTopicKeywordHints(chunkText),
        sourceEventIds: chunk.map((event) => event.eventId),
        taskSignals: mergeTaskSignals(
          extractTaskSignalsFromTranscriptSegments(chunk, selectedWindow.windowId, speakerLayer),
          extractTaskSignalsFromText(chunkText),
        ),
      });
      chunk = [];
      chunkChars = 0;
      chunkStart = endedAt;
    };

    for (const event of audioEvents) {
      const text = getAudioEventTranscriptText(event);
      const shouldSplit =
        chunk.length > 0 &&
        (event.capturedAt - chunkStart >= targetSegmentMs || chunkChars + text.length > 1600);
      if (shouldSplit) {
        flushChunk();
        chunkStart = event.capturedAt;
      }
      chunk.push(event);
      chunkChars += text.length;
    }
    flushChunk();
  }

  return segments
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(0, maxSegments);
}

function buildConversationDigest(params: {
  payload: AssistantContextPayload;
  windows: EvidenceBundleWindow[];
  topicSegments: EvidenceTopicSegment[];
  taskAttribution: EvidenceTaskAttribution;
  questionIntent: ReturnType<typeof inferQuestionIntent>;
  question?: string;
}): EvidenceConversationDigest | undefined {
  const transcriptWindows = params.windows.filter((window) => Boolean(window.transcriptExcerpt));
  if (
    params.topicSegments.length === 0 ||
    (!params.questionIntent.conversation && params.payload.scope !== "custom-range" && transcriptWindows.length < 4)
  ) {
    return undefined;
  }
  const orderedTopics = params.topicSegments.slice().sort((left, right) => left.startedAt - right.startedAt);
  const firstTopic = orderedTopics[0];
  const lastTopic = orderedTopics[orderedTopics.length - 1];
  const coverageBits = [
    `覆盖 ${params.windows.length} 个 evidence window`,
    `${transcriptWindows.length} 个含转写窗口`,
    `${orderedTopics.length} 个可追问话题段`,
  ];
  if (firstTopic && lastTopic) {
    coverageBits.push(`范围 ${firstTopic.timeRange} 到 ${lastTopic.timeRange}`);
  }
  const taskBucketCounts = Object.fromEntries(
    Object.entries(params.taskAttribution.buckets).map(([key, value]) => [key, value.length]),
  ) as EvidenceConversationDigest["taskBucketCounts"];
  const topicIndex = orderedTopics.slice(0, 24).map((segment, index) => ({
    index: index + 1,
    segmentId: segment.segmentId,
    windowId: segment.windowId,
    timeRange: segment.timeRange,
    title: segment.title,
    summary: segment.summary,
    keywordHints: segment.keywordHints,
    taskSignalCount: segment.taskSignals.length,
  }));
  const queryMatches = buildConversationDigestQueryMatches(params.question, orderedTopics);
  const taskMatches = buildConversationDigestTaskMatches(params.question, params.taskAttribution);

  return {
    status: "available",
    coverage: {
      windowCount: params.windows.length,
      transcriptWindowCount: transcriptWindows.length,
      topicSegmentCount: orderedTopics.length,
      ...(firstTopic ? { firstTimeRange: firstTopic.timeRange } : {}),
      ...(lastTopic ? { lastTimeRange: lastTopic.timeRange } : {}),
    },
    overview: `${coverageBits.join("，")}。任务桶：你的任务 ${taskBucketCounts.assignedToUser}，他人/团队 ${taskBucketCounts.assignedToOthersOrTeams}，需标注 speaker ${taskBucketCounts.needsSpeakerLabel}，无 owner ${taskBucketCounts.unassignedActions}，只是讨论 ${taskBucketCounts.discussionOnly}。`,
    topicIndex,
    queryMatches,
    taskMatches,
    keywordIndex: buildConversationDigestKeywordIndex(topicIndex),
    taskBucketCounts,
    followupPrompts: orderedTopics.slice(0, 6).map(
      (segment, index) =>
        `第 ${index + 1} 段（${segment.timeRange}，${segment.title}）具体讲了什么？有哪些任务、风险或待确认点？`,
    ),
  };
}

function buildConversationDigestQueryMatches(
  question: string | undefined,
  topics: EvidenceTopicSegment[],
): EvidenceConversationDigest["queryMatches"] {
  const terms = extractConversationDigestQueryTerms(question);
  if (terms.length === 0) {
    return [];
  }
  return topics
    .map((segment, index) => {
      const haystack = [
        segment.title,
        segment.summary,
        segment.transcriptExcerpt,
        ...segment.keywordHints,
        ...segment.taskSignals.map((signal) => `${signal.text} ${signal.assigneeHint ?? ""} ${signal.speakerDisplayName ?? ""}`),
      ].join(" ").toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term.toLowerCase()));
      const taskBoost = /任务|负责|分配|指派|owner|待办|跟进|行动|action/i.test(question ?? "") && segment.taskSignals.length > 0
        ? 2 + segment.taskSignals.length
        : 0;
      const score = matchedTerms.length * 2 + taskBoost;
      return {
        index: index + 1,
        segmentId: segment.segmentId,
        windowId: segment.windowId,
        timeRange: segment.timeRange,
        title: segment.title,
        summary: segment.summary,
        matchedTerms,
        score,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 6);
}

function buildRollingDigestQueryMatches(
  digests: AssistantContextPayload["rollingDigests"] | undefined,
  question: string | undefined,
): EvidenceRollingDigestMatch[] {
  const terms = extractConversationDigestQueryTerms(question);
  const taskQuestion = isTaskOwnershipQuestion(question);
  if ((!digests || digests.length === 0) || (terms.length === 0 && !taskQuestion)) {
    return [];
  }
  return digests
    .flatMap((digest) =>
      digest.topicIndex.map((topic) => {
        const haystack = [
          digest.summary,
          topic.title,
          topic.summary,
          topic.transcriptExcerpt,
          ...topic.keywordHints,
          ...topic.taskHints,
        ].join(" ").toLowerCase();
        const matchedTerms = terms.filter((term) => haystack.includes(term.toLowerCase()));
        const taskBoost = taskQuestion && topic.taskHints.length > 0 ? 2 + topic.taskHints.length : 0;
        const score = matchedTerms.length * 2 + taskBoost;
        return {
          digestId: digest.digestId,
          digestSummary: digest.summary,
          index: topic.index,
          windowId: topic.windowId,
          timeRange: topic.timeRange,
          title: topic.title,
          summary: topic.summary,
          matchedTerms,
          keywordHints: topic.keywordHints,
          taskHints: topic.taskHints,
          score,
        };
      }),
    )
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 8);
}

function buildMemoryCardQueryMatches(
  cards: AssistantContextPayload["memoryCards"] | undefined,
  question: string | undefined,
): EvidenceMemoryCardMatch[] {
  if (!cards || cards.length === 0) {
    return [];
  }
  const terms = extractConversationDigestQueryTerms(question);
  const rawQuestion = question ?? "";
  const taskQuestion = isTaskOwnershipQuestion(question) || /任务|待办|行动项|跟进|分配|落到|负责|todo|action/i.test(rawQuestion);
  const attentionQuestion = /注意|风险|问题|缺口|遗漏|异常|踩坑|隐患|watch|risk|issue/i.test(rawQuestion);
  const learningQuestion = /学习|知识|课堂|重点|笔记|learn|note|study/i.test(rawQuestion);
  const documentQuestion = /沉淀|整理|文档|纪要|报告|草稿|总结|markdown|brief/i.test(rawQuestion);
  const topicQuestion = /发生了什么|聊了什么|讨论|重点|主题|回顾|总结|what happened|summary/i.test(rawQuestion);
  if (
    terms.length === 0 &&
    !taskQuestion &&
    !attentionQuestion &&
    !learningQuestion &&
    !documentQuestion &&
    !topicQuestion
  ) {
    return [];
  }
  return cards
    .map((card) => {
      const haystack = [
        card.kind,
        card.title,
        card.summary,
        ...card.keywords,
        ...card.evidence.taskHints,
        ...card.evidence.transcriptExcerpts,
      ].join(" ").toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term.toLowerCase()));
      const matchReasons: string[] = [];
      let score = 0;
      if (matchedTerms.length > 0) {
        score += matchedTerms.length * 3;
        matchReasons.push("keyword-match");
      }
      if (taskQuestion && card.kind === "task") {
        score += 6;
        matchReasons.push("task-intent");
      }
      if (attentionQuestion && card.kind === "attention") {
        score += 6;
        matchReasons.push("attention-intent");
      }
      if (learningQuestion && card.kind === "learning") {
        score += 6;
        matchReasons.push("learning-intent");
      }
      if (learningQuestion && card.kind === "topic") {
        score += 2;
        matchReasons.push("learning-context");
      }
      if (documentQuestion && (card.kind === "task" || card.kind === "attention" || card.kind === "learning")) {
        score += 3;
        matchReasons.push("document-ready");
      }
      if (documentQuestion && card.kind === "topic") {
        score += 2;
        matchReasons.push("document-context");
      }
      if (topicQuestion && card.kind === "topic") {
        score += 3;
        matchReasons.push("topic-intent");
      }
      if (topicQuestion && card.kind !== "topic" && card.evidence.transcriptExcerpts.length > 0) {
        score += 1;
        matchReasons.push("topic-evidence");
      }
      if (card.confidence === "medium") {
        score += 1;
        matchReasons.push("confidence-medium");
      }
      if (card.evidence.taskHints.length > 0) {
        score += Math.min(2, card.evidence.taskHints.length);
        matchReasons.push("task-evidence");
      }
      if (card.evidence.transcriptExcerpts.length > 0) {
        score += 1;
        matchReasons.push("transcript-evidence");
      }
      if (card.evidence.timeRanges.length > 0) {
        score += 1;
        matchReasons.push("time-evidence");
      }
      return {
        ...card,
        matchedTerms,
        matchReasons: Array.from(new Set(matchReasons)),
        retrievalRank: 0,
        score,
      };
    })
    .filter((card) => card.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        memoryCardIntentPriority(right.kind, { taskQuestion, attentionQuestion, learningQuestion, documentQuestion, topicQuestion }) -
          memoryCardIntentPriority(left.kind, { taskQuestion, attentionQuestion, learningQuestion, documentQuestion, topicQuestion }) ||
        right.lastSeenAt - left.lastSeenAt,
    )
    .slice(0, 10)
    .map((card, index) => ({
      ...card,
      retrievalRank: index + 1,
    }));
}

function memoryCardIntentPriority(
  kind: AssistantContextPayload["memoryCards"][number]["kind"],
  intent: {
    taskQuestion: boolean;
    attentionQuestion: boolean;
    learningQuestion: boolean;
    documentQuestion: boolean;
    topicQuestion: boolean;
  },
): number {
  if (intent.taskQuestion && kind === "task") return 50;
  if (intent.attentionQuestion && kind === "attention") return 50;
  if (intent.learningQuestion && kind === "learning") return 50;
  if (intent.topicQuestion && kind === "topic") return 40;
  if (intent.documentQuestion) {
    if (kind === "task") return 35;
    if (kind === "attention") return 30;
    if (kind === "learning") return 25;
    if (kind === "topic") return 20;
  }
  if (kind === "task") return 15;
  if (kind === "attention") return 12;
  if (kind === "learning") return 10;
  return 5;
}

function buildConversationDigestTaskMatches(
  question: string | undefined,
  taskAttribution: EvidenceTaskAttribution,
): EvidenceConversationDigest["taskMatches"] {
  const terms = extractConversationDigestQueryTerms(question);
  const taskQuestion = isTaskOwnershipQuestion(question);
  if (!taskQuestion && terms.length === 0) {
    return [];
  }
  return taskAttribution.candidates
    .filter((candidate) => candidate.category !== "discussion-only")
    .map((candidate) => {
      const resolutionPrompt = findSpeakerResolutionPromptForCandidate(candidate, taskAttribution.speakerResolutionPrompts);
      const haystack = [
        candidate.text,
        candidate.assigneeHint,
        candidate.speakerLabel,
        candidate.speakerDisplayName,
        candidate.speakerRelationship,
        candidate.reason,
        formatUserAssignmentStatus(candidate.userAssignmentStatus),
      ].filter(Boolean).join(" ").toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term.toLowerCase()));
      const statusBoost = scoreTaskMatchForQuestion(candidate, question);
      const score = matchedTerms.length * 2 + statusBoost + (taskQuestion ? 2 : 0);
      return {
        signalId: candidate.signalId,
        timeRange: candidate.timeRange,
        text: candidate.text,
        category: candidate.category,
        userAssignmentStatus: candidate.userAssignmentStatus,
        assigneeHint: candidate.assigneeHint,
        speakerLabel: candidate.speakerLabel,
        speakerRef: candidate.speakerRef,
        speakerDisplayName: candidate.speakerDisplayName,
        speakerRelationship: candidate.speakerRelationship,
        ...(resolutionPrompt
          ? {
              resolutionMode: resolutionPrompt.resolutionMode,
              requiresDiarization: resolutionPrompt.requiresDiarization,
              speakerResolutionPrompt: resolutionPrompt.prompt,
              selfSentenceTemplate: resolutionPrompt.selfSentenceTemplate,
              ...(resolutionPrompt.selfCommandTemplate ? { selfCommandTemplate: resolutionPrompt.selfCommandTemplate } : {}),
            }
          : {}),
        matchedTerms,
        score,
        reason: candidate.reason,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.timeRange.localeCompare(right.timeRange))
    .slice(0, 8);
}

function findSpeakerResolutionPromptForCandidate(
  candidate: EvidenceTaskCandidate,
  prompts: EvidenceTaskAttribution["speakerResolutionPrompts"],
): EvidenceTaskAttribution["speakerResolutionPrompts"][number] | undefined {
  if (candidate.userAssignmentStatus !== "needs-speaker-label") {
    return undefined;
  }
  const candidateWindowId = parseWindowIdFromTaskSignalId(candidate.signalId);
  return prompts.find((prompt) => {
    if (candidate.speakerRef && prompt.speakerRef === candidate.speakerRef) {
      return true;
    }
    if (candidate.speakerLabel && prompt.speakerLabel === candidate.speakerLabel) {
      return !candidateWindowId || !prompt.windowId || prompt.windowId === candidateWindowId;
    }
    if (candidateWindowId && prompt.windowId === candidateWindowId) {
      return true;
    }
    return prompt.sampleTasks.some((sample) => sample.includes(candidate.text) || candidate.text.includes(sample.replace(/^\d{2}:\d{2}-\d{2}:\d{2}\s+/u, "")));
  });
}

function isTaskOwnershipQuestion(question: string | undefined): boolean {
  const text = toSingleLine(question ?? "").toLowerCase();
  return /任务|行动项|待办|负责|分配|指派|落到|给我|我的|别人|他人|owner|action|todo|follow/i.test(text);
}

function scoreTaskMatchForQuestion(
  candidate: EvidenceTaskCandidate,
  question: string | undefined,
): number {
  const text = toSingleLine(question ?? "");
  const asksMine = /我的|给我|落到我|分配给我|我.*任务|我.*负责|我身上/u.test(text);
  const asksOthers = /别人|他人|团队|不是我|没落到|没有落到|只是.*提到/u.test(text);
  switch (candidate.userAssignmentStatus) {
    case "assigned-to-user":
      return asksMine ? 7 : 4;
    case "needs-speaker-label":
      return asksMine || asksOthers ? 6 : 3;
    case "assigned-to-known-speaker":
    case "not-user-unless-role-matches":
      return asksOthers ? 5 : 2;
    case "unknown-owner":
      return 2;
    case "not-an-assignment":
      return asksOthers ? 1 : 0;
  }
}

function extractConversationDigestQueryTerms(question: string | undefined): string[] {
  const text = toSingleLine(question ?? "").trim();
  if (!text) {
    return [];
  }
  const normalized = text.toLowerCase();
  const domainTerms = [
    "数据",
    "数仓",
    "阿里云",
    "api",
    "接口",
    "安全",
    "ai陪练",
    "陪练",
    "剧本",
    "语料",
    "对练",
    "考核",
    "考试",
    "报表",
    "培训",
    "海南",
    "上海",
    "物流",
    "工单",
    "售后",
    "视频",
    "图片",
    "方案",
    "排期",
    "产品团队",
    "7月30",
    "任务",
    "行动项",
    "负责",
    "分配",
    "指派",
    "跟进",
    "风险",
    "缺口",
    "amy",
    "小郭",
    "三爷",
    "文文",
    "张帆",
  ];
  const explicitTerms = domainTerms.filter((term) => normalized.includes(term.toLowerCase()));
  const asciiTerms = Array.from(normalized.matchAll(/[a-z][a-z0-9_-]{1,24}/g)).map((match) => match[0]);
  const chineseTerms = Array.from(text.matchAll(/[\u4e00-\u9fff]{2,8}/g))
    .map((match) => match[0])
    .filter((term) => !looksGenericDigestQueryTerm(term));
  return uniqueItems(explicitTerms.concat(asciiTerms, chineseTerms)).slice(0, 12);
}

function looksGenericDigestQueryTerm(term: string): boolean {
  return /^(过去|刚才|昨天|今天|发生|什么|哪些|怎么|如何|会议|讨论|聊天|沟通|重点|内容|里面|其中|明确|只是|别人|提到|落到|身上|给我|我们|他们|这个|那个|一下|请问)$/u.test(term);
}

function buildConversationDigestKeywordIndex(
  topicIndex: EvidenceConversationDigest["topicIndex"],
): EvidenceConversationDigest["keywordIndex"] {
  const byKeyword = new Map<string, number[]>();
  for (const topic of topicIndex) {
    for (const keyword of topic.keywordHints.slice(0, 6)) {
      const indexes = byKeyword.get(keyword) ?? [];
      indexes.push(topic.index);
      byKeyword.set(keyword, indexes);
    }
  }
  return Array.from(byKeyword.entries())
    .map(([keyword, topicIndexes]) => ({ keyword, topicIndexes: topicIndexes.slice(0, 8) }))
    .sort((left, right) => right.topicIndexes.length - left.topicIndexes.length || left.keyword.localeCompare(right.keyword))
    .slice(0, 12);
}

function getAudioEventTranscriptText(event: {
  transcript?: string;
  transcriptSegments?: Array<{ text?: string }>;
  speakerTimelineSegments?: Array<{ text?: string }>;
}): string {
  const transcript = toSingleLine(event.transcript ?? "").trim();
  if (transcript) {
    return transcript;
  }
  const transcriptSegmentText = (event.transcriptSegments ?? [])
    .map((segment) => toSingleLine(segment.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (transcriptSegmentText) {
    return transcriptSegmentText;
  }
  return (event.speakerTimelineSegments ?? [])
    .map((segment) => toSingleLine(segment.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildTaskAttribution(
  topicSegments: EvidenceTopicSegment[],
  practicalOutputs: EvidenceBundle["practicalOutputs"],
  speakerLayer: EvidenceBundle["speakerLayer"],
): EvidenceTaskAttribution {
  const candidates: EvidenceTaskCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: EvidenceTaskCandidate) => {
    const key = `${candidate.category}:${candidate.timeRange}:${candidate.text}`;
    if (seen.has(key)) {
      return;
    }
    const normalizedText = normalizeTaskTextForDedup(candidate.text);
    if (normalizedText && candidate.category !== "discussion-only") {
      const existingIndex = candidates.findIndex(
        (existing) =>
          existing.category !== "discussion-only" &&
          (hasSpeakerAttributionEvidence(existing) || hasSpeakerAttributionEvidence(candidate)) &&
          areOverlappingTaskTexts(normalizeTaskTextForDedup(existing.text), normalizedText),
      );
      if (existingIndex >= 0) {
        const existing = candidates[existingIndex]!;
        if (scoreTaskAttributionCandidate(existing) >= scoreTaskAttributionCandidate(candidate)) {
          return;
        }
        seen.delete(`${existing.category}:${existing.timeRange}:${existing.text}`);
        candidates.splice(existingIndex, 1);
      }
    }
    seen.add(key);
    candidates.push(candidate);
  };

  for (const segment of topicSegments) {
    for (const [signalIndex, signal] of segment.taskSignals.entries()) {
      const category = signal.attribution;
      const userAssignmentStatus = resolveUserAssignmentStatus({
        category,
        signal,
      });
      pushCandidate({
        signalId: `${segment.segmentId}::task-${signalIndex + 1}`,
        category,
        timeRange: segment.timeRange,
        text: signal.text,
        assigneeHint: signal.assigneeHint,
        speakerLabel: signal.speakerLabel,
        speakerRef: signal.speakerRef,
        speakerDisplayName: signal.speakerDisplayName,
        speakerRelationship: signal.speakerRelationship,
        userAssignmentStatus,
        confidence:
          category === "named-assignee" || userAssignmentStatus === "assigned-to-user" || userAssignmentStatus === "assigned-to-known-speaker"
            ? "medium"
            : "low",
        reason: signal.reason,
      });
    }
  }

  for (const task of practicalOutputs.tasks.slice(0, 4)) {
    const signal = classifyTaskAttribution(task);
    const taskText = stripLeadingTimeRange(task);
    const hasRicherSpeakerCandidate = candidates.some(
      (candidate) =>
        Boolean(candidate.speakerLabel || candidate.speakerDisplayName) &&
        areOverlappingTaskTexts(normalizeTaskTextForDedup(candidate.text), normalizeTaskTextForDedup(taskText)),
    );
    if (hasRicherSpeakerCandidate) {
      continue;
    }
    pushCandidate({
      signalId: `practical-task-${candidates.length + 1}`,
      category: signal?.attribution ?? "unassigned-action",
      timeRange: extractLeadingTimeRange(task) ?? "日级回顾",
      text: taskText,
      assigneeHint: signal?.assigneeHint,
      userAssignmentStatus:
        signal?.attribution === "named-assignee"
          ? "not-user-unless-role-matches"
          : signal?.attribution === "speaker-dependent"
            ? "needs-speaker-label"
            : "unknown-owner",
      confidence: "low",
      reason: signal?.reason ?? "来自日级任务候选，但缺少明确 owner。",
    });
  }

  for (const segment of topicSegments.filter((segment) => segment.taskSignals.length === 0).slice(0, 3)) {
    pushCandidate({
      signalId: `${segment.segmentId}::discussion`,
      category: "discussion-only",
      timeRange: segment.timeRange,
      text: `${segment.title}：${segment.summary}`,
      userAssignmentStatus: "not-an-assignment",
      confidence: "low",
      reason: "这是可回顾话题段，但没有明确行动指派语气。",
    });
  }

  const actionableCandidates = candidates.filter((candidate) => candidate.category !== "discussion-only");
  const hasUnresolvedSpeakerDependent = actionableCandidates.some(
    (candidate) => candidate.category === "speaker-dependent" && !candidate.speakerDisplayName,
  );
  const status =
    actionableCandidates.length === 0
      ? "no-task-signals"
      : hasUnresolvedSpeakerDependent
        ? "needs-speaker-labels"
        : "ready";
  const note =
    status === "ready"
      ? "当前任务候选已有较明确指向；已标注 speaker 的代词任务不会默认落到用户本人，仍需按原文复核。"
      : status === "needs-speaker-labels"
        ? "当前存在任务信号，但 speaker_1 / speaker_2 尚未完整标注，不能断言哪些任务落到用户本人。"
        : "当前证据中没有稳定行动项，只能按讨论主题回顾。";
  const limitedCandidates = candidates.slice(0, 12);
  const buckets = buildTaskAttributionBuckets(limitedCandidates);

  return {
    status,
    note,
    candidates: limitedCandidates,
    buckets,
    speakerResolutionPrompts: buildSpeakerResolutionPrompts(buckets.needsSpeakerLabel, speakerLayer),
  };
}

function buildTaskAttributionBuckets(candidates: EvidenceTaskCandidate[]): EvidenceTaskAttribution["buckets"] {
  return {
    assignedToUser: candidates.filter((candidate) => candidate.userAssignmentStatus === "assigned-to-user"),
    assignedToOthersOrTeams: candidates.filter((candidate) =>
      candidate.userAssignmentStatus === "assigned-to-known-speaker" ||
      candidate.userAssignmentStatus === "not-user-unless-role-matches"
    ),
    needsSpeakerLabel: candidates.filter((candidate) => candidate.userAssignmentStatus === "needs-speaker-label"),
    unassignedActions: candidates.filter((candidate) => candidate.userAssignmentStatus === "unknown-owner"),
    discussionOnly: candidates.filter((candidate) => candidate.userAssignmentStatus === "not-an-assignment"),
  };
}

function buildTaskAttributionBucketLines(buckets: EvidenceTaskAttribution["buckets"]): string[] {
  const groups: Array<[string, EvidenceTaskCandidate[]]> = [
    ["明确分配给你的任务", buckets.assignedToUser],
    ["明确指向他人/团队，不能默认算你的任务", buckets.assignedToOthersOrTeams],
    ["需要先标注 speaker 才能判断是否落到你", buckets.needsSpeakerLabel],
    ["无明确 owner 的行动项", buckets.unassignedActions],
    ["只是讨论主题，不是任务分配", buckets.discussionOnly],
  ];
  return groups.flatMap(([label, items]) => {
    if (items.length === 0) {
      return [];
    }
    return [
      `- ${label}：${items
        .slice(0, 3)
        .map((item) => `${item.timeRange} ${item.text}`)
        .join("；")}`,
    ];
  });
}

function buildSpeakerResolutionPrompts(
  candidates: EvidenceTaskCandidate[],
  speakerLayer: EvidenceBundle["speakerLayer"],
): EvidenceTaskAttribution["speakerResolutionPrompts"] {
  const groups = new Map<string, EvidenceTaskCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.speakerRef ?? candidate.speakerLabel ?? `unknown:${candidate.timeRange}`;
    groups.set(key, (groups.get(key) ?? []).concat(candidate));
  }
  return Array.from(groups.entries())
    .map(([key, items]) => {
      const first = items[0]!;
      const speakerRef = first.speakerRef;
      const slot =
        speakerRef
          ? speakerLayer.suggestedSlots.find((item) => item.speakerRef === speakerRef)
          : speakerLayer.suggestedSlots.find((item) => item.slotLabel === first.speakerLabel);
      const windowId = slot?.windowId ?? parseWindowIdFromTaskSignalId(first.signalId);
      const candidateSpeakerSlots = buildCandidateSpeakerSlotActions({
        speakerLayer,
        speakerRef,
        speakerLabel: first.speakerLabel,
        windowId,
      });
      const speakerLabel = first.speakerLabel ?? slot?.slotLabel ?? (candidateSpeakerSlots.length > 0 ? "窗口级未确认说话人" : "未确认说话人");
      const timeRange = slot?.timeRange ?? first.timeRange;
      const sampleTasks = uniqueItems(items.map((item) => `${item.timeRange} ${item.text}`)).slice(0, 3);
      const labelForSentence = speakerLabel === "未确认说话人" ? `这个说话人（${timeRange}）` : `${speakerLabel}（${timeRange}）`;
      const resolutionMode: EvidenceTaskAttribution["speakerResolutionPrompts"][number]["resolutionMode"] =
        speakerRef || first.speakerLabel ? "exact-speaker-label" : "window-context-only";
      const requiresDiarization = resolutionMode === "window-context-only";
      const selfSentenceTemplate =
        requiresDiarization && candidateSpeakerSlots[0]?.selfSentenceTemplate
          ? candidateSpeakerSlots[0].selfSentenceTemplate
          : `${labelForSentence}是我本人。`;
      const sentenceTemplate =
        requiresDiarization && candidateSpeakerSlots[0]?.sentenceTemplate
          ? candidateSpeakerSlots[0].sentenceTemplate
          : `${labelForSentence}是我的同事李三。`;
      return {
        speakerLabel,
        ...(speakerRef ? { speakerRef } : {}),
        ...(windowId ? { windowId } : {}),
        timeRange,
        resolutionMode,
        requiresDiarization,
        taskCount: items.length,
        sampleTasks,
        reason: requiresDiarization
          ? `这 ${items.length} 条任务候选依赖“我/你/我们/你们”等代词，但当前缺少句级 speaker；需先补 diarization 或至少标注同窗口 speaker 槽位作为人物线索。`
          : `${speakerLabel} 相关的 ${items.length} 条任务候选依赖“我/你/我们/你们”等代词，必须先确认说话人身份。`,
        prompt: requiresDiarization
          ? `要判断这些任务是否分配给你，当前还缺句级 speaker；可以先标注同窗口的 speaker_1 / speaker_2，例如：“${selfSentenceTemplate}”；之后补 diarization 才能精确归属。`
          : `要判断这些任务是否分配给你，先确认 ${speakerLabel} 是谁；如果是你本人，可以说：“${selfSentenceTemplate}”`,
        selfSentenceTemplate,
        sentenceTemplate,
        ...(speakerRef && windowId
          ? {
              selfCommandTemplate: `openclaw clawsense annotate-speaker ${shellDoubleQuote(speakerRef)} ${shellDoubleQuote("我")} --relationship ${shellDoubleQuote("本人")} --windowId ${shellDoubleQuote(windowId)}`,
              commandTemplate: `openclaw clawsense annotate-speaker ${shellDoubleQuote(speakerRef)} ${shellDoubleQuote("李三")} --relationship ${shellDoubleQuote("同事")} --windowId ${shellDoubleQuote(windowId)}`,
            }
          : {}),
        candidateSpeakerSlots,
      };
    })
    .sort((left, right) => right.taskCount - left.taskCount || left.speakerLabel.localeCompare(right.speakerLabel))
    .slice(0, 4);
}

function buildCandidateSpeakerSlotActions(params: {
  speakerLayer: EvidenceBundle["speakerLayer"];
  speakerRef?: string;
  speakerLabel?: string;
  windowId?: string;
}): EvidenceTaskAttribution["speakerResolutionPrompts"][number]["candidateSpeakerSlots"] {
  const slots = params.speakerLayer.suggestedSlots.filter((slot) => {
    if (params.speakerRef) {
      return slot.speakerRef === params.speakerRef;
    }
    if (params.speakerLabel) {
      return slot.slotLabel === params.speakerLabel;
    }
    return params.windowId ? slot.windowId === params.windowId : false;
  });
  return slots.slice(0, 4).map((slot) => ({
    speakerRef: slot.speakerRef,
    slotLabel: slot.slotLabel,
    windowId: slot.windowId,
    timeRange: slot.timeRange,
    ...(slot.displayName ? { displayName: slot.displayName } : {}),
    ...(slot.relationship ? { relationship: slot.relationship } : {}),
    selfSentenceTemplate: `${slot.slotLabel}（${slot.timeRange}）是我本人。`,
    sentenceTemplate: `${slot.slotLabel}（${slot.timeRange}）是我的同事李三。`,
    selfCommandTemplate: `openclaw clawsense annotate-speaker ${shellDoubleQuote(slot.speakerRef)} ${shellDoubleQuote("我")} --relationship ${shellDoubleQuote("本人")} --windowId ${shellDoubleQuote(slot.windowId)}`,
    commandTemplate: `openclaw clawsense annotate-speaker ${shellDoubleQuote(slot.speakerRef)} ${shellDoubleQuote("李三")} --relationship ${shellDoubleQuote("同事")} --windowId ${shellDoubleQuote(slot.windowId)}`,
  }));
}

function parseWindowIdFromTaskSignalId(signalId: string): string | undefined {
  const separatorIndex = signalId.indexOf("::task-");
  if (separatorIndex <= 0) {
    return undefined;
  }
  const segmentId = signalId.slice(0, separatorIndex);
  const topicIndex = segmentId.lastIndexOf("::topic-");
  return topicIndex > 0 ? segmentId.slice(0, topicIndex) : undefined;
}

function extractLeadingTimeRange(text: string): string | undefined {
  return /^(\d{2}:\d{2}-\d{2}:\d{2})：/.exec(text.trim())?.[1];
}

function stripLeadingTimeRange(text: string): string {
  return text.trim().replace(/^\d{2}:\d{2}-\d{2}:\d{2}：/, "").trim();
}

function normalizeTaskTextForDedup(text: string): string {
  return toSingleLine(stripSectionPrefix(text))
    .replace(/[。！？!?；;，,\s]+/gu, "")
    .toLowerCase();
}

function areOverlappingTaskTexts(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 8 && longer.includes(shorter);
}

function hasSpeakerAttributionEvidence(candidate: EvidenceTaskAttribution["candidates"][number]): boolean {
  return Boolean(candidate.speakerLabel || candidate.speakerRef || candidate.speakerDisplayName);
}

function scoreTaskAttributionCandidate(candidate: EvidenceTaskAttribution["candidates"][number]): number {
  let score = 0;
  if (candidate.speakerDisplayName) {
    score += 8;
  }
  if (candidate.speakerLabel) {
    score += 4;
  }
  if (candidate.assigneeHint) {
    score += 3;
  }
  if (candidate.category === "named-assignee") {
    score += 3;
  }
  if (candidate.category === "speaker-dependent") {
    score += 2;
  }
  if (candidate.confidence === "medium") {
    score += 1;
  }
  return score;
}

function resolveUserAssignmentStatus(params: {
  category: EvidenceTaskAttribution["candidates"][number]["category"];
  signal: EvidenceTopicSegment["taskSignals"][number];
}): EvidenceTaskAttribution["candidates"][number]["userAssignmentStatus"] {
  if (params.category === "named-assignee") {
    return "not-user-unless-role-matches";
  }
  if (params.category === "speaker-dependent") {
    if (!params.signal.speakerDisplayName) {
      return "needs-speaker-label";
    }
    return looksLikeUserSpeakerIdentity(params.signal.speakerDisplayName, params.signal.speakerRelationship)
      ? "assigned-to-user"
      : "assigned-to-known-speaker";
  }
  if (params.category === "discussion-only") {
    return "not-an-assignment";
  }
  return "unknown-owner";
}

function looksLikeUserSpeakerIdentity(displayName: string, relationship?: string): boolean {
  const values = [displayName, relationship]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return values.some((value) => /^(我|本人|用户|自己|本人自己|机主|owner|me|user|self)$/iu.test(value));
}

function summarizeTopicText(text: string): string {
  const clauses = splitTopicClauses(text);
  if (clauses.length === 0) {
    return truncateText(toSingleLine(text), 180);
  }
  return truncateText(clauses.slice(0, 2).join("；"), 220);
}

function splitTopicClauses(text: string): string[] {
  return toSingleLine(stripSectionPrefix(text))
    .split(/[。！？!?；;]\s*|(?<=，)(?=(?:然后|接着|另外|还有|但是|所以|因为|关于|这个|那个|我们|你们|产品|数据|剧本|考核|培训|报表|任务|风险|需要|先|再))/u)
    .map((item) => item.trim().replace(/[，,；;]+$/u, "").trim())
    .filter((item) => item.length >= 6 && !looksLowSignalClause(item))
    .slice(0, 8);
}

function extractTaskSignalsFromText(text: string): EvidenceTopicSegment["taskSignals"] {
  return uniqueItems(splitTaskClauses(text))
    .map((clause) => classifyTaskAttribution(clause))
    .filter((signal): signal is EvidenceTopicSegment["taskSignals"][number] => Boolean(signal))
    .slice(0, 4);
}

function extractTaskSignalsFromTranscriptSegments(
  audioEvents: Array<{
    eventId: string;
    transcriptSegments?: Array<{
      text: string;
      speakerLabel?: string;
    }>;
    speakerTimelineSegments?: Array<{
      text: string;
      speakerLabel?: string;
    }>;
  }>,
  windowId: string,
  speakerLayer: EvidenceBundle["speakerLayer"],
): EvidenceTopicSegment["taskSignals"] {
  const signals: EvidenceTopicSegment["taskSignals"] = [];
  for (const event of audioEvents) {
    const segments = [
      ...(event.speakerTimelineSegments ?? []),
      ...(event.transcriptSegments ?? []),
    ];
    for (const segment of segments) {
      const signal = classifyTaskAttribution(segment.text);
      if (!signal) {
        continue;
      }
      const speakerLabel = normalizeSpeakerLabel(segment.speakerLabel);
      if (!speakerLabel) {
        signals.push(signal);
        continue;
      }
      const speakerRef = resolveSpeakerRefFromLabel(windowId, speakerLabel);
      const speakerSlot = resolveSpeakerSlot(speakerLayer, windowId, speakerLabel, speakerRef);
      const speakerDisplayName =
        speakerSlot?.displayName && !looksPendingIdentityLabel(speakerSlot.displayName)
          ? speakerSlot.displayName
          : undefined;
      const speakerRelationship =
        speakerSlot?.relationship && !looksPendingIdentityLabel(speakerSlot.relationship)
          ? speakerSlot.relationship
          : undefined;
      signals.push({
        ...signal,
        speakerLabel,
        ...(speakerRef ? { speakerRef } : {}),
        ...(speakerDisplayName ? { speakerDisplayName } : {}),
        ...(speakerRelationship ? { speakerRelationship } : {}),
        reason: speakerDisplayName
          ? `${signal.reason} 句级转写显示这句话由 ${speakerDisplayName}${speakerRelationship ? `（${speakerRelationship}，${speakerLabel}）` : `（${speakerLabel}）`}说出。`
          : `${signal.reason} 句级转写显示这句话由 ${speakerLabel} 说出，但该 speaker 尚未标注身份。`,
      });
    }
  }
  return mergeTaskSignals(signals);
}

function mergeTaskSignals(
  ...groups: EvidenceTopicSegment["taskSignals"][]
): EvidenceTopicSegment["taskSignals"] {
  const merged: EvidenceTopicSegment["taskSignals"] = [];
  const seen = new Set<string>();
  for (const signal of groups.flat()) {
    const normalizedText = normalizeTaskTextForDedup(signal.text);
    const key = `${normalizedText}:${signal.speakerLabel ?? ""}:${signal.assigneeHint ?? ""}`;
    const genericKey = `${normalizedText}::${signal.assigneeHint ?? ""}`;
    if (seen.has(key) || (!signal.speakerLabel && seen.has(genericKey))) {
      continue;
    }
    if (signal.speakerLabel) {
      seen.add(genericKey);
    }
    seen.add(key);
    merged.push(signal);
  }
  return merged.slice(0, 4);
}

function normalizeSpeakerLabel(value: string | undefined): string | undefined {
  const normalized = toSingleLine(value ?? "").trim();
  return normalized || undefined;
}

function resolveSpeakerRefFromLabel(windowId: string, speakerLabel: string | undefined): string | undefined {
  const normalized = normalizeSpeakerLabel(speakerLabel);
  if (!normalized) {
    return undefined;
  }
  const indexed = /^speaker[_\s-]*(\d+)$/i.exec(normalized);
  return indexed?.[1] ? `speaker:${windowId}:${indexed[1]}` : undefined;
}

function resolveSpeakerSlot(
  speakerLayer: EvidenceBundle["speakerLayer"],
  windowId: string,
  speakerLabel?: string,
  speakerRef?: string,
): EvidenceBundle["speakerLayer"]["suggestedSlots"][number] | undefined {
  return speakerLayer.suggestedSlots.find(
    (slot) =>
      slot.windowId === windowId &&
      ((speakerRef && slot.speakerRef === speakerRef) ||
        (speakerLabel && slot.slotLabel.toLowerCase() === speakerLabel.toLowerCase())),
  );
}

function splitTaskClauses(text: string): string[] {
  return toSingleLine(stripSectionPrefix(text))
    .split(/[。！？!?；;]\s*|(?<=，)(?=(?:你|你们|我|我们|大家|产品|数仓|运维|售前|售后|运营|小郭|三爷|文文|张帆|海南|上海|需要|要|先|再|记得|确认|提供|安排|负责|同步|开发|验证|整理|提交|跟进))/u)
    .map((item) => item.trim().replace(/[，,；;]+$/u, "").trim())
    .filter((item) => item.length >= 5 && !looksLowSignalClause(item))
    .slice(0, 16);
}

function classifyTaskAttribution(text: string): EvidenceTopicSegment["taskSignals"][number] | undefined {
  const normalized = stripSectionPrefix(text).trim();
  if (!normalized) {
    return undefined;
  }
  const actionable = looksTaskLike(normalized) || looksActionCue(normalized) || (looksDeadlineCue(normalized) && hasConcreteActionVerb(normalized));
  if (!actionable) {
    return undefined;
  }
  const assigneeHint = extractAssigneeHint(normalized);
  if (assigneeHint && !isPronounAssigneeHint(assigneeHint)) {
    return {
      text: truncateText(normalized, 180),
      attribution: "named-assignee",
      assigneeHint,
      reason: "句子里出现了明确团队/人名/角色指向；除非用户本人就是该角色，否则不能归为用户任务。",
    };
  }
  if (assigneeHint && isPronounAssigneeHint(assigneeHint)) {
    return {
      text: truncateText(normalized, 180),
      attribution: "speaker-dependent",
      assigneeHint,
      reason: "句子依赖“我/你/我们/你们”等代词，必须先知道 speaker 身份才能判断任务归属。",
    };
  }
  return {
    text: truncateText(normalized, 180),
    attribution: "unassigned-action",
    reason: "句子有行动/截止/确认语气，但没有明确 owner。",
  };
}

function extractAssigneeHint(text: string): string | undefined {
  const normalized = text.trim();
  const leadingPronoun = /^(?:然后|那|这个|那个)?\s*(你们|你|我们|咱们|大家|我|他|她|他们|她们)(?:这边|那边)?(?:要|需要|负责|确认|提供|同步|安排|开发|验证|整理|提交|跟进|问一下|看一下|发一下|补一下|先|再)?/u.exec(normalized);
  if (leadingPronoun?.[1]) {
    return leadingPronoun[1];
  }
  const namedHints = [
    "产品团队",
    "数仓同事",
    "数仓",
    "运维",
    "售前",
    "售后",
    "运营",
    "产品",
    "海南物流",
    "上海物流",
    "小郭",
    "三爷",
    "文文",
    "张帆",
    "客户",
    "老师",
    "同事",
    "老板",
  ];
  const named = namedHints.find((hint) => normalized.includes(hint));
  if (named) {
    return named;
  }
  const pronoun = /(你们|你|我们|咱们|大家|我|他|她|他们|她们)(?:这边|那边)?(?:要|需要|负责|确认|提供|同步|安排|开发|验证|整理|提交|跟进|问一下|看一下|发一下|补一下)?/u.exec(normalized);
  if (pronoun?.[1]) {
    return pronoun[1];
  }
  const personLike = /(?:^|[，,。\s])([\u4e00-\u9fff]{2,4}(?:老师|经理|总|同学)?|[A-Z][a-zA-Z]{1,20})(?:这边|那边)?(?:要|需要|负责|确认|提供|同步|安排|开发|验证|整理|提交|跟进)/u.exec(normalized);
  if (
    personLike?.[1] &&
    !NON_PERSON_IDENTITY_CANDIDATES.has(personLike[1]) &&
    !looksGenericAssigneeHint(personLike[1])
  ) {
    return personLike[1];
  }
  return undefined;
}

function isPronounAssigneeHint(value: string): boolean {
  return /^(我|你|你们|我们|咱们|大家|他|她|他们|她们)$/.test(value.trim());
}

function looksGenericAssigneeHint(value: string): boolean {
  return /^(这种|这个|那个|这些|那些|就是|这是|那是|里面|上面|下面|前面|后面)/u.test(value.trim());
}

function inferTopicTitle(text: string): string {
  const normalized = text.toLowerCase();
  const leading = normalized.slice(0, 360);
  const candidates: Array<{ title: string; keywords: string[] }> = [
    { title: "数据来源、接口与安全", keywords: ["数据", "数仓", "中台", "阿里云", "api", "接口", "跨域", "安全"] },
    { title: "剧本生成与语料导入", keywords: ["自动生成剧本", "文本文档", "聊天记录", "语料", "会话明细", "通话内容", "导出来"] },
    { title: "智能体配置与知识点维护", keywords: ["智能体", "知识点", "覆盖", "重新添加", "训练", "文档", "后台"] },
    { title: "对练方式与任务指派", keywords: ["纯文本对练", "语音", "电话对练", "视频对练", "指派", "学员", "陪练任务", "池子"] },
    { title: "报告视角与考核证据", keywords: ["报告", "管理视角", "陪练师", "训练师", "对话记录", "考核点", "通过率", "缺陷"] },
    { title: "真实客服场景扩展", keywords: ["无效会话", "客服真实", "真实的场景", "语料", "清洗", "范围", "售后"] },
    { title: "AI 陪练总体演示", keywords: ["ai陪练", "陪练", "剧本", "对练", "电话"] },
    { title: "考核、考试与报表", keywords: ["考核", "考试", "练习", "通过率", "缺陷", "报表", "自动结束"] },
    { title: "培训与物流业务安排", keywords: ["培训", "海南", "上海", "物流", "工单", "采购"] },
    { title: "多模态与售后场景", keywords: ["图片", "视频", "卡片", "售后", "看图", "截图"] },
    { title: "产品方案与排期", keywords: ["方案", "排期", "7月30", "规划", "产品团队", "同步"] },
  ];
  const winner = candidates
    .map((candidate) => ({
      ...candidate,
      score: candidate.keywords.reduce((score, keyword) => {
        const normalizedKeyword = keyword.toLowerCase();
        if (!normalized.includes(normalizedKeyword)) {
          return score;
        }
        return score + (leading.includes(normalizedKeyword) ? 3 : 1);
      }, 0),
    }))
    .sort((left, right) => right.score - left.score)[0];
  return winner && winner.score > 0 ? winner.title : "对话片段";
}

function extractTopicKeywordHints(text: string): string[] {
  const keywords = [
    "数据",
    "数仓",
    "阿里云",
    "API",
    "安全",
    "AI陪练",
    "剧本",
    "语料",
    "对练",
    "考核",
    "考试",
    "报表",
    "培训",
    "海南物流",
    "上海物流",
    "售后",
    "视频",
    "图片",
    "7月30",
  ];
  const normalized = text.toLowerCase();
  return keywords.filter((keyword) => normalized.includes(keyword.toLowerCase())).slice(0, 6);
}

function formatTaskAttributionCategory(category: EvidenceTaskAttribution["candidates"][number]["category"]): string {
  switch (category) {
    case "named-assignee":
      return "明确指向人/团队";
    case "speaker-dependent":
      return "依赖 speaker 标注";
    case "unassigned-action":
      return "无明确 owner 行动项";
    case "discussion-only":
      return "只是讨论主题";
  }
}

function formatTaskCandidateSpeaker(candidate: {
  speakerDisplayName?: string;
  speakerLabel?: string;
  speakerRelationship?: string;
}): string {
  if (!candidate.speakerDisplayName && !candidate.speakerLabel) {
    return "";
  }
  if (!candidate.speakerDisplayName) {
    return ` | 说话人：${candidate.speakerLabel}`;
  }
  const suffix = [candidate.speakerRelationship, candidate.speakerLabel].filter(Boolean).join("，");
  return ` | 说话人：${candidate.speakerDisplayName}${suffix ? `（${suffix}）` : ""}`;
}

function formatMemoryCardKind(kind: AssistantContextPayload["memoryCards"][number]["kind"]): string {
  switch (kind) {
    case "task":
      return "任务卡";
    case "attention":
      return "注意卡";
    case "learning":
      return "学习卡";
    case "topic":
      return "话题卡";
  }
}

function formatUserAssignmentStatus(
  status: EvidenceTaskAttribution["candidates"][number]["userAssignmentStatus"],
): string {
  switch (status) {
    case "assigned-to-user":
      return "speaker 已标注为用户本人，可作为你的任务候选";
    case "assigned-to-known-speaker":
      return "speaker 已标注为其他人物，不能默认算你的任务";
    case "not-user-unless-role-matches":
      return "不能默认算你的任务，除非你确认自己就是该角色/团队";
    case "needs-speaker-label":
      return "需要先标注 speaker_1/speaker_2 才能判断是否落到你";
    case "unknown-owner":
      return "有行动语气，但 owner 不明确";
    case "not-an-assignment":
      return "不是任务分配，只能作为背景话题";
  }
}

function formatRawAudioArtifactStatus(status: EvidenceAudioDiagnostics["verdict"]["rawAudioArtifacts"]): string {
  switch (status) {
    case "available":
      return "原始音频仍可用，可补跑本地 ASR / diarization";
    case "deleted":
      return "原始音频已被 retention 清理，只能引用已保存转写，不能直接补跑";
    case "missing-record":
      return "缺少原始音频 artifact 记录，无法定位 raw wav 补强";
    case "no-audio":
      return "当前时间范围没有音频事件";
  }
}

type EvidenceStatement = {
  timeRange: string;
  text: string;
  source: "summary" | "transcript" | "video";
};

function collectEvidenceStatements(windows: EvidenceBundleWindow[]): EvidenceStatement[] {
  return windows.flatMap((window) => {
    const statements: EvidenceStatement[] = [];
    for (const text of splitEvidenceClauses(window.summary)) {
      statements.push({
        timeRange: window.timeRange,
        text,
        source: "summary",
      });
    }
    for (const text of splitEvidenceClauses(window.transcriptExcerpt ?? "")) {
      statements.push({
        timeRange: window.timeRange,
        text,
        source: "transcript",
      });
    }
    return statements;
  });
}

function collectVideoEvidenceStatements(
  videoGroups: EvidenceBundleVideoGroup[],
): EvidenceStatement[] {
  return videoGroups.flatMap((group) => {
    const statements: EvidenceStatement[] = [];
    if (group.summary && !looksDarkOrOccluded(group.summary)) {
      statements.push({
        timeRange: group.timeRange,
        text: group.summary,
        source: "video",
      });
    }
    for (const clip of group.videoDetails.slice(0, 2)) {
      if (!clip.caption || looksDarkOrOccluded(clip.caption || clip.summary)) {
        continue;
      }
      statements.push({
        timeRange: `${group.timeRange}/${clip.time}`,
        text: clip.caption,
        source: "video",
      });
    }
    for (const frame of group.keyframeDetails.slice(0, 3)) {
      const timeLabel = `${group.timeRange}/${frame.time}`;
      if (frame.caption && !looksDarkOrOccluded(frame.caption || frame.summary)) {
        statements.push({
          timeRange: timeLabel,
          text: frame.caption,
          source: "video",
        });
      }
      for (const ocrHint of frame.ocrHints.slice(0, 2)) {
        statements.push({
          timeRange: timeLabel,
          text: ocrHint,
          source: "video",
        });
      }
    }
    for (const hint of group.semanticSignals.ocrHints.slice(0, 2)) {
      statements.push({
        timeRange: group.timeRange,
        text: hint,
        source: "video",
      });
    }
    return statements;
  });
}

function splitEvidenceClauses(text: string): string[] {
  const normalized = stripSectionPrefix(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/[。！？!?；;]\s*|(?<=，)(?=(?:老师|老板|同事|同学|客户|导师|班主任|Amy|明天|今天|需要|记得|先|再))/u)
    .map((item) => item.trim().replace(/[，,；;]+$/u, "").trim())
    .filter((item) => item.length >= 4 && !looksLowSignalClause(item))
    .slice(0, 4);
}

function looksLowSignalClause(text: string): boolean {
  return /^(今天|目前|当时|就是|这个|那个|然后|还有|以及)$/.test(text.trim());
}

function formatTimedEvidence(timeRange: string, text: string): string {
  const trimmed = stripSectionPrefix(text);
  if (!trimmed) {
    return "";
  }
  return /^\d{2}:\d{2}-\d{2}:\d{2}/.test(trimmed) ? trimmed : `${timeRange}：${trimmed}`;
}

function extractRoleHintsFromEvidence(
  statements: EvidenceStatement[],
  scenarioCandidate: EvidenceBundle["scenarioProfile"]["candidate"],
): string[] {
  const roleKeywords =
    scenarioCandidate === "study"
      ? ["老师", "同学", "班主任", "导师", "助教"]
      : scenarioCandidate === "work"
        ? ["老板", "同事", "客户", "经理", "产品", "运营"]
        : ["老师", "同学", "老板", "同事", "客户", "朋友"];

  return uniqueItems(
    statements.flatMap((statement) =>
      roleKeywords
        .filter((role) => statement.text.includes(role))
        .map((role) => `待确认角色：${role}（${statement.timeRange} ${formatEvidenceSourceLabel(statement.source)}）`),
    ),
  ).slice(0, 3);
}

const ROLE_HINT_PREFIX_PATTERN =
  "(?:老板|同事|老师|同学|客户|导师|经理|班主任|主管|教授|讲师|助教|组长|主任|运维|售前|产品|运营)";
const PERSON_NAME_TOKEN_PATTERN = "(?:[A-Z][a-zA-Z]{1,20}|[\\u4e00-\\u9fff]{1,6}(?:老师|总|同学|经理)?)";
const NON_PERSON_IDENTITY_CANDIDATES = new Set([
  "构造",
  "纸箱",
  "模型",
  "算法",
  "数据",
  "系统",
  "问题",
  "功能",
  "任务",
  "项目",
  "主题",
  "版本",
  "报价",
  "截图",
  "会议",
  "复盘",
  "视频",
  "画面",
  "桌面",
  "工位",
  "文字",
  "字幕",
  "麦克风",
  "还是",
  "或者",
  "以及",
  "然后",
  "但是",
]);

function looksLikelyIdentityName(name: string): boolean {
  const trimmed = normalizeIdentityNameCandidate(name);
  if (!trimmed || looksPendingIdentityLabel(trimmed)) {
    return false;
  }
  if (NON_PERSON_IDENTITY_CANDIDATES.has(trimmed)) {
    return false;
  }
  if (new RegExp(`^${ROLE_HINT_PREFIX_PATTERN}$`, "u").test(trimmed)) {
    return false;
  }
  if (
    /^(说明|说明天|说今天|提醒|确认|安排|提到|表示|需要|应该|可能|今天|明天|后天|上午|下午|晚上|开会|会议|讨论|复盘|跟进|准备)$/u.test(
      trimmed,
    )
  ) {
    return false;
  }
  if (/^(同步对象|最终版|最终版本|版本号|会议纪要|截图顺序|报价|需求|项目|主题|安排)$/u.test(trimmed)) {
    return false;
  }
  if (/^[A-Z][a-zA-Z]{1,20}$/.test(trimmed)) {
    return true;
  }
  const withoutSuffix = trimmed.replace(/(?:老师|总|同学|经理)$/u, "");
  if (/^[\u4e00-\u9fff]{2,4}$/.test(withoutSuffix)) {
    return true;
  }
  if (/^[\u4e00-\u9fff]$/.test(withoutSuffix) && /(?:老师|总|同学|经理)$/u.test(trimmed)) {
    return true;
  }
  return false;
}

function normalizeIdentityNameCandidate(value: string): string {
  const stripped = value
    .trim()
    .replace(/^[“"'`]+|[”"'`]+$/g, "")
    .replace(/[，。！？!?,；;:：]+$/u, "")
    .trim();
  const withoutDeterminer = stripped.replace(/^(?:这位|那位|一位|某位|该位|该名|这个|那个)/u, "");
  const withoutRolePrefix = withoutDeterminer.replace(new RegExp(`^${ROLE_HINT_PREFIX_PATTERN}`, "u"), "").trim();
  return withoutRolePrefix;
}

function extractNameHintsFromEvidence(statements: EvidenceStatement[]): string[] {
  const hints: string[] = [];
  const roleNameRegex = new RegExp(
    `(${ROLE_HINT_PREFIX_PATTERN})\\s*[:：]?\\s*(${PERSON_NAME_TOKEN_PATTERN})(?=\\s*(?:说|提到|提醒|表示|安排|回复|确认|要求|让|在|跟|和|把|发给|告诉|的))`,
    "gu",
  );
  const targetNameRegex = new RegExp(
    `(?:给|和|与|向|跟)\\s*(${PERSON_NAME_TOKEN_PATTERN})(?=\\s*(?:说|提到|确认|同步|沟通|发|汇报|开会|讨论|请教|请示|[，。！？!?,；;]|$))`,
    "gu",
  );
  const possessiveNameRegex = new RegExp(
    `(${ROLE_HINT_PREFIX_PATTERN})\\s*(${PERSON_NAME_TOKEN_PATTERN})(?=的)`,
    "gu",
  );
  for (const statement of statements) {
    const sourceLabel = formatEvidenceSourceLabel(statement.source);
    const sourcePatterns = [
      { regex: roleNameRegex, hasRoleGroup: true },
      { regex: targetNameRegex, hasRoleGroup: false },
      { regex: possessiveNameRegex, hasRoleGroup: true },
    ] as const;
    for (const pattern of sourcePatterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(statement.text)) !== null) {
        const rawName = pattern.hasRoleGroup ? match[2] ?? "" : match[1] ?? "";
        const roleWord = pattern.hasRoleGroup
          ? (match[1] ?? "").trim()
          : extractLeadingRoleWord(rawName);
        const name = normalizeIdentityNameCandidate(rawName);
        if (!name || !looksLikelyIdentityName(name)) {
          continue;
        }
        const relationshipHint = roleWord ? normalizeRelationshipFromRole(roleWord) : undefined;
        hints.push(
          relationshipHint
            ? `待确认人物：${name}（角色：${relationshipHint}；${statement.timeRange} ${sourceLabel}）`
            : `待确认人物：${name}（${statement.timeRange} ${sourceLabel}）`,
        );
      }
    }
  }
  return uniqueItems(hints).slice(0, 3);
}

function extractPendingIdentityHints(
  payload: AssistantContextPayload,
  statements: EvidenceStatement[],
  speakerLayer: EvidenceBundle["speakerLayer"],
  scenarioCandidate: EvidenceBundle["scenarioProfile"]["candidate"],
): string[] {
  const reviewHints = readSectionItems(payload, "关键人物")
    .map(stripSectionPrefix)
    .flatMap((item) => normalizePendingIdentityHint(item));
  const nameHints = extractNameHintsFromEvidence(statements);
  const roleHints = extractRoleHintsFromEvidence(statements, scenarioCandidate);
  const speakerHints = speakerLayer.suggestedSlots
    .filter((slot) => !slot.displayName)
    .map((slot) => `待确认发言者：${slot.slotLabel}（${slot.timeRange}）`);
  return reviewHints
    .concat(nameHints)
    .concat(roleHints)
    .concat(speakerHints);
}

function formatEvidenceSourceLabel(source: EvidenceStatement["source"]): string {
  if (source === "transcript") {
    return "音频线索";
  }
  if (source === "video") {
    return "视频线索";
  }
  return "事件线索";
}

function normalizePendingIdentityHint(item: string): string[] {
  const trimmed = item.trim();
  if (!trimmed) {
    return [];
  }
  if (/待确认|未确认|未知/.test(trimmed)) {
    if (/人物|人士|同事|老板|老师|同学|客户|发言者|对话对象/.test(trimmed)) {
      return [trimmed];
    }
    return [`待确认人物：${trimmed}`];
  }
  if (/穿|戴|长发|短发|坐姿|站姿|画面中|镜头里|外套|帽子|工位/.test(trimmed)) {
    return [`待确认视觉人物：${trimmed}`];
  }
  if (/老板|同事|老师|同学|客户|经理|运维|售前|主讲人|演讲/.test(trimmed)) {
    return [`待确认角色线索：${trimmed}`];
  }
  return [];
}

function buildSpeakerLayer(
  payload: AssistantContextPayload,
  transcriptWindowCount: number,
): EvidenceBundle["speakerLayer"] {
  const candidateWindows = payload.windows
    .filter((window) => window.audioCount > 0)
    .slice(0, 2);
  const suggestedSlots = candidateWindows.flatMap((window) =>
    [1, 2].map((index) => {
      const speakerRef = `speaker:${window.windowId}:${index}`;
      const saved = payload.highlights.speakers.find((speaker) => speaker.speakerRef === speakerRef);
      return {
        speakerRef,
        slotLabel: `speaker_${index}`,
        windowId: window.windowId,
        timeRange: `${formatTime(window.startedAt)}-${formatTime(window.endedAt)}`,
        displayName: saved?.displayName,
        relationship: saved?.relationship,
      };
    }),
  );
  const audioWindowCount = payload.windows.filter((window) => window.audioCount > 0).length;
  if (audioWindowCount === 0) {
    return {
      status: "no-audio",
      suggestedSlots: [],
      note: "当前时间范围里没有音频窗口，所以还没有说话人层可整理。",
    };
  }
  if (transcriptWindowCount > 0) {
    return {
      status: "ready-for-labeling",
      suggestedSlots,
      note: "当前已经有可引用的音频转写，但还没有稳定的句级说话人归属；speaker 标注可帮助后续识别人物，但任务归属仍需保守表达。",
    };
  }
  return {
    status: "pending-diarization",
    suggestedSlots,
    note: "当前已经有音频窗口，但还没有说话人分离；下一阶段应先生成 speaker_1 / speaker_2 这类占位，再让用户回填身份。",
  };
}

function buildEvidenceGaps(payload: AssistantContextPayload): string[] {
  const gaps: string[] = [];
  const allEvents = payload.windows.flatMap((window) => window.events);
  const audioEvents = allEvents.filter((event) => event.modality === "audio");
  const imageEvents = allEvents.filter((event) => event.modality === "image");
  const transcriptCount = audioEvents.filter((event) => Boolean(event.transcript?.trim())).length;
  const degradedEvents = allEvents.filter((event) => event.analysisStatus === "degraded");

  if (payload.counts.events === 0) {
    if (typeof payload.recentActivity?.lastSeenAt === "number" && payload.recentActivity.priorEventCount > 0) {
      gaps.push(
        `当前时间范围里还没有采集到可用于回顾的新事件。最近一次有效记录在 ${formatDateTime(payload.recentActivity.lastSeenAt)}，过去 ${payload.recentActivity.lookbackDays} 天累计 ${payload.recentActivity.priorWindowCount} 个窗口 / ${payload.recentActivity.priorEventCount} 条事件。`,
      );
    } else {
      gaps.push("当前时间范围里还没有采集到可用于回顾的事件。");
    }
    return gaps;
  }
  if (audioEvents.length > 0 && transcriptCount === 0) {
    gaps.push("有音频事件，但目前没有可用转写，无法确认具体对话内容。");
  }
  if (imageEvents.length === 0) {
    gaps.push("当前时间范围里没有图片证据，场景判断会更依赖音频或已有标签。");
  }
  if (degradedEvents.length > 0) {
    gaps.push(`当前有 ${degradedEvents.length} 条降级事件，相关结论应视为待确认线索。`);
  }
  return gaps;
}

function buildEvidenceAudioDiagnostics(payload: AssistantContextPayload): EvidenceAudioDiagnostics {
  const audioEvents = payload.windows.flatMap((window) => window.events).filter((event) => event.modality === "audio");
  const audioArtifactRecords = audioEvents.filter((event) => Boolean(event.artifact)).length;
  const activeAudioArtifactRecords = audioEvents.filter((event) => event.artifact?.available).length;
  const deletedAudioArtifactRecords = Math.max(0, audioArtifactRecords - activeAudioArtifactRecords);
  const missingAudioArtifactRecords = Math.max(0, audioEvents.length - audioArtifactRecords);
  const transcriptReadyEvents = audioEvents.filter((event) => Boolean(event.transcript?.trim())).length;
  const transcriptSegmentReadyEvents = audioEvents.filter((event) => (event.transcriptSegments ?? []).length > 0).length;
  const speakerTimelineReadyEvents = audioEvents.filter((event) => (event.speakerTimelineSegments ?? []).length > 0).length;
  const degradedAudioEvents = audioEvents.filter((event) => event.analysisStatus === "degraded").length;
  const backfillNeededEvents = audioEvents.filter(
    (event) => !event.transcript?.trim() || (event.transcriptSegments ?? []).length === 0,
  ).length;
  const diarizationNeededEvents = audioEvents.filter(
    (event) => Boolean(event.transcript?.trim()) && (event.speakerTimelineSegments ?? []).length === 0,
  ).length;
  const rawAudioArtifacts =
    audioEvents.length === 0
      ? "no-audio"
      : activeAudioArtifactRecords > 0
        ? "available"
        : audioArtifactRecords > 0
          ? "deleted"
          : "missing-record";
  const transcriptLayer =
    audioEvents.length === 0 ? "no-audio" : transcriptReadyEvents > 0 ? "ready" : "missing";
  const diarizationLayer =
    audioEvents.length === 0 ? "no-audio" : speakerTimelineReadyEvents > 0 ? "ready" : "missing";
  const blockers = buildEvidenceAudioDiagnosticBlockers({
    audioEvents: audioEvents.length,
    rawAudioArtifacts,
    backfillNeededEvents,
    diarizationNeededEvents,
  });

  return {
    counts: {
      audioEvents: audioEvents.length,
      audioArtifactRecords,
      activeAudioArtifactRecords,
      deletedAudioArtifactRecords,
      missingAudioArtifactRecords,
      transcriptReadyEvents,
      transcriptSegmentReadyEvents,
      speakerTimelineReadyEvents,
      degradedAudioEvents,
      backfillNeededEvents,
      diarizationNeededEvents,
    },
    coverage: {
      transcriptCoverage: ratio(transcriptReadyEvents, audioEvents.length),
      transcriptSegmentCoverage: ratio(transcriptSegmentReadyEvents, audioEvents.length),
      speakerTimelineCoverage: ratio(speakerTimelineReadyEvents, audioEvents.length),
    },
    verdict: {
      transcriptLayer,
      diarizationLayer,
      needsBackfill: backfillNeededEvents > 0,
      needsDiarization: diarizationNeededEvents > 0,
      rawAudioArtifacts,
    },
    blockers,
    blockerIds: blockers.map((blocker) => blocker.id),
    nextActions: buildEvidenceAudioDiagnosticNextActions({
      rawAudioArtifacts,
      backfillNeededEvents,
      diarizationNeededEvents,
    }),
  };
}

function buildEvidenceAudioDiagnosticBlockers(params: {
  audioEvents: number;
  rawAudioArtifacts: EvidenceAudioDiagnostics["verdict"]["rawAudioArtifacts"];
  backfillNeededEvents: number;
  diarizationNeededEvents: number;
}): EvidenceAudioDiagnostics["blockers"] {
  const blockers: EvidenceAudioDiagnostics["blockers"] = [];
  if (params.audioEvents === 0) {
    return [
      {
        id: "no-audio-events",
        severity: "info",
        message: "当前时间范围没有音频事件。",
      },
    ];
  }
  if (params.rawAudioArtifacts === "deleted") {
    blockers.push({
      id: "raw-audio-retention-deleted",
      severity: "blocked",
      message: "raw 音频已被 retention 清理；可继续引用已保存转写，但不能直接补跑本地 ASR / diarization。",
    });
  } else if (params.rawAudioArtifacts === "missing-record") {
    blockers.push({
      id: "raw-audio-artifact-record-missing",
      severity: "blocked",
      message: "音频事件缺少 artifact 记录；无法定位原始 wav 做补强。",
    });
  }
  if (params.diarizationNeededEvents > 0) {
    blockers.push({
      id: params.rawAudioArtifacts === "available" ? "diarization-runnable" : "diarization-not-runnable",
      severity: params.rawAudioArtifacts === "available" ? "warning" : "blocked",
      message:
        params.rawAudioArtifacts === "available"
          ? "部分音频已有转写但缺少 speaker timeline，可补跑 diarization。"
          : "部分音频已有转写但缺少 speaker timeline；当前没有可用 raw 音频，不能直接补跑 diarization。",
    });
  }
  if (params.backfillNeededEvents > 0) {
    blockers.push({
      id: params.rawAudioArtifacts === "available" ? "audio-backfill-runnable" : "backfill-not-runnable",
      severity: params.rawAudioArtifacts === "available" ? "warning" : "blocked",
      message:
        params.rawAudioArtifacts === "available"
          ? "部分音频还缺 transcriptSegments，可补跑本地 ASR backfill。"
          : "部分音频还缺 transcriptSegments；当前没有可用 raw 音频，不能直接补跑本地 ASR backfill。",
    });
  }
  if (blockers.length === 0) {
    blockers.push({
      id: "audio-ready",
      severity: "info",
      message: "当前音频层可用于回答；如已配置 speaker timeline，可继续做人物归属追问。",
    });
  }
  return blockers;
}

function buildEvidenceAudioDiagnosticNextActions(params: {
  rawAudioArtifacts: EvidenceAudioDiagnostics["verdict"]["rawAudioArtifacts"];
  backfillNeededEvents: number;
  diarizationNeededEvents: number;
}): string[] {
  if (params.rawAudioArtifacts === "no-audio") {
    return ["先采集一段真实音频，再验证转写、speaker timeline 和任务归属。"];
  }
  if (params.rawAudioArtifacts === "available") {
    const actions: string[] = [];
    if (params.backfillNeededEvents > 0) {
      actions.push("运行 local ASR backfill，为缺 transcriptSegments 的音频补齐句子级片段。");
    }
    if (params.diarizationNeededEvents > 0) {
      actions.push("运行 diarization-probe / ASR queue，把 speaker timeline 写回 state。");
    }
    return actions.length > 0 ? actions : ["音频层已经可引用；下一步优先标注 speaker/person。"];
  }
  if (params.rawAudioArtifacts === "deleted") {
    return [
      "可以继续基于已保存 transcript / digest 回顾当天内容。",
      "如果要重新跑本地 ASR / diarization，需要重新导入原始 wav，或采集一段仍在 retention 窗口内的新音频。",
      "后续采集前把 artifactRetentionDays 设到足够长，并在 retention 到期前运行 audio-diagnostics / diarization-probe。",
    ];
  }
  return [
    "先确认音频事件是否缺 artifactId / artifact 记录。",
    "必要时重新导入 raw wav，或采集新音频后再跑 ASR / diarization。",
  ];
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function readSectionItems(payload: AssistantContextPayload, title: string): string[] {
  return payload.review?.sections.find((section) => section.title === title)?.items ?? [];
}

function extractQueryTerms(question: string | undefined): string[] {
  if (!question) {
    return [];
  }
  return Array.from(
    new Set(
      (question.match(/[\p{L}\p{N}\u4e00-\u9fff]{2,}/gu) ?? [])
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  );
}

function uniqueItems(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function normalizeVisualCaption(summary: string | undefined): string {
  const normalized = stripSectionPrefix(toSingleLine(summary ?? ""));
  if (!normalized) {
    return "";
  }
  return truncateText(normalized, 140);
}

function extractVisualOcrHints(summary: string | undefined): string[] {
  const normalized = stripSectionPrefix(toSingleLine(summary ?? ""));
  if (!normalized) {
    return [];
  }
  const hints: string[] = [];
  for (const match of normalized.matchAll(/[“"'《](.{2,48}?)[”"'》]/gu)) {
    const value = normalizePotentialOcrChunk(match[1]);
    if (value) {
      hints.push(value);
    }
  }
  for (const match of normalized.matchAll(/(?:写着|写有|显示|内容(?:关于|为)?|文字(?:内容)?(?:是|为)?|标题(?:为)?|板书(?:内容)?(?:是|为)?|投影(?:内容)?(?:是|为)?|白板(?:内容)?(?:是|为)?|屏幕(?:内容)?(?:是|为)?)[：:\s]+([^。；;]+)/gu)) {
    const segments = match[1]
      .split(/[，,、]/u)
      .map((segment) => normalizePotentialOcrChunk(segment))
      .filter(Boolean);
    hints.push(...segments);
  }
  return uniqueItems(
    hints.filter((item) => item.length >= 2 && item.length <= 48 && !looksDarkOrOccluded(item)),
  ).slice(0, 4);
}

function normalizePotentialOcrChunk(value: string | undefined): string {
  const normalized = toSingleLine(value ?? "")
    .replace(/^(?:内容|文字|标题|白板|屏幕|投影|板书)[：:\s]*/u, "")
    .replace(/[。；;，,]+$/u, "")
    .trim();
  if (!normalized) {
    return "";
  }
  if (/^(?:一些|若干|多个|信息|文字|内容|短语|句子)$/u.test(normalized)) {
    return "";
  }
  return truncateText(normalized, 48);
}

function linkKeyframeToVideoDetail(
  keyframe: {
    capturedAt: number;
    videoOffsetMs?: number;
  },
  videoDetails: Array<{
    eventId: string;
    artifactId?: string;
    url?: string;
    capturedAt: number;
    time: string;
  }>,
): {
  linkedVideoEventId?: string;
  linkedVideoArtifactId?: string;
  linkedVideoUrl?: string;
  linkedVideoTime?: string;
  linkedDeltaMs?: number;
  linkMethod: "offset-marker" | "nearest-clip" | "fallback-first-clip" | "no-clip";
} {
  if (videoDetails.length === 0) {
    return {
      linkMethod: "no-clip",
    };
  }
  if (typeof keyframe.videoOffsetMs === "number" && Number.isFinite(keyframe.videoOffsetMs)) {
    const offsetLinked = videoDetails
      .slice()
      .sort((left, right) => {
        const leftExpectedAt = left.capturedAt + keyframe.videoOffsetMs!;
        const rightExpectedAt = right.capturedAt + keyframe.videoOffsetMs!;
        return (
          Math.abs(leftExpectedAt - keyframe.capturedAt) - Math.abs(rightExpectedAt - keyframe.capturedAt) ||
          left.capturedAt - right.capturedAt
        );
      })[0];
    if (offsetLinked) {
      const expectedAt = offsetLinked.capturedAt + keyframe.videoOffsetMs;
      return {
        linkedVideoEventId: offsetLinked.eventId,
        linkedVideoArtifactId: offsetLinked.artifactId,
        linkedVideoUrl: offsetLinked.url,
        linkedVideoTime: offsetLinked.time,
        linkedDeltaMs: Math.abs(expectedAt - keyframe.capturedAt),
        linkMethod: "offset-marker",
      };
    }
  }
  const nearest = videoDetails
    .slice()
    .sort(
      (left, right) =>
        Math.abs(left.capturedAt - keyframe.capturedAt) - Math.abs(right.capturedAt - keyframe.capturedAt) ||
        left.capturedAt - right.capturedAt,
    )[0];
  if (!nearest) {
    const firstClip = videoDetails[0];
    return {
      linkedVideoEventId: firstClip?.eventId,
      linkedVideoArtifactId: firstClip?.artifactId,
      linkedVideoUrl: firstClip?.url,
      linkedVideoTime: firstClip?.time,
      linkedDeltaMs: typeof firstClip?.capturedAt === "number" ? Math.abs(firstClip.capturedAt - keyframe.capturedAt) : undefined,
      linkMethod: "fallback-first-clip",
    };
  }
  return {
    linkedVideoEventId: nearest.eventId,
    linkedVideoArtifactId: nearest.artifactId,
    linkedVideoUrl: nearest.url,
    linkedVideoTime: nearest.time,
    linkedDeltaMs: Math.abs(nearest.capturedAt - keyframe.capturedAt),
    linkMethod: "nearest-clip",
  };
}

function looksDarkOrOccluded(text: string): boolean {
  return /黑暗|全黑|近乎全黑|遮挡|模糊|无光|全暗/i.test(text);
}

function countKeywordHits(text: string, keywords: string[]): number {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

function looksTaskLike(text: string): boolean {
  return /确认|准备|提交|检查|跟进|安排|完成|复习|整理|发送|提供|同步|开发|验证|演示|询问|问一下|问下|看一下|看下|查看|发一下|发给|补一下|补齐|补上|沟通/i.test(text);
}

function looksActionCue(text: string): boolean {
  return /需要.{0,24}(确认|准备|提交|检查|跟进|安排|完成|整理|发送|提供|同步|开发|验证|演示|询问|沟通|补齐|补上|发给|查看|看一下|看下|问一下|问下)|(?:你|你们|我们|我|大家).{0,24}(确认|准备|提交|检查|跟进|安排|完成|整理|发送|提供|同步|开发|验证|演示|询问|沟通|补齐|补上|发给|查看|看一下|看下|问一下|问下)|先.{0,24}(确认|整理|演示|记录|做|看一下|看下|查看|补齐|补上|发给|提交|同步|验证|问一下|问下)|再.{0,24}(确认|整理|补齐|补上|发给|提交|同步|验证|看一下|看下|查看|问一下|问下)|记得.{0,24}(确认|准备|提交|检查|跟进|安排|完成|整理|发送|提供|同步|开发|验证|补齐|补上|发给)|请|麻烦|会后|补上|补齐|发给|带上|整理好|准备好|确认下|跟一下/i.test(text);
}

function looksDeadlineCue(text: string): boolean {
  return /明天|今晚|下午|早上|周一|下周|截止|之前|尽快|稍后|会后|课后/i.test(text);
}

function hasConcreteActionVerb(text: string): boolean {
  return looksTaskLike(text) || /补上|补齐|发给|带上|整理好|准备好|确认下|跟一下/i.test(text);
}

function looksStudyLike(text: string): boolean {
  return /老师|课程|课堂|作业|复习|学习|讲义|概念|公式|实验|考试/i.test(text);
}

function looksStudyActionCue(text: string): boolean {
  return /作业|实验报告|交作业|复习|预习|背诵|抄写|订正|考试|测验|签到/i.test(text);
}

function looksWorkLike(text: string): boolean {
  return /会议|同事|老板|客户|项目|演示|汇报|待办|开会|办公室|版本|产品|方案/i.test(text);
}

function looksClassroomLike(text: string): boolean {
  return /老师|同学|教室|课堂|课程|作业|讲题|板书|笔记|复习|考试|实验|讲义/i.test(text);
}

function looksTeachingCue(text: string): boolean {
  return /讲了|提到|解释了|强调了|复习了|布置了|提醒|例题|重点|概念/i.test(text);
}

function looksLearningOutcomeCue(text: string): boolean {
  return /要点|定义|原理|步骤|评分|标准|重点|结论|公式|实验步骤|知识点/i.test(text);
}

function looksQuestionLike(text: string): boolean {
  return /[？?]$/.test(text.trim());
}

function looksPendingIdentityLabel(text: string): boolean {
  return /待确认|未确认|未知|speaker_/i.test(text.trim());
}

function looksEnvironmentLike(text: string): boolean {
  return /桌面|教室|办公室|会议室|屏幕|讲台|投影|白板|课桌|工位|实验室|咖啡店|走廊/i.test(text);
}

function stripSectionPrefix(text: string): string {
  return text.replace(/^(今天遗漏但值得追问的点|明天建议关注的事情|关键人物|关键项目\s*\/\s*主题|值得注意的细节)\s*[:：]\s*/u, "").trim();
}

function buildScenarioPriorityHint(candidate: EvidenceBundle["scenarioProfile"]["candidate"]): string {
  switch (candidate) {
    case "work":
      return "优先回答任务、关键人物、待跟进项。";
    case "study":
      return "优先回答学习要点、老师/同学、待确认知识点。";
    case "social":
      return "优先回答互动对象、值得回看的细节、后续可追问的问题。";
    default:
      return "优先回答已确认事实，再补充任务、人物和信息缺口。";
  }
}

function buildScenarioBucketsHint(
  candidate: EvidenceBundle["scenarioProfile"]["candidate"],
): string[] {
  switch (candidate) {
    case "work":
      return ["一句结论", "项目主线", "任务候选", "已确认人物", "角色线索", "待确认重点"];
    case "study":
      return ["一句结论", "课程 / 主题主线", "学习要点", "已确认人物", "角色线索", "待确认知识点"];
    case "social":
      return ["一句结论", "互动主线", "已确认人物", "互动线索", "待确认重点"];
    default:
      return ["一句结论", "已确认证据", "主题线索", "已确认人物", "待确认缺口"];
  }
}

function buildScenarioAnswerTemplate(evidence: EvidenceBundle): string[] {
  const firstTask = evidence.practicalOutputs.tasks[0];
  const firstLearningPoint = evidence.practicalOutputs.learningPoints[0];
  const firstAttention = evidence.practicalOutputs.attentionItems[0];
  switch (evidence.scenarioProfile.candidate) {
    case "work":
      return [
        "结论：今天的办公主线是什么（项目/会议）。",
        `任务：${firstTask ?? "提取 1-3 条可执行任务，并尽量带时间窗。"}`,
        "人物：区分已确认人物和待确认角色线索（不要混写）。",
        `待确认：${firstAttention ?? "列 1-2 条仍需补问的缺口。"}`,
      ];
    case "study":
      return [
        "结论：今天课程/学习主线是什么。",
        `学习点：${firstLearningPoint ?? "提取 1-3 条可复习知识点或课堂重点。"}`,
        "人物：明确老师/同学是否已确认身份。",
        `待确认：${firstAttention ?? "列 1-2 条仍需补问的知识点或作业信息。"}`,
      ];
    case "social":
      return [
        "结论：今天社交互动主线是什么。",
        "互动对象：区分已确认人物与待确认角色。",
        "细节：列 1-2 条可回链证据的画面/对话片段。",
        `待确认：${firstAttention ?? "列 1 条后续可追问问题。"}`,
      ];
    default:
      return [
        "结论：先给一句当天主线。",
        "证据：列 2-4 条可回链到时间窗/转写/图片的事实。",
        "人物与主题：分别列已确认项与待确认线索。",
        `缺口：${firstAttention ?? "最后补 1-2 条待确认问题。"}`,
      ];
  }
}

function buildAnnotationSuggestions(params: {
  speakerLayer: EvidenceBundle["speakerLayer"];
  roleHints: string[];
}): EvidenceAnnotationSuggestions {
  const speakerSuggestions = params.speakerLayer.suggestedSlots
    .filter((slot) => !slot.displayName)
    .slice(0, 3)
    .map((slot) => ({
      suggestionId: `speaker:${slot.speakerRef}`,
      speakerRef: slot.speakerRef,
      slotLabel: slot.slotLabel,
      windowId: slot.windowId,
      timeRange: slot.timeRange,
      confidence: "medium" as const,
      sentenceTemplate: `${slot.slotLabel}（${slot.timeRange}）是我的同事李三。`,
      commandTemplate: `openclaw clawsense annotate-speaker ${shellDoubleQuote(slot.speakerRef)} ${shellDoubleQuote("李三")} --relationship ${shellDoubleQuote("同事")} --windowId ${shellDoubleQuote(slot.windowId)}`,
      selfSentenceTemplate: `${slot.slotLabel}（${slot.timeRange}）是我本人。`,
      selfCommandTemplate: `openclaw clawsense annotate-speaker ${shellDoubleQuote(slot.speakerRef)} ${shellDoubleQuote("我")} --relationship ${shellDoubleQuote("本人")} --windowId ${shellDoubleQuote(slot.windowId)}`,
    }));

  const personSuggestions: EvidenceAnnotationSuggestions["people"] = [];
  for (const hint of params.roleHints) {
    const candidate = parsePendingIdentityHint(hint);
    if (!candidate.name) {
      continue;
    }
    const personRef = toPersonRefCandidate(candidate.name);
    personSuggestions.push({
      suggestionId: `person:${personRef}`,
      personRef,
      displayName: candidate.name,
      timeRange: candidate.timeRange,
      sourceHint: hint,
      relationshipHint: candidate.relationshipHint,
      confidence: candidate.confidence,
      autoApplyEligible: candidate.confidence === "high",
      sentenceTemplate: `${candidate.name} 是我的${candidate.relationshipHint ?? "同事/老板/老师"}。`,
      commandTemplate: [
        `openclaw clawsense annotate ${shellDoubleQuote(personRef)} ${shellDoubleQuote(candidate.name)}`,
        candidate.relationshipHint ? `--relationship ${shellDoubleQuote(candidate.relationshipHint)}` : "",
        `--notes ${shellDoubleQuote(`来自线索：${hint}`)}`,
      ].filter(Boolean).join(" "),
    });
  }

  return {
    speakers: speakerSuggestions,
    people: dedupePersonSuggestions(personSuggestions).slice(0, 3),
  };
}

function dedupePersonSuggestions(
  items: EvidenceAnnotationSuggestions["people"],
): EvidenceAnnotationSuggestions["people"] {
  const deduped = new Map<string, EvidenceAnnotationSuggestions["people"][number]>();
  for (const item of items) {
    const key = item.personRef;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}

function buildAnnotationPrompts(evidence: EvidenceBundle): string[] {
  const speakerPrompts = evidence.annotationSuggestions.speakers
    .slice(0, 2)
    .flatMap((item) => [
      `如果 ${item.slotLabel} 是你本人，可以直接说：“${item.selfSentenceTemplate}”`,
      `如果你知道 ${item.slotLabel} 是谁，可以直接说：“${item.sentenceTemplate}”`,
    ]);
  const prompts = speakerPrompts
    .concat(
      evidence.annotationSuggestions.people
        .slice(0, 2)
        .map((item) => `如果你知道 ${item.displayName} 的身份，可以直接说：“${item.sentenceTemplate}”`),
    );

  if (prompts.length === 0 && evidence.practicalOutputs.roleHints.length > 0) {
    prompts.push(
      ...evidence.practicalOutputs.roleHints
        .slice(0, 2)
        .map((hint) => `如果你知道这条角色线索对应的人是谁，可以直接告诉我：${hint} 对应的是谁。`),
    );
  }

  return uniqueItems(prompts).slice(0, 4);
}

function buildHistoryFollowUps(
  identityHistory: IdentityHistoryEntry[],
  projectHistory: ProjectHistoryEntry[],
): string[] {
  const identityPrompts = identityHistory.map((entry) => buildIdentityHistoryFollowUpPrompt(entry));
  const projectPrompts = projectHistory.map((entry) => {
    const latest = entry.recentMoments[0];
    if (latest?.transcriptExcerpt) {
      return `你可以继续问：“${entry.label} 在 ${latest.date} ${latest.timeRange} 的对话重点是什么？”`;
    }
    return `你可以继续问：“${entry.label} 最近一次出现时，有哪些需要我补充确认的点？”`;
  });
  return uniqueItems(identityPrompts.concat(projectPrompts)).slice(0, 4);
}

function buildAudioFollowUps(windows: EvidenceBundleWindow[]): string[] {
  return buildAudioFollowUpTargets(windows).map((item) => item.prompt);
}

function buildVideoFollowUps(videoGroups: EvidenceBundleVideoGroup[]): string[] {
  return buildVideoFollowUpTargets(videoGroups).map((item) => item.prompt);
}

function buildTopicFollowUps(topicSegments: EvidenceTopicSegment[]): string[] {
  return buildTopicFollowUpTargets(topicSegments).map((item) => item.prompt);
}

function buildTopicFollowUpTargets(topicSegments: EvidenceTopicSegment[]): Array<{
  source: "topic";
  prompt: string;
  kind: "topic-segment";
  segmentId: string;
  windowId: string;
  timeRange: string;
  title: string;
  transcriptExcerpt: string;
  keywordHints: string[];
  taskSignalCount: number;
}> {
  return topicSegments.slice(0, 6).map((segment, index) => ({
    source: "topic",
    prompt: `你可以继续问：“第 ${index + 1} 段（${segment.timeRange}，${segment.title}）具体讲了什么？有哪些任务信号？”`,
    kind: "topic-segment",
    segmentId: segment.segmentId,
    windowId: segment.windowId,
    timeRange: segment.timeRange,
    title: segment.title,
    transcriptExcerpt: segment.transcriptExcerpt,
    keywordHints: segment.keywordHints,
    taskSignalCount: segment.taskSignals.length,
  }));
}

function buildEvidenceFollowUpTargets(params: {
  audioFollowUpTargets: ReturnType<typeof buildAudioFollowUpTargets>;
  videoFollowUpTargets: ReturnType<typeof buildVideoFollowUpTargets>;
  historyFollowUps: string[];
  topicFollowUpTargets: ReturnType<typeof buildTopicFollowUpTargets>;
}): Array<{
  source: "audio" | "video" | "history" | "topic";
  prompt: string;
  kind: string;
  windowId?: string;
  segmentId?: string;
  timeRange?: string;
  title?: string;
  videoRequestId?: string;
  eventId?: string;
  artifactUrl?: string;
  keyframeIndex?: number;
  caption?: string;
  ocrHints?: string[];
  linkedVideoEventId?: string;
  linkedVideoArtifactId?: string;
  linkedVideoUrl?: string;
  linkedVideoTime?: string;
  linkedVideoDeltaMs?: number;
  linkMethod?: "offset-marker" | "nearest-clip" | "fallback-first-clip" | "no-clip";
  videoOffsetMs?: number;
  videoOffsetLabel?: string;
  linkedTranscriptEventId?: string;
  linkedTranscriptExcerpt?: string;
  keywordHints?: string[];
  taskSignalCount?: number;
}> {
  type EvidenceFollowUpTarget = {
    source: "audio" | "video" | "history" | "topic";
    prompt: string;
    kind: string;
    windowId?: string;
    segmentId?: string;
    timeRange?: string;
    title?: string;
    videoRequestId?: string;
    eventId?: string;
    artifactUrl?: string;
    keyframeIndex?: number;
    caption?: string;
    ocrHints?: string[];
    linkedVideoEventId?: string;
    linkedVideoArtifactId?: string;
    linkedVideoUrl?: string;
    linkedVideoTime?: string;
    linkedVideoDeltaMs?: number;
    linkMethod?: "offset-marker" | "nearest-clip" | "fallback-first-clip" | "no-clip";
    videoOffsetMs?: number;
    videoOffsetLabel?: string;
    linkedTranscriptEventId?: string;
    linkedTranscriptExcerpt?: string;
    keywordHints?: string[];
    taskSignalCount?: number;
  };

  const merged: EvidenceFollowUpTarget[] = [];
  for (const item of params.topicFollowUpTargets) {
    merged.push({
      source: "topic",
      prompt: item.prompt,
      kind: item.kind,
      segmentId: item.segmentId,
      windowId: item.windowId,
      timeRange: item.timeRange,
      title: item.title,
      keywordHints: item.keywordHints,
      taskSignalCount: item.taskSignalCount,
      linkedTranscriptExcerpt: item.transcriptExcerpt,
    });
  }
  for (const item of params.audioFollowUpTargets) {
    merged.push({
      source: "audio",
      prompt: item.prompt,
      kind: item.status,
      windowId: item.windowId,
      eventId: item.eventId,
      artifactUrl: item.artifactUrl,
    });
  }
  for (const item of params.videoFollowUpTargets) {
    merged.push({
      source: "video",
      prompt: item.prompt,
      kind: item.kind,
      videoRequestId: item.videoRequestId,
      eventId: item.eventId,
      artifactUrl: item.artifactUrl,
      keyframeIndex: item.keyframeIndex,
      caption: item.caption,
      ocrHints: item.ocrHints,
      linkedVideoEventId: item.linkedVideoEventId,
      linkedVideoArtifactId: item.linkedVideoArtifactId,
      linkedVideoUrl: item.linkedVideoUrl,
      linkedVideoTime: item.linkedVideoTime,
      linkedVideoDeltaMs: item.linkedVideoDeltaMs,
      linkMethod: item.linkMethod,
      videoOffsetMs: item.videoOffsetMs,
      videoOffsetLabel: item.videoOffsetLabel,
      linkedTranscriptEventId: item.linkedTranscriptEventId,
      linkedTranscriptExcerpt: item.linkedTranscriptExcerpt,
    });
  }
  for (const prompt of params.historyFollowUps) {
    merged.push({
      source: "history",
      prompt,
      kind: "history-follow-up",
    });
  }

  const deduped = new Map<string, (typeof merged)[number]>();
  for (const item of merged) {
    if (!deduped.has(item.prompt)) {
      deduped.set(item.prompt, item);
    }
  }
  return Array.from(deduped.values()).slice(0, 8);
}

function buildAudioFollowUpTargets(windows: EvidenceBundleWindow[]): Array<{
  windowId: string;
  timeRange: string;
  status: "transcript-ready" | "needs-recheck" | "artifact-missing";
  audioCount: number;
  eventId?: string;
  artifactUrl?: string;
  transcriptExcerpt?: string;
  prompt: string;
}> {
  const candidates = windows
    .filter((window) => window.audioCount > 0)
    .slice(0, 4)
    .map((window) => {
      const leadArtifact = window.audioArtifacts[0];
      const transcriptExcerpt = window.transcriptExcerpt?.trim() || undefined;
      if (transcriptExcerpt) {
        return {
          windowId: window.windowId,
          timeRange: window.timeRange,
          status: "transcript-ready" as const,
          audioCount: window.audioCount,
          eventId: leadArtifact?.eventId,
          artifactUrl: leadArtifact?.url,
          transcriptExcerpt,
          prompt: `你可以继续问：“${window.timeRange} 这段对话里，最关键的任务、人名和决定分别是什么？”`,
        };
      }
      if (leadArtifact?.url) {
        return {
          windowId: window.windowId,
          timeRange: window.timeRange,
          status: "needs-recheck" as const,
          audioCount: window.audioCount,
          eventId: leadArtifact.eventId,
          artifactUrl: leadArtifact.url,
          prompt: `你可以继续问：“请复核 ${window.timeRange} 这段音频，尽量提取任务、人物和结论。”`,
        };
      }
      return {
        windowId: window.windowId,
        timeRange: window.timeRange,
        status: "artifact-missing" as const,
        audioCount: window.audioCount,
        prompt: `你可以继续问：“${window.timeRange} 这段音频为什么还缺可回放素材或可用转写？”`,
      };
    });

  const deduped = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    if (!deduped.has(candidate.prompt)) {
      deduped.set(candidate.prompt, candidate);
    }
  }
  return Array.from(deduped.values()).slice(0, 3);
}

function buildVideoFollowUpTargets(videoGroups: EvidenceBundleVideoGroup[]): Array<{
  videoRequestId: string;
  timeRange: string;
  windowIds: string[];
  kind: "keyframe" | "clip" | "gap";
  eventId?: string;
  artifactId?: string;
  keyframeIndex?: number;
  frameTime?: string;
  artifactUrl?: string;
  caption?: string;
  ocrHints?: string[];
  linkedVideoEventId?: string;
  linkedVideoArtifactId?: string;
  linkedVideoUrl?: string;
  linkedVideoTime?: string;
  linkedVideoDeltaMs?: number;
  linkMethod?: "offset-marker" | "nearest-clip" | "fallback-first-clip" | "no-clip";
  videoOffsetMs?: number;
  videoOffsetLabel?: string;
  linkedTranscriptEventId?: string;
  linkedTranscriptExcerpt?: string;
  prompt: string;
}> {
  const targets = videoGroups.slice(0, 3).map((group) => {
    const firstIndexedKeyframe =
      group.keyframeDetails.find((frame) => frame.ocrHints.length > 0 && typeof frame.keyframeIndex === "number") ??
      group.keyframeDetails.find((frame) => typeof frame.keyframeIndex === "number");
    const transcriptLead = group.transcriptSpans[0];
    if (firstIndexedKeyframe && typeof firstIndexedKeyframe.keyframeIndex === "number") {
      const ocrPromptSuffix = firstIndexedKeyframe.ocrHints[0]
        ? `，尤其核对“${truncateText(firstIndexedKeyframe.ocrHints[0], 24)}”这条板书 / 屏幕文字`
        : "";
      const frameAnchor = firstIndexedKeyframe.videoOffsetLabel
        ? `片段内 ${firstIndexedKeyframe.videoOffsetLabel}`
        : firstIndexedKeyframe.time;
      return {
        videoRequestId: group.videoRequestId,
        timeRange: group.timeRange,
        windowIds: group.windowIds,
        kind: "keyframe" as const,
        eventId: firstIndexedKeyframe.eventId,
        artifactId: firstIndexedKeyframe.artifactId,
        keyframeIndex: firstIndexedKeyframe.keyframeIndex,
        frameTime: firstIndexedKeyframe.time,
        artifactUrl: firstIndexedKeyframe.url,
        caption: firstIndexedKeyframe.caption,
        ocrHints: firstIndexedKeyframe.ocrHints,
        linkedVideoEventId: firstIndexedKeyframe.linkedVideoEventId,
        linkedVideoArtifactId: firstIndexedKeyframe.linkedVideoArtifactId,
        linkedVideoUrl: firstIndexedKeyframe.linkedVideoUrl,
        linkedVideoTime: firstIndexedKeyframe.linkedVideoTime,
        linkedVideoDeltaMs: firstIndexedKeyframe.linkedDeltaMs,
        linkMethod: firstIndexedKeyframe.linkMethod,
        videoOffsetMs: firstIndexedKeyframe.videoOffsetMs,
        videoOffsetLabel: firstIndexedKeyframe.videoOffsetLabel,
        linkedTranscriptEventId: transcriptLead?.eventId,
        linkedTranscriptExcerpt: transcriptLead?.text,
        prompt: `你可以继续问：“${group.timeRange} 的第 ${firstIndexedKeyframe.keyframeIndex} 帧（${frameAnchor}）里具体发生了什么${ocrPromptSuffix}？”`,
      };
    }
    if (group.summary && isUsableVisualSummaryText(group.summary)) {
      const transcriptHint = transcriptLead
        ? `（同窗语音：${truncateText(toSingleLine(transcriptLead.text), 36)}）`
        : "";
      const ocrHint = group.semanticSignals.ocrHints[0]
        ? `，并重点确认“${truncateText(group.semanticSignals.ocrHints[0], 24)}”这条文字线索`
        : "";
      return {
        videoRequestId: group.videoRequestId,
        timeRange: group.timeRange,
        windowIds: group.windowIds,
        kind: "clip" as const,
        eventId: group.videoDetails[0]?.eventId,
        artifactId: group.videoDetails[0]?.artifactId ?? group.keyframeDetails[0]?.artifactId,
        artifactUrl: group.videoArtifactUrls[0],
        caption: group.videoDetails[0]?.caption ?? group.summary,
        ocrHints: group.semanticSignals.ocrHints,
        linkedTranscriptEventId: transcriptLead?.eventId,
        linkedTranscriptExcerpt: transcriptLead?.text,
        prompt: `你可以继续问：“${group.timeRange} 这段视频里最值得注意的细节是什么${ocrHint}${transcriptHint}？”`,
      };
    }
    if (group.videoArtifactUrls.length > 0) {
      const transcriptHint = transcriptLead
        ? `（可结合语音：${truncateText(toSingleLine(transcriptLead.text), 36)}）`
        : "";
      return {
        videoRequestId: group.videoRequestId,
        timeRange: group.timeRange,
        windowIds: group.windowIds,
        kind: "clip" as const,
        eventId: group.videoDetails[0]?.eventId,
        artifactId: group.videoDetails[0]?.artifactId,
        artifactUrl: group.videoArtifactUrls[0],
        caption: group.videoDetails[0]?.caption,
        ocrHints: group.semanticSignals.ocrHints,
        linkedTranscriptEventId: transcriptLead?.eventId,
        linkedTranscriptExcerpt: transcriptLead?.text,
        prompt: `你可以继续问：“请帮我总结 ${group.timeRange} 这段视频的关键变化${transcriptHint}。”`,
      };
    }
    return {
      videoRequestId: group.videoRequestId,
      timeRange: group.timeRange,
      windowIds: group.windowIds,
      kind: "gap" as const,
      prompt: `你可以继续问：“${group.timeRange} 这段视频为什么还缺关键帧或可用摘要？”`,
    };
  });
  const deduped = new Map<string, (typeof targets)[number]>();
  for (const target of targets) {
    if (!deduped.has(target.prompt)) {
      deduped.set(target.prompt, target);
    }
  }
  return Array.from(deduped.values()).slice(0, 3);
}

function buildIdentityHistoryFollowUpPrompt(entry: IdentityHistoryEntry): string {
  if (entry.nextWatchFor) {
    return `你可以继续问：“围绕 ${entry.displayName}，${entry.nextWatchFor}”`;
  }
  const latest = entry.recentMoments[0];
  if (latest?.transcriptExcerpt) {
    return `你可以继续问：“${entry.displayName} 在 ${latest.date} ${latest.timeRange} 具体说了什么？”`;
  }
  return `你可以继续问：“${entry.displayName} 最近一次出现时，有哪些值得我留意的细节？”`;
}

function buildAnnotationCommandHints(evidence: EvidenceBundle): string[] {
  return uniqueItems(
    evidence.annotationSuggestions.speakers
      .slice(0, 2)
      .flatMap((item) => [item.selfCommandTemplate, item.commandTemplate])
      .concat(evidence.annotationSuggestions.people.slice(0, 2).map((item) => item.commandTemplate)),
  ).slice(0, 4);
}

function parsePendingIdentityHint(hint: string): {
  name?: string;
  timeRange?: string;
  relationshipHint?: string;
  confidence: "high" | "medium";
} {
  const timeRange = hint.match(/(\d{2}:\d{2}-\d{2}:\d{2}(?:\/\d{2}:\d{2})?)/)?.[1];
  const relationshipHint = inferRelationshipHint(hint);
  const candidate = extractPendingIdentityNameFromHint(hint);
  return {
    name: candidate?.name,
    timeRange,
    relationshipHint,
    confidence: candidate?.confidence ?? "medium",
  };
}

function extractPendingIdentityNameFromHint(hint: string): {
  name: string;
  confidence: "high" | "medium";
} | null {
  const direct = normalizeIdentityNameCandidate(hint.match(/待确认人物：([^（(；;]+)/)?.[1] ?? "");
  if (direct && looksLikelyIdentityName(direct)) {
    return { name: direct, confidence: "high" };
  }
  const roleBased = normalizeIdentityNameCandidate(
    hint.match(new RegExp(`${ROLE_HINT_PREFIX_PATTERN}\\s*(${PERSON_NAME_TOKEN_PATTERN})`, "u"))?.[1] ?? "",
  );
  if (roleBased && looksLikelyIdentityName(roleBased)) {
    return { name: roleBased, confidence: "medium" };
  }
  return null;
}

function inferRelationshipHint(text: string): string | undefined {
  const explicit = text.match(/角色[:：]\s*(老板|同事|老师|同学|客户)/i)?.[1];
  if (explicit) {
    if (/老板/i.test(explicit)) {
      return "老板";
    }
    if (/同事/i.test(explicit)) {
      return "同事";
    }
    if (/老师/i.test(explicit)) {
      return "老师";
    }
    if (/同学/i.test(explicit)) {
      return "同学";
    }
    if (/客户/i.test(explicit)) {
      return "客户";
    }
  }
  if (/老板|经理|上级|主管/i.test(text)) {
    return "老板";
  }
  if (/老师|导师|班主任|助教/i.test(text)) {
    return "老师";
  }
  if (/同学/i.test(text)) {
    return "同学";
  }
  if (/客户/i.test(text)) {
    return "客户";
  }
  if (/同事|运维|售前|运营|产品|开发/i.test(text)) {
    return "同事";
  }
  return undefined;
}

function extractLeadingRoleWord(rawValue: string): string | undefined {
  const matched = rawValue.trim().match(new RegExp(`^(${ROLE_HINT_PREFIX_PATTERN})`, "u"));
  return matched?.[1]?.trim() || undefined;
}

function normalizeRelationshipFromRole(roleWord: string): string | undefined {
  if (/老板|经理|主管|主任/i.test(roleWord)) {
    return "老板";
  }
  if (/老师|导师|教授|讲师|助教|班主任/i.test(roleWord)) {
    return "老师";
  }
  if (/同学/i.test(roleWord)) {
    return "同学";
  }
  if (/客户/i.test(roleWord)) {
    return "客户";
  }
  if (/同事|运维|售前|运营|产品/i.test(roleWord)) {
    return "同事";
  }
  return undefined;
}

function toPersonRefCandidate(displayName: string): string {
  const normalized = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized) {
    return `person_${normalized.slice(0, 40)}`;
  }
  return `person_auto_${shortStableHash(displayName).slice(0, 8)}`;
}

function shortStableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function buildProjectSummaries(
  payload: AssistantContextPayload,
  windows: EvidenceBundleWindow[],
): EvidenceBundle["projects"] {
  const projectMap = new Map<
    string,
    {
      ref: string;
      label: string;
      source: EvidenceBundle["projects"][number]["source"];
      evidenceCount: number;
      windowIds: Set<string>;
    }
  >();

  const pushProject = (
    ref: string,
    label: string,
    source: EvidenceBundle["projects"][number]["source"],
    windowId?: string,
  ) => {
    const normalizedRef = ref.trim();
    const normalizedLabel = label.trim();
    if (!normalizedRef || !normalizedLabel) {
      return;
    }
    const existing =
      projectMap.get(normalizedRef) ??
      {
        ref: normalizedRef,
        label: normalizedLabel,
        source,
        evidenceCount: 0,
        windowIds: new Set<string>(),
      };
    existing.label = chooseProjectLabel(existing.label, normalizedLabel);
    if (compareProjectSourcePriority(source, existing.source) < 0) {
      existing.source = source;
    }
    existing.evidenceCount += 1;
    if (windowId) {
      existing.windowIds.add(windowId);
    }
    projectMap.set(normalizedRef, existing);
  };

  for (const window of windows) {
    for (const projectRef of uniqueItems(window.projectRefs ?? [])) {
      pushProject(projectRef, humanizeProjectLabel(projectRef), "project-ref", window.windowId);
    }
    for (const tag of uniqueItems(window.tags ?? []).filter(isProjectLikeTag)) {
      pushProject(`tag:${tag}`, humanizeProjectLabel(tag), "tag", window.windowId);
    }
  }

  for (const project of payload.consolidation?.projects ?? []) {
    pushProject(project.ref, project.label, project.source, project.windowIds[0]);
  }

  for (const item of readSectionItems(payload, "关键项目 / 主题").map(stripSectionPrefix).filter(Boolean).slice(0, 4)) {
    pushProject(`review:${toProjectRef(item)}`, item, "review-section");
  }

  return Array.from(projectMap.values())
    .sort(
      (left, right) =>
        right.evidenceCount - left.evidenceCount ||
        compareProjectSourcePriority(left.source, right.source) ||
        left.label.localeCompare(right.label, "zh-CN"),
    )
    .slice(0, 6)
    .map((item) => ({
      ref: item.ref,
      label: item.label,
      source: item.source,
      evidenceCount: item.evidenceCount,
      windowIds: Array.from(item.windowIds),
    }));
}

function collectStructuredScenarioSignals(
  payload: AssistantContextPayload,
  windows: EvidenceBundleWindow[],
): string[] {
  return uniqueItems(
    windows
      .flatMap((window) => window.tags.concat(window.projectRefs))
      .concat(payload.highlights.people.map((person) => person.relationship ?? ""))
      .concat(payload.highlights.speakers.map((speaker) => speaker.relationship ?? ""))
      .concat(payload.consolidation?.projects.flatMap((project) => [project.ref, project.label]) ?? [])
      .concat(payload.consolidation?.tasks ?? [])
      .concat(payload.consolidation?.learningPoints ?? []),
  ).map((item) => item.toLowerCase());
}

function scoreStructuredScenarioHits(signals: string[], keywords: string[]): number {
  const normalizedKeywords = keywords.map((keyword) => keyword.toLowerCase());
  let score = 0;
  for (const signal of signals) {
    if (normalizedKeywords.some((keyword) => signal.includes(keyword))) {
      score += 1;
    }
  }
  return Math.min(score, 5);
}

function isProjectLikeTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return ![
    "audio-window",
    "active-window",
    "baseline-snapshot",
    "office",
    "study",
    "social",
  ].includes(normalized);
}

function humanizeProjectLabel(value: string): string {
  const normalized = value.trim().replace(/^tag:/, "").replace(/^review:/, "");
  const aliases: Record<string, string> = {
    class: "课堂主线",
    lecture: "课堂主线",
    demo: "演示",
    demo_prep: "演示准备",
    quote: "报价",
    quote_followup: "报价跟进",
    meeting: "会议",
    "meeting-notes": "会议纪要",
    meeting_notes: "会议纪要",
    report: "汇报",
    report_followup: "汇报跟进",
    classroom: "课堂内容",
    course_notes: "课程重点",
    homework: "作业",
    homework_followup: "作业跟进",
    exam: "考试复习",
    exam_prep: "考试复习",
    experiment: "实验任务",
    lab_work: "实验任务",
    launch: "上线主线",
    launch_checklist: "上线清单",
  };
  return aliases[normalized] ?? normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function toProjectRef(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/^_+|_+$/g, "");
  return normalized || "project";
}

function chooseProjectLabel(left: string, right: string): string {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.length >= right.length ? left : right;
}

function compareProjectSourcePriority(
  left: EvidenceBundle["projects"][number]["source"],
  right: EvidenceBundle["projects"][number]["source"],
): number {
  const priority: Record<EvidenceBundle["projects"][number]["source"], number> = {
    "project-ref": 0,
    tag: 1,
    "review-section": 2,
  };
  return priority[left] - priority[right];
}

function shouldAttemptQueryTimeAudioReview(
  payload: AssistantContextPayload,
  focus: "general" | "what_happened" | "watch_for",
  question?: string,
): boolean {
  const hasAudioGap = payload.windows.some(
    (window) => window.audioCount > 0 && !window.transcriptText.trim(),
  );
  if (!hasAudioGap) {
    return false;
  }
  if (focus === "what_happened") {
    return true;
  }
  const normalizedQuestion = (question ?? "").toLowerCase();
  return /音频|语音|对话|会议|课堂|老师|同事|老板|人物|任务|学习|要点|发生了什么|讲了什么|说了什么|谁说|谁讲|跟进/.test(
    normalizedQuestion,
  );
}

function shouldAttemptIdentityHistory(question?: string): boolean {
  if (!question) {
    return false;
  }
  const normalized = question.toLowerCase();
  return /之前|以前|历史|过往|过去.*记录|出现过|见过|这个.*之前|这位.*之前|回顾.*(这个人|此人|这个发言者|这个speaker|这个 speaker|这个老板|这个老师|这个同事|这个同学|这位老板|这位老师|这位同事|这位同学)/.test(
    normalized,
  );
}

function shouldAttemptProjectHistory(question?: string): boolean {
  if (!question) {
    return false;
  }
  return /之前|以前|历史|过往|过去.*记录|出现过|记录过|回顾.*(这个项目|这个主题|这条主线)|这个项目.*之前|这个主题.*之前|这个主线.*之前/.test(
    question.toLowerCase(),
  );
}

function inferQuestionIntent(question?: string): {
  conversation: boolean;
  video: boolean;
  watchFor: boolean;
  happened: boolean;
} {
  const normalized = (question ?? "").toLowerCase();
  return {
    conversation:
      /音频|语音|录音|转写|对话|沟通|会议|课堂|老师|同事|老板|人物|任务|学习|要点|重点|聊了什么|讲了什么|说了什么|谁说|谁讲|怎么回复|讨论|谈了什么|跟进/.test(
        normalized,
      ),
    video: /视频|访谈|采访|播放|看片|看了.*视频|字幕|片段|主讲|主播|画面里|屏幕上/.test(normalized),
    watchFor: /注意|提醒|待办|待跟进|跟进|风险|遗漏|需要我|有什么要|下一步|任务落给谁/.test(normalized),
    happened: /发生了什么|发生什么|有什么|总结|回顾|刚才|刚刚|过去|昨天|今天|这几天|最近|重点|要点|聊了什么|说了什么|讲了什么|看到了什么|在看什么/.test(
      normalized,
    ),
  };
}

function inferFocusFromQuestion(question?: string): "what_happened" | "watch_for" | undefined {
  if (!question) {
    return undefined;
  }
  const intent = inferQuestionIntent(question);
  if (intent.watchFor && !/发生了什么|发生什么|聊了什么|说了什么|讲了什么|重点|要点|总结|回顾/.test(question)) {
    return "watch_for";
  }
  if (intent.happened || intent.conversation || intent.video) {
    return "what_happened";
  }
  return undefined;
}

function shouldDefaultToRecentMeetingLookback(question?: string): boolean {
  if (!question) {
    return false;
  }
  const normalized = question.replace(/\s+/g, "").toLowerCase();
  return /会议纪要|会议总结|整理.*纪要|整理.*会议|会议.*重点|会议.*任务|会议.*待办|会议.*谁负责|meetingnotes|meetingminutes/.test(
    normalized,
  );
}

function resolveQueryTimeAudioReviewMaxWindows(
  payload: AssistantContextPayload,
  focus: "general" | "what_happened" | "watch_for",
  question?: string,
): number {
  const pendingWindows = resolveAudioCoverage(payload).pendingAudioWindows;
  if (pendingWindows <= 1) {
    return 1;
  }
  if (focus === "what_happened") {
    return Math.min(4, pendingWindows);
  }
  const normalizedQuestion = (question ?? "").toLowerCase();
  if (/任务|人物|老板|同事|老师|同学|学习|课堂|会议|要点|跟进|谁说|谁讲/.test(normalizedQuestion)) {
    return Math.min(4, Math.max(2, pendingWindows));
  }
  return Math.min(2, pendingWindows);
}

function inferScopeFromQuestion(question?: string): "last-hour" | "today" | undefined {
  if (!question) {
    return undefined;
  }
  const normalized = question.toLowerCase();
  if (/过去一小时|最近一小时|last hour|last-hour|recent hour/.test(normalized)) {
    return "last-hour";
  }
  return undefined;
}

function inferCustomRangeFromQuestion(question?: string): { startAt: number; endAt: number } | undefined {
  if (!question) {
    return undefined;
  }
  const normalized = question.replace(/\s+/g, "").toLowerCase();
  const now = new Date();
  const nowTs = now.getTime();

  if (/最近7天|近7天|过去7天|最近一周|近一周|过去一周|last7days|past7days/.test(normalized)) {
    return {
      startAt: startOfDay(addDays(now, -6)).getTime(),
      endAt: nowTs,
    };
  }
  if (/最近3天|近3天|过去3天/.test(normalized)) {
    return {
      startAt: startOfDay(addDays(now, -2)).getTime(),
      endAt: nowTs,
    };
  }
  if (/本周|这周|本星期|这星期|thisweek/.test(normalized)) {
    return {
      startAt: startOfWeekMonday(now).getTime(),
      endAt: nowTs,
    };
  }
  if (/上周|上一周|上星期|lastweek/.test(normalized)) {
    const thisWeekStart = startOfWeekMonday(now);
    const lastWeekStart = addDays(thisWeekStart, -7);
    const lastWeekEnd = new Date(thisWeekStart.getTime() - 1);
    return {
      startAt: lastWeekStart.getTime(),
      endAt: lastWeekEnd.getTime(),
    };
  }

  const explicitRange = inferExplicitDateTimeRange(question, now);
  if (explicitRange) {
    return explicitRange;
  }

  const relativeDurationMs = parseRelativeDurationMs(normalized);
  if (relativeDurationMs) {
    const anchoredEndAt = parseAnchorEndTimestamp(question, now);
    if (anchoredEndAt && /结束|截止|之前|往前|向前|倒推|为止|以前/.test(normalized)) {
      return {
        startAt: anchoredEndAt - relativeDurationMs,
        endAt: anchoredEndAt,
      };
    }
    if (/过去|最近|近|前|之前|往前|向前|last|past/.test(normalized)) {
      return {
        startAt: nowTs - relativeDurationMs,
        endAt: nowTs,
      };
    }
  }
  return undefined;
}

function inferDateFromQuestion(question?: string): string | undefined {
  if (!question) {
    return undefined;
  }

  const now = new Date();
  const normalized = question.replace(/\s+/g, "");

  if (/今天|今日/.test(normalized)) {
    return formatDateKey(now);
  }
  if (/大前天/.test(normalized)) {
    return formatDateKey(addDays(now, -3));
  }
  if (/前天/.test(normalized)) {
    return formatDateKey(addDays(now, -2));
  }
  if (/昨晚|昨天/.test(normalized)) {
    return formatDateKey(addDays(now, -1));
  }

  const dateMention = parseDateMention(question, now);
  if (dateMention) {
    return dateMention.dateKey;
  }

  return undefined;
}

function inferExplicitDateTimeRange(question: string, now: Date): { startAt: number; endAt: number } | undefined {
  const dateKey = inferDateFromQuestion(question) ?? formatDateKey(now);
  const match = question.match(
    /(\d{1,2})(?:[:：](\d{1,2}))?\s*(?:点)?\s*(?:-|~|到|至|—|–)\s*(\d{1,2})(?:[:：](\d{1,2}))?\s*(?:点)?/,
  );
  if (!match) {
    return undefined;
  }
  const startHour = Number(match[1]);
  const startMinute = Number(match[2] ?? 0);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4] ?? 0);
  if (!isValidClockTime(startHour, startMinute) || !isValidClockTime(endHour, endMinute)) {
    return undefined;
  }
  const startAt = timestampFromDateKey(dateKey, startHour, startMinute);
  let endAt = timestampFromDateKey(dateKey, endHour, endMinute);
  if (endAt <= startAt) {
    endAt += ONE_DAY_MS;
  }
  return { startAt, endAt };
}

function parseAnchorEndTimestamp(question: string, now: Date): number | undefined {
  const dateKey = inferDateFromQuestion(question);
  const clock = parseClockTime(question);
  if (dateKey && clock) {
    return timestampFromDateKey(dateKey, clock.hour, clock.minute);
  }
  if (dateKey) {
    return timestampFromDateKey(dateKey, 23, 59, 59, 999);
  }
  if (clock) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.hour, clock.minute, 0, 0).getTime();
  }
  return undefined;
}

function parseDateMention(question: string, now: Date): { dateKey: string; year: number; month: number; day: number } | undefined {
  const normalized = question.replace(/\s+/g, "");
  const isoMatch = normalized.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|号)?/);
  if (isoMatch) {
    return buildDateMention(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }
  const monthDayMatch = normalized.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})[日号]?/);
  if (monthDayMatch) {
    const year = Number(monthDayMatch[1] ?? now.getFullYear());
    return buildDateMention(year, Number(monthDayMatch[2]), Number(monthDayMatch[3]));
  }
  return undefined;
}

function buildDateMention(
  year: number,
  month: number,
  day: number,
): { dateKey: string; year: number; month: number; day: number } | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return {
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    month,
    day,
  };
}

function parseClockTime(question: string): { hour: number; minute: number } | undefined {
  const colonMatch = question.match(/(\d{1,2})[:：](\d{1,2})/);
  if (colonMatch) {
    const hour = Number(colonMatch[1]);
    const minute = Number(colonMatch[2]);
    return isValidClockTime(hour, minute) ? { hour, minute } : undefined;
  }
  const dotMatch = question.match(/(\d{1,2})点(半|(\d{1,2})分?)?/);
  if (dotMatch) {
    const hour = Number(dotMatch[1]);
    const minute = dotMatch[2] === "半" ? 30 : Number(dotMatch[3] ?? 0);
    return isValidClockTime(hour, minute) ? { hour, minute } : undefined;
  }
  return undefined;
}

function parseRelativeDurationMs(normalizedQuestion: string): number | undefined {
  const match = normalizedQuestion.match(
    /(\d+(?:\.\d+)?|一|二|两|三|四|五|六|七|八|九|十|十一|十二|十三|十四|十五|二十|三十|半)(?:个)?(小时|钟头|分钟|分|天)/,
  );
  if (!match) {
    return undefined;
  }
  const amount = parseDurationAmount(match[1]);
  if (!amount || amount <= 0) {
    return undefined;
  }
  const unit = match[2];
  if (unit === "小时" || unit === "钟头") {
    return amount * ONE_HOUR_MS;
  }
  if (unit === "分钟" || unit === "分") {
    return amount * ONE_MINUTE_MS;
  }
  if (unit === "天") {
    return amount * ONE_DAY_MS;
  }
  return undefined;
}

function parseDurationAmount(raw: string): number | undefined {
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const chineseNumbers: Record<string, number> = {
    半: 0.5,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    十一: 11,
    十二: 12,
    十三: 13,
    十四: 14,
    十五: 15,
    二十: 20,
    三十: 30,
  };
  return chineseNumbers[raw];
}

function isValidClockTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function timestampFromDateKey(dateKey: string, hour: number, minute: number, second = 0, millisecond = 0): number {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day, hour, minute, second, millisecond).getTime();
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function startOfWeekMonday(date: Date): Date {
  const day = date.getDay();
  const distanceToMonday = day === 0 ? 6 : day - 1;
  return startOfDay(addDays(date, -distanceToMonday));
}

function addDays(base: Date, deltaDays: number): Date {
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + deltaDays);
  return next;
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function resolveAudioCoverage(
  payload: Pick<AssistantContextPayload, "windows" | "highlights">,
): AssistantContextPayload["highlights"]["audioCoverage"] {
  if (payload.highlights.audioCoverage) {
    return payload.highlights.audioCoverage;
  }
  const audioWindows = payload.windows.filter((window) => window.audioCount > 0);
  const transcriptReadyWindows = audioWindows.filter((window) => Boolean(window.transcriptText.trim()));
  const degradedAudioEvents = payload.windows.reduce(
    (count, window) =>
      count +
      window.events.filter((event) => event.modality === "audio" && event.analysisStatus === "degraded").length,
    0,
  );
  return {
    totalAudioWindows: audioWindows.length,
    transcriptReadyWindows: transcriptReadyWindows.length,
    pendingAudioWindows: Math.max(0, audioWindows.length - transcriptReadyWindows.length),
    degradedAudioEvents,
  };
}

function resolveVideoCoverage(videoGroups: EvidenceBundleVideoGroup[]): {
  totalVideoGroups: number;
  groupsWithVideoArtifacts: number;
  groupsWithKeyframes: number;
  groupsWithSemanticSummary: number;
  groupsNeedingFollowUp: number;
  groupsWithOcrHints: number;
  linkedKeyframes: number;
  totalKeyframes: number;
} {
  const groupsWithVideoArtifacts = videoGroups.filter((group) => group.videoArtifactUrls.length > 0).length;
  const groupsWithKeyframes = videoGroups.filter((group) => group.keyframeEventIds.length > 0).length;
  const groupsWithSemanticSummary = videoGroups.filter((group) => isUsableVisualSummaryText(group.summary)).length;
  const groupsWithOcrHints = videoGroups.filter((group) => group.semanticSignals.ocrHints.length > 0).length;
  const linkedKeyframes = videoGroups.reduce((count, group) => count + group.semanticSignals.linkedKeyframes, 0);
  const totalKeyframes = videoGroups.reduce((count, group) => count + group.semanticSignals.totalKeyframes, 0);
  const groupsNeedingFollowUp = videoGroups.filter(
    (group) =>
      group.videoArtifactUrls.length === 0 ||
      (group.keyframeEventIds.length === 0 && !isUsableVisualSummaryText(group.summary)),
  ).length;
  return {
    totalVideoGroups: videoGroups.length,
    groupsWithVideoArtifacts,
    groupsWithKeyframes,
    groupsWithSemanticSummary,
    groupsNeedingFollowUp,
    groupsWithOcrHints,
    linkedKeyframes,
    totalKeyframes,
  };
}

function formatScenarioLabel(candidate: EvidenceBundle["scenarioProfile"]["candidate"]): string {
  switch (candidate) {
    case "work":
      return "偏办公场景";
    case "study":
      return "偏课堂 / 学习场景";
    case "social":
      return "偏社交场景";
    default:
      return "通用场景";
  }
}

function formatScenarioConfidence(confidence: EvidenceBundle["scenarioProfile"]["confidence"]): string {
  switch (confidence) {
    case "high":
      return "高置信";
    case "medium":
      return "中置信";
    default:
      return "低置信";
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function buildPersonAnnotationText(annotation: {
  personRef: string;
  displayName: string;
  relationship?: string;
  notes?: string;
  nextWatchFor?: string;
}): string {
  const lines = [`已写入 ClawSense 人物标注：${annotation.displayName}（ref: ${annotation.personRef}）`];
  if (annotation.relationship) {
    lines.push(`关系：${annotation.relationship}`);
  }
  if (annotation.notes) {
    lines.push(`备注：${annotation.notes}`);
  }
  if (annotation.nextWatchFor) {
    lines.push(`下次留意：${annotation.nextWatchFor}`);
  }
  return lines.join("\n");
}

function buildSpeakerAnnotationText(annotation: {
  speakerRef: string;
  displayName: string;
  relationship?: string;
  notes?: string;
}): string {
  const lines = [`已写入 ClawSense 说话人标注：${annotation.displayName}（ref: ${annotation.speakerRef}）`];
  if (annotation.relationship) {
    lines.push(`关系：${annotation.relationship}`);
  }
  if (annotation.notes) {
    lines.push(`备注：${annotation.notes}`);
  }
  return lines.join("\n");
}
