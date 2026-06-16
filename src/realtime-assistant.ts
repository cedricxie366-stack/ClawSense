import type { ClawSenseReviewEngine } from "./review-engine.js";

export type RecentContextWindowHint = "last_15s" | "last_60s" | "last_5m" | "custom";
export type AssistantModeHint = "auto" | "meeting" | "desk";

type AssistantContextPayload = Awaited<ReturnType<ClawSenseReviewEngine["buildAssistantContext"]>>;

export type RecentContextPayload = {
  windowHint: RecentContextWindowHint;
  modeUsed: AssistantModeHint;
  timeRange: {
    startAt: number;
    endAt: number;
    label: string;
  };
  overview?: {
    kind: "recent" | "custom" | "day";
    date: string;
    summary: string;
    counts: { events: number; windows: number; artifacts: number; devices: number };
    audioCoverage: {
      totalAudioWindows: number;
      transcriptReadyWindows: number;
      pendingAudioWindows: number;
      degradedAudioEvents: number;
    };
    reviewItems: string[];
    keyWindowSummaries: string[];
  };
  sceneSummary: string;
  recentTranscriptSpans: Array<{
    windowId: string;
    eventId: string;
    capturedAt: number;
    time: string;
    text: string;
    artifactUrl?: string;
  }>;
  peopleHints: Array<{
    kind: "person" | "speaker";
    ref: string;
    displayName: string;
    relationship?: string;
  }>;
  attentionHints: string[];
  taskHints: string[];
  topEvidence: Array<{
    windowId: string;
    timeRange: string;
    summary: string;
    transcriptExcerpt?: string;
    artifactUrls: string[];
    people: string[];
  }>;
  counts: {
    windows: number;
    events: number;
    transcriptSpans: number;
    audioEvents: number;
    pendingAudioWindows: number;
  };
};

export type AssistantAnswerPayload = {
  queryText: string;
  answerText: string;
  answerSpokenText: string;
  supportingEvidence: Array<{
    windowId: string;
    timeRange: string;
    summary: string;
    transcriptExcerpt?: string;
    artifactUrls: string[];
  }>;
  modeUsed: AssistantModeHint;
  answeredAt: number;
  answerSource?: "template" | "model";
  actionIntent?: AssistantActionIntent;
};

export type AssistantActionIntent = {
  type: "none" | "draft_document";
  title?: string;
  reason?: string;
  contentHint?: string;
  fileName?: string;
  filePath?: string;
};

export type AssistantModelPrompt = {
  system: string;
  user: string;
};

export type AssistantConversationTurn = {
  queryText: string;
  answerText: string;
  answerSpokenText?: string;
  answeredAt: number;
  modeUsed: AssistantModeHint;
  timeRange?: RecentContextPayload["timeRange"];
  actionIntent?: AssistantAnswerPayload["actionIntent"];
};

export type AssistantDraftDocument = {
  title: string;
  markdown: string;
};

export type AssistantQueryResolution = {
  queryText: string;
  rawQueryText: string;
  replaced: boolean;
  reason?: "ambient_transcript_too_long" | "ambient_transcript_no_question";
};

export type AssistantAudioRecheckPlan = {
  shouldRecheck: boolean;
  maxWindows: number;
  reason?: "pending_audio_summary" | "pending_audio_question" | "pending_audio_meeting";
};

export function resolveAssistantQueryText(params: {
  queryText: string;
  modeHint?: AssistantModeHint;
  explicitQuery?: boolean;
}): AssistantQueryResolution {
  const rawQueryText = normalizeQuestion(params.queryText);
  if (!rawQueryText) {
    return {
      queryText: "",
      rawQueryText,
      replaced: false,
    };
  }
  const normalizedQueryText = normalizeAssistantQueryAliases(rawQueryText);
  if (normalizedQueryText !== rawQueryText) {
    return {
      queryText: normalizedQueryText,
      rawQueryText,
      replaced: true,
      reason: undefined,
    };
  }
  const extracted = extractSupportedShortQuestion(rawQueryText);
  if (extracted) {
    return {
      queryText: extracted,
      rawQueryText,
      replaced: extracted !== rawQueryText,
      reason: extracted !== rawQueryText ? "ambient_transcript_too_long" : undefined,
    };
  }
  if (params.explicitQuery && isLikelyExplicitSpokenQuery(rawQueryText)) {
    return {
      queryText: rawQueryText,
      rawQueryText,
      replaced: false,
    };
  }
  if (looksLikeAmbientQueryTranscript(rawQueryText)) {
    return {
      queryText: "",
      rawQueryText,
      replaced: true,
      reason: rawQueryText.length > 80 ? "ambient_transcript_too_long" : "ambient_transcript_no_question",
    };
  }
  if (!hasSupportedQuestionCue(rawQueryText)) {
    return {
      queryText: "",
      rawQueryText,
      replaced: true,
      reason: "ambient_transcript_no_question",
    };
  }
  return {
    queryText: rawQueryText,
    rawQueryText,
    replaced: false,
  };
}

export async function buildRecentContextPayload(params: {
  reviewEngine: ClawSenseReviewEngine;
  artifactUrlBase: string;
  windowHint?: RecentContextWindowHint;
  question?: string;
  deviceId?: string;
  modeHint?: AssistantModeHint;
  timeRangeOverride?: {
    startAt: number;
    endAt: number;
  };
  now?: number;
}): Promise<{ recentContext: RecentContextPayload; context: AssistantContextPayload }> {
  const now = params.now ?? Date.now();
  const requestedWindowHint = params.windowHint ?? "last_60s";
  const range =
    params.timeRangeOverride &&
    Number.isFinite(params.timeRangeOverride.startAt) &&
    Number.isFinite(params.timeRangeOverride.endAt) &&
    params.timeRangeOverride.endAt > params.timeRangeOverride.startAt
      ? {
          kind: "custom" as const,
          windowHint: "custom" as const,
          startAt: params.timeRangeOverride.startAt,
          endAt: params.timeRangeOverride.endAt,
        }
      : resolveRecentContextRange({
          requestedWindowHint,
          question: params.question,
          modeHint: params.modeHint,
          now,
        });
  const context =
    range.kind === "day"
      ? await params.reviewEngine.buildAssistantContext({
          scope: "today",
          date: range.date,
          question: params.question,
          deviceId: params.deviceId,
          artifactUrlBase: params.artifactUrlBase,
          now,
        })
      : await params.reviewEngine.buildAssistantContext({
          scope: "custom-range",
          startAt: range.startAt,
          endAt: range.endAt,
          question: params.question,
          deviceId: params.deviceId,
          artifactUrlBase: params.artifactUrlBase,
          now,
        });
  const modeUsed = inferAssistantMode({
    requestedMode: params.modeHint,
    question: params.question,
    context,
  });
  const transcriptSpanLimit = range.kind === "recent" ? 5 : range.kind === "custom" ? 16 : 20;
  const evidenceLimit = range.kind === "recent" ? 3 : range.kind === "custom" ? 8 : 10;
  const transcriptSpans = buildTranscriptSpans(context, transcriptSpanLimit);
  const audioEvents = context.windows.reduce((sum, window) => sum + window.audioCount, 0);
  const evidenceWindows = rankRecentContextEvidenceWindows({
    windows: context.windows,
    question: params.question,
    modeUsed,
    contextKind: range.kind,
  });
  const topEvidence = evidenceWindows.slice(0, evidenceLimit).map((window) => ({
    windowId: window.windowId,
    timeRange: `${formatTime(window.startedAt)}-${formatTime(window.endedAt)}`,
    summary: resolveWindowEvidenceSummary(window),
    transcriptExcerpt: cleanTranscriptText(window.transcriptText)
      ? truncateText(toSingleLine(cleanTranscriptText(window.transcriptText)), 180)
      : undefined,
    artifactUrls: window.events
      .map((event) => event.artifact?.url)
      .filter((value): value is string => Boolean(value))
      .slice(0, 3),
    people: dedupeStrings(
      window.peopleRefs.flatMap((ref) => {
        const matchedPerson = context.highlights.people.find((person) => person.personRef === ref);
        return matchedPerson?.displayName ?? ref;
      }),
    ),
  }));
  const peopleHints = [
    ...context.highlights.people.map((person) => ({
      kind: "person" as const,
      ref: person.personRef,
      displayName: person.displayName,
      relationship: person.relationship,
    })),
    ...context.highlights.speakers.map((speaker) => ({
      kind: "speaker" as const,
      ref: speaker.speakerRef,
      displayName: speaker.displayName,
      relationship: speaker.relationship,
    })),
  ].slice(0, 8);
  const taskHints = extractTaskHints(context);
  const attentionHints = extractAttentionHints({
    context,
    taskHints,
    modeUsed,
  });

  return {
    context,
    recentContext: {
      windowHint: range.windowHint,
      modeUsed,
      timeRange: {
        startAt: context.startAt,
        endAt: context.endAt,
        label: range.kind === "day" ? `${context.date} 全天` : `${formatTime(context.startAt)}-${formatTime(context.endAt)}`,
      },
      overview: buildRecentContextOverview(context, range.kind),
      sceneSummary: resolveSceneSummary(context),
      recentTranscriptSpans: transcriptSpans,
      peopleHints,
      attentionHints,
      taskHints,
      topEvidence,
      counts: {
        windows: context.windows.length,
        events: context.counts.events,
        transcriptSpans: transcriptSpans.length,
        audioEvents,
        pendingAudioWindows: context.highlights.audioCoverage.pendingAudioWindows,
      },
    },
  };
}

