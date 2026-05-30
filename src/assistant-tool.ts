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
const EVIDENCE_BUNDLE_SCHEMA_VERSION = "2026-05-30";

function enumString<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

export const ClawSenseContextToolSchema = Type.Object(
  {
    scope: Type.Optional(enumString(TOOL_SCOPE, "Time scope: today or last-hour.")),
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
          "Optional original user question. Helps ClawSense prioritize the most relevant evidence windows for the host model.",
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
  const inferredRange =
    !rawParams.scope && !customRange && !lookbackRange ? inferCustomRangeFromQuestion(question) : undefined;
  const effectiveRange = customRange ?? lookbackRange ?? inferredRange;
  const inferredScope = rawParams.scope
    ? undefined
    : inferScopeFromQuestion(question);
  const scope =
    effectiveRange
      ? "custom-range"
      : rawParams.scope === "last-hour" || inferredScope === "last-hour"
        ? "last-hour"
        : "today";
  const focus = rawParams.focus ?? "general";
  const inferredDate =
    scope === "today" && !rawParams.date ? inferDateFromQuestion(question) : undefined;
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
  const lines = [`ClawSense ${periodLabel}证据包`, `总览：${payload.summary}`];
  lines.push(
    `素材覆盖：${payload.counts.events} 条事件 / ${payload.counts.windows} 个时间窗 / ${payload.counts.artifacts} 个媒体文件 / ${payload.counts.devices} 台设备。`,
  );
  if (evidence.audioCoverage.totalAudioWindows > 0) {
    lines.push(
      `音频覆盖：${evidence.audioCoverage.transcriptReadyWindows}/${evidence.audioCoverage.totalAudioWindows} 个音频窗口已有可引用转写，仍有 ${evidence.audioCoverage.pendingAudioWindows} 个待补强窗口。`,
    );
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
  lines.push("额外约束：如果画面全黑或疑似被遮挡，只能说“黑暗环境 / 镜头可能被遮挡，待确认”，不要推断设备关闭、故障或休眠。");
  lines.push("如果下面提供了原始音频 URL，且当前主模型支持音频理解，请优先结合原始音频复核，再回答具体对话或学习/会议内容。");
  lines.push("人物处理规则：把“已确认人物”“待确认视觉人物”“待确认角色线索”“speaker 占位”分开；不要把待确认角色写成已确认身份，也不要写“可能是你/同事/演讲参与者”这类猜测。");
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
  if (evidence.speakerLayer.suggestedSlots.some((slot) => !slot.displayName)) {
    lines.push("  可继续动作：如果你知道某个 speaker 是谁，可以直接说“speaker_1 是我同事李三”这类标注。");
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
  const evidenceFollowUpTargets = buildEvidenceFollowUpTargets({
    audioFollowUpTargets,
    videoFollowUpTargets,
    historyFollowUps,
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
      audioFollowUps,
      audioFollowUpTargets,
      videoCoverage: evidence.videoCoverage,
      videoFollowUps,
      videoFollowUpTargets,
      evidenceFollowUpTargets,
      avoidGuessingDarkState: true,
      scenarioProfile: evidence.scenarioProfile,
      practicalOutputs: evidence.practicalOutputs,
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
  const peopleByRef = new Map(
    payload.highlights.people.map((person) => [
      person.personRef,
      `${person.displayName}${person.relationship ? `（${person.relationship}）` : ""}`,
    ]),
  );

  const windows = payload.windows
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
        ? truncateText(toSingleLine(window.transcriptText), 180)
        : undefined;
      const degradedCount = window.events.filter((event) => event.analysisStatus === "degraded").length;
      const audioArtifacts = window.events
        .filter((event) => event.modality === "audio" && Boolean(event.artifact?.url))
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
      const score =
        (keyWindowIds.has(window.windowId) ? 40 : 0) +
        questionBoost +
        window.audioCount * 6 +
        window.imageCount * 4 +
        videoCount * 5 +
        (window.transcriptText.trim() ? 10 : 0) -
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
    .sort((left, right) => right.score - left.score || right.endedAt - left.endedAt)
    .slice(0, focus === "what_happened" ? 6 : 3);
  const darkImageHintCount = payload.highlights.recentImages.filter((image) => looksDarkOrOccluded(image.summary)).length;
  const degradedEventCount = payload.windows.reduce(
    (count, window) => count + window.events.filter((event) => event.analysisStatus === "degraded").length,
    0,
  );
  const transcriptWindowCount = windows.filter((window) => Boolean(window.transcriptExcerpt)).length;
  const videoEvidenceGroups = buildVideoEvidenceGroups(payload, windows);
  const scenarioProfile = buildScenarioProfile(payload, windows, videoEvidenceGroups);
  const speakerLayer = buildSpeakerLayer(payload, transcriptWindowCount);
  const practicalOutputs = buildPracticalOutputs(payload, scenarioProfile, speakerLayer, windows, videoEvidenceGroups);
  const projects = buildProjectSummaries(payload, windows);
  const fragments = buildEvidenceFragments(payload, windows, videoEvidenceGroups);
  const audioCoverage = resolveAudioCoverage(payload);
  const videoCoverage = resolveVideoCoverage(videoEvidenceGroups);
  const transcriptSpans = buildTranscriptSpans(payload, windows);
  const artifactRefs = buildArtifactRefs(payload, windows);
  const annotationSuggestions = buildAnnotationSuggestions({
    speakerLayer,
    roleHints: practicalOutputs.roleHints,
  });
  const topEvidence = buildTopEvidence(fragments);

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
          artifactUrl: event.artifact?.url,
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
        if (!artifact) {
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
              artifactUrl: event.artifact?.url,
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
      note: "当前已经有可引用的音频窗口。下一步可以把这些 speaker 占位映射成“我同事李三”“我老板 Amy”这类稳定标签。",
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
  return /确认|准备|提交|检查|跟进|安排|记得|完成|复习|整理|发送/i.test(text);
}

function looksActionCue(text: string): boolean {
  return /要|需要|先|再|记得|请|麻烦|会后|补上|补齐|发给|带上|整理好|准备好|确认下|跟一下/i.test(text);
}

function looksDeadlineCue(text: string): boolean {
  return /明天|今晚|下午|早上|周一|下周|截止|之前|尽快|稍后|会后|课后/i.test(text);
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
  const prompts = evidence.annotationSuggestions.speakers
    .slice(0, 2)
    .map((item) => `如果你知道 ${item.slotLabel} 是谁，可以直接说：“${item.sentenceTemplate}”`)
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

function buildEvidenceFollowUpTargets(params: {
  audioFollowUpTargets: ReturnType<typeof buildAudioFollowUpTargets>;
  videoFollowUpTargets: ReturnType<typeof buildVideoFollowUpTargets>;
  historyFollowUps: string[];
}): Array<{
  source: "audio" | "video" | "history";
  prompt: string;
  kind: string;
  windowId?: string;
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
}> {
  type EvidenceFollowUpTarget = {
    source: "audio" | "video" | "history";
    prompt: string;
    kind: string;
    windowId?: string;
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
  };

  const merged: EvidenceFollowUpTarget[] = [];
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
      .map((item) => item.commandTemplate)
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
  if (/昨晚|昨天/.test(normalized)) {
    return formatDateKey(addDays(now, -1));
  }
  if (/前天/.test(normalized)) {
    return formatDateKey(addDays(now, -2));
  }
  if (/大前天/.test(normalized)) {
    return formatDateKey(addDays(now, -3));
  }

  const isoMatch = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch?.[1]) {
    return isoMatch[1];
  }

  const monthDayMatch = normalized.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})[日号]?/);
  if (monthDayMatch) {
    const year = Number(monthDayMatch[1] ?? now.getFullYear());
    const month = Number(monthDayMatch[2]);
    const day = Number(monthDayMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return undefined;
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