export function answerAssistantQuery(params: {
  queryText: string;
  recentContext: RecentContextPayload;
  previousTurn?: AssistantConversationTurn;
  queryRewriteReason?: AssistantQueryResolution["reason"];
  rawQueryText?: string;
  answeredAt?: number;
}): AssistantAnswerPayload {
  const answeredAt = params.answeredAt ?? Date.now();
  const normalizedQuery = normalizeQuestion(params.queryText);
  const supportingEvidence = params.recentContext.topEvidence.map((item) => ({
    windowId: item.windowId,
    timeRange: item.timeRange,
    summary: item.summary,
    transcriptExcerpt: item.transcriptExcerpt,
    artifactUrls: item.artifactUrls,
  }));
  if (!normalizedQuery) {
    if (params.queryRewriteReason) {
      const answerText =
        "这次我听到了一段环境声音或视频转写，但没有识别到你在向我提问的短句，所以不会把它当成“最近显式提问”。这段内容仍会作为环境音素材进入 ClawSense；如果你想追问，请点“问实时助手”后直接说一句，比如“刚才讨论的重点是什么”。";
      return {
        queryText: "",
        answerText,
        answerSpokenText: "我听到的是环境声音，不像是你在提问。请点问实时助手后，用一句短话重新问我。",
        supportingEvidence,
        modeUsed: params.recentContext.modeUsed,
        answeredAt,
        answerSource: "template",
        actionIntent: { type: "none" },
      };
    }
    const contextLead = buildEmptyQueryContextLead(params.recentContext);
    if (contextLead) {
      const answerText = `这次我没有听清你的问题。先按最近上下文看：${contextLead} 你可以再用一句短问题追问，比如“刚才重点是什么”。`;
      return {
        queryText: params.queryText,
        answerText,
        answerSpokenText: buildSpokenAnswerText(`我没有听清问题。按最近上下文看，${contextLead}`),
        supportingEvidence,
        modeUsed: params.recentContext.modeUsed,
        answeredAt,
        answerSource: "template",
      };
    }
    return {
      queryText: params.queryText,
      answerText: "这次我没有听清你的问题。请靠近一点，再用一句短问题重新问我一次。",
      answerSpokenText: "我没有听清问题，请再问一次。",
      supportingEvidence: [],
      modeUsed: params.recentContext.modeUsed,
      answeredAt,
      answerSource: "template",
    };
  }

  const followUpAnswer = buildFollowUpTemplateAnswer({
    queryText: normalizedQuery,
    recentContext: params.recentContext,
    previousTurn: params.previousTurn,
    answeredAt,
  });
  if (followUpAnswer) {
    return followUpAnswer;
  }

  const intent = classifyQuestionIntent(normalizedQuery, params.recentContext);
  const answerText = buildAnswerForIntent(intent, params.recentContext);
  const actionIntent = inferActionIntentFromQuery({
    queryText: normalizedQuery,
    recentContext: params.recentContext,
    answerText,
  });

  return {
    queryText: normalizedQuery,
    answerText,
    answerSpokenText: buildSpokenAnswerText(answerText, params.recentContext, intent),
    supportingEvidence,
    modeUsed: params.recentContext.modeUsed,
    answeredAt,
    answerSource: "template",
    actionIntent,
  };
}

export function shouldFallbackAssistantContextToAllDevices(recentContext: RecentContextPayload): boolean {
  return recentContext.counts.events === 0 && recentContext.counts.windows === 0;
}

export function shouldUsePreviousTurnEvidenceRange(params: {
  queryText: string;
  previousTurn?: AssistantConversationTurn;
}): boolean {
  if (!params.previousTurn?.timeRange) {
    return false;
  }
  const queryText = normalizeQuestion(params.queryText);
  if (!queryText) {
    return false;
  }
  if (hasExplicitTimeRangeCue(queryText)) {
    return false;
  }
  return /(继续说|继续讲|详细.*说|展开.*说|多说|第二点|第三点|第[一二三四五六七八九十]点|简短点|间短点|简单点|短一点|一句话|读全文|完整读|全文读|都读出来|全部读|整理成|沉淀成|会议纪要|行动项|生成.*(文件|文档|笔记)|写.*(文件|文档|笔记)|保存成|导出)/.test(
    queryText,
  );
}

export function shouldUseDeterministicAssistantAnswer(queryText: string): boolean {
  const normalized = normalizeAssistantQueryAliases(normalizeQuestion(queryText));
  return /(停止朗读|别读了|停一下|不用读了|读全文|完整读|全文读|都读出来|全部读)/.test(normalized);
}

export function resolveAssistantAudioRecheckPlan(params: {
  queryText: string;
  recentContext: RecentContextPayload;
}): AssistantAudioRecheckPlan {
  const queryText = normalizeQuestion(params.queryText);
  const pendingAudioWindows =
    params.recentContext.overview?.audioCoverage.pendingAudioWindows ??
    params.recentContext.counts.pendingAudioWindows;
  const totalAudioWindows =
    params.recentContext.overview?.audioCoverage.totalAudioWindows ??
    params.recentContext.counts.audioEvents;
  const transcriptReadyWindows =
    params.recentContext.overview?.audioCoverage.transcriptReadyWindows ??
    params.recentContext.recentTranscriptSpans.length;
  const hasAudioGap =
    pendingAudioWindows > 0 ||
    (totalAudioWindows > 0 && transcriptReadyWindows === 0 && params.recentContext.recentTranscriptSpans.length === 0);
  if (!queryText || !hasAudioGap || shouldUseDeterministicAssistantAnswer(queryText)) {
    return { shouldRecheck: false, maxWindows: 0 };
  }
  const isOverviewQuestion =
    params.recentContext.overview?.kind === "day" ||
    /(过去|最近).*(小时|分钟|天).*(发生|做了什么|干了什么|聊了什么|说了什么|讨论|重点|回顾|总结)/.test(
      queryText,
    ) ||
    /(今天|今日|昨天|昨日).*(发生|做了什么|干了什么|聊了什么|说了什么|讨论|重点|回顾|总结)/.test(
      queryText,
    );
  const isAudioQuestion =
    /(音频|语音|对话|说了什么|聊了什么|讲了什么|讨论|沟通|重点|任务|会议|课堂|老师|同事|老板|谁说|谁讲|怎么回复|我说了什么|会议纪要|行动项)/.test(
      queryText,
    );
  const isVisualOnlyQuestion =
    /(看什么|看到什么|场景|环境|周围|画面)/.test(queryText) &&
    !isAudioQuestion &&
    !isOverviewQuestion;
  if (isVisualOnlyQuestion) {
    return { shouldRecheck: false, maxWindows: 0 };
  }
  if (!isOverviewQuestion && !isAudioQuestion && params.recentContext.modeUsed !== "meeting") {
    return { shouldRecheck: false, maxWindows: 0 };
  }
  const reason = isOverviewQuestion
    ? "pending_audio_summary"
    : params.recentContext.modeUsed === "meeting"
      ? "pending_audio_meeting"
      : "pending_audio_question";
  const maxWindows = Math.max(1, Math.min(reason === "pending_audio_summary" ? 3 : 2, pendingAudioWindows || 1));
  return { shouldRecheck: true, maxWindows, reason };
}

export function withAssistantDeviceFallbackHint(params: {
  recentContext: RecentContextPayload;
  deviceName?: string;
}): RecentContextPayload {
  const deviceLabel = normalizeQuestion(params.deviceName) || "当前配对设备";
  const hint = `${deviceLabel} 在这个时间窗没有单独采到记录，已临时回退到同一 ClawSense 媒体库里的全部设备证据。`;
  return {
    ...params.recentContext,
    attentionHints: dedupeStrings([hint, ...params.recentContext.attentionHints]).slice(0, 8),
  };
}

export function buildAssistantModelPrompt(params: {
  queryText: string;
  recentContext: RecentContextPayload;
  templateAnswer: AssistantAnswerPayload;
  previousTurn?: AssistantConversationTurn;
}): AssistantModelPrompt {
  const evidence = {
    queryText: params.queryText,
    modeUsed: params.recentContext.modeUsed,
    timeRange: params.recentContext.timeRange,
    overview: params.recentContext.overview,
    sceneSummary: params.recentContext.sceneSummary,
    recentTranscriptSpans: params.recentContext.recentTranscriptSpans.slice(
      0,
      params.recentContext.overview?.kind === "recent" ? 8 : 20,
    ),
    peopleHints: params.recentContext.peopleHints.slice(0, 8),
    attentionHints: params.recentContext.attentionHints.slice(0, 8),
    taskHints: params.recentContext.taskHints.slice(0, 8),
    topEvidence: params.recentContext.topEvidence.slice(
      0,
      params.recentContext.overview?.kind === "recent" ? 6 : 10,
    ),
    counts: params.recentContext.counts,
    templateAnswer: {
      answerText: params.templateAnswer.answerText,
      answerSpokenText: params.templateAnswer.answerSpokenText,
    },
    previousTurn: params.previousTurn
      ? {
          queryText: params.previousTurn.queryText,
          answerText: truncateText(params.previousTurn.answerText, 800),
          answerSpokenText: params.previousTurn.answerSpokenText
            ? truncateText(params.previousTurn.answerSpokenText, 360)
            : undefined,
          answeredAt: params.previousTurn.answeredAt,
          modeUsed: params.previousTurn.modeUsed,
          timeRange: params.previousTurn.timeRange,
          actionIntent: params.previousTurn.actionIntent,
        }
      : undefined,
  };
  return {
    system: [
      "你是 ClawSense 连接到 OpenClaw 的现实世界语音对话入口。",
      "你不是固定摘要模板；你要像可以沟通的大模型助手一样回答用户的语音问题。",
      "只能基于给定 ClawSense evidence 回答；不知道就说不知道，并指出缺口。",
      "如果用户要求理解、建议、沉淀文件、会议纪要或任务清单，可以给出你的判断和可执行下一步，但不要假装已经创建文件。",
      "回答要自然、有帮助、有上下文感。不要只复述图片；有音频转写时必须优先使用音频，再结合画面。",
      "answerText 给屏幕展示，可以较完整；answerSpokenText 给手机 TTS，控制在 1 到 4 句，适合听。",
      "如果用户是在追问“过去4小时/昨天/今天”，必须使用 evidence 的 timeRange/overview，而不是只看最近画面。",
      "如果 evidence 里有 previousTurn，并且用户说“继续说、详细说说、第二点、整理成文件”等，要把它理解为上一轮的追问。",
      '只输出 JSON，不要 markdown。结构：{"answerText":"","answerSpokenText":"","actionIntent":{"type":"none|draft_document","title":"","reason":"","contentHint":""}}',
    ].join("\n"),
    user: `用户问题：${params.queryText}\n\nClawSense evidence：\n${JSON.stringify(evidence, null, 2)}`,
  };
}

export function mergeAssistantModelAnswer(params: {
  rawText: string | undefined;
  queryText: string;
  recentContext: RecentContextPayload;
  fallback: AssistantAnswerPayload;
  answeredAt?: number;
}): AssistantAnswerPayload | null {
  const parsed = safeParseAssistantModelJson(params.rawText);
  const answerText = normalizeQuestion(parsed?.answerText);
  if (!answerText || answerText.length < 4) {
    return null;
  }
  const actionIntent = normalizeActionIntent(parsed?.actionIntent);
  const normalizedQuery = normalizeQuestion(params.queryText);
  const intent = classifyQuestionIntent(normalizedQuery, params.recentContext);
  const answerSpokenText =
    normalizeQuestion(parsed?.answerSpokenText) ||
    buildSpokenAnswerText(answerText, params.recentContext, intent);
  return {
    ...params.fallback,
    queryText: normalizedQuery,
    answerText,
    answerSpokenText: truncateSpokenText(answerSpokenText, intent.kind === "day_summary" ? 360 : 220),
    answeredAt: params.answeredAt ?? params.fallback.answeredAt,
    answerSource: "model",
    actionIntent,
  };
}

export function buildAssistantDraftDocument(params: {
  queryText: string;
  answer: AssistantAnswerPayload;
  recentContext: RecentContextPayload;
  createdAt?: number;
}): AssistantDraftDocument | null {
  const action = params.answer.actionIntent;
  if (action?.type !== "draft_document") {
    return null;
  }
  const createdAt = params.createdAt ?? Date.now();
  const title = normalizeQuestion(action.title) || inferDraftTitle(params.queryText, params.recentContext);
  const evidenceLines = params.recentContext.topEvidence
    .slice(0, 6)
    .map((item) => {
      const transcript = item.transcriptExcerpt ? `\n  - 转写摘录：${item.transcriptExcerpt}` : "";
      const artifacts = item.artifactUrls.length > 0 ? `\n  - 素材：${item.artifactUrls.join(", ")}` : "";
      return `- ${item.timeRange}：${item.summary}${transcript}${artifacts}`;
    });
  const transcriptLines = params.recentContext.recentTranscriptSpans
    .slice(0, 8)
    .map((span) => `- ${span.time}：${span.text}`);
  const taskLines = params.recentContext.taskHints.slice(0, 8).map((item) => `- ${item}`);
  const attentionLines = params.recentContext.attentionHints
    .filter((item) => !isDiagnosticAttentionHint(item))
    .slice(0, 8)
    .map((item) => `- ${item}`);
  const contentHint = normalizeQuestion(action.contentHint);
  const reason = normalizeQuestion(action.reason);
  const markdown = [
    `# ${title}`,
    "",
    `- 生成时间：${new Date(createdAt).toISOString()}`,
    `- 用户问题：${params.queryText}`,
    `- 时间范围：${params.recentContext.timeRange.label}`,
    reason ? `- 生成原因：${reason}` : "",
    "",
    "## 摘要",
    "",
    params.answer.answerText,
    "",
    contentHint ? "## 整理方向" : "",
    contentHint ? "" : "",
    contentHint || "",
    contentHint ? "" : "",
    taskLines.length > 0 ? "## 行动项 / 待跟进" : "",
    taskLines.length > 0 ? "" : "",
    ...taskLines,
    taskLines.length > 0 ? "" : "",
    attentionLines.length > 0 ? "## 值得注意" : "",
    attentionLines.length > 0 ? "" : "",
    ...attentionLines,
    attentionLines.length > 0 ? "" : "",
    transcriptLines.length > 0 ? "## 关键转写" : "",
    transcriptLines.length > 0 ? "" : "",
    ...transcriptLines,
    transcriptLines.length > 0 ? "" : "",
    evidenceLines.length > 0 ? "## 证据窗口" : "",
    evidenceLines.length > 0 ? "" : "",
    ...evidenceLines,
    "",
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
  return { title, markdown };
}

function buildFollowUpTemplateAnswer(params: {
  queryText: string;
  recentContext: RecentContextPayload;
  previousTurn?: AssistantConversationTurn;
  answeredAt: number;
}): AssistantAnswerPayload | null {
  const queryText = normalizeQuestion(params.queryText);
  const isStop = /(停止朗读|别读了|停一下|不用读了)/.test(queryText);
  const isReadFull = /(读全文|完整读|全文读|都读出来|全部读)/.test(queryText);
  const isShorten = /(简短点|间短点|简单点|短一点|一句话|太长了)/.test(queryText);
  const isExpand = /(继续说|继续讲|详细.*说|展开.*说|多说|再讲|第二点|第三点|第[一二三四五六七八九十]点)/.test(queryText);
  if (!isStop && !isReadFull && !isShorten && !isExpand) {
    return null;
  }

  const supportingEvidence = params.recentContext.topEvidence.map((item) => ({
    windowId: item.windowId,
    timeRange: item.timeRange,
    summary: item.summary,
    transcriptExcerpt: item.transcriptExcerpt,
    artifactUrls: item.artifactUrls,
  }));

  if (isStop) {
    return {
      queryText,
      answerText: "好的，我先停止继续展开。若手机端正在朗读，这条指令应由客户端立刻停止当前 TTS，并保留屏幕上的文本答案。",
      answerSpokenText: "好的，我先不继续读了。",
      supportingEvidence,
      modeUsed: params.previousTurn?.modeUsed ?? params.recentContext.modeUsed,
      answeredAt: params.answeredAt,
      answerSource: "template",
      actionIntent: { type: "none" },
    };
  }

  if (!params.previousTurn) {
    const contextLead = buildEmptyQueryContextLead(params.recentContext);
    const answerText = contextLead
      ? `我还没有上一轮回答可以继续承接。按当前上下文看：${contextLead} 你可以直接问“刚才重点是什么”或“过去4小时聊了什么”。`
      : "我还没有上一轮回答可以继续承接。你可以先问一个具体问题，比如“刚才重点是什么”。";
    return {
      queryText,
      answerText,
      answerSpokenText: buildSpokenAnswerText(answerText),
      supportingEvidence,
      modeUsed: params.recentContext.modeUsed,
      answeredAt: params.answeredAt,
      answerSource: "template",
      actionIntent: { type: "none" },
    };
  }

  const previous = params.previousTurn;
  if (isReadFull) {
    const answerText = `上一轮完整回答如下：${previous.answerText}`;
    return {
      queryText,
      answerText,
      answerSpokenText: truncateSpokenText(previous.answerText, 900),
      supportingEvidence,
      modeUsed: previous.modeUsed,
      answeredAt: params.answeredAt,
      answerSource: "template",
      actionIntent: previous.actionIntent ?? { type: "none" },
    };
  }

  if (isShorten) {
    const shortText =
      splitSentences(previous.answerText).slice(0, 2).join("。") || truncateText(previous.answerText, 120);
    const answerText = `简短版：${stripTrailingPunctuation(shortText)}。`;
    return {
      queryText,
      answerText,
      answerSpokenText: truncateSpokenText(answerText, 160),
      supportingEvidence,
      modeUsed: previous.modeUsed,
      answeredAt: params.answeredAt,
      answerSource: "template",
      actionIntent: previous.actionIntent ?? { type: "none" },
    };
  }

  const previousSentences = splitSentences(previous.answerText).slice(0, 5);
  const evidenceLines = params.recentContext.topEvidence
    .slice(0, 3)
    .map((item) => {
      const transcript = item.transcriptExcerpt ? `；语音摘录：${item.transcriptExcerpt}` : "";
      return `${item.timeRange}：${item.summary}${transcript}`;
    });
  const followUpSuggestion =
    previous.actionIntent?.type === "draft_document"
      ? "如果你要继续沉淀，我可以基于这轮内容更新成一份更完整的草稿。"
      : "如果你愿意，我也可以继续把它整理成会议纪要、行动项或可沉淀的文件。";
  const answerText = [
    `我继续基于上一轮“${previous.queryText}”展开。`,
    previousSentences.length > 0 ? `上一轮核心是：${previousSentences.join("；")}。` : "",
    evidenceLines.length > 0 ? `当前可回链的证据包括：${evidenceLines.join("；")}。` : "",
    followUpSuggestion,
  ]
    .filter(Boolean)
    .join("");

  return {
    queryText,
    answerText,
    answerSpokenText: truncateSpokenText(answerText, 260),
    supportingEvidence,
    modeUsed: previous.modeUsed,
    answeredAt: params.answeredAt,
    answerSource: "template",
    actionIntent: previous.actionIntent ?? { type: "none" },
  };
}

function buildEmptyQueryContextLead(recentContext: RecentContextPayload): string {
  const latestTranscript = recentContext.recentTranscriptSpans[0]?.text.trim();
  if (latestTranscript) {
    return `最近听到的是：${truncateText(latestTranscript, 90)}。`;
  }
  const attention = recentContext.attentionHints[0]?.trim();
  if (attention) {
    return `${truncateText(attention, 100)}。`;
  }
  const scene = recentContext.sceneSummary.trim();
  if (scene) {
    return `最近看到的场景是：${truncateText(scene, 100)}。`;
  }
  const evidence = recentContext.topEvidence[0]?.summary.trim();
  if (evidence) {
    return truncateText(evidence, 100);
  }
  return "";
}

function recentContextWindowMs(windowHint: RecentContextWindowHint): number {
  if (windowHint === "last_15s") {
    return 15_000;
  }
  if (windowHint === "last_5m") {
    return 5 * 60_000;
  }
  if (windowHint === "custom") {
    return 5 * 60_000;
  }
  return 60_000;
}

function resolveRecentContextRange(params: {
  requestedWindowHint: RecentContextWindowHint;
  question?: string;
  modeHint?: AssistantModeHint;
  now: number;
}): { windowHint: RecentContextWindowHint; startAt: number; endAt: number; kind: "recent" | "custom" | "day"; date?: string } {
  const requestedRange = resolveQuestionRequestedRange(params.question, params.now);
  if (requestedRange) {
    return {
      windowHint: "custom",
      startAt: requestedRange.startAt,
      endAt: requestedRange.endAt,
      kind: requestedRange.kind,
      date: requestedRange.date,
    };
  }
  const windowHint =
    (params.modeHint === "meeting" || params.modeHint === "desk") && params.requestedWindowHint === "last_60s"
      ? "last_5m"
      : params.requestedWindowHint === "last_60s" && shouldPromoteRecentQuestionToFiveMinutes(params.question)
        ? "last_5m"
      : params.requestedWindowHint;
  return {
    windowHint,
    startAt: params.now - recentContextWindowMs(windowHint),
    endAt: params.now,
    kind: "recent",
  };
}

function resolveQuestionRequestedRange(
  question: string | undefined,
  now: number,
): { startAt: number; endAt: number; kind: "custom" | "day"; date?: string } | null {
  const normalized = normalizeQuestion(question);
  if (!normalized) {
    return null;
  }
  if (/昨天|昨日/.test(normalized)) {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60_000);
    return {
      startAt: startOfYesterday.getTime(),
      endAt: startOfToday.getTime(),
      kind: "day",
      date: formatDateKey(startOfYesterday.getTime()),
    };
  }
  if (/今天|今日/.test(normalized)) {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    return { startAt: startOfDay.getTime(), endAt: now, kind: "day", date: formatDateKey(startOfDay.getTime()) };
  }
  const hourMatch = normalized.match(/(?:过去|最近|前)?\s*([0-9０-９一二两三四五六七八九十半]+)\s*(?:个)?\s*小时/);
  if (hourMatch) {
    const hours = parseChineseNumberLike(hourMatch[1] ?? "");
    if (hours > 0) {
      return { startAt: now - Math.min(hours, 24) * 60 * 60_000, endAt: now, kind: "custom" };
    }
  }
  const minuteMatch = normalized.match(/(?:过去|最近|前)?\s*([0-9０-９一二两三四五六七八九十半]+)\s*(?:分钟|分)/);
  if (minuteMatch) {
    const minutes = parseChineseNumberLike(minuteMatch[1] ?? "");
    if (minutes > 0) {
      return { startAt: now - Math.min(minutes, 24 * 60) * 60_000, endAt: now, kind: "custom" };
    }
  }
  if (/半小时/.test(normalized)) {
    return { startAt: now - 30 * 60_000, endAt: now, kind: "custom" };
  }
  return null;
}

function shouldPromoteRecentQuestionToFiveMinutes(question: string | undefined): boolean {
  const normalized = normalizeQuestion(question);
  if (!normalized) {
    return false;
  }
  return (
    /(刚才|刚刚|方才|刚才这段|刚刚这段).*(聊了什么|说了什么|讲了什么|讨论|重点|结论|任务|注意|跟进|回复)/.test(
      normalized,
    ) ||
    /(刚才|刚刚|方才).*(他们|他说|她说|对方|同事|老师|老板|客户)/.test(normalized) ||
    /(讨论的重点|沟通的重点|会议重点|刚才重点|刚刚重点)/.test(normalized)
  );
}

function parseChineseNumberLike(raw: string): number {
  const normalized = raw
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .trim();
  if (!normalized) {
    return 0;
  }
  if (normalized === "半") {
    return 0.5;
  }
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const digitMap = new Map<string, number>([
    ["零", 0],
    ["一", 1],
    ["二", 2],
    ["两", 2],
    ["三", 3],
    ["四", 4],
    ["五", 5],
    ["六", 6],
    ["七", 7],
    ["八", 8],
    ["九", 9],
  ]);
  if (!normalized.includes("十")) {
    return digitMap.get(normalized) ?? 0;
  }
  const [tensRaw, onesRaw] = normalized.split("十");
  const tens = tensRaw ? digitMap.get(tensRaw) ?? 0 : 1;
  const ones = onesRaw ? digitMap.get(onesRaw) ?? 0 : 0;
  return tens * 10 + ones;
}

function inferAssistantMode(params: {
  requestedMode?: AssistantModeHint;
  question?: string;
  context: AssistantContextPayload;
}): AssistantModeHint {
  const requestedMode = params.requestedMode ?? "auto";
  if (requestedMode !== "auto") {
    return requestedMode;
  }
  const question = normalizeQuestion(params.question);
  if (question && /(来找我|谁来过|有人来过|工位|离开的时候)/.test(question)) {
    return "desk";
  }
  if (question && /(会议|开会|重点|任务|落给谁|结论|讨论)/.test(question)) {
    return "meeting";
  }
  if (params.context.highlights.audioCoverage.totalAudioWindows >= 2) {
    return "meeting";
  }
  return "auto";
}

// The user pressed "问实时助手", so the prior is overwhelmingly "this is a question".
// Accept any short single-utterance transcript and let the model judge intent;
// the cue whitelist stays in charge only of long ambient transcripts and aliases.
function isLikelyExplicitSpokenQuery(text: string): boolean {
  if (text.length < 2 || text.length > 40) {
    return false;
  }
  const clauseMarks = (text.match(/[，,。;；]/g) ?? []).length;
  if (clauseMarks > 2) {
    return false;
  }
  // Multimodal audio understanding sometimes returns a description of the clip
  // instead of verbatim speech; never treat description-style output as the user's words.
  if (/^(听起来|似乎(是|在)|好像(是|在)|这段(音频|声音|录音)|环境音|音频(中|里)|背景(音|声))/.test(text)) {
    return false;
  }
  return true;
}

function looksLikeAmbientQueryTranscript(text: string): boolean {
  const normalized = normalizeQuestion(text);
  if (!normalized) {
    return false;
  }
  const questionLike = hasSupportedQuestionCue(normalized);
  if (normalized.length > 80) {
    return true;
  }
  if (!questionLike && normalized.length > 32) {
    return true;
  }
  const commaLikeCount = (normalized.match(/[，,。]/g) ?? []).length;
  return !questionLike && commaLikeCount >= 2;
}

function extractSupportedShortQuestion(text: string): string | null {
  const normalized = normalizeQuestion(text);
  if (normalized.length <= 80 && hasSupportedQuestionCue(normalized)) {
    return normalized;
  }
  const sentences = splitSentences(normalized);
  const candidates = sentences
    .filter((sentence) => sentence.length <= 50 && hasSupportedQuestionCue(sentence))
    .filter((sentence) => !looksLikeAmbientInterviewQuestion(sentence));
  return candidates.at(-1) ?? null;
}

function hasSupportedQuestionCue(text: string): boolean {
  return /(我现在在看什么|^(?:我们|咱们)?聊了什么[？?]?$|刚(?:才|刚).*(重点|说了什么|聊了什么|讨论|回复|发生|干了什么|做了什么|看到了什么|看到什么|听到了什么|听到什么)|过去.*(聊了什么|说了什么|讨论|重点|发生|干了什么|做了什么)|最近.*(聊了什么|说了什么|讨论|重点|发生|干了什么|做了什么)|[0-9０-９一二两三四五六七八九十半]+(?:个)?小时.*(聊了什么|说了什么|讨论|重点|发生)|今天.*(聊了什么|说了什么|讨论|重点|发生|干了什么|做了什么)|昨天.*(聊了什么|说了什么|讨论|重点|发生|干了什么|做了什么)|现在.*注意|有什么.*跟进|有人.*找|任务.*谁|落给谁|谁负责|我刚才.*回复|我说了什么|整理成|沉淀成|会议纪要|行动项|生成.*(文件|文档|笔记)|写.*(文件|文档|笔记)|总结(?:一下)?|归纳(?:一下)?|说重点|重点是什么|继续说|详细.*说|展开.*说|简短点|间短点|简单点|读全文|完整读|停止朗读|\b(?:what happened|what did (?:we|they|he|she|i) (?:say|discuss|talk about)|what (?:am i|are we) (?:looking at|watching)|what should i (?:notice|pay attention to)|summari[sz]e|key points?|action items?|who (?:came|visited)|what did (?:he|she|they) say)\b)/i.test(text);
}

function hasExplicitTimeRangeCue(text: string): boolean {
  return /(过去|最近).*(小时|分钟|天)|今天|今日|昨天|昨日|前天|刚才|刚刚/.test(text);
}

function normalizeAssistantQueryAliases(text: string): string {
  const normalized = normalizeQuestion(text);
  if (/^(过去|最近)[0-9０-９一二两三四五六七八九十半]+(?:个)?小时$/.test(normalized)) {
    return `${normalized}我们聊了什么？`;
  }
  if (/^(?:我们|咱们)?聊了什么[？?]?$/.test(normalized)) {
    return "过去4个小时我们聊了什么？";
  }
  if (/^(朱全文|读全问|度全文)$/.test(normalized)) {
    return "读全文";
  }
  if (/^间短点$/.test(normalized)) {
    return "简短点";
  }
  return normalized;
}

function looksLikeAmbientInterviewQuestion(text: string): boolean {
  return /(你们.*bug|你们怎么|你觉得|你评价|为什么.*谁也不收|如果是你|你会怎么选)/.test(text);
}

function buildTranscriptSpans(
  context: AssistantContextPayload,
  limit: number,
): RecentContextPayload["recentTranscriptSpans"] {
  return context.windows
    .flatMap((window) =>
      window.events
        .filter((event) => event.modality === "audio" && event.transcript?.trim())
        .map((event) => ({
          windowId: window.windowId,
          eventId: event.eventId,
          capturedAt: event.capturedAt,
          time: formatTime(event.capturedAt),
          text: truncateText(toSingleLine(event.transcript ?? ""), 220),
          artifactUrl: event.artifact?.url,
        }))
        .filter((span) => !looksLikeAssistantSelfTalk(span.text)),
    )
    .sort((left, right) => right.capturedAt - left.capturedAt)
    .slice(0, limit);
}

function resolveSceneSummary(context: AssistantContextPayload): string {
  const latestVisualEvent = context.windows
    .flatMap((window) => window.events)
    .filter((event) => event.modality === "image" || event.modality === "video")
    .sort((left, right) => right.capturedAt - left.capturedAt)[0];
  if (latestVisualEvent?.summary?.trim()) {
    return latestVisualEvent.summary.trim();
  }
  const topWindow = context.windows[0];
  if (topWindow?.primarySummary?.trim() && !looksLikeAssistantSelfTalk(topWindow.primarySummary)) {
    return topWindow.primarySummary.trim();
  }
  return context.summary.trim();
}

function resolveWindowEvidenceSummary(window: AssistantContextPayload["windows"][number]): string {
  if (window.primarySummary?.trim() && !looksLikeAssistantSelfTalk(window.primarySummary)) {
    return window.primarySummary.trim();
  }
  const visualSummary = window.events
    .filter((event) => event.modality === "image" || event.modality === "video")
    .map((event) => event.summary?.trim() ?? "")
    .find((summary) => summary && !looksLikeAssistantSelfTalk(summary));
  if (visualSummary) {
    return visualSummary;
  }
  const cleanedTranscript = cleanTranscriptText(window.transcriptText);
  if (cleanedTranscript) {
    return truncateText(cleanedTranscript, 160);
  }
  return window.primarySummary.trim();
}

function buildRecentContextOverview(
  context: AssistantContextPayload,
  kind: "recent" | "custom" | "day",
): RecentContextPayload["overview"] {
  const reviewItems =
    context.review?.sections
      .flatMap((section) => section.items.map((item) => `${section.title}：${item}`))
      .filter((item) => item.trim())
      .slice(0, 6) ?? [];
  const keyWindowSummaries = context.windows
    .map((window) => {
      const summary = resolveWindowEvidenceSummary(window);
      if (!summary) {
        return "";
      }
      return `${formatTime(window.startedAt)}-${formatTime(window.endedAt)}：${truncateText(summary, 120)}`;
    })
    .filter(Boolean)
    .slice(0, kind === "recent" ? 6 : 12);
  return {
    kind,
    date: context.date,
    summary: context.summary.trim(),
    counts: context.counts,
    audioCoverage: context.highlights.audioCoverage,
    reviewItems,
    keyWindowSummaries,
  };
}

function rankRecentContextEvidenceWindows(params: {
  windows: AssistantContextPayload["windows"];
  question?: string;
  modeUsed: AssistantModeHint;
  contextKind: "recent" | "custom" | "day";
}): AssistantContextPayload["windows"] {
  if (!shouldPrioritizeAudioEvidence(params)) {
    return params.windows;
  }
  return params.windows.slice().sort((left, right) => {
    const leftScore = scoreRecentContextEvidenceWindow(left, params.question);
    const rightScore = scoreRecentContextEvidenceWindow(right, params.question);
    return rightScore - leftScore || right.endedAt - left.endedAt;
  });
}

function shouldPrioritizeAudioEvidence(params: {
  question?: string;
  modeUsed: AssistantModeHint;
  contextKind: "recent" | "custom" | "day";
}): boolean {
  const question = normalizeQuestion(params.question);
  if (params.contextKind === "custom" || params.contextKind === "day") {
    return true;
  }
  if (params.modeUsed === "meeting") {
    return true;
  }
  return /(音频|语音|对话|说了什么|聊了什么|讲了什么|讨论|沟通|重点|任务|会议|课堂|老师|同事|老板|客户|谁说|谁讲|怎么回复|我说了什么|会议纪要|行动项)/.test(
    question,
  );
}

function scoreRecentContextEvidenceWindow(
  window: AssistantContextPayload["windows"][number],
  question: string | undefined,
): number {
  const questionText = normalizeQuestion(question);
  const transcript = cleanTranscriptText(window.transcriptText);
  let score = 0;
  if (transcript) {
    score += 100;
  }
  if (window.audioCount > 0) {
    score += 30 + Math.min(window.audioCount, 3);
  }
  if (/(讨论|会议|课堂|任务|重点|报价|复盘|跟进|行动项|Scaling Law|模型|数据|算法)/i.test(transcript)) {
    score += 10;
  }
  if (questionText) {
    const questionTerms = questionText
      .split(/[，。！？、\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && !/^(过去|最近|今天|昨天|发生|什么|刚才|重点)$/.test(item));
    for (const term of questionTerms) {
      if (`${window.primarySummary} ${transcript}`.includes(term)) {
        score += 4;
      }
    }
  }
  if (!transcript && (window.imageCount > 0 || window.videoCount > 0)) {
    score += 5;
  }
  return score;
}

function extractTaskHints(context: AssistantContextPayload): string[] {
  const candidates = context.windows.flatMap((window) => {
    const transcriptSentences = splitSentences(cleanTranscriptText(window.transcriptText));
    const actionSentences = transcriptSentences.filter((sentence) =>
      /(需要|要我|要你|要他|要她|要我们|要大家|要把|跟进|确认|安排|负责|提交|同步|明天|今天|待确认|决定|结论|稍后|等会|发出去|交付|上线|测试|排期|报价|deadline|截止|action|todo)/i.test(sentence),
    );
    if (actionSentences.length > 0) {
      return actionSentences.slice(0, 2);
    }
    if (
      !looksLikeAssistantSelfTalk(window.primarySummary) &&
      /(任务|待办|确认|安排|跟进|提醒|排期|报价|测试|会议|讨论)/.test(window.primarySummary)
    ) {
      return [window.primarySummary];
    }
    return [];
  });
  return dedupeStrings(candidates).slice(0, 4);
}

function extractAttentionHints(params: {
  context: AssistantContextPayload;
  taskHints: string[];
  modeUsed: AssistantModeHint;
}): string[] {
  const hints: string[] = [];
  if (params.taskHints.length > 0) {
    hints.push(...params.taskHints.map((item) => `待跟进：${item}`));
  }
  for (const person of params.context.highlights.people) {
    if (person.nextWatchFor?.trim()) {
      hints.push(`${person.displayName}：${person.nextWatchFor.trim()}`);
    }
  }
  if (params.context.highlights.audioCoverage.pendingAudioWindows > 0) {
    hints.push("最近还有音频窗口未形成清晰转写，重要细节可能还不完整。");
  }
  if (params.modeUsed === "desk" && params.context.windows.length === 0) {
    hints.push("当前时间窗里还没有新的工位证据。");
  }
  return dedupeStrings(hints).slice(0, 5);
}

type AssistantIntent =
  | { kind: "day_summary" }
  | { kind: "scene" }
  | { kind: "what_said" }
  | { kind: "self_reply" }
  | { kind: "attention" }
  | { kind: "focus" }
  | { kind: "assignment" }
  | { kind: "visit" }
  | { kind: "person"; displayName: string }
  | { kind: "general" };

function classifyQuestionIntent(queryText: string, recentContext: RecentContextPayload): AssistantIntent {
  const matchedPerson = recentContext.peopleHints.find((hint) => queryText.includes(hint.displayName));
  if (matchedPerson) {
    return { kind: "person", displayName: matchedPerson.displayName };
  }
  if (
    recentContext.overview?.kind === "day" &&
    /(昨天|昨日|今天|今日).*(发生|做了什么|干了什么|聊了什么|说了什么|讨论|重点|回顾|总结)/.test(queryText)
  ) {
    return { kind: "day_summary" };
  }
  if (/(过去|最近).*(小时|分钟|天).*(发生|做了什么|干了什么|聊了什么|说了什么|讨论|重点|回顾|总结)/.test(queryText)) {
    return { kind: "day_summary" };
  }
  if (/(看什么|看到什么|场景|环境|周围|画面)/.test(queryText)) {
    return { kind: "scene" };
  }
  if (/(我刚才.*(怎么|如何)?.*(回复|回的|说的|讲的)|我刚刚.*(怎么|如何)?.*(回复|回的|说的|讲的)|我说了什么|我刚才讲了什么|我刚才说了什么)/.test(queryText)) {
    return { kind: "self_reply" };
  }
  if (/(说了什么|聊了什么|讲了什么|提到什么|回复了什么|刚才他们在说什么)/.test(queryText)) {
    return { kind: "what_said" };
  }
  if (/(注意|留意|风险|提醒|需要注意)/.test(queryText)) {
    return { kind: "attention" };
  }
  if (/(重点|结论|任务|落给谁|谁负责|action|待办)/i.test(queryText)) {
    if (/(落给谁|谁负责|谁来|负责人|责任人)/.test(queryText)) {
      return { kind: "assignment" };
    }
    return { kind: "focus" };
  }
  if (/(来找我|谁来过|有人来过|来找过我)/.test(queryText)) {
    return { kind: "visit" };
  }
  return { kind: "general" };
}

function buildAnswerForIntent(intent: AssistantIntent, recentContext: RecentContextPayload): string {
  if (intent.kind === "day_summary") {
    return buildOverviewAnswer(recentContext);
  }

  if (intent.kind === "scene") {
    const scene = recentContext.sceneSummary.trim();
    if (!scene) {
      return "我这会儿还没有拿到足够清晰的画面证据，所以不能确认你当前正在看什么。";
    }
    return `我最近看到的场景是：${scene}${appendEvidenceTail(recentContext.topEvidence[0])}`;
  }

  if (intent.kind === "what_said") {
    if (recentContext.recentTranscriptSpans.length === 0) {
      return `${recentContext.timeRange.label} 这段里有音频活动，但还没有拿到足够清晰的转写，所以我暂时不能准确复述具体说了什么。`;
    }
    const excerpts = recentContext.recentTranscriptSpans
      .slice(0, 2)
      .map((span) => `${span.time}：${span.text}`);
    const visual = recentContext.sceneSummary ? `画面线索是：${recentContext.sceneSummary}。` : "";
    return `在 ${recentContext.timeRange.label} 这段里，我听到的重点是：${excerpts.join("；")}。${visual}`;
  }

  if (intent.kind === "self_reply") {
    return buildSelfReplyAnswer(recentContext);
  }

  if (intent.kind === "attention") {
    if (recentContext.modeUsed === "meeting") {
      return buildMeetingAttentionAnswer(recentContext);
    }
    if (recentContext.modeUsed === "desk") {
      return buildDeskAttentionAnswer(recentContext);
    }
    if (recentContext.attentionHints.length === 0) {
      return `最近 ${recentContext.timeRange.label} 里没有特别明确的新风险点。更明显的线索还是：${recentContext.sceneSummary}`;
    }
    return `现在值得注意的点有：${recentContext.attentionHints.slice(0, 3).join("；")}。`;
  }

  if (intent.kind === "focus") {
    if (recentContext.modeUsed === "meeting") {
      return buildMeetingFocusAnswer(recentContext);
    }
    if (recentContext.taskHints.length > 0) {
      return `刚才这段讨论更像是在收敛这些事情：${recentContext.taskHints.slice(0, 3).join("；")}。`;
    }
    if (recentContext.recentTranscriptSpans.length > 0) {
      return `我目前能抓到的讨论重点是：${recentContext.recentTranscriptSpans
        .slice(0, 2)
        .map((span) => span.text)
        .join("；")}。`;
    }
    return `我目前能确认的重点还是这段场景摘要：${recentContext.sceneSummary}`;
  }

  if (intent.kind === "assignment") {
    return buildAssignmentAnswer(recentContext);
  }

  if (intent.kind === "visit") {
    if (recentContext.modeUsed === "desk") {
      return buildDeskVisitAnswer(recentContext);
    }
    const people = recentContext.topEvidence.flatMap((item) => item.people);
    if (people.length > 0) {
      return `最近时间窗里我看到了这些人物线索：${dedupeStrings(people).join("、")}。更具体的来访内容还要结合音频转写一起确认。`;
    }
    if (recentContext.topEvidence.length > 0) {
      return `最近我没有看到明确的来访身份，但最相关的证据是：${recentContext.topEvidence[0].summary}`;
    }
    return "最近这个时间窗里还没有足够证据让我确认是否有人来找过你。";
  }

  if (intent.kind === "person") {
    const relevantSpans = recentContext.recentTranscriptSpans.filter((span) => span.text.includes(intent.displayName));
    if (relevantSpans.length > 0) {
      return `${intent.displayName} 在最近证据里主要出现在这些片段：${relevantSpans
        .slice(0, 2)
        .map((span) => `${span.time}：${span.text}`)
        .join("；")}。`;
    }
    return `最近时间窗里我还没有抓到 ${intent.displayName} 的明确语音转写，但相关人物线索仍建议结合图片和更长时间窗再看一次。`;
  }

  const generalParts = [
    recentContext.overview?.kind === "day" ? buildOverviewAnswer(recentContext) : "",
    recentContext.sceneSummary ? `场景上看，${recentContext.sceneSummary}` : "",
    recentContext.recentTranscriptSpans[0]?.text ? `对话上我听到：${recentContext.recentTranscriptSpans[0].text}` : "",
    recentContext.attentionHints[0] ? `当前最值得注意的是：${recentContext.attentionHints[0]}` : "",
  ].filter(Boolean);
  if (generalParts.length > 0) {
    return `${generalParts.join("。")}。`;
  }
  return "最近这个时间窗里的新证据还不够多，我暂时只能告诉你：还没有形成可稳定复述的内容。";
}

function buildOverviewAnswer(recentContext: RecentContextPayload): string {
  const overview = recentContext.overview;
  if (!overview) {
    return buildEmptyQueryContextLead(recentContext) || "这段时间里的证据还不够完整，我暂时不能稳定总结。";
  }
  const rangeLead =
    overview.kind === "day"
      ? `${overview.date} 我按全天记录回顾了`
      : `我按 ${recentContext.timeRange.label} 这个时间范围回顾了`;
  if (overview.counts.events === 0) {
    return `${rangeLead}，但没有查到可用于回顾的 ClawSense 事件。`;
  }
  const coverage = `我查到 ${overview.counts.events} 条事件、${overview.counts.windows} 个时间窗，其中音频窗口 ${overview.audioCoverage.totalAudioWindows} 个，已形成清晰转写的音频窗口 ${overview.audioCoverage.transcriptReadyWindows} 个`;
  const conversationSummary = buildCustomRangeConversationSummary(recentContext, 4, 90);
  const summary = stripTrailingPunctuation(
    conversationSummary ||
      overview.summary ||
      recentContext.sceneSummary ||
      "这段时间留下了若干图片和音频线索，但还没有形成稳定总览。",
  );
  const reviewItems =
    overview.reviewItems.length > 0
      ? overview.reviewItems.slice(0, 4)
      : overview.keyWindowSummaries.slice(0, 4);
  const normalizedItems = reviewItems.map((item) =>
    stripTrailingPunctuation(item.replace(/^Today at a glance：/, "")),
  );
  const details = normalizedItems.length > 0 ? `关键线索：${normalizedItems.join("；")}。` : "";
  const pending =
    overview.audioCoverage.pendingAudioWindows > 0
      ? `另有 ${overview.audioCoverage.pendingAudioWindows} 个音频窗口还不够清晰，细节可能不完整。`
      : "";
  return `${rangeLead}。${coverage}。整体上：${summary}。${details}${pending}`;
}

function safeParseAssistantModelJson(raw: string | undefined): {
  answerText?: string;
  answerSpokenText?: string;
  actionIntent?: unknown;
} | null {
  const text = normalizeQuestion(raw);
  if (!text) {
    return null;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeActionIntent(value: unknown): AssistantAnswerPayload["actionIntent"] {
  if (!value || typeof value !== "object") {
    return { type: "none" };
  }
  const object = value as Record<string, unknown>;
  const type = object.type === "draft_document" ? "draft_document" : "none";
  return {
    type,
    title: typeof object.title === "string" ? truncateText(object.title.trim(), 80) : undefined,
    reason: typeof object.reason === "string" ? truncateText(object.reason.trim(), 160) : undefined,
    contentHint: typeof object.contentHint === "string" ? truncateText(object.contentHint.trim(), 240) : undefined,
    fileName: typeof object.fileName === "string" ? truncateText(object.fileName.trim(), 120) : undefined,
    filePath: typeof object.filePath === "string" ? truncateText(object.filePath.trim(), 260) : undefined,
  };
}

function inferActionIntentFromQuery(params: {
  queryText: string;
  recentContext: RecentContextPayload;
  answerText: string;
}): AssistantActionIntent {
  if (!/(整理成|沉淀成|会议纪要|行动项|生成.*(文件|文档|笔记)|写.*(文件|文档|笔记)|保存成|导出)/.test(params.queryText)) {
    return { type: "none" };
  }
  const title = inferDraftTitle(params.queryText, params.recentContext);
  return {
    type: "draft_document",
    title,
    reason: "用户要求把当前对话和证据沉淀成可保存文档。",
    contentHint: truncateText(params.answerText, 220),
  };
}

function inferDraftTitle(queryText: string, recentContext: RecentContextPayload): string {
  const normalized = normalizeQuestion(queryText);
  if (/会议纪要|纪要/.test(normalized)) {
    return `${recentContext.timeRange.label} 会议纪要`;
  }
  if (/行动项|待办|任务/.test(normalized)) {
    return `${recentContext.timeRange.label} 行动项`;
  }
  if (/学习|课堂|笔记/.test(normalized)) {
    return `${recentContext.timeRange.label} 学习笔记`;
  }
  return `${recentContext.timeRange.label} ClawSense 整理草稿`;
}

function buildSelfReplyAnswer(recentContext: RecentContextPayload): string {
  if (recentContext.recentTranscriptSpans.length === 0) {
    return "我还没有拿到足够清晰的转写，所以不能确认你刚才具体怎么回复。";
  }
  const excerpts = recentContext.recentTranscriptSpans
    .slice(0, 2)
    .map((span) => `${span.time}：${span.text}`)
    .join("；");
  return `我目前还不能可靠区分哪一句一定是你说的，但最近可转写片段是：${excerpts}。`;
}

function buildMeetingAttentionAnswer(recentContext: RecentContextPayload): string {
  if (recentContext.attentionHints.length > 0) {
    return `会议里现在最需要注意的是：${recentContext.attentionHints.slice(0, 3).join("；")}。`;
  }
  if (recentContext.taskHints.length > 0) {
    return `会议里先盯住这些落点：${recentContext.taskHints.slice(0, 3).join("；")}。`;
  }
  if (recentContext.recentTranscriptSpans.length > 0) {
    return `会议里暂时没有明确风险点，但最近听到的是：${recentContext.recentTranscriptSpans[0]?.text}`;
  }
  return `会议里暂时没有明确风险点；当前更可靠的线索是：${recentContext.sceneSummary}`;
}

function buildDeskAttentionAnswer(recentContext: RecentContextPayload): string {
  const people = dedupeStrings(recentContext.topEvidence.flatMap((item) => item.people));
  if (recentContext.attentionHints.length > 0) {
    return `工位上现在最需要注意的是：${recentContext.attentionHints.slice(0, 3).join("；")}。`;
  }
  if (people.length > 0) {
    return `工位上先留意这些人物线索：${people.join("、")}。如果要确认是否需要跟进，还要结合最近语音内容。`;
  }
  if (recentContext.recentTranscriptSpans.length > 0) {
    return `工位上最近有语音线索：${recentContext.recentTranscriptSpans[0]?.text}。是否需要跟进还要你再确认对象身份。`;
  }
  return `工位上暂时没有明确待跟进事项；当前更可靠的画面线索是：${recentContext.sceneSummary}`;
}

function buildMeetingFocusAnswer(recentContext: RecentContextPayload): string {
  const parts: string[] = [];
  if (recentContext.recentTranscriptSpans.length > 0) {
    parts.push(`音频重点：${recentContext.recentTranscriptSpans.slice(0, 2).map((span) => span.text).join("；")}`);
  }
  if (recentContext.taskHints.length > 0) {
    parts.push(`待办/决策：${recentContext.taskHints.slice(0, 3).join("；")}`);
  }
  if (recentContext.sceneSummary.trim()) {
    parts.push(`画面线索：${recentContext.sceneSummary.trim()}`);
  }
  const people = dedupeStrings([
    ...recentContext.peopleHints.map((hint) => hint.displayName),
    ...recentContext.topEvidence.flatMap((item) => item.people),
  ]);
  if (people.length > 0) {
    parts.push(`相关人物：${people.slice(0, 4).join("、")}`);
  }
  if (parts.length > 0) {
    return `会议模式下，我抓到的重点是：${parts.join("。")}。`;
  }
  if (recentContext.counts.audioEvents > 0 || recentContext.counts.pendingAudioWindows > 0) {
    return `会议模式下，我检测到刚才有音频活动，但还没有拿到清晰转写；当前只能确认的场景是：${recentContext.sceneSummary}`;
  }
  return `会议模式下，我还没有抓到清晰讨论内容；当前可确认的场景是：${recentContext.sceneSummary}`;
}

function buildAssignmentAnswer(recentContext: RecentContextPayload): string {
  const namedTaskHints = recentContext.taskHints.filter((hint) =>
    recentContext.peopleHints.some((person) => hint.includes(person.displayName)),
  );
  const explicitAssignmentSpans = recentContext.recentTranscriptSpans.filter((span) =>
    /(负责|交给|落给|你来|我来|他来|她来|谁来|负责人|责任人)/.test(span.text),
  );
  if (namedTaskHints.length > 0 || explicitAssignmentSpans.length > 0) {
    const snippets = [
      ...namedTaskHints,
      ...explicitAssignmentSpans.map((span) => `${span.time}：${span.text}`),
    ];
    return `我听到的任务归属线索是：${dedupeStrings(snippets).slice(0, 3).join("；")}。`;
  }
  if (recentContext.taskHints.length > 0) {
    return `我没有听到明确“任务落给谁”的句子；能确认的待办是：${recentContext.taskHints.slice(0, 3).join("；")}。`;
  }
  if (recentContext.recentTranscriptSpans.length > 0) {
    return `我没有听到明确责任人；最近可转写内容是：${recentContext.recentTranscriptSpans
      .slice(0, 2)
      .map((span) => span.text)
      .join("；")}。`;
  }
  return "我还没有拿到足够清晰的语音证据，不能确认任务落给了谁。";
}

function buildDeskVisitAnswer(recentContext: RecentContextPayload): string {
  const people = dedupeStrings(recentContext.topEvidence.flatMap((item) => item.people));
  if (people.length > 0) {
    const speech = recentContext.recentTranscriptSpans[0]?.text;
    return `工位模式下，最近看到的人物线索有：${people.join("、")}。${speech ? `最近听到的是：${speech}` : "但暂时没有足够语音说明来访目的。"}`;
  }
  if (recentContext.recentTranscriptSpans.length > 0) {
    return `我没有看到明确来访者身份，但最近听到一段语音：${recentContext.recentTranscriptSpans[0]?.text}。`;
  }
  if (recentContext.topEvidence.length > 0) {
    return `我没有看到明确来访者身份；最近最相关的画面证据是：${recentContext.topEvidence[0]?.summary}`;
  }
  return "最近这个工位时间窗里还没有足够证据确认是否有人来找过你。";
}

function appendEvidenceTail(evidence: RecentContextPayload["topEvidence"][number] | undefined): string {
  if (!evidence?.transcriptExcerpt) {
    return "";
  }
  return `；最贴近的语音线索是：${evidence.transcriptExcerpt}`;
}

function buildSpokenAnswerText(
  answerText: string,
  recentContext?: RecentContextPayload,
  intent?: AssistantIntent,
): string {
  if (intent?.kind === "day_summary" && recentContext?.overview) {
    return buildOverviewSpokenAnswer(recentContext);
  }
  const normalized = normalizeQuestion(answerText);
  if (!normalized) {
    return "我现在还没有整理出可播报的答案。";
  }
  const sentences = splitSentences(normalized);
  const spoken = sentences.slice(0, 2).join("。");
  return truncateSpokenText(spoken || normalized, 96);
}

function buildOverviewSpokenAnswer(recentContext: RecentContextPayload): string {
  const overview = recentContext.overview;
  if (!overview) {
    return buildSpokenAnswerText(buildEmptyQueryContextLead(recentContext));
  }
  if (overview.counts.events === 0) {
    const rangeLead = overview.kind === "day" ? overview.date : recentContext.timeRange.label;
    return `${rangeLead} 我没有查到可用于回顾的记录。`;
  }
  const summary = stripTrailingPunctuation(
    buildCustomRangeConversationSummary(recentContext, 3, 56) ||
      overview.summary ||
      recentContext.sceneSummary ||
      "这段时间有一些记录，但还没有形成稳定总览",
  );
  const compactSummary = truncateText(summary, overview.kind === "day" ? 120 : 96);
  const reviewItems = (overview.reviewItems.length > 0 ? overview.reviewItems : overview.keyWindowSummaries)
    .map((item) => stripTrailingPunctuation(item.replace(/^Today at a glance：/, "")))
    .filter(Boolean)
    .slice(0, overview.kind === "day" ? 3 : 2)
    .map((item) => truncateText(item, overview.kind === "day" ? 80 : 64));
  const keyLine = reviewItems.length > 0 ? `关键线索包括：${reviewItems.join("；")}。` : "";
  const pending =
    overview.audioCoverage.pendingAudioWindows > 0
      ? `还有 ${overview.audioCoverage.pendingAudioWindows} 个音频窗口不够清晰，细节可能不完整。`
      : "";
  const rangeLead =
    overview.kind === "day"
      ? `${overview.date} 我按全天记录回顾了`
      : `我按 ${recentContext.timeRange.label} 这个时间范围回顾了`;
  const fullText = `${rangeLead}。共 ${overview.counts.events} 条事件、${overview.counts.windows} 个时间窗，${overview.audioCoverage.transcriptReadyWindows}/${overview.audioCoverage.totalAudioWindows} 个音频窗口有清晰转写。整体上：${compactSummary}。${keyLine}${pending}完整内容我已经显示在屏幕上。`;
  return truncateSpokenText(fullText, overview.kind === "day" ? 360 : 280);
}

function buildCustomRangeConversationSummary(
  recentContext: RecentContextPayload,
  limit: number,
  excerptLength: number,
): string {
  if (recentContext.overview?.kind !== "custom" || recentContext.recentTranscriptSpans.length === 0) {
    return "";
  }
  const spans = recentContext.recentTranscriptSpans
    .slice(0, limit)
    .map((span) => `${span.time}：${truncateText(stripTrailingPunctuation(span.text), excerptLength)}`);
  return spans.length > 0 ? `可读音频主要包括：${spans.join("；")}` : "";
}

function isDiagnosticAttentionHint(text: string): boolean {
  return /已临时回退到同一 ClawSense 媒体库里的全部设备证据/.test(text);
}

function splitSentences(text: string): string[] {
  return normalizeQuestion(text)
    .split(/[。！？!?；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanTranscriptText(text: string | null | undefined): string {
  return splitSentences(text ?? "")
    .filter((sentence) => !looksLikeAssistantSelfTalk(sentence))
    .join("。");
}

function looksLikeAssistantSelfTalk(text: string | null | undefined): boolean {
  const normalized = normalizeQuestion(text);
  if (!normalized) {
    return false;
  }
  return [
    /^会议模式下[，,。]?我/,
    /^工位模式下[，,。]?/,
    /^我最近看到的场景是/,
    /^我刚刚听到的重点是/,
    /^我没有听到明确责任人/,
    /^我没有看到明确来访者身份/,
    /^我还没有拿到足够清晰/,
    /^我这会儿还没有拿到/,
    /^最近这段时间有音频活动/,
    /^当前可确认的场景是/,
    /^场景上看[，,]/,
    /^刚才.*(重点|说了什么|聊了什么|讨论).*场景上看/,
    /当前最值得注意的是/,
    /^这次我没有听清/,
    /^最近这个时间窗/,
  ].some((pattern) => pattern.test(normalized));
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function stripTrailingPunctuation(text: string): string {
  return text.trim().replace(/[。；;,.，]+$/g, "");
}

function truncateSpokenText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const boundaryChars = ["。", "；", "，", "、", ",", ";"];
  let bestBoundary = -1;
  for (const boundary of boundaryChars) {
    const index = text.lastIndexOf(boundary, maxLength - 1);
    if (index >= Math.floor(maxLength * 0.45)) {
      bestBoundary = Math.max(bestBoundary, index);
    }
  }
  if (bestBoundary > 0) {
    return `${text.slice(0, bestBoundary).trim()}。`;
  }
  return truncateText(text, maxLength);
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeQuestion(text: string | null | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatDateKey(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}
