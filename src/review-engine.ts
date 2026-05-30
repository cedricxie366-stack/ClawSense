import fs from "node:fs/promises";
import type { ClawSenseConfig } from "./config.js";
import type { ClawSenseMemorySearchHit } from "./memory-store.js";
import {
  resolveOpenAiClient,
  resolveOpenAiClientForProvider,
  resolvePrimaryMultimodalModel,
  resolveReviewGenerationModel,
  transcribeAudioWithFallbackModel,
  understandAudioWithPrimaryModel,
} from "./openai-client.js";
import type { OpenClawConfig, PluginLogger } from "./openclaw-types.js";
import type {
  ClawSenseArtifactRecord,
  ClawSenseCaptureEvent,
  ClawSenseDailyConsolidation,
  ClawSenseDailyReview,
  ClawSensePersonAnnotation,
  ClawSenseReviewSection,
  ClawSenseSpeakerAnnotation,
  ClawSenseStateStore,
} from "./state-store.js";
import { toLocalDateKey } from "./state-store.js";
import {
  inferMimeFromName,
  isLowSignalSemanticText,
  isUsableAudioSemanticSummaryText,
  isUsableTranscriptText,
  isUsableVisualSummaryText,
  normalizeSemanticText,
  parseClawSenseAudioSessionHint,
} from "./utils.js";

type ReviewWindow = {
  windowId: string;
  deviceId: string;
  startedAt: number;
  endedAt: number;
  events: ClawSenseCaptureEvent[];
  artifacts: ClawSenseArtifactRecord[];
  primarySummary: string;
  transcriptText: string;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  score: number;
  summaryStrength: number;
  summaryCapturedAt: number;
};

type PhaseAcceptanceStatus = "pass" | "needs-work" | "missing-data";
type PhaseAcceptanceCriterionId =
  | "office-recap"
  | "school-recap"
  | "audio-reinforcement"
  | "video-evidence"
  | "annotation-and-stability";
type RecentActivitySnapshot = {
  lookbackDays: number;
  priorEventCount: number;
  priorWindowCount: number;
  priorActiveDays: number;
  lastSeenAt?: number;
  sampleWindows?: Array<{
    windowId: string;
    startedAt: number;
    endedAt: number;
    summary: string;
    audioCount: number;
    imageCount: number;
    videoCount: number;
  }>;
};

const REVIEW_SECTION_TITLES = [
  "Today at a glance",
  "时间线回顾",
  "关键人物",
  "关键项目 / 主题",
  "值得注意的细节",
  "今天遗漏但值得追问的点",
  "明天建议关注的事情",
] as const;

const MAX_SECTION_ITEMS = 4;
const MAX_TIMELINE_ITEMS = 6;
const SYSTEM_TAGS = new Set(["audio-window", "active-window", "baseline-snapshot"]);
const ACTIVE_IMAGE_SESSION_ATTACH_GAP_MS = 3 * 60_000;
const MAX_QUERY_TIME_AUDIO_ARTIFACT_BYTES = 512 * 1024;
const MAX_QUERY_TIME_AUDIO_ARTIFACTS_PER_WINDOW = 2;
const AUDIO_BACKFILL_MAX_ARTIFACT_BYTES = 768 * 1024;
const AUDIO_BACKFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ASSISTANT_RECENT_ACTIVITY_LOOKBACK_DAYS = 7;
const MULTIMODAL_REVIEW_INSTRUCTIONS = [
  "你正在为 ClawSense 生成当天回顾，角色是可靠的助理，而不是机械纪要。",
  "只能根据给定的事件窗口、人物注释和图片来写，不要编造未出现的事实。",
  "不要对情绪、意图、关系状态或微表情下结论；如果不确定，只能写成观察或待确认问题。",
  "如果画面全黑、近乎全黑、模糊或可能被遮挡，只能写成“黑暗环境”或“镜头可能被遮挡，待确认”，不要推断设备关闭、故障、休眠或其他系统状态。",
  "如果图片里出现文字，可以概括可见文字内容，但不要从文字再延伸推断拍摄者的心理状态、人生处境或动机。",
  "输出必须是 JSON，且不要带 markdown 代码块。",
  'JSON 结构必须是 {"summary":"","sections":[{"title":"Today at a glance","items":[""]},{"title":"时间线回顾","items":[""]},{"title":"关键人物","items":[""]},{"title":"关键项目 / 主题","items":[""]},{"title":"值得注意的细节","items":[""]},{"title":"今天遗漏但值得追问的点","items":[""]},{"title":"明天建议关注的事情","items":[""]}],"keyWindowIds":[""]}。',
  "summary 用 1 到 2 句话说明当天最值得关注的主线，以及是否存在信息缺口。",
  "sections 必须严格包含以上 7 个标题，顺序不能变。",
  "每个 section 的 items 保持 1 到 4 条，每条一句话，尽量具体到时间、人物、项目、细节或待确认问题。",
  "时间线回顾必须按时间顺序写，不要只重复 summary。",
  "关键人物不要轻易留空；如果身份不明，也要写成待确认的对话对象或待确认人物，并指出下一步该问什么。",
  "关键项目 / 主题只写当天真实出现过的项目、任务、生活主题或反复出现的标签，不要直接照搬 audio-window、windowId、eventId 等技术词。",
  "如果只能看到 personRef，请写成“待确认人物（ref: xxx）”，不要把原始 ref 当成人名。",
  "如果只能看到机器标签，请先翻译成用户能懂的活动或主题表达，再决定是否输出。",
  "值得注意的细节不要只贴原句，要顺带说清为什么这段值得记住。",
  "今天遗漏但值得追问的点必须写成用户可以直接回答的问题。",
  "今天遗漏但值得追问的点优先保留 1 到 3 个最有价值的问题，而不是把所有缺口都列出来。",
  "明天建议关注的事情必须是可执行的下一步，不要泛泛而谈。",
  "如果转写、图片或人物信息不足，请直接指出素材不足，不要假装已经确认。",
  "keyWindowIds 只保留 1 到 3 个最值得回看的窗口 ID。",
].join("\n");

export class ClawSenseReviewEngine {
  private readonly cfg: ClawSenseConfig;
  private readonly runtimeConfig: OpenClawConfig;
  private readonly logger: PluginLogger;
  private readonly stateStore: ClawSenseStateStore;
  private readonly memorySearch?:
    | {
        searchRelevantMemories: (params: {
          question: string;
          startAt?: number;
          endAt?: number;
          deviceId?: string;
          modality?: "audio" | "image" | "video";
          limit?: number;
        }) => Promise<ClawSenseMemorySearchHit[]>;
      }
    | undefined;
  private readonly openai;
  private readonly providerOpenAiClients = new Map<string, ReturnType<typeof resolveOpenAiClient>>();

  constructor(params: {
    cfg: ClawSenseConfig;
    runtimeConfig: OpenClawConfig;
    logger: PluginLogger;
    stateStore: ClawSenseStateStore;
    memorySearch?: {
      searchRelevantMemories: (args: {
        question: string;
        startAt?: number;
        endAt?: number;
        deviceId?: string;
        modality?: "audio" | "image" | "video";
        limit?: number;
      }) => Promise<ClawSenseMemorySearchHit[]>;
    };
  }) {
    this.cfg = params.cfg;
    this.runtimeConfig = params.runtimeConfig;
    this.logger = params.logger;
    this.stateStore = params.stateStore;
    this.memorySearch = params.memorySearch;
    this.openai = resolveOpenAiClient(params.cfg, params.runtimeConfig);
  }

  normalizeDateInput(input: string | undefined): string {
    if (input && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
      return input.trim();
    }
    return toLocalDateKey(Date.now());
  }

  async buildLibrary(params: {
    date: string;
    deviceId?: string;
    modality?: "audio" | "image" | "video";
    artifactUrlBase: string;
  }): Promise<{
    date: string;
    counts: { events: number; artifacts: number; devices: number };
    devices: Array<{ deviceId: string; name: string }>;
    events: Array<{
      eventId: string;
      windowId: string;
      deviceId: string;
      modality: "audio" | "image" | "video";
      capturedAt: number;
      summary: string;
      transcript?: string;
      note?: string;
      captureContext: string;
      artifact?: {
        artifactId: string;
        fileName: string;
        mime?: string;
        available: boolean;
        sizeBytes: number;
        url: string;
      };
    }>;
  }> {
    const events = await this.filteredEvents({
      date: params.date,
      deviceId: params.deviceId,
      modality: params.modality,
      includeVideo: true,
    });
    const artifacts = await this.stateStore.listArtifacts();
    const devices = await this.stateStore.listDevices();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));

    return {
      date: params.date,
      counts: {
        events: events.length,
        artifacts: events.filter((event) => artifactById.has(event.artifactId)).length,
        devices: new Set(events.map((event) => event.deviceId)).size,
      },
      devices: devices.map((device) => ({ deviceId: device.deviceId, name: device.name })),
      events: events.map((event) => {
        const artifact = artifactById.get(event.artifactId);
        return {
          eventId: event.eventId,
          windowId: event.windowId,
          deviceId: event.deviceId,
          modality: event.modality,
          capturedAt: event.capturedAt,
          summary: event.summary,
          transcript: event.transcript,
          note: event.note,
          captureContext: event.captureContext,
          artifact: artifact
            ? {
                artifactId: artifact.artifactId,
                fileName: artifact.fileName,
                mime: artifact.mime,
                available: !artifact.deletedAt,
                sizeBytes: artifact.sizeBytes,
                url: `${params.artifactUrlBase}?id=${encodeURIComponent(artifact.artifactId)}`,
              }
            : undefined,
        };
      }),
    };
  }

  async buildEvents(params: {
    date: string;
    deviceId?: string;
    modality?: "audio" | "image" | "video";
  }): Promise<{
    date: string;
    windows: ReviewWindow[];
    people: ClawSensePersonAnnotation[];
  }> {
    const events = await this.filteredEvents({
      date: params.date,
      deviceId: params.deviceId,
      modality: params.modality,
    });
    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const windows = groupWindows(events, artifactById);
    const people = await this.stateStore.listPeople();
    return {
      date: params.date,
      windows,
      people,
    };
  }

  async buildAssistantContext(params: {
    scope?: "last-hour" | "today" | "custom-range";
    date?: string;
    startAt?: number;
    endAt?: number;
    question?: string;
    deviceId?: string;
    modality?: "audio" | "image" | "video";
    artifactUrlBase: string;
    now?: number;
  }): Promise<{
    scope: "last-hour" | "today" | "custom-range";
    date: string;
    startAt: number;
    endAt: number;
    counts: { events: number; windows: number; artifacts: number; devices: number };
    summary: string;
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
    review?: ClawSenseDailyReview;
    consolidation?: ClawSenseDailyConsolidation;
    windows: Array<{
      windowId: string;
      deviceId: string;
      startedAt: number;
      endedAt: number;
      primarySummary: string;
      transcriptText: string;
      imageCount: number;
      videoCount: number;
      audioCount: number;
      captureContexts: string[];
      peopleRefs: string[];
      projectRefs: string[];
      tags: string[];
      events: Array<{
        eventId: string;
        modality: "audio" | "image" | "video";
        capturedAt: number;
        summary: string;
        transcript?: string;
        note?: string;
        captureContext: string;
        analysisMode: ClawSenseCaptureEvent["analysisMode"];
        analysisProvider?: string;
        analysisStatus?: ClawSenseCaptureEvent["analysisStatus"];
        analysisFailureReason?: string;
        artifact?: {
          artifactId: string;
          fileName: string;
          mime?: string;
          available: boolean;
          sizeBytes: number;
          url: string;
        };
      }>;
    }>;
    highlights: {
      keyWindowIds: string[];
      audioCoverage: {
        totalAudioWindows: number;
        transcriptReadyWindows: number;
        pendingAudioWindows: number;
        degradedAudioEvents: number;
      };
      recentImages: Array<{
        eventId: string;
        capturedAt: number;
        summary: string;
        artifact?: {
          artifactId: string;
          fileName: string;
          mime?: string;
          available: boolean;
          sizeBytes: number;
          url: string;
        };
      }>;
      recentConversations: Array<{
        windowId: string;
        startedAt: number;
        endedAt: number;
        summary: string;
        transcriptExcerpt?: string;
      }>;
      people: Array<{
        personRef: string;
        displayName: string;
        relationship?: string;
        nextWatchFor?: string;
      }>;
      speakers: Array<{
        speakerRef: string;
        displayName: string;
        relationship?: string;
        windowId?: string;
        deviceId?: string;
      }>;
    };
  }> {
    const hasCustomRange =
      Number.isFinite(params.startAt) &&
      Number.isFinite(params.endAt) &&
      Number(params.endAt) > Number(params.startAt);
    const scope = hasCustomRange ? "custom-range" : params.scope ?? "today";
    const now = params.now ?? Date.now();
    const date =
      scope === "today"
        ? this.normalizeDateInput(params.date)
        : hasCustomRange
          ? toLocalDateKey(Number(params.startAt))
          : toLocalDateKey(now);
    const startAt = hasCustomRange
      ? Number(params.startAt)
      : scope === "last-hour"
        ? now - 60 * 60 * 1000
        : startOfLocalDate(date).getTime();
    const endAt = hasCustomRange
      ? Number(params.endAt)
      : scope === "last-hour"
        ? now
        : startAt + 24 * 60 * 60 * 1000;
    const events = await this.filteredEvents({
      startAt,
      endAt,
      deviceId: params.deviceId,
      modality: params.modality,
    });
    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const windows = groupWindows(events, artifactById);
    const people = selectRelevantPeople(windows, await this.stateStore.listPeople());
    const speakers = selectRelevantSpeakers(windows, await this.stateStore.listSpeakers());
    const review = scope === "today" ? await this.getOrGenerateDailyReview(date) : undefined;
    const consolidation =
      scope === "today" ? await this.getOrGenerateDailyConsolidation(date) : undefined;
    const semanticWindowIds = await this.resolveSemanticWindowHints({
      question: params.question,
      startAt,
      endAt,
      deviceId: params.deviceId,
      modality: params.modality,
      events,
    });
    const contextWindows = selectAssistantContextWindows({
      windows,
      question: params.question,
      maxWindows: 6,
      semanticWindowIds,
    });
    const keyWindows = windows.slice().sort((left, right) => right.score - left.score).slice(0, 3);
    const audioWindows = windows.filter((window) => window.audioCount > 0);
    const transcriptReadyWindows = audioWindows.filter((window) => Boolean(window.transcriptText.trim()));
    const pendingAudioWindows = audioWindows.filter((window) => !window.transcriptText.trim());
    const degradedAudioEvents = events.filter(
      (event) => event.modality === "audio" && event.analysisStatus === "degraded",
    ).length;
    const recentActivity = await this.buildRecentActivitySnapshot({
      startAt,
      deviceId: params.deviceId,
      modality: params.modality,
    });
    const shouldUseReviewSummary = Boolean(review?.summary?.trim()) && events.length > 0;

    return {
      scope,
      date,
      startAt,
      endAt,
      counts: {
        events: events.length,
        windows: windows.length,
        artifacts: events.filter((event) => artifactById.has(event.artifactId)).length,
        devices: new Set(events.map((event) => event.deviceId)).size,
      },
      summary: shouldUseReviewSummary
        ? review!.summary
        : buildAssistantContextSummary(scope, date, windows, {
            startAt,
            endAt,
            recentActivity,
          }),
      recentActivity: {
        ...recentActivity,
        lastSeenDate:
          typeof recentActivity.lastSeenAt === "number"
            ? toLocalDateKey(recentActivity.lastSeenAt)
            : undefined,
        sampleWindows: (recentActivity.sampleWindows ?? []).map((window) => ({
          windowId: window.windowId,
          startedAt: window.startedAt,
          endedAt: window.endedAt,
          timeRange: `${toLocalDateKey(window.startedAt)} ${toTimeLabel(window.startedAt)}-${toTimeLabel(window.endedAt)}`,
          summary: window.summary,
          audioCount: window.audioCount,
          imageCount: window.imageCount,
          videoCount: window.videoCount,
        })),
      },
      review,
      consolidation,
      windows: contextWindows.map((window) => ({
        windowId: window.windowId,
        deviceId: window.deviceId,
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        primarySummary: window.primarySummary,
        transcriptText: window.transcriptText,
        imageCount: window.imageCount,
        videoCount: window.videoCount,
        audioCount: window.audioCount,
        captureContexts: dedupeStrings(window.events.map((event) => event.captureContext)),
        peopleRefs: dedupeStrings(window.events.flatMap((event) => event.peopleRefs)),
        projectRefs: dedupeStrings(window.events.flatMap((event) => event.projectRefs)),
        tags: dedupeStrings(window.events.flatMap((event) => event.tags)),
        events: window.events
          .slice()
          .sort((left, right) => left.capturedAt - right.capturedAt)
          .map((event) => ({
            eventId: event.eventId,
            modality: event.modality,
            capturedAt: event.capturedAt,
            summary: event.summary,
            transcript: event.transcript,
            note: event.note,
            captureContext: event.captureContext,
            analysisMode: event.analysisMode,
            analysisProvider: event.analysisProvider,
            analysisStatus: event.analysisStatus,
            analysisFailureReason: event.analysisFailureReason,
            artifact: buildArtifactPayload(
              artifactById.get(event.artifactId),
              params.artifactUrlBase,
            ),
          })),
      })),
      highlights: {
        keyWindowIds: keyWindows.map((window) => window.windowId),
        audioCoverage: {
          totalAudioWindows: audioWindows.length,
          transcriptReadyWindows: transcriptReadyWindows.length,
          pendingAudioWindows: pendingAudioWindows.length,
          degradedAudioEvents,
        },
        recentImages: events
          .filter((event) => event.modality === "image")
          .slice()
          .sort((left, right) => right.capturedAt - left.capturedAt)
          .slice(0, 4)
          .map((event) => ({
            eventId: event.eventId,
            capturedAt: event.capturedAt,
            summary: event.summary,
            artifact: buildArtifactPayload(
              artifactById.get(event.artifactId),
              params.artifactUrlBase,
            ),
          })),
        recentConversations: windows
          .filter((window) => window.audioCount > 0 || Boolean(window.transcriptText.trim()))
          .slice()
          .sort((left, right) => right.endedAt - left.endedAt)
          .slice(0, 4)
          .map((window) => ({
            windowId: window.windowId,
            startedAt: window.startedAt,
            endedAt: window.endedAt,
            summary: resolveWindowDisplaySummary(window),
            transcriptExcerpt: window.transcriptText
              ? truncateText(toSingleLine(window.transcriptText), 180)
              : undefined,
          })),
        people: people.slice(0, 6).map((person) => ({
          personRef: person.personRef,
          displayName: person.displayName,
          relationship: person.relationship,
          nextWatchFor: person.nextWatchFor,
        })),
        speakers: speakers.slice(0, 8).map((speaker) => ({
          speakerRef: speaker.speakerRef,
          displayName: speaker.displayName,
          relationship: speaker.relationship,
          windowId: speaker.windowId,
          deviceId: speaker.deviceId,
        })),
      },
    };
  }

  private async resolveSemanticWindowHints(params: {
    question?: string;
    startAt: number;
    endAt: number;
    deviceId?: string;
    modality?: "audio" | "image" | "video";
    events: ClawSenseCaptureEvent[];
  }): Promise<string[]> {
    if (!this.memorySearch || !params.question?.trim()) {
      return [];
    }
    try {
      const hits = await this.memorySearch.searchRelevantMemories({
        question: params.question,
        startAt: params.startAt,
        endAt: params.endAt,
        deviceId: params.deviceId,
        modality: params.modality,
        limit: 12,
      });
      if (hits.length === 0) {
        return [];
      }
      const windowByEventId = new Map(params.events.map((event) => [event.eventId, event.windowId]));
      const matched = hits
        .map((hit) => windowByEventId.get(hit.eventId))
        .filter((windowId): windowId is string => Boolean(windowId));
      return dedupeStrings(matched).slice(0, 6);
    } catch (error) {
      this.logger.warn(`[clawsense] semantic window recall failed: ${String(error)}`);
      return [];
    }
  }

  async recheckAudioEvidence(params: {
    scope?: "last-hour" | "today" | "custom-range";
    date?: string;
    startAt?: number;
    endAt?: number;
    deviceId?: string;
    artifactUrlBase: string;
    question?: string;
    maxWindows?: number;
  }): Promise<
    Array<{
      windowId: string;
      timeRange: string;
      transcript?: string;
      summary?: string;
      analysisProvider: string;
      analysisFailureReason?: string;
      artifact: {
        artifactId: string;
        fileName: string;
        mime?: string;
        available: boolean;
        sizeBytes: number;
        url: string;
      };
    }>
  > {
    const hasCustomRange =
      Number.isFinite(params.startAt) &&
      Number.isFinite(params.endAt) &&
      Number(params.endAt) > Number(params.startAt);
    const scope = hasCustomRange ? "custom-range" : params.scope ?? "today";
    const now = Date.now();
    const date =
      scope === "today"
        ? this.normalizeDateInput(params.date)
        : hasCustomRange
          ? toLocalDateKey(Number(params.startAt))
          : toLocalDateKey(now);
    const startAt = hasCustomRange
      ? Number(params.startAt)
      : scope === "last-hour"
        ? now - 60 * 60 * 1000
        : startOfLocalDate(date).getTime();
    const endAt = hasCustomRange
      ? Number(params.endAt)
      : scope === "last-hour"
        ? now
        : startAt + 24 * 60 * 60 * 1000;
    const events = await this.filteredEvents({
      startAt,
      endAt,
      deviceId: params.deviceId,
      modality: "audio",
    });
    if (events.length === 0) {
      return [];
    }

    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const windows = groupWindows(events, artifactById);
    const primaryProviderId = resolvePrimaryMultimodalModel(this.cfg, this.runtimeConfig).providerId;
    const fallbackSttProviderId = this.resolveFallbackSttProviderId(primaryProviderId);
    const queryTerms = extractSimpleQueryTerms(params.question);
    const selectedWindows = windows
      .filter((window) => window.audioCount > 0)
      .map((window) => ({
        window,
        candidateArtifacts: pickQueryTimeAudioArtifacts(window.artifacts),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          window: ReviewWindow;
          candidateArtifacts: ClawSenseArtifactRecord[];
        } => candidate.candidateArtifacts.length > 0,
      )
      .map((window) => ({
        window: window.window,
        candidateArtifacts: window.candidateArtifacts,
        questionBoost:
          queryTerms.length === 0
            ? 0
            : queryTerms.reduce((score, term) => {
                const haystack = `${window.window.primarySummary} ${window.window.transcriptText}`.toLowerCase();
                return haystack.includes(term) ? score + 8 : score;
              }, 0),
        artifactPenalty: Math.floor(window.candidateArtifacts[0]!.sizeBytes / MAX_QUERY_TIME_AUDIO_ARTIFACT_BYTES),
      }))
      .sort(
        (left, right) =>
          right.questionBoost - left.questionBoost ||
          left.artifactPenalty - right.artifactPenalty ||
          right.window.score - left.window.score ||
          right.window.endedAt - left.window.endedAt,
      )
      .slice(0, Math.max(1, Math.min(params.maxWindows ?? 2, 3)));

    const results: Array<{
      windowId: string;
      timeRange: string;
      transcript?: string;
      summary?: string;
      analysisProvider: string;
      analysisFailureReason?: string;
      artifact: {
        artifactId: string;
        fileName: string;
        mime?: string;
        available: boolean;
        sizeBytes: number;
        url: string;
      };
    }> = [];

    for (const { window, candidateArtifacts } of selectedWindows) {
      for (const artifact of candidateArtifacts.slice(0, MAX_QUERY_TIME_AUDIO_ARTIFACTS_PER_WINDOW)) {
        try {
          const buffer = await fs.readFile(artifact.storagePath);
          const multimodalAttempt = await understandAudioWithPrimaryModel({
            primaryOpenai: this.resolveMultimodalClient(primaryProviderId),
            fallbackOpenai: this.resolveMultimodalClient(this.cfg.visionProvider),
            cfg: this.cfg,
            runtimeConfig: this.runtimeConfig,
            body: buffer,
            fileName: artifact.fileName,
            mime: artifact.mime,
          });
          let transcript = multimodalAttempt.transcript;
          const summary = multimodalAttempt.summary;
          let analysisProvider = multimodalAttempt.analysisProvider;
          let analysisFailureReason = multimodalAttempt.analysisFailureReason;
          let sttProvider: ClawSenseCaptureEvent["sttProvider"];

          if (!normalizeSemanticText(transcript)) {
            const asrAttempt = await transcribeAudioWithFallbackModel({
              cfg: this.cfg,
              runtimeConfig: this.runtimeConfig,
              body: buffer,
              fileName: artifact.fileName,
              mime: artifact.mime,
              providerId: fallbackSttProviderId,
              openai: this.resolveMultimodalClient(fallbackSttProviderId),
            });
            if (normalizeSemanticText(asrAttempt.transcript)) {
              transcript = asrAttempt.transcript;
              analysisProvider = `${multimodalAttempt.analysisProvider}+${asrAttempt.analysisProvider}`;
              sttProvider = inferBackfillSttProvider(asrAttempt.analysisProvider);
            } else {
              analysisFailureReason = combineFailureReasons(
                analysisFailureReason,
                asrAttempt.analysisFailureReason,
              );
            }
          }

          if (normalizeSemanticText(transcript) || normalizeSemanticText(summary)) {
            await this.stateStore.backfillCaptureAnalysis({
              artifactId: artifact.artifactId,
              summary,
              transcript,
              analysisProvider,
              analysisStatus: normalizeSemanticText(transcript) ? "succeeded" : "degraded",
              analysisFailureReason,
              sttProvider,
            });
          }
          const artifactPayload = buildArtifactPayload(artifact, params.artifactUrlBase);
          if (!artifactPayload) {
            continue;
          }
          results.push({
            windowId: window.windowId,
            timeRange: `${toTimeLabel(window.startedAt)}-${toTimeLabel(window.endedAt)}`,
            transcript,
            summary,
            analysisProvider,
            analysisFailureReason,
            artifact: artifactPayload,
          });
        } catch (error) {
          const artifactPayload = buildArtifactPayload(artifact, params.artifactUrlBase);
          if (!artifactPayload) {
            continue;
          }
          results.push({
            windowId: window.windowId,
            timeRange: `${toTimeLabel(window.startedAt)}-${toTimeLabel(window.endedAt)}`,
            analysisProvider: "query-time-audio-recheck",
            analysisFailureReason: `audio_artifact_read_error:${String(error)}`,
            artifact: artifactPayload,
          });
        }
      }
    }

    return results;
  }

  async getOrGenerateDailyReview(date: string, options?: { force?: boolean }): Promise<ClawSenseDailyReview> {
    if (!options?.force) {
      const existing = await this.stateStore.getDailyReview(date);
      if (existing && (await this.isReviewFresh(date, existing))) {
        return existing;
      }
    }
    const review = await this.generateDailyReview(date);
    await this.stateStore.putDailyReview(review);
    return review;
  }

  async getOrGenerateDailyConsolidation(
    date: string,
    options?: { force?: boolean },
  ): Promise<ClawSenseDailyConsolidation> {
    if (!options?.force) {
      const existing = await this.stateStore.getDailyConsolidation(date);
      if (existing && (await this.isConsolidationFresh(date, existing))) {
        return existing;
      }
    }
    const consolidation = await this.generateDailyConsolidation(date);
    await this.stateStore.putDailyConsolidation(consolidation);
    return consolidation;
  }

  async annotatePerson(params: {
    personRef: string;
    displayName: string;
    notes?: string;
    relationship?: string;
    nextWatchFor?: string;
    eventIds?: string[];
  }): Promise<ClawSensePersonAnnotation> {
    return await this.stateStore.upsertPersonAnnotation(params);
  }

  async annotateSpeaker(params: {
    speakerRef: string;
    displayName: string;
    notes?: string;
    relationship?: string;
    windowId?: string;
    deviceId?: string;
    eventIds?: string[];
  }): Promise<ClawSenseSpeakerAnnotation> {
    return await this.stateStore.upsertSpeakerAnnotation(params);
  }

  async buildIdentityHistory(params: {
    question?: string;
    artifactUrlBase: string;
    currentPersonRefs?: string[];
    currentSpeakerRefs?: string[];
    limit?: number;
  }): Promise<
    Array<{
      kind: "person" | "speaker";
      ref: string;
      displayName: string;
      relationship?: string;
      notes?: string;
      nextWatchFor?: string;
      occurrenceCount: number;
      relatedDates: string[];
      firstSeenAt: number;
      lastSeenAt: number;
      recentMoments: Array<{
        date: string;
        timeRange: string;
        windowId: string;
        summary: string;
        transcriptExcerpt?: string;
        artifactUrls: string[];
      }>;
    }>
  > {
    if (!params.question?.trim()) {
      return [];
    }

    const people = await this.stateStore.listPeople();
    const speakers = await this.stateStore.listSpeakers();
    const targets = resolveHistoricalIdentityTargets({
      question: params.question,
      currentPersonRefs: params.currentPersonRefs ?? [],
      currentSpeakerRefs: params.currentSpeakerRefs ?? [],
      people,
      speakers,
    }).slice(0, Math.max(1, params.limit ?? 2));

    if (targets.length === 0) {
      return [];
    }

    const events = await this.stateStore.listEvents();
    if (events.length === 0) {
      return [];
    }
    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const windows = groupWindows(events, artifactById)
      .slice()
      .sort((left, right) => right.endedAt - left.endedAt);

    const results = targets.flatMap((target) => {
      const matchedWindows = windows.filter((window) => doesWindowMatchHistoricalTarget(window, target));
      if (matchedWindows.length === 0) {
        return [];
      }

      const relatedDates = dedupeStrings(matchedWindows.map((window) => toLocalDateKey(window.startedAt)));
      const firstSeenAt = matchedWindows.reduce((earliest, window) => Math.min(earliest, window.startedAt), Number.POSITIVE_INFINITY);
      const lastSeenAt = matchedWindows.reduce((latest, window) => Math.max(latest, window.endedAt), 0);
      const recentMoments = matchedWindows.slice(0, 4).map((window) => ({
        date: toLocalDateKey(window.startedAt),
        timeRange: `${toTimeLabel(window.startedAt)}-${toTimeLabel(window.endedAt)}`,
        windowId: window.windowId,
        summary: resolveWindowDisplaySummary(window),
        transcriptExcerpt: window.transcriptText
          ? truncateText(toSingleLine(window.transcriptText), 180)
          : undefined,
        artifactUrls: window.artifacts
          .filter((artifact) => !artifact.deletedAt)
          .slice(0, 2)
          .map((artifact) => `${params.artifactUrlBase}?id=${encodeURIComponent(artifact.artifactId)}`),
      }));

      return [{
        kind: target.kind,
        ref: target.ref,
        displayName: target.displayName,
        relationship: target.relationship,
        notes: target.notes,
        nextWatchFor: target.nextWatchFor,
        occurrenceCount: matchedWindows.length,
        relatedDates,
        firstSeenAt,
        lastSeenAt,
        recentMoments,
      }];
    });

    return results
      .slice()
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.occurrenceCount - left.occurrenceCount)
      .slice(0, Math.max(1, params.limit ?? 2));
  }

  async buildProjectHistory(params: {
    question?: string;
    artifactUrlBase: string;
    currentProjectRefs?: string[];
    currentTags?: string[];
    limit?: number;
  }): Promise<
    Array<{
      ref: string;
      label: string;
      source: "project-ref" | "tag";
      occurrenceCount: number;
      relatedDates: string[];
      firstSeenAt: number;
      lastSeenAt: number;
      recentMoments: Array<{
        date: string;
        timeRange: string;
        windowId: string;
        summary: string;
        transcriptExcerpt?: string;
        artifactUrls: string[];
      }>;
    }>
  > {
    if (!params.question?.trim()) {
      return [];
    }

    const events = await this.stateStore.listEvents();
    if (events.length === 0) {
      return [];
    }
    const targets = resolveHistoricalProjectTargets({
      question: params.question,
      currentProjectRefs: params.currentProjectRefs ?? [],
      currentTags: params.currentTags ?? [],
      events,
    }).slice(0, Math.max(1, params.limit ?? 2));
    if (targets.length === 0) {
      return [];
    }

    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const windows = groupWindows(events, artifactById)
      .slice()
      .sort((left, right) => right.endedAt - left.endedAt);

    const results = targets.flatMap((target) => {
      const matchedWindows = windows.filter((window) => doesWindowMatchHistoricalProjectTarget(window, target));
      if (matchedWindows.length === 0) {
        return [];
      }

      const relatedDates = dedupeStrings(matchedWindows.map((window) => toLocalDateKey(window.startedAt)));
      const firstSeenAt = matchedWindows.reduce((earliest, window) => Math.min(earliest, window.startedAt), Number.POSITIVE_INFINITY);
      const lastSeenAt = matchedWindows.reduce((latest, window) => Math.max(latest, window.endedAt), 0);
      const recentMoments = matchedWindows.slice(0, 4).map((window) => ({
        date: toLocalDateKey(window.startedAt),
        timeRange: `${toTimeLabel(window.startedAt)}-${toTimeLabel(window.endedAt)}`,
        windowId: window.windowId,
        summary: resolveWindowDisplaySummary(window),
        transcriptExcerpt: window.transcriptText
          ? truncateText(toSingleLine(window.transcriptText), 180)
          : undefined,
        artifactUrls: window.artifacts
          .filter((artifact) => !artifact.deletedAt)
          .slice(0, 2)
          .map((artifact) => `${params.artifactUrlBase}?id=${encodeURIComponent(artifact.artifactId)}`),
      }));

      return [{
        ref: target.ref,
        label: target.label,
        source: target.source,
        occurrenceCount: matchedWindows.length,
        relatedDates,
        firstSeenAt,
        lastSeenAt,
        recentMoments,
      }];
    });

    return results
      .slice()
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.occurrenceCount - left.occurrenceCount)
      .slice(0, Math.max(1, params.limit ?? 2));
  }

  async buildPhaseAcceptance(params?: {
    lookbackDays?: number;
    now?: number;
  }): Promise<{
    generatedAt: number;
    lookbackDays: number;
    range: {
      startAt: number;
      endAt: number;
      startDate: string;
      endDate: string;
    };
    completion: {
      isPhaseReady: boolean;
      passedCriteria: number;
      totalCriteria: number;
      needsWorkCriteria: number;
      missingDataCriteria: number;
      progressPct: number;
      phaseState: "collecting-data" | "hardening" | "ready-to-close";
    };
    blockers: Array<{
      id: PhaseAcceptanceCriterionId;
      title: string;
      status: Exclude<PhaseAcceptanceStatus, "pass">;
      summary: string;
      topNextAction?: string;
    }>;
    criteria: Array<{
      id: PhaseAcceptanceCriterionId;
      title: string;
      status: PhaseAcceptanceStatus;
      summary: string;
      evidence: Record<string, number | string | boolean>;
      targets: Array<{
        metric: string;
        current: number | string | boolean;
        target: string;
        pass: boolean;
      }>;
      nextActions: string[];
    }>;
  }> {
    const now = params?.now ?? Date.now();
    const lookbackDays = Math.max(1, Math.min(Math.floor(params?.lookbackDays ?? 7), 14));
    const startAt = now - lookbackDays * 24 * 60 * 60 * 1000;
    const endAt = now;
    const events = await this.filteredEvents({ startAt, endAt });
    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const windows = groupWindows(events, artifactById);
    const people = await this.stateStore.listPeople();
    const speakers = await this.stateStore.listSpeakers();
    const devices = await this.stateStore.listDevices();

    const audioEvents = events.filter((event) => event.modality === "audio");
    const audioWindows = windows.filter((window) => window.audioCount > 0);
    const transcriptReadyWindows = audioWindows.filter((window) => isUsableTranscriptText(window.transcriptText));
    const degradedAudioEvents = audioEvents.filter((event) => event.analysisStatus === "degraded");
    const emptyAudioWindows = audioWindows.filter(
      (window) =>
        !isUsableTranscriptText(window.transcriptText) &&
        !isUsableAudioSemanticSummaryText(window.primarySummary),
    );

    const officeWindows = windows.filter((window) =>
      windowMatchesKeywords(window, OFFICE_SCENARIO_KEYWORDS),
    );
    const officePeople = selectRelevantPeople(officeWindows, people);
    const officeSpeakers = selectRelevantSpeakers(officeWindows, speakers);
    const officeConfirmedIdentityCount = officePeople.length + officeSpeakers.length;
    const officeTaskWindows = officeWindows.filter((window) => {
      const keywordHits = countWindowKeywordHits(window, OFFICE_TASK_KEYWORDS);
      const projectHints = window.events.some(
        (event) => event.projectRefs.length > 0 || event.tags.some((tag) => isUserFacingTag(tag)),
      );
      return keywordHits > 0 || projectHints;
    });
    const officeUnknownPersonRefs = dedupeStrings(
      officeWindows
        .flatMap((window) => window.events.flatMap((event) => event.peopleRefs))
        .filter((personRef) => !officePeople.some((person) => person.personRef === personRef)),
    );
    const officePendingSignals =
      officeWindows.filter((window) => window.audioCount > 0 && !isUsableTranscriptText(window.transcriptText))
        .length + officeUnknownPersonRefs.length;
    const officeRoleHintCount =
      officeUnknownPersonRefs.length +
      collectSpeakerRefsFromWindows(officeWindows).length +
      officeSpeakers.length;
    const officeWeakIdentityGuessMentions = officeWindows.reduce(
      (count, window) => count + (containsIdentityGuessPattern(window) ? 1 : 0),
      0,
    );
    const officeStatus: PhaseAcceptanceStatus =
      officeWindows.length === 0
        ? "missing-data"
        : officeTaskWindows.length >= 1 &&
            officeConfirmedIdentityCount >= 1 &&
            officePendingSignals >= 1 &&
            officeRoleHintCount >= 1 &&
            officeWeakIdentityGuessMentions === 0
          ? "pass"
          : "needs-work";
    const officeNextActions: string[] = [];
    if (officeWindows.length === 0) {
      officeNextActions.push("先采一段真实办公日素材（会议/任务讨论），再跑一次验收。");
    } else {
      if (officeTaskWindows.length < 1) {
        officeNextActions.push("补一段明确提到任务、项目或待办的转写，让任务候选能被稳定抽出。");
      }
      if (officeConfirmedIdentityCount < 1) {
        officeNextActions.push("给办公窗口里的人物或说话人至少补一条实名注释（personRef/speakerRef -> displayName）。");
      }
      if (officePendingSignals < 1) {
        officeNextActions.push("让回答里保留至少一个“待确认重点”，避免只给平铺描述。");
      }
      if (officeWeakIdentityGuessMentions > 0) {
        officeNextActions.push("减少“可能是你/可能是同事”这类弱猜测，改为待确认角色线索。");
      }
    }

    const schoolWindows = windows.filter((window) =>
      windowMatchesKeywords(window, SCHOOL_SCENARIO_KEYWORDS),
    );
    const schoolLearningWindows = schoolWindows.filter(
      (window) =>
        isUsableTranscriptText(window.transcriptText) &&
        countWindowKeywordHits(window, SCHOOL_LEARNING_KEYWORDS) > 0,
    );
    const schoolPendingKnowledgeCount = schoolWindows.filter(
      (window) => window.audioCount > 0 && !isUsableTranscriptText(window.transcriptText),
    ).length;
    const schoolSpeakerClues = dedupeStrings([
      ...collectSpeakerRefsFromWindows(schoolWindows),
      ...selectRelevantSpeakers(schoolWindows, speakers).map((speaker) => normalizeSpeakerRef(speaker.speakerRef)),
      ...selectRelevantPeople(schoolWindows, people).map((person) => person.personRef),
    ]).filter(Boolean);
    const schoolStatus: PhaseAcceptanceStatus =
      schoolWindows.length === 0
        ? "missing-data"
        : schoolLearningWindows.length >= 1 &&
            schoolPendingKnowledgeCount >= 1 &&
            schoolSpeakerClues.length >= 1
          ? "pass"
          : "needs-work";
    const schoolNextActions: string[] = [];
    if (schoolWindows.length === 0) {
      schoolNextActions.push("补一段课堂/上学场景素材，至少覆盖一次老师讲重点的对话窗口。");
    } else {
      if (schoolLearningWindows.length < 1) {
        schoolNextActions.push("补一段可读 transcript，明确提到课程重点、作业或知识点。");
      }
      if (schoolPendingKnowledgeCount < 1) {
        schoolNextActions.push("保留一个待确认知识点，让回答能分出“学习要点 vs 待确认问题”。");
      }
      if (schoolSpeakerClues.length < 1) {
        schoolNextActions.push("把课堂中的 speaker/person 线索补出来，至少有一个可标注对象。");
      }
    }

    const transcriptCoverage = audioWindows.length
      ? Number((transcriptReadyWindows.length / audioWindows.length).toFixed(3))
      : 0;
    const audioStatus: PhaseAcceptanceStatus =
      audioWindows.length === 0
        ? "missing-data"
        : transcriptReadyWindows.length >= 1 &&
            transcriptCoverage >= 0.35 &&
            emptyAudioWindows.length < audioWindows.length
          ? "pass"
          : "needs-work";
    const audioNextActions: string[] = [];
    if (audioWindows.length === 0) {
      audioNextActions.push("先采一段包含真实语音的素材，验证 transcript 补强链。");
    } else {
      if (transcriptReadyWindows.length < 1) {
        audioNextActions.push("至少让一个关键音频窗口补出可引用 transcript（ingest/recheck/backfill 任一链路）。");
      }
      if (transcriptCoverage < 0.35) {
        audioNextActions.push("提高关键窗口 transcript 覆盖率，避免回答长期只靠图像和降级摘要。");
      }
      if (emptyAudioWindows.length === audioWindows.length) {
        audioNextActions.push("避免“只有音频但没有任何可引用内容”的状态持续出现。");
      }
    }

    const observedSpeakerRefs = collectSpeakerRefsFromWindows(windows);
    const normalizedSpeakerAnnotations = new Set(
      speakers.map((speaker) => normalizeSpeakerRef(speaker.speakerRef)).filter(Boolean),
    );
    const mappedSpeakerRefs = observedSpeakerRefs.filter((ref) => normalizedSpeakerAnnotations.has(ref));
    const relevantPeople = selectRelevantPeople(windows, people);
    const relevantSpeakers = selectRelevantSpeakers(windows, speakers);
    const relevantIdentityAnnotations = relevantPeople.length + relevantSpeakers.length;
    const activeDeviceIds = new Set(events.map((event) => event.deviceId));
    const activeDevices = devices.filter((device) => activeDeviceIds.has(device.deviceId));
    const heartbeatFreshWindowMs = Math.max(
      this.cfg.heartbeatIntervalSeconds * 1000 * 6,
      45 * 60 * 1000,
    );
    const staleActiveDevices = activeDevices.filter(
      (device) =>
        typeof device.lastHeartbeatAt !== "number" || now - device.lastHeartbeatAt > heartbeatFreshWindowMs,
    );
    const instabilitySignalEvents = events.filter((event) =>
      hasDataPlaneInstabilitySignal(event.analysisFailureReason),
    );
    const stabilityStatus: PhaseAcceptanceStatus =
      activeDevices.length === 0
        ? "missing-data"
        : (observedSpeakerRefs.length === 0 || mappedSpeakerRefs.length >= 1 || relevantSpeakers.length >= 1) &&
            relevantIdentityAnnotations >= 1 &&
            staleActiveDevices.length === 0 &&
            instabilitySignalEvents.length === 0
          ? "pass"
          : "needs-work";
    const stabilityNextActions: string[] = [];
    if (activeDevices.length === 0) {
      stabilityNextActions.push("先让至少一台设备完成一次心跳和上传，才能验收稳定性。");
    } else {
      if (
        observedSpeakerRefs.length > 0 &&
        mappedSpeakerRefs.length < 1 &&
        relevantSpeakers.length < 1
      ) {
        stabilityNextActions.push("把 speaker_1 / speaker_2 至少标注一次，确认后续回答可以复用。");
      }
      if (relevantIdentityAnnotations < 1) {
        stabilityNextActions.push("补一条人物或说话人注释并关联到事件，验证身份写回链路可复用。");
      }
      if (staleActiveDevices.length > 0) {
        stabilityNextActions.push("检查设备心跳是否稳定，避免长时间掉线导致回顾窗口断档。");
      }
      if (instabilitySignalEvents.length > 0) {
        stabilityNextActions.push("优先处理 unauthorized/queue/full 等稳定性错误，避免打断上传闭环。");
      }
    }

    const videoModeEnabled = this.cfg.hostModelVideoMode !== "none";
    const videoEvents = events.filter((event) => event.modality === "video");
    const keyframeEvents = events.filter((event) => isVideoKeyframeCaptureEvent(event));
    const videoWindows = windows.filter(
      (window) =>
        window.videoCount > 0 ||
        window.events.some((event) => isVideoKeyframeCaptureEvent(event)),
    );
    const videoEventsWithArtifacts = videoEvents.filter((event) => {
      const artifact = artifactById.get(event.artifactId);
      return Boolean(artifact && !artifact.deletedAt && artifact.modality === "video");
    });
    const videoRequestIds = dedupeStrings(
      videoEvents
        .map((event) => parseVideoRequestId(event.note) ?? `video-event:${event.eventId}`)
        .concat(
          keyframeEvents.map(
            (event) => parseVideoRequestId(event.note) ?? `keyframe-event:${event.eventId}`,
          ),
        ),
    );
    const videoSemanticReadyEvents = events.filter(
      (event) =>
        (event.modality === "video" || isVideoKeyframeCaptureEvent(event)) &&
        isUsableVisualSummaryText(event.summary),
    );
    const videoSemanticReady = keyframeEvents.length >= 1 || videoSemanticReadyEvents.length >= 1;
    const videoStatus: PhaseAcceptanceStatus =
      !videoModeEnabled
        ? "pass"
        : videoEvents.length + keyframeEvents.length === 0
          ? "missing-data"
          : videoEventsWithArtifacts.length >= 1 && videoSemanticReady
            ? "pass"
            : "needs-work";
    const videoNextActions: string[] = [];
    if (!videoModeEnabled) {
      videoNextActions.push(
        "当前 hostModelVideoMode=none，视频链路按“有意关闭”处理。如要进入视频验收，请先切到 keyframes 或 direct。",
      );
    } else {
      if (videoEvents.length + keyframeEvents.length === 0) {
        videoNextActions.push("补一段真实视频素材并上传（可带 keyframes），再跑一次验收。");
      }
      if (videoEventsWithArtifacts.length < 1) {
        videoNextActions.push("确认视频原件已入库（至少 1 条可回放视频 artifact）。");
      }
      if (!videoSemanticReady) {
        videoNextActions.push("补至少 1 张关键帧或 1 条可用视频摘要，避免只剩 metadata-only 证据。");
      }
    }

    const criteria: Array<{
      id: PhaseAcceptanceCriterionId;
      title: string;
      status: PhaseAcceptanceStatus;
      summary: string;
      evidence: Record<string, number | string | boolean>;
      targets: Array<{
        metric: string;
        current: number | string | boolean;
        target: string;
        pass: boolean;
      }>;
      nextActions: string[];
    }> = [
      {
        id: "office-recap",
        title: "办公场景回答可用",
        status: officeStatus,
        summary:
          officeStatus === "pass"
            ? "办公场景已能稳定提供任务候选、人物信息与待确认重点。"
            : officeStatus === "missing-data"
              ? "当前验收窗口还没有足够的办公场景素材。"
              : "办公场景仍缺任务/人物/待确认重点中的关键要素，离收口标准还有差距。",
        evidence: {
          officeWindows: officeWindows.length,
          taskCandidateWindows: officeTaskWindows.length,
          confirmedPeople: officePeople.length,
          confirmedSpeakers: officeSpeakers.length,
          confirmedIdentities: officeConfirmedIdentityCount,
          roleHints: officeRoleHintCount,
          pendingSignals: officePendingSignals,
          weakIdentityGuessMentions: officeWeakIdentityGuessMentions,
        },
        targets: [
          {
            metric: "officeWindows",
            current: officeWindows.length,
            target: ">= 1",
            pass: officeWindows.length >= 1,
          },
          {
            metric: "taskCandidateWindows",
            current: officeTaskWindows.length,
            target: ">= 1",
            pass: officeTaskWindows.length >= 1,
          },
          {
            metric: "confirmedIdentities",
            current: officeConfirmedIdentityCount,
            target: ">= 1",
            pass: officeConfirmedIdentityCount >= 1,
          },
          {
            metric: "pendingSignals",
            current: officePendingSignals,
            target: ">= 1",
            pass: officePendingSignals >= 1,
          },
          {
            metric: "weakIdentityGuessMentions",
            current: officeWeakIdentityGuessMentions,
            target: "== 0",
            pass: officeWeakIdentityGuessMentions === 0,
          },
        ],
        nextActions: officeNextActions,
      },
      {
        id: "school-recap",
        title: "上学 / 课堂场景回答可用",
        status: schoolStatus,
        summary:
          schoolStatus === "pass"
            ? "课堂场景已能同时给出学习要点、待确认问题和发言者线索。"
            : schoolStatus === "missing-data"
              ? "当前验收窗口还没有覆盖课堂/上学素材。"
              : "课堂场景还缺学习要点、待确认知识点或发言者线索，暂未达标。",
        evidence: {
          schoolWindows: schoolWindows.length,
          learningPointWindows: schoolLearningWindows.length,
          pendingKnowledgeSignals: schoolPendingKnowledgeCount,
          speakerClues: schoolSpeakerClues.length,
        },
        targets: [
          {
            metric: "schoolWindows",
            current: schoolWindows.length,
            target: ">= 1",
            pass: schoolWindows.length >= 1,
          },
          {
            metric: "learningPointWindows",
            current: schoolLearningWindows.length,
            target: ">= 1",
            pass: schoolLearningWindows.length >= 1,
          },
          {
            metric: "pendingKnowledgeSignals",
            current: schoolPendingKnowledgeCount,
            target: ">= 1",
            pass: schoolPendingKnowledgeCount >= 1,
          },
          {
            metric: "speakerClues",
            current: schoolSpeakerClues.length,
            target: ">= 1",
            pass: schoolSpeakerClues.length >= 1,
          },
        ],
        nextActions: schoolNextActions,
      },
      {
        id: "audio-reinforcement",
        title: "音频补强链成立",
        status: audioStatus,
        summary:
          audioStatus === "pass"
            ? "关键音频窗口已开始稳定产出 transcript，可直接支撑聊天页回答。"
            : audioStatus === "missing-data"
              ? "当前验收窗口没有音频窗口，无法验证补强链。"
              : "音频补强链仍偏弱，聊天页仍有回落到“只有音频但无可引用内容”的风险。",
        evidence: {
          audioWindows: audioWindows.length,
          transcriptReadyWindows: transcriptReadyWindows.length,
          transcriptCoverage,
          degradedAudioEvents: degradedAudioEvents.length,
          emptyAudioWindows: emptyAudioWindows.length,
        },
        targets: [
          {
            metric: "audioWindows",
            current: audioWindows.length,
            target: ">= 1",
            pass: audioWindows.length >= 1,
          },
          {
            metric: "transcriptReadyWindows",
            current: transcriptReadyWindows.length,
            target: ">= 1",
            pass: transcriptReadyWindows.length >= 1,
          },
          {
            metric: "transcriptCoverage",
            current: transcriptCoverage,
            target: ">= 0.35",
            pass: transcriptCoverage >= 0.35,
          },
          {
            metric: "emptyAudioWindows",
            current: emptyAudioWindows.length,
            target: "< audioWindows",
            pass: emptyAudioWindows.length < audioWindows.length,
          },
        ],
        nextActions: audioNextActions,
      },
      {
        id: "video-evidence",
        title: "视频证据链可回放",
        status: videoStatus,
        summary:
          !videoModeEnabled
            ? "视频模式当前是有意关闭（hostModelVideoMode=none），本阶段不强制卡视频验收。"
            : videoStatus === "pass"
              ? "视频链路已具备可回放原件，并且至少有关键帧或可引用视频摘要。"
              : videoStatus === "missing-data"
                ? "视频模式已开启，但当前验收窗口没有可用视频素材。"
                : "视频素材已有上传，但还缺回放原件或关键帧/摘要信号，需补齐。",
        evidence: {
          hostModelVideoMode: this.cfg.hostModelVideoMode,
          videoModeEnabled,
          videoEvents: videoEvents.length,
          keyframeEvents: keyframeEvents.length,
          videoWindows: videoWindows.length,
          videoRequestGroups: videoRequestIds.length,
          playableVideoArtifacts: videoEventsWithArtifacts.length,
          semanticReadyVideoEvents: videoSemanticReadyEvents.length,
        },
        targets: [
          {
            metric: "videoModeEnabled",
            current: videoModeEnabled,
            target: "true or intentionally-disabled",
            pass: true,
          },
          {
            metric: "videoEventsOrKeyframes",
            current: videoEvents.length + keyframeEvents.length,
            target: ">= 1 when mode enabled",
            pass: !videoModeEnabled || videoEvents.length + keyframeEvents.length >= 1,
          },
          {
            metric: "playableVideoArtifacts",
            current: videoEventsWithArtifacts.length,
            target: ">= 1 when mode enabled",
            pass: !videoModeEnabled || videoEventsWithArtifacts.length >= 1,
          },
          {
            metric: "keyframeOrSemanticReady",
            current: videoSemanticReady,
            target: "true when mode enabled",
            pass: !videoModeEnabled || videoSemanticReady,
          },
        ],
        nextActions: videoNextActions,
      },
      {
        id: "annotation-and-stability",
        title: "标注和稳定性成立",
        status: stabilityStatus,
        summary:
          stabilityStatus === "pass"
            ? "speaker/person 标注链路和设备稳定性都已达到当前阶段收口要求。"
            : stabilityStatus === "missing-data"
              ? "当前验收窗口还没有活跃设备数据，稳定性尚无法判定。"
              : "标注复用或设备稳定性仍有缺口，需再收一轮。",
        evidence: {
          activeDevices: activeDevices.length,
          staleActiveDevices: staleActiveDevices.length,
          observedSpeakerRefs: observedSpeakerRefs.length,
          mappedSpeakerRefs: mappedSpeakerRefs.length,
          relevantPeopleAnnotations: relevantPeople.length,
          relevantSpeakerAnnotations: relevantSpeakers.length,
          relevantIdentityAnnotations,
          instabilitySignalEvents: instabilitySignalEvents.length,
        },
        targets: [
          {
            metric: "activeDevices",
            current: activeDevices.length,
            target: ">= 1",
            pass: activeDevices.length >= 1,
          },
          {
            metric: "relevantIdentityAnnotations",
            current: relevantIdentityAnnotations,
            target: ">= 1",
            pass: relevantIdentityAnnotations >= 1,
          },
          {
            metric: "speakerMappingOrAnnotation",
            current:
              observedSpeakerRefs.length === 0
                ? "n/a(no observed speakers)"
                : `${mappedSpeakerRefs.length} mapped / ${relevantSpeakers.length} annotated`,
            target: "mapped >= 1 or annotated >= 1 (when observedSpeakerRefs > 0)",
            pass:
              observedSpeakerRefs.length === 0 ||
              mappedSpeakerRefs.length >= 1 ||
              relevantSpeakers.length >= 1,
          },
          {
            metric: "staleActiveDevices",
            current: staleActiveDevices.length,
            target: "== 0",
            pass: staleActiveDevices.length === 0,
          },
          {
            metric: "instabilitySignalEvents",
            current: instabilitySignalEvents.length,
            target: "== 0",
            pass: instabilitySignalEvents.length === 0,
          },
        ],
        nextActions: stabilityNextActions,
      },
    ];

    const passedCriteria = criteria.filter((criterion) => criterion.status === "pass").length;
    const needsWorkCriteria = criteria.filter((criterion) => criterion.status === "needs-work").length;
    const missingDataCriteria = criteria.filter((criterion) => criterion.status === "missing-data").length;
    const totalCriteria = criteria.length;
    const phaseState: "collecting-data" | "hardening" | "ready-to-close" =
      missingDataCriteria > 0
        ? "collecting-data"
        : needsWorkCriteria > 0
          ? "hardening"
          : "ready-to-close";
    const blockers = criteria
      .filter(
        (
          criterion,
        ): criterion is (typeof criteria)[number] & { status: "needs-work" | "missing-data" } =>
          criterion.status !== "pass",
      )
      .map((criterion) => ({
        id: criterion.id,
        title: criterion.title,
        status: criterion.status,
        summary: criterion.summary,
        topNextAction: criterion.nextActions[0],
      }));

    return {
      generatedAt: now,
      lookbackDays,
      range: {
        startAt,
        endAt,
        startDate: toLocalDateKey(startAt),
        endDate: toLocalDateKey(endAt),
      },
      completion: {
        isPhaseReady: passedCriteria === totalCriteria,
        passedCriteria,
        totalCriteria,
        needsWorkCriteria,
        missingDataCriteria,
        progressPct: Math.round((passedCriteria / totalCriteria) * 100),
        phaseState,
      },
      blockers,
      criteria,
    };
  }

  async buildPhaseAcceptancePlan(params?: {
    lookbackDays?: number;
    now?: number;
  }): Promise<{
    generatedAt: number;
    lookbackDays: number;
    phaseState: "collecting-data" | "hardening" | "ready-to-close";
    progressPct: number;
    passedCriteria: number;
    totalCriteria: number;
    summary: string;
    quickCommands: string[];
    tracks: Array<{
      id: PhaseAcceptanceCriterionId;
      title: string;
      status: Exclude<PhaseAcceptanceStatus, "pass">;
      goal: string;
      failingTargets: string[];
      nextActions: string[];
      commands: string[];
    }>;
  }> {
    const acceptance = await this.buildPhaseAcceptance(params);
    const tracks = acceptance.criteria
      .filter(
        (
          criterion,
        ): criterion is (typeof acceptance.criteria)[number] & { status: Exclude<PhaseAcceptanceStatus, "pass"> } =>
          criterion.status !== "pass",
      )
      .map((criterion) => ({
        id: criterion.id,
        title: criterion.title,
        status: criterion.status,
        goal: resolveAcceptanceCriterionGoal(criterion.id),
        failingTargets: criterion.targets
          .filter((target) => !target.pass)
          .map((target) => `${target.metric}: ${String(target.current)} (target ${target.target})`),
        nextActions: criterion.nextActions,
        commands: resolveAcceptanceCriterionCommands(criterion.id),
      }));

    return {
      generatedAt: acceptance.generatedAt,
      lookbackDays: acceptance.lookbackDays,
      phaseState: acceptance.completion.phaseState,
      progressPct: acceptance.completion.progressPct,
      passedCriteria: acceptance.completion.passedCriteria,
      totalCriteria: acceptance.completion.totalCriteria,
      summary:
        acceptance.completion.phaseState === "ready-to-close"
          ? "当前阶段验收已达到收口标准，可进入下一阶段。"
          : acceptance.completion.phaseState === "hardening"
            ? "当前已进入 hardening，建议按下方 tracks 逐项补齐并复跑 acceptance。"
            : "当前仍处于 collecting-data，先补素材覆盖，再进入 hardening。",
      quickCommands: [
        "openclaw clawsense devices",
        "openclaw clawsense doctor",
        "openclaw clawsense evidence today --focus what_happened",
        `openclaw clawsense acceptance ${acceptance.lookbackDays}`,
      ],
      tracks,
    };
  }

  async runMaintenanceTick(now = Date.now()): Promise<void> {
    const pendingBackfillCandidates = await this.estimatePendingAudioBackfillCandidates(now);
    const adaptiveMaxArtifacts = resolveMaintenanceBackfillBatchSize(pendingBackfillCandidates);
    await this.runAudioBackfillTick({ now, maxArtifacts: adaptiveMaxArtifacts });
    if (new Date(now).getHours() !== 22) {
      return;
    }
    const today = toLocalDateKey(now);
    const existing = await this.stateStore.getDailyReview(today);
    if (existing && existing.generatedAt >= startOfLocalDate(today).getTime() + 22 * 60 * 60 * 1000) {
      return;
    }
    const events = await this.stateStore.listEventsByDate(today);
    if (events.length === 0) {
      return;
    }
    const review = await this.generateDailyReview(today);
    await this.stateStore.putDailyReview(review);
    const consolidation = await this.generateDailyConsolidation(today);
    await this.stateStore.putDailyConsolidation(consolidation);
    this.logger.info(`[clawsense] daily review + consolidation generated for ${today}`);
  }

  private async estimatePendingAudioBackfillCandidates(
    now: number,
    dates?: string[],
  ): Promise<number> {
    const targetDates =
      Array.isArray(dates) && dates.length > 0
        ? Array.from(new Set(dates.map((date) => this.normalizeDateInput(date))))
        : [toLocalDateKey(now), toLocalDateKey(now - 24 * 60 * 60 * 1000)];
    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    let count = 0;
    for (const date of targetDates) {
      const events = await this.stateStore.listEventsByDate(date);
      count += events.filter((event) => {
        if (!shouldAttemptAudioBackfill(event, now)) {
          return false;
        }
        const artifact = artifactById.get(event.artifactId);
        return Boolean(artifact && !artifact.deletedAt && artifact.modality === "audio");
      }).length;
    }
    return count;
  }

  async runAudioBackfillTick(params?: {
    now?: number;
    dates?: string[];
    maxArtifacts?: number;
  }): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
  }> {
    type AudioBackfillCandidate = {
      event: ClawSenseCaptureEvent;
      artifact: ClawSenseArtifactRecord;
      date: string;
      window?: ReviewWindow;
    };
    const now = params?.now ?? Date.now();
    const maxArtifacts = Math.max(1, Math.min(params?.maxArtifacts ?? 2, 6));
    const primaryProviderId = resolvePrimaryMultimodalModel(this.cfg, this.runtimeConfig).providerId;
    const fallbackSttProviderId = this.resolveFallbackSttProviderId(primaryProviderId);
    const dates =
      params?.dates && params.dates.length > 0
        ? Array.from(new Set(params.dates.map((date) => this.normalizeDateInput(date))))
        : [toLocalDateKey(now), toLocalDateKey(now - 24 * 60 * 60 * 1000)];
    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const candidates = (
      await Promise.all(
        dates.map(async (date) => {
          const dateEvents = await this.stateStore.listEventsByDate(date);
          const windowByEventId = new Map(
            groupWindows(dateEvents, artifactById).flatMap((window) =>
              window.events.map((event) => [event.eventId, window] as const),
            ),
          );
          const dateCandidates: AudioBackfillCandidate[] = [];
          for (const event of dateEvents) {
            if (!shouldAttemptAudioBackfill(event, now)) {
              continue;
            }
            const artifact = artifactById.get(event.artifactId);
            if (!artifact || artifact.deletedAt || artifact.modality !== "audio") {
              continue;
            }
            dateCandidates.push({
              event,
              artifact,
              date,
              window: windowByEventId.get(event.eventId),
            });
          }
          return dateCandidates;
        }),
      )
    )
      .flat()
      .sort((left, right) => {
        return (
          scoreAudioBackfillCandidate({ ...right, now }) - scoreAudioBackfillCandidate({ ...left, now }) ||
          left.artifact.sizeBytes - right.artifact.sizeBytes ||
          right.event.capturedAt - left.event.capturedAt
        );
      })
      .slice(0, maxArtifacts);

    if (candidates.length === 0) {
      return { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    }

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      attempted += 1;
      try {
        const body = await fs.readFile(candidate.artifact.storagePath);
        const asrAttempt = await transcribeAudioWithFallbackModel({
          cfg: this.cfg,
          runtimeConfig: this.runtimeConfig,
          body,
          fileName: candidate.artifact.fileName,
          mime: candidate.artifact.mime,
          providerId: fallbackSttProviderId,
          openai: this.resolveMultimodalClient(fallbackSttProviderId),
        });
        if (normalizeSemanticText(asrAttempt.transcript)) {
          const result = await this.stateStore.backfillCaptureAnalysis({
            artifactId: candidate.artifact.artifactId,
            transcript: asrAttempt.transcript,
            analysisProvider: asrAttempt.analysisProvider,
            analysisStatus: "succeeded",
            analysisFailureReason: undefined,
            sttProvider: inferBackfillSttProvider(asrAttempt.analysisProvider),
            attemptedAt: now,
          });
          if (result.updated) {
            succeeded += 1;
            this.logger.info(
              `[clawsense] audio backfill captured transcript eventId=${candidate.event.eventId} artifactId=${candidate.artifact.artifactId} bytes=${candidate.artifact.sizeBytes}`,
            );
          } else {
            skipped += 1;
          }
          continue;
        }

        await this.stateStore.noteAudioBackfillAttempt({
          artifactId: candidate.artifact.artifactId,
          analysisProvider: asrAttempt.analysisProvider,
          analysisFailureReason: combineFailureReasons(
            candidate.event.analysisFailureReason,
            asrAttempt.analysisFailureReason,
          ),
          attemptedAt: now,
        });
        failed += 1;
      } catch (error) {
        await this.stateStore.noteAudioBackfillAttempt({
          artifactId: candidate.artifact.artifactId,
          analysisProvider: "audio-backfill",
          analysisFailureReason: combineFailureReasons(
            candidate.event.analysisFailureReason,
            `audio_backfill_error:${String(error)}`,
          ),
          attemptedAt: now,
        });
        failed += 1;
      }
    }

    return { attempted, succeeded, failed, skipped };
  }

  async renderLibraryPage(date: string, artifactUrlBase: string, libraryUrlBase: string): Promise<string> {
    const safeDate = this.normalizeDateInput(date);
    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ClawSense 媒体库</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #07111d;
        --panel: rgba(12, 23, 40, 0.88);
        --panel-strong: rgba(18, 36, 60, 0.94);
        --line: rgba(255, 255, 255, 0.08);
        --text: #edf5ff;
        --muted: #8ca2bf;
        --accent: #6ee7ff;
        --accent-strong: #1ea7ff;
        --warm: #ffd279;
        --ok: #7ff2b5;
        --danger: #ff8f8f;
      }
      * { box-sizing: border-box; }
      html { background: var(--bg); }
      body {
        margin: 0;
        font-family: "Avenir Next", "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(37, 99, 235, 0.2), transparent 28%),
          radial-gradient(circle at top right, rgba(16, 185, 129, 0.14), transparent 30%),
          linear-gradient(180deg, rgba(6, 13, 24, 0.96), rgba(7, 17, 29, 1));
      }
      button, input, select { font: inherit; }
      code { font-family: "SFMono-Regular", "JetBrains Mono", ui-monospace, monospace; }
      .page { max-width: 1240px; margin: 0 auto; padding: 28px 20px 72px; }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(300px, 0.9fr);
        gap: 18px;
        margin-bottom: 18px;
      }
      .hero-card,
      .toolbar,
      .stat,
      .info-card,
      .card,
      .empty {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        backdrop-filter: blur(18px);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22);
      }
      .hero-card { padding: 24px; }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(110, 231, 255, 0.12);
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .hero h1 { margin: 14px 0 0; font-size: clamp(32px, 4vw, 52px); line-height: 1.05; }
      .hero p {
        margin: 12px 0 0;
        max-width: 760px;
        color: var(--muted);
        line-height: 1.7;
        font-size: 15px;
      }
      .hero-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 10px;
        margin-top: 18px;
      }
      .hero-chip {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid var(--line);
      }
      .hero-chip strong {
        display: block;
        margin-bottom: 6px;
        font-size: 13px;
        color: var(--text);
      }
      .hero-chip span {
        display: block;
        color: var(--muted);
        line-height: 1.55;
        font-size: 13px;
      }
      .hero-side { padding: 24px; background: var(--panel-strong); }
      .hero-side h2 { margin: 0; font-size: 18px; }
      .hero-side p { margin: 10px 0 0; color: var(--muted); line-height: 1.65; font-size: 14px; }
      .hero-list {
        margin: 16px 0 0;
        padding-left: 18px;
        color: var(--muted);
        line-height: 1.7;
      }
      .command {
        margin-top: 18px;
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(8, 16, 28, 0.96);
        border: 1px solid rgba(110, 231, 255, 0.14);
      }
      .command-label {
        display: block;
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .command code {
        display: block;
        color: var(--accent);
        font-size: 13px;
        white-space: nowrap;
        overflow-x: auto;
      }
      .toolbar {
        padding: 18px;
        margin-bottom: 18px;
      }
      .auth-panel {
        display: grid;
        gap: 14px;
        margin-bottom: 18px;
        padding: 18px;
      }
      .toolbar-row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
      }
      .date-controls,
      .action-row,
      .filter-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .field {
        display: grid;
        gap: 8px;
        min-width: 190px;
      }
      .field.grow {
        flex: 1 1 280px;
        min-width: min(320px, 100%);
      }
      .field-label {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .auth-note {
        color: var(--muted);
        line-height: 1.7;
        font-size: 13px;
      }
      .auth-status {
        min-height: 24px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .auth-status.ok { color: var(--ok); }
      .auth-status.warn { color: var(--warm); }
      .auth-status.danger { color: var(--danger); }
      .control,
      .action-button,
      .segment-button {
        height: 44px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
        color: var(--text);
      }
      .control {
        padding: 0 14px;
        min-width: 160px;
      }
      .action-button,
      .segment-button {
        padding: 0 14px;
        cursor: pointer;
        transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
      }
      .action-button:hover,
      .segment-button:hover { border-color: rgba(110, 231, 255, 0.35); transform: translateY(-1px); }
      .action-button.primary {
        border: none;
        background: linear-gradient(135deg, var(--accent-strong), #0ea5e9);
      }
      .segmented {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .segment-button.is-active {
        background: rgba(110, 231, 255, 0.14);
        border-color: rgba(110, 231, 255, 0.4);
        color: var(--accent);
      }
      .scope {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        line-height: 1.7;
      }
      .followups {
        margin-bottom: 18px;
        padding: 18px;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        backdrop-filter: blur(18px);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22);
      }
      .followups-head {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: flex-start;
      }
      .followups-head h3 {
        margin: 0;
        font-size: 18px;
      }
      .followups-head p {
        margin: 10px 0 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.65;
      }
      .followups-source {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .followups-list {
        margin-top: 14px;
        display: grid;
        gap: 10px;
      }
      .followup-item {
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        padding: 14px;
      }
      .followup-prompt {
        margin: 10px 0 0;
        color: var(--text);
        font-size: 14px;
        line-height: 1.7;
        white-space: pre-wrap;
      }
      .followup-actions {
        margin-top: 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .followup-copy {
        height: 34px;
        padding: 0 12px;
        border-radius: 10px;
        border: 1px solid rgba(110, 231, 255, 0.35);
        background: rgba(30, 167, 255, 0.14);
        color: var(--accent);
        cursor: pointer;
      }
      .followup-empty {
        margin-top: 12px;
        padding: 14px;
        border-radius: 14px;
        border: 1px dashed rgba(255, 255, 255, 0.12);
        color: var(--muted);
        line-height: 1.65;
      }
      .followup-status {
        margin-top: 10px;
        min-height: 22px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .followup-status.ok { color: var(--ok); }
      .followup-status.warn { color: var(--warm); }
      .followup-status.danger { color: var(--danger); }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
        margin-bottom: 18px;
      }
      .stat { padding: 18px; }
      .stat-label {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .stat-value {
        margin-top: 12px;
        font-size: 30px;
        font-weight: 700;
        letter-spacing: -0.03em;
      }
      .stat-note {
        margin-top: 8px;
        color: var(--muted);
        line-height: 1.55;
        font-size: 13px;
      }
      .info-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
        margin-bottom: 18px;
      }
      .info-card { padding: 18px; }
      .info-card h3 { margin: 0; font-size: 16px; }
      .info-card p { margin: 10px 0 0; color: var(--muted); line-height: 1.65; font-size: 14px; }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 16px;
      }
      .card { padding: 18px; }
      .card-header {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: flex-start;
      }
      .card-title-wrap { min-width: 0; }
      .card-title {
        margin: 10px 0 0;
        font-size: 20px;
        line-height: 1.35;
      }
      .card-subtitle {
        margin-top: 8px;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.65;
      }
      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        font-size: 12px;
        color: var(--muted);
      }
      .pill.primary {
        color: var(--accent);
        border-color: rgba(110, 231, 255, 0.24);
        background: rgba(110, 231, 255, 0.08);
      }
      .pill.ok {
        color: var(--ok);
        border-color: rgba(127, 242, 181, 0.2);
      }
      .pill.warn {
        color: var(--warm);
        border-color: rgba(255, 210, 121, 0.22);
      }
      .pill.danger {
        color: var(--danger);
        border-color: rgba(255, 143, 143, 0.2);
      }
      .detail-block {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
      }
      .video-insight {
        margin-top: 14px;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid rgba(110, 231, 255, 0.16);
        background: rgba(110, 231, 255, 0.06);
      }
      .video-insight-grid {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }
      .video-insight-row {
        color: #d8e8ff;
        font-size: 14px;
        line-height: 1.65;
        word-break: break-word;
      }
      .video-insight-row strong {
        color: var(--accent);
        font-weight: 600;
      }
      .detail-label {
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .transcript,
      .note-text {
        margin: 0;
        color: #d8e8ff;
        line-height: 1.72;
        font-size: 14px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .artifact-frame {
        margin-top: 16px;
        overflow: hidden;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.05);
        background: rgba(3, 8, 16, 0.82);
      }
      audio,
      img {
        display: block;
        width: 100%;
        background: rgba(3, 8, 16, 0.82);
      }
      .artifact-missing {
        margin-top: 16px;
        padding: 14px;
        border-radius: 16px;
        border: 1px dashed rgba(255, 255, 255, 0.1);
        color: var(--muted);
        line-height: 1.65;
      }
      .empty {
        padding: 36px 24px;
        text-align: center;
        color: var(--muted);
        line-height: 1.75;
      }
      .empty strong {
        display: block;
        color: var(--text);
        font-size: 18px;
        margin-bottom: 8px;
      }
      @media (max-width: 960px) {
        .hero { grid-template-columns: 1fr; }
      }
      @media (max-width: 720px) {
        .page { padding-left: 14px; padding-right: 14px; }
        .toolbar-row { align-items: flex-start; }
        .date-controls,
        .action-row,
        .filter-row { width: 100%; }
        .control,
        .action-button,
        .segment-button { width: 100%; }
        .field { width: 100%; }
        .segmented { display: grid; grid-template-columns: repeat(3, 1fr); width: 100%; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        <article class="hero-card">
          <span class="eyebrow">ClawSense Raw Sense Library</span>
          <h1>媒体库</h1>
          <p>这里是给人浏览的原始感知库，用来按日期、设备和素材类型快速确认今天到底采到了什么。它负责保留事实和线索，不负责替代最终的 Daily Review。</p>
          <div class="hero-grid">
            <div class="hero-chip">
              <strong>先找哪一天</strong>
              <span>用日期切换快速定位当天素材，再看当天有没有关键窗口。</span>
            </div>
            <div class="hero-chip">
              <strong>再看哪台设备</strong>
              <span>通过设备筛选确认是哪个 Android 节点上传了这批原始感知。</span>
            </div>
            <div class="hero-chip">
              <strong>最后看哪类素材</strong>
              <span>音频和图片分开展示，更容易判断当天采集是否完整。</span>
            </div>
          </div>
        </article>
        <article class="hero-card hero-side">
          <h2>如何理解这个页面</h2>
          <p>媒体库只负责浏览原始感知线索，例如音频片段、图片快照、时间点和简短摘要。真正的助理式总结，建议通过 review 命令或 Daily Review skill 来生成。</p>
          <ul class="hero-list">
            <li>适合确认采集是否正常</li>
            <li>适合回看某个时间点、设备或素材类型</li>
            <li>不适合把它当成最终回顾页</li>
            <li>访问媒体详情时需要当前 OpenClaw 的 gateway token</li>
          </ul>
          <div class="command">
            <span class="command-label">Daily Review 命令</span>
            <code id="reviewCommand">openclaw clawsense review ${safeDate}</code>
          </div>
        </article>
      </section>
      <section class="auth-panel">
        <div class="toolbar-row">
          <label class="field grow">
            <span class="field-label">OpenClaw Gateway Token</span>
            <input class="control" id="tokenInput" type="password" placeholder="粘贴当前 OpenClaw 的访问 token" autocomplete="off" />
          </label>
          <div class="action-row">
            <button class="action-button primary" id="saveTokenButton" type="button">保存并加载</button>
            <button class="action-button" id="clearTokenButton" type="button">清除 token</button>
          </div>
        </div>
        <div class="auth-note">
          媒体库默认复用你当前 OpenClaw 的同一地址，但不会依赖 Control UI。素材数据和原件需要使用同一台 OpenClaw 的 gateway token 读取，token 只保存在当前浏览器。
        </div>
        <div class="auth-status" id="authStatus"></div>
      </section>
      <section class="toolbar">
        <div class="toolbar-row">
          <div class="date-controls">
            <button class="action-button" id="prevDayButton" type="button">前一天</button>
            <input class="control" id="dateInput" type="date" value="${safeDate}" />
            <button class="action-button" id="todayButton" type="button">今天</button>
            <button class="action-button" id="nextDayButton" type="button">后一天</button>
          </div>
          <div class="action-row">
            <button class="action-button primary" id="refreshButton" type="button">刷新素材</button>
          </div>
        </div>
        <div class="toolbar-row" style="margin-top:14px;">
          <div class="filter-row">
            <label class="field">
              <span class="field-label">设备</span>
              <select class="control" id="deviceSelect">
                <option value="">全部设备</option>
              </select>
            </label>
            <div class="field">
              <span class="field-label">素材类型</span>
              <div class="segmented" id="modalityTabs">
                <button class="segment-button is-active" type="button" data-value="">全部素材</button>
                <button class="segment-button" type="button" data-value="audio">音频</button>
                <button class="segment-button" type="button" data-value="image">图片</button>
                <button class="segment-button" type="button" data-value="video">视频</button>
              </div>
            </div>
          </div>
        </div>
        <div class="scope" id="scopeSummary">正在加载当天素材...</div>
      </section>
      <section class="followups" id="followupsPanel">
        <div class="followups-head">
          <div>
            <h3>继续追问</h3>
            <p>优先消费 <code>responseHints.evidenceFollowUpTargets</code>；如果当前响应没有该字段，就自动回退到 <code>/api/clawsense/followups</code>。</p>
          </div>
          <div class="followups-source" id="followupsSource">来源：等待加载</div>
        </div>
        <div class="followups-list" id="followupsList"></div>
        <div class="followup-empty" id="followupsEmpty">还没有可执行的追问动作。先采集一段真实素材，再刷新本页。</div>
        <div class="followup-status" id="followupsStatus"></div>
      </section>
      <section class="stats" id="stats"></section>
      <section class="info-grid">
        <article class="info-card">
          <h3>适合做的事</h3>
          <p>确认某一天、某设备、某类素材是否真的采到，快速点开原件，判断当天是不是值得进入 Daily Review。</p>
        </article>
        <article class="info-card">
          <h3>不适合做的事</h3>
          <p>不要把这里当成完整回顾页。它是原始感知浏览面，最终结论和后续追问应该交给 OpenClaw 的 Daily Review 流程。</p>
        </article>
        <article class="info-card">
          <h3>回顾入口</h3>
          <p>当你确认素材已经足够时，用页面右上角的 review 命令，或在 OpenClaw 里调用 repo 内的 Daily Review skill 生成助理式日回顾。</p>
        </article>
        <article class="info-card">
          <h3>普通聊天页也能这样说</h3>
          <p>你也可以直接在普通聊天页里说：“回顾今天发生了什么”“总结过去一个小时我需要注意的地方”“把今天最值得记住的 3 件事告诉我”。正确路径是显式走 ClawSense skill / tool，按 review -> events -> artifacts 下钻，而不是去扫文件系统。</p>
        </article>
      </section>
      <section class="cards" id="cards"></section>
    </main>
    <script>
      const TOKEN_STORAGE_KEY = "clawsense.gatewayToken";
      const libraryUrlBase = ${JSON.stringify(libraryUrlBase)};
      const statusApiPath = "/api/clawsense/status";
      const followupsApiPath = "/api/clawsense/followups";
      const initialDate = ${JSON.stringify(safeDate)};
      const state = {
        date: initialDate,
        deviceId: "",
        modality: "",
        token: "",
        followups: [],
      };
      const mediaObjectUrls = [];
      const contextLabels = {
        "audio-window": "对话活跃窗口",
        "active-window": "活跃场景补拍",
        "baseline-snapshot": "基线定格采样",
      };
      const modalityLabels = {
        audio: "音频",
        image: "图片",
        video: "视频",
      };
      const followupSourceLabels = {
        audio: "音频线索",
        video: "视频线索",
        history: "历史记忆",
      };
      const followupKindLabels = {
        "transcript-ready": "可直接追问",
        "needs-recheck": "转写待补强",
        "artifact-missing": "原件缺失",
        "history-follow-up": "历史延伸",
        "top-prompt": "推荐追问",
      };
      const dateInput = document.getElementById("dateInput");
      const deviceSelect = document.getElementById("deviceSelect");
      const tokenInput = document.getElementById("tokenInput");
      const authStatus = document.getElementById("authStatus");
      const scopeSummary = document.getElementById("scopeSummary");
      const cards = document.getElementById("cards");
      const stats = document.getElementById("stats");
      const followupsList = document.getElementById("followupsList");
      const followupsEmpty = document.getElementById("followupsEmpty");
      const followupsSource = document.getElementById("followupsSource");
      const followupsStatus = document.getElementById("followupsStatus");
      const reviewCommand = document.getElementById("reviewCommand");
      const saveTokenButton = document.getElementById("saveTokenButton");
      const clearTokenButton = document.getElementById("clearTokenButton");
      hydrateStateFromUrl();
      readTokenFromUrl();
      hydrateTokenState();
      syncControls();

      function hydrateStateFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const maybeDate = params.get("date");
        if (maybeDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(maybeDate)) {
          state.date = maybeDate;
        }
        state.deviceId = params.get("deviceId") || "";
        state.modality = params.get("modality") || "";
      }

      function readStoredToken() {
        try {
          return window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
        } catch {
          return "";
        }
      }

      function persistToken(token) {
        try {
          if (token) {
            window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
          } else {
            window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          }
        } catch {}
        state.token = token;
      }

      function readTokenFromUrl() {
        const url = new URL(window.location.href);
        const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
        const queryToken = url.searchParams.get("token");
        const hashToken = hash.get("token");
        const token = (queryToken || hashToken || "").trim();
        if (!token) {
          return;
        }
        persistToken(token);
        url.searchParams.delete("token");
        hash.delete("token");
        url.hash = hash.toString() ? "#" + hash.toString() : "";
        window.history.replaceState({}, "", url);
      }

      function hydrateTokenState() {
        state.token = readStoredToken();
      }

      function setAuthStatus(message, level) {
        authStatus.textContent = message;
        authStatus.className = "auth-status" + (level ? " " + level : "");
      }

      function getGatewayToken() {
        return (tokenInput.value || state.token || "").trim();
      }

      function clearMediaObjectUrls() {
        while (mediaObjectUrls.length) {
          const url = mediaObjectUrls.pop();
          if (url) {
            URL.revokeObjectURL(url);
          }
        }
      }

      function syncControls() {
        dateInput.value = state.date;
        deviceSelect.value = state.deviceId;
        tokenInput.value = state.token;
        for (const button of document.querySelectorAll("[data-value]")) {
          button.classList.toggle("is-active", button.dataset.value === state.modality);
        }
        reviewCommand.textContent = "openclaw clawsense review " + state.date;
      }

      function updateUrl() {
        const url = new URL(window.location.href);
        url.searchParams.set("date", state.date);
        if (state.deviceId) {
          url.searchParams.set("deviceId", state.deviceId);
        } else {
          url.searchParams.delete("deviceId");
        }
        if (state.modality) {
          url.searchParams.set("modality", state.modality);
        } else {
          url.searchParams.delete("modality");
        }
        url.searchParams.delete("token");
        window.history.replaceState({}, "", url);
      }

      function formatTime(ts) {
        return new Date(ts).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function formatDateInput(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return year + "-" + month + "-" + day;
      }

      function shiftDate(dateString, offset) {
        const date = new Date(dateString + "T12:00:00");
        date.setDate(date.getDate() + offset);
        return formatDateInput(date);
      }

      function formatDeviceName(devices, deviceId) {
        const matched = devices.find((device) => device.deviceId === deviceId);
        return matched ? matched.name : deviceId || "全部设备";
      }

      function formatCaptureContext(value) {
        return contextLabels[value] || value || "未标注场景";
      }

      function formatFileSize(sizeBytes) {
        if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
          return "未知大小";
        }
        if (sizeBytes < 1024 * 1024) {
          return (sizeBytes / 1024).toFixed(1) + " KB";
        }
        return (sizeBytes / (1024 * 1024)).toFixed(1) + " MB";
      }

      function sanitizeNote(value) {
        return String(value || "")
          .replace(/\\bvideoRequestId=[^\\s]+\\b/gi, "")
          .replace(/\\bvideoKeyframe=1\\b/gi, "")
          .replace(/\\bkeyframe=\\d+\\b/gi, "")
          .replace(/\\bactive-window\\b/gi, "")
          .replace(/\\bbaseline-snapshot\\b/gi, "")
          .replace(/\\s+/g, " ")
          .trim();
      }

      function decodeNoteValue(value) {
        const raw = String(value || "").trim();
        if (!raw) return "";
        try {
          return decodeURIComponent(raw);
        } catch {
          return raw;
        }
      }

      function readNoteField(note, names) {
        const text = String(note || "");
        for (const name of names) {
          const match = new RegExp("\\\\b" + name + "=([^\\\\s]+)", "i").exec(text);
          if (match && match[1]) {
            return decodeNoteValue(match[1]);
          }
        }
        return "";
      }

      function formatVideoOffset(ms) {
        if (!Number.isFinite(ms) || ms < 0) return "";
        const totalSeconds = Math.round(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
      }

      function parseVideoMarker(note) {
        const text = String(note || "");
        const requestId = readNoteField(text, ["videoRequestId"]);
        const keyframeIndexRaw = readNoteField(text, ["keyframe"]);
        const videoOffsetMsRaw = readNoteField(text, ["videoOffsetMs", "offsetMs", "frameOffsetMs", "timeMs"]);
        const videoOffsetSecRaw = readNoteField(text, ["videoOffsetSec", "offsetSec", "frameOffsetSec", "timeSec"]);
        let videoOffsetMs = Number(videoOffsetMsRaw);
        if (!Number.isFinite(videoOffsetMs) && videoOffsetSecRaw) {
          videoOffsetMs = Number(videoOffsetSecRaw) * 1000;
        }
        return {
          requestId,
          isKeyframe: /\\bvideoKeyframe=1\\b/i.test(text) || Boolean(keyframeIndexRaw),
          keyframeIndex: Number.isFinite(Number(keyframeIndexRaw)) ? Number(keyframeIndexRaw) : null,
          videoOffsetLabel: Number.isFinite(videoOffsetMs) ? formatVideoOffset(videoOffsetMs) : "",
          caption: readNoteField(text, ["caption"]),
          ocr: readNoteField(text, ["ocr", "ocrText", "ocrHints"]),
        };
      }

      function renderVideoInsight(event) {
        const marker = parseVideoMarker(event.note);
        if (!marker.requestId && !marker.isKeyframe && !marker.caption && !marker.ocr) {
          return "";
        }
        const rows = [];
        if (marker.requestId) rows.push(["视频组", marker.requestId]);
        if (event.modality === "video") rows.push(["类型", "原始视频片段"]);
        if (marker.isKeyframe) {
          const label = marker.keyframeIndex ? "关键帧 #" + marker.keyframeIndex : "视频关键帧";
          rows.push(["类型", marker.videoOffsetLabel ? label + " / 片段内 " + marker.videoOffsetLabel : label]);
        }
        if (marker.caption) rows.push(["关键帧 caption", marker.caption]);
        if (marker.ocr) rows.push(["关键帧 OCR", marker.ocr.replaceAll("|", " / ")]);
        if (!rows.length) {
          return "";
        }
        return (
          '<section class="video-insight"><div class="detail-label">视频线索</div><div class="video-insight-grid">' +
          rows
            .map((row) => '<div class="video-insight-row"><strong>' + escapeHtml(row[0]) + '：</strong>' + escapeHtml(row[1]) + "</div>")
            .join("") +
          "</div></section>"
        );
      }

      function createAuthorizedUrl(url) {
        return url;
      }

      function populateDeviceOptions(devices) {
        const options = ['<option value="">全部设备</option>'];
        for (const device of devices) {
          options.push(
            '<option value="' +
              escapeHtml(device.deviceId) +
              '"' +
              (device.deviceId === state.deviceId ? " selected" : "") +
              ">" +
              escapeHtml(device.name) +
              "</option>",
          );
        }
        if (state.deviceId && !devices.some((device) => device.deviceId === state.deviceId)) {
          options.push('<option value="' + escapeHtml(state.deviceId) + '" selected>' + escapeHtml(state.deviceId) + "</option>");
        }
        deviceSelect.innerHTML = options.join("");
      }

      function renderStats(data, diagnostics) {
        const audioCount = data.events.filter((event) => event.modality === "audio").length;
        const imageCount = data.events.filter((event) => event.modality === "image").length;
        const videoCount = data.events.filter((event) => event.modality === "video").length;
        const availableArtifacts = data.events.filter((event) => event.artifact && event.artifact.available).length;
        const entries = [
          {
            label: "当前事件",
            value: String(data.counts.events),
            note: "当前筛选条件下可浏览的原始感知事件数",
          },
          {
            label: "音频 / 图片 / 视频",
            value: audioCount + " / " + imageCount + " / " + videoCount,
            note: "三类素材分开展示，方便判断采集是否完整",
          },
          {
            label: "涉及设备",
            value: String(data.counts.devices),
            note: "当前日期和筛选范围内实际出现过的设备数量",
          },
          {
            label: "可直接打开的原件",
            value: String(availableArtifacts),
            note: "原件过期清理后，事件摘要仍然会保留在索引里",
          },
        ];
        if (diagnostics && diagnostics.queue) {
          entries.push({
            label: "上传队列",
            value: diagnostics.queue.depth + " / " + diagnostics.queue.maxPending,
            note:
              diagnostics.queue.depth > 0
                ? "当前有待处理上传，队列深时客户端可能短暂收到 503 重试信号"
                : "当前上传队列为空",
          });
        }
        if (diagnostics && diagnostics.devices) {
          entries.push({
            label: "活跃设备",
            value: diagnostics.devices.active + " / " + diagnostics.devices.total,
            note:
              diagnostics.devices.stale > 0
                ? "有设备心跳已过期，建议检查手机端前台服务状态"
                : "设备活跃度正常",
          });
        }
        stats.innerHTML = entries
          .map(
            (entry) =>
              '<article class="stat"><div class="stat-label">' +
              escapeHtml(entry.label) +
              '</div><div class="stat-value">' +
              escapeHtml(entry.value) +
              '</div><div class="stat-note">' +
              escapeHtml(entry.note) +
              "</div></article>",
          )
          .join("");
      }

      function renderScopeSummary(data) {
        const deviceLabel = formatDeviceName(data.devices, state.deviceId);
        const modalityLabel = state.modality ? modalityLabels[state.modality] : "全部素材";
        scopeSummary.textContent =
          "当前正在浏览 " +
          data.date +
          " 的原始感知素材，范围为 " +
          deviceLabel +
          " / " +
          modalityLabel +
          "。如果你要的是助理式总结，请改用 Daily Review，而不是直接把媒体库当作结论页。";
        reviewCommand.textContent = "openclaw clawsense review " + data.date;
      }

      function renderEmpty(title, detail) {
        cards.innerHTML =
          '<article class="empty"><strong>' +
          escapeHtml(title) +
          '</strong>' +
          escapeHtml(detail) +
          "</article>";
      }

      function renderCards(data) {
        cards.innerHTML = "";
        if (!data.events.length) {
          renderEmpty(
            "这一天还没有可展示的原始感知事件。",
            "可以先切换日期、设备或素材类型，也可以回头确认 Android 节点是否在线、音频上传和图片采样是否正常。",
          );
          return;
        }
        for (const event of data.events) {
          const card = document.createElement("article");
          card.className = "card";
          const summary = event.summary || "暂无摘要";
          const deviceName = formatDeviceName(data.devices, event.deviceId);
          const meta = [
            '<span class="pill primary">' + escapeHtml(modalityLabels[event.modality] || event.modality) + "</span>",
            '<span class="pill">' + escapeHtml(deviceName) + "</span>",
            '<span class="pill">' + escapeHtml(formatCaptureContext(event.captureContext)) + "</span>",
            '<span class="pill">' + escapeHtml(formatTime(event.capturedAt)) + "</span>",
          ];
          if (event.artifact?.available) {
            meta.push('<span class="pill ok">原件可打开</span>');
          } else if (event.artifact) {
            meta.push('<span class="pill warn">原件已清理</span>');
          } else {
            meta.push('<span class="pill danger">无原件</span>');
          }
          const videoMarker = parseVideoMarker(event.note);
          if (videoMarker.isKeyframe) {
            meta.push('<span class="pill primary">视频关键帧</span>');
          } else if (videoMarker.requestId && event.modality === "video") {
            meta.push('<span class="pill primary">视频片段</span>');
          }
          const transcript = event.transcript
            ? '<section class="detail-block"><div class="detail-label">语音片段</div><pre class="transcript">' +
              escapeHtml(event.transcript) +
              "</pre></section>"
            : "";
          const videoInsight = renderVideoInsight(event);
          const cleanNote = sanitizeNote(event.note);
          const note = cleanNote
            ? '<section class="detail-block"><div class="detail-label">补充备注</div><p class="note-text">' +
              escapeHtml(cleanNote) +
              "</p></section>"
            : "";
          let media = "";
          if (event.artifact && event.artifact.available) {
            if (event.modality === "audio") {
              media =
                '<div class="artifact-frame"><audio controls preload="none" data-artifact-url="' +
                escapeHtml(createAuthorizedUrl(event.artifact.url)) +
                '"></audio></div><section class="detail-block"><div class="detail-label">原件信息</div><p class="note-text">' +
                escapeHtml(event.artifact.fileName) +
                " · " +
                escapeHtml(formatFileSize(event.artifact.sizeBytes)) +
                "</p></section>";
            } else if (event.modality === "video") {
              media =
                '<div class="artifact-frame"><video controls preload="metadata" playsinline data-artifact-url="' +
                escapeHtml(createAuthorizedUrl(event.artifact.url)) +
                '"></video></div><section class="detail-block"><div class="detail-label">原件信息</div><p class="note-text">' +
                escapeHtml(event.artifact.fileName) +
                " · " +
                escapeHtml(formatFileSize(event.artifact.sizeBytes)) +
                "</p></section>";
            } else {
              media =
                '<div class="artifact-frame"><img loading="lazy" alt="' +
                escapeHtml(summary) +
                '" data-artifact-url="' +
                escapeHtml(createAuthorizedUrl(event.artifact.url)) +
                '" /></div><section class="detail-block"><div class="detail-label">原件信息</div><p class="note-text">' +
                escapeHtml(event.artifact.fileName) +
                " · " +
                escapeHtml(formatFileSize(event.artifact.sizeBytes)) +
                "</p></section>";
            }
          } else if (event.artifact) {
            media =
              '<div class="artifact-missing">原件已按保留策略清理，但事件摘要、时间和上下文仍会保留在索引里，便于之后做回顾。</div>';
          }
          card.innerHTML =
            '<div class="card-header"><div class="card-title-wrap"><div class="pill-row">' +
            meta.join("") +
            '</div><h3 class="card-title">' +
            escapeHtml(summary) +
            '</h3><div class="card-subtitle">这是 ' +
            escapeHtml(deviceName) +
            " 在 " +
            escapeHtml(formatTime(event.capturedAt)) +
            " 记录的一条原始感知事件，用来保留事实线索，而不是直接下结论。</div></div></div>" +
            transcript +
            videoInsight +
            note +
            media;
          cards.appendChild(card);
        }
      }

      function setFollowupsStatus(message, level) {
        followupsStatus.textContent = message;
        followupsStatus.className = "followup-status" + (level ? " " + level : "");
      }

      function normalizeFollowupSource(value) {
        const normalized = typeof value === "string" ? value.toLowerCase() : "";
        if (normalized === "audio" || normalized === "video" || normalized === "history") {
          return normalized;
        }
        return "history";
      }

      function normalizeFollowupTarget(item) {
        if (!item || typeof item !== "object") {
          return null;
        }
        const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
        if (!prompt) {
          return null;
        }
        return {
          prompt,
          source: normalizeFollowupSource(item.source),
          kind: typeof item.kind === "string" && item.kind.trim() ? item.kind.trim() : "follow-up",
          windowId: typeof item.windowId === "string" ? item.windowId : "",
          eventId: typeof item.eventId === "string" ? item.eventId : "",
          keyframeIndex: Number.isFinite(item.keyframeIndex) ? Number(item.keyframeIndex) : null,
        };
      }

      function dedupeFollowups(targets) {
        const deduped = [];
        const seen = new Set();
        for (const item of targets) {
          if (!item) {
            continue;
          }
          const key = item.prompt;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          deduped.push(item);
        }
        return deduped.slice(0, 8);
      }

      function collectFollowupsFromResponseHints(payload) {
        const responseHints = payload && typeof payload === "object" && payload.responseHints && typeof payload.responseHints === "object"
          ? payload.responseHints
          : null;
        if (!responseHints || !Array.isArray(responseHints.evidenceFollowUpTargets)) {
          return [];
        }
        return dedupeFollowups(responseHints.evidenceFollowUpTargets.map(normalizeFollowupTarget).filter(Boolean));
      }

      function collectFollowupsFromFollowupsApi(payload) {
        if (!payload || typeof payload !== "object") {
          return [];
        }
        if (Array.isArray(payload.evidenceFollowUpTargets)) {
          const normalizedTargets = dedupeFollowups(
            payload.evidenceFollowUpTargets
              .map(normalizeFollowupTarget)
              .filter(Boolean),
          );
          if (normalizedTargets.length > 0) {
            return normalizedTargets;
          }
        }
        if (Array.isArray(payload.topPrompts)) {
          return dedupeFollowups(
            payload.topPrompts
              .map((prompt) => (typeof prompt === "string" && prompt.trim() ? { prompt: prompt.trim(), source: "history", kind: "top-prompt" } : null))
              .filter(Boolean),
          );
        }
        return [];
      }

      function renderFollowups(targets, sourceLabel) {
        state.followups = targets;
        followupsSource.textContent = "来源：" + sourceLabel;
        if (!targets.length) {
          followupsList.innerHTML = "";
          followupsEmpty.style.display = "block";
          return;
        }
        followupsEmpty.style.display = "none";
        followupsList.innerHTML = targets
          .map((target, index) => {
            const pills = [
              '<span class="pill primary">' + escapeHtml(followupSourceLabels[target.source] || target.source) + "</span>",
              '<span class="pill">' + escapeHtml(followupKindLabels[target.kind] || target.kind) + "</span>",
            ];
            if (target.windowId) {
              pills.push('<span class="pill">窗口 ' + escapeHtml(target.windowId) + "</span>");
            }
            if (target.eventId) {
              pills.push('<span class="pill">事件 ' + escapeHtml(target.eventId.slice(0, 8)) + "</span>");
            }
            if (Number.isFinite(target.keyframeIndex)) {
              pills.push('<span class="pill">关键帧 #' + escapeHtml(String(target.keyframeIndex)) + "</span>");
            }
            return (
              '<article class="followup-item">' +
              '<div class="pill-row">' + pills.join("") + "</div>" +
              '<p class="followup-prompt">' + escapeHtml(target.prompt) + "</p>" +
              '<div class="followup-actions">' +
              '<button class="followup-copy" type="button" data-followup-index="' + String(index) + '">继续追问（复制）</button>' +
              "</div></article>"
            );
          })
          .join("");
      }

      async function copyToClipboard(text) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return;
        }
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "readonly");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }

      async function fetchJson(url, token) {
        const response = await fetch(url, {
          headers: {
            Authorization: "Bearer " + token,
          },
        });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return await response.json();
      }

      async function hydrateArtifacts(token) {
        clearMediaObjectUrls();
        const nodes = cards.querySelectorAll("[data-artifact-url]");
        await Promise.all(
          Array.from(nodes).map(async (node) => {
            const artifactUrl = node.getAttribute("data-artifact-url");
            if (!artifactUrl) {
              return;
            }
            try {
              const response = await fetch(artifactUrl, {
                headers: {
                  Authorization: "Bearer " + token,
                },
              });
              if (!response.ok) {
                throw new Error("HTTP " + response.status);
              }
              const blob = await response.blob();
              const objectUrl = URL.createObjectURL(blob);
              mediaObjectUrls.push(objectUrl);
              node.src = objectUrl;
            } catch (error) {
              const frame = node.closest(".artifact-frame");
              if (frame) {
                const fallback = document.createElement("div");
                fallback.className = "artifact-missing";
                fallback.textContent =
                  "原件读取失败，请确认 gateway token 正确且当前会话仍然有效。错误：" + String(error);
                frame.replaceWith(fallback);
              }
            }
          }),
        );
      }

      async function load() {
        state.date = dateInput.value || initialDate;
        state.deviceId = deviceSelect.value || "";
        state.token = getGatewayToken();
        syncControls();
        updateUrl();
        clearMediaObjectUrls();
        const token = getGatewayToken();
        if (!token) {
          stats.innerHTML = "";
          renderFollowups([], "等待 token");
          setAuthStatus("请输入当前 OpenClaw 的 gateway token，然后再加载媒体库。", "warn");
          setFollowupsStatus("先填写 gateway token，再加载统一追问动作。", "warn");
          renderEmpty(
            "需要访问 token",
            "媒体库会复用你当前 OpenClaw 的同一地址，但事件索引和媒体原件需要当前 gateway token 才能读取。token 只保存在当前浏览器。",
          );
          return;
        }
        const url = new URL(libraryUrlBase, window.location.origin);
        url.searchParams.set("date", state.date);
        if (state.deviceId) url.searchParams.set("deviceId", state.deviceId);
        if (state.modality) url.searchParams.set("modality", state.modality);
        const followupsUrl = new URL(followupsApiPath, window.location.origin);
        followupsUrl.searchParams.set("scope", "today");
        followupsUrl.searchParams.set("focus", "what_happened");
        followupsUrl.searchParams.set("date", state.date);
        if (state.deviceId) followupsUrl.searchParams.set("deviceId", state.deviceId);
        if (state.modality) followupsUrl.searchParams.set("modality", state.modality);
        renderEmpty("正在加载素材...", "ClawSense 正在整理这一天的原始感知事件。");
        setAuthStatus("正在使用已保存的 gateway token 加载媒体库...", "");
        setFollowupsStatus("正在加载统一追问源...", "");
        try {
          persistToken(token);
          const statusUrl = new URL(statusApiPath, window.location.origin);
          const [payload, diagnostics, followupsResult] = await Promise.all([
            fetchJson(url.toString(), token),
            fetchJson(statusUrl.toString(), token).catch(() => null),
            fetchJson(followupsUrl.toString(), token)
              .then((data) => ({ ok: true, data }))
              .catch((error) => ({ ok: false, error })),
          ]);
          populateDeviceOptions(payload.devices || []);
          renderScopeSummary(payload);
          renderStats(payload, diagnostics);
          renderCards(payload);
          const hintsTargets = collectFollowupsFromResponseHints(payload);
          if (hintsTargets.length > 0) {
            renderFollowups(hintsTargets, "responseHints.evidenceFollowUpTargets");
            setFollowupsStatus("已加载 responseHints 里的继续追问动作。", "ok");
          } else {
            const apiTargets = followupsResult.ok ? collectFollowupsFromFollowupsApi(followupsResult.data) : [];
            renderFollowups(
              apiTargets,
              followupsResult.ok ? "/api/clawsense/followups" : "统一追问接口暂时不可用",
            );
            if (apiTargets.length > 0) {
              setFollowupsStatus("已从 /api/clawsense/followups 加载可点击追问动作。", "ok");
            } else if (followupsResult.ok) {
              setFollowupsStatus("当前没有可执行的追问动作，建议先采集更多有效素材。", "warn");
            } else {
              setFollowupsStatus("统一追问源读取失败，稍后重试。错误：" + String(followupsResult.error), "warn");
            }
          }
          await hydrateArtifacts(token);
          if (diagnostics && diagnostics.publicHostLooksAlias) {
            setAuthStatus("媒体库已加载，但当前 public host 看起来像内网别名（如 lan）。建议检查 publicBaseUrl。", "warn");
          } else if (diagnostics && diagnostics.queue && diagnostics.queue.depth > 0) {
            setAuthStatus("媒体库已加载。当前上传队列有积压，客户端偶发 503 属于短时拥堵保护。", "warn");
          } else {
            setAuthStatus("已使用当前浏览器保存的 gateway token 加载媒体库。", "ok");
          }
        } catch (error) {
          stats.innerHTML = "";
          renderFollowups([], "加载失败");
          setFollowupsStatus("统一追问动作加载失败。", "danger");
          setAuthStatus("媒体库访问失败，请确认 token 正确且网关在线。", "danger");
          renderEmpty("媒体库加载失败", "请检查 OpenClaw 服务是否在线，然后再刷新。错误信息：" + String(error));
        }
      }

      saveTokenButton.addEventListener("click", function () {
        const token = tokenInput.value.trim();
        persistToken(token);
        load();
      });
      clearTokenButton.addEventListener("click", function () {
        persistToken("");
        tokenInput.value = "";
        clearMediaObjectUrls();
        stats.innerHTML = "";
        renderFollowups([], "等待 token");
        setFollowupsStatus("已清除 token，统一追问动作已重置。", "warn");
        setAuthStatus("已清除当前浏览器保存的 gateway token。", "warn");
        renderEmpty(
          "需要访问 token",
          "媒体库会复用你当前 OpenClaw 的同一地址，但事件索引和媒体原件需要当前 gateway token 才能读取。token 只保存在当前浏览器。",
        );
      });
      tokenInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          saveTokenButton.click();
        }
      });
      document.getElementById("refreshButton").addEventListener("click", load);
      document.getElementById("todayButton").addEventListener("click", function () {
        state.date = formatDateInput(new Date());
        dateInput.value = state.date;
        load();
      });
      document.getElementById("prevDayButton").addEventListener("click", function () {
        state.date = shiftDate(dateInput.value || state.date, -1);
        dateInput.value = state.date;
        load();
      });
      document.getElementById("nextDayButton").addEventListener("click", function () {
        state.date = shiftDate(dateInput.value || state.date, 1);
        dateInput.value = state.date;
        load();
      });
      dateInput.addEventListener("change", load);
      deviceSelect.addEventListener("change", function () {
        state.deviceId = deviceSelect.value;
        load();
      });
      document.getElementById("modalityTabs").addEventListener("click", function (event) {
        const button = event.target.closest("[data-value]");
        if (!button) return;
        state.modality = button.dataset.value || "";
        syncControls();
        load();
      });
      followupsList.addEventListener("click", async function (event) {
        const button = event.target.closest("[data-followup-index]");
        if (!button) {
          return;
        }
        const index = Number(button.dataset.followupIndex);
        const target = Number.isFinite(index) ? state.followups[index] : null;
        if (!target || !target.prompt) {
          setFollowupsStatus("追问动作失效，请刷新页面后重试。", "warn");
          return;
        }
        try {
          await copyToClipboard(target.prompt);
          setFollowupsStatus("已复制追问：直接粘贴到聊天页即可继续追问。", "ok");
        } catch (error) {
          setFollowupsStatus("复制失败，请手动复制。错误：" + String(error), "danger");
        }
      });
      if (state.token) {
        setAuthStatus("已检测到浏览器保存的 gateway token，正在准备加载媒体库。", "ok");
        setFollowupsStatus("准备加载统一追问源...", "");
      } else {
        setAuthStatus("请输入当前 OpenClaw 的 gateway token，然后再加载媒体库。", "warn");
        setFollowupsStatus("请先填写 gateway token。", "warn");
      }
      load();
    </script>
  </body>
</html>`;
  }

  private resolveMultimodalClient(providerId?: string) {
    const normalized = providerId?.trim().toLowerCase();
    if (!normalized) {
      return this.openai;
    }
    const cachedClient = this.providerOpenAiClients.get(normalized);
    if (cachedClient !== undefined || this.providerOpenAiClients.has(normalized)) {
      return cachedClient ?? null;
    }
    const resolvedClient = resolveOpenAiClientForProvider(this.cfg, this.runtimeConfig, normalized);
    this.providerOpenAiClients.set(normalized, resolvedClient);
    return resolvedClient;
  }

  private resolveFallbackSttProviderId(primaryProviderId?: string): string {
    const fallbackSttModel = this.cfg.sttFallbackModel.trim();
    return fallbackSttModel.toLowerCase() === "whisper-1"
      ? "openai"
      : primaryProviderId ?? this.cfg.visionProvider;
  }

  private async buildRecentActivitySnapshot(params: {
    startAt: number;
    deviceId?: string;
    modality?: "audio" | "image" | "video";
  }): Promise<RecentActivitySnapshot> {
    const lookbackMs = ASSISTANT_RECENT_ACTIVITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const lookbackStart = params.startAt - lookbackMs;
    const priorEvents = await this.filteredEvents({
      startAt: lookbackStart,
      endAt: params.startAt - 1,
      deviceId: params.deviceId,
      modality: params.modality,
    });
    if (priorEvents.length === 0) {
      return {
        lookbackDays: ASSISTANT_RECENT_ACTIVITY_LOOKBACK_DAYS,
        priorEventCount: 0,
        priorWindowCount: 0,
        priorActiveDays: 0,
        sampleWindows: [],
      };
    }
    const artifacts = await this.stateStore.listArtifacts();
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const priorWindows = groupWindows(priorEvents, artifactById);
    const activeDays = new Set(priorEvents.map((event) => toLocalDateKey(event.capturedAt))).size;
    const lastSeenAt = priorEvents.reduce((latest, event) => Math.max(latest, event.capturedAt), 0);
    const sampleWindows = priorWindows
      .slice()
      .sort((left, right) => right.endedAt - left.endedAt)
      .slice(0, 3)
      .map((window) => ({
        windowId: window.windowId,
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        summary: resolveWindowDisplaySummary(window),
        audioCount: window.audioCount,
        imageCount: window.imageCount,
        videoCount: window.videoCount,
      }));
    return {
      lookbackDays: ASSISTANT_RECENT_ACTIVITY_LOOKBACK_DAYS,
      priorEventCount: priorEvents.length,
      priorWindowCount: priorWindows.length,
      priorActiveDays: activeDays,
      lastSeenAt: lastSeenAt > 0 ? lastSeenAt : undefined,
      sampleWindows,
    };
  }

  private async filteredEvents(params: {
    date?: string;
    startAt?: number;
    endAt?: number;
    deviceId?: string;
    modality?: "audio" | "image" | "video";
    includeVideo?: boolean;
  }): Promise<ClawSenseCaptureEvent[]> {
    const events =
      typeof params.startAt === "number" || typeof params.endAt === "number"
        ? await this.stateStore.listEvents()
        : await this.stateStore.listEventsByDate(params.date ?? toLocalDateKey(Date.now()));
    return events
      .filter((event) => (params.deviceId ? event.deviceId === params.deviceId : true))
      .filter((event) => (params.includeVideo === false ? event.modality !== "video" : true))
      .filter((event) => {
        if (!params.modality) {
          return true;
        }
        if (params.modality === "video") {
          return event.modality === "video" || isVideoKeyframeCaptureEvent(event);
        }
        return event.modality === params.modality;
      })
      .filter((event) => (typeof params.startAt === "number" ? event.capturedAt >= params.startAt : true))
      .filter((event) => (typeof params.endAt === "number" ? event.capturedAt <= params.endAt : true))
      .sort((left, right) => left.capturedAt - right.capturedAt);
  }

  private async isReviewFresh(date: string, review: ClawSenseDailyReview): Promise<boolean> {
    const events = await this.stateStore.listEventsByDate(date);
    const latestEventCreatedAt = events.reduce((latest, event) => Math.max(latest, event.createdAt), 0);
    if (latestEventCreatedAt > review.generatedAt) {
      return false;
    }

    const eventIds = new Set(events.map((event) => event.eventId));
    if (eventIds.size === 0) {
      return true;
    }

    const people = await this.stateStore.listPeople();
    const latestRelevantAnnotationAt = people.reduce((latest, person) => {
      return person.eventIds.some((eventId) => eventIds.has(eventId))
        ? Math.max(latest, person.updatedAt)
        : latest;
    }, 0);
    return latestRelevantAnnotationAt <= review.generatedAt;
  }

  private async isConsolidationFresh(
    date: string,
    consolidation: ClawSenseDailyConsolidation,
  ): Promise<boolean> {
    const events = await this.stateStore.listEventsByDate(date);
    const latestEventCreatedAt = events.reduce((latest, event) => Math.max(latest, event.createdAt), 0);
    if (latestEventCreatedAt > consolidation.generatedAt) {
      return false;
    }

    const sourceReview = await this.stateStore.getDailyReview(date);
    if (sourceReview && sourceReview.generatedAt > consolidation.generatedAt) {
      return false;
    }

    const relevantEventIds = new Set(events.map((event) => event.eventId));
    if (relevantEventIds.size === 0) {
      return true;
    }
    const [people, speakers] = await Promise.all([
      this.stateStore.listPeople(),
      this.stateStore.listSpeakers(),
    ]);
    const latestPersonAnnotationAt = people.reduce((latest, person) => {
      return person.eventIds.some((eventId) => relevantEventIds.has(eventId))
        ? Math.max(latest, person.updatedAt)
        : latest;
    }, 0);
    const latestSpeakerAnnotationAt = speakers.reduce((latest, speaker) => {
      return speaker.eventIds.some((eventId) => relevantEventIds.has(eventId))
        ? Math.max(latest, speaker.updatedAt)
        : latest;
    }, 0);
    return Math.max(latestPersonAnnotationAt, latestSpeakerAnnotationAt) <= consolidation.generatedAt;
  }

  private async generateDailyReview(date: string): Promise<ClawSenseDailyReview> {
    const { windows, people } = await this.buildEvents({ date });
    const relevantPeople = selectRelevantPeople(windows, people);
    const keyWindows = windows.slice().sort((left, right) => right.score - left.score).slice(0, 6);
    if (this.cfg.analysisMode === "multimodal-preferred" && keyWindows.length > 0) {
      const multimodal = await this.tryGenerateMultimodalReview(date, windows, keyWindows, relevantPeople);
      if (multimodal) {
        return multimodal;
      }
    }
    return buildHeuristicReview(date, windows, relevantPeople);
  }

  private async generateDailyConsolidation(date: string): Promise<ClawSenseDailyConsolidation> {
    const [review, events, artifacts, people, speakers] = await Promise.all([
      this.getOrGenerateDailyReview(date),
      this.stateStore.listEventsByDate(date),
      this.stateStore.listArtifacts(),
      this.stateStore.listPeople(),
      this.stateStore.listSpeakers(),
    ]);
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const windows = groupWindows(events, artifactById);
    const relevantPeople = selectRelevantPeople(windows, people);
    const relevantSpeakers = selectRelevantSpeakers(windows, speakers);
    return buildHeuristicConsolidation({
      date,
      review,
      windows,
      people: relevantPeople,
      speakers: relevantSpeakers,
    });
  }

  private async tryGenerateMultimodalReview(
    date: string,
    windows: ReviewWindow[],
    keyWindows: ReviewWindow[],
    people: ClawSensePersonAnnotation[],
  ): Promise<ClawSenseDailyReview | null> {
    const reviewModel = resolveReviewGenerationModel(this.cfg, this.runtimeConfig);
    const reviewOpenai = this.resolveMultimodalClient(reviewModel.providerId);
    if (!reviewOpenai) {
      return null;
    }
    const model = reviewModel.model;
    const fallback = buildHeuristicReview(date, windows, people);
    const compactWindows = keyWindows.map((window) => ({
      windowId: window.windowId,
      deviceId: window.deviceId,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      summary: window.primarySummary,
      transcript: window.transcriptText,
      eventCount: window.events.length,
      imageCount: window.imageCount,
      videoCount: window.videoCount,
      audioCount: window.audioCount,
      peopleRefs: dedupeStrings(window.events.flatMap((event) => event.peopleRefs)),
      projectRefs: dedupeStrings(window.events.flatMap((event) => event.projectRefs)),
      captureContexts: dedupeStrings(window.events.map((event) => event.captureContext)),
      notes: dedupeStrings(window.events.map((event) => sanitizeUserFacingNoteText(event.note))),
      tags: Array.from(new Set(window.events.flatMap((event) => event.tags))),
    }));
    const content: any[] = [
      {
        type: "input_text",
        text: MULTIMODAL_REVIEW_INSTRUCTIONS,
      },
      {
        type: "input_text",
        text: `日期: ${date}\n人物注释: ${JSON.stringify(people, null, 2)}\n关键窗口: ${JSON.stringify(compactWindows, null, 2)}`,
      },
    ];

    for (const window of keyWindows) {
      const artifact = window.artifacts.find((item) => item.modality === "image" && !item.deletedAt);
      if (!artifact) {
        continue;
      }
      try {
        const buffer = await fs.readFile(artifact.storagePath);
        const mime = artifact.mime ?? inferMimeFromName(artifact.fileName, "image");
        content.push({
          type: "input_text",
          text: `以下图片属于窗口 ${window.windowId}，可用来辅助理解场景和人物。`,
        });
        content.push({
          type: "input_image",
          image_url: `data:${mime};base64,${buffer.toString("base64")}`,
          detail: "auto",
        });
      } catch {
        // Ignore deleted or unreadable images during multimodal review generation.
      }
    }

    try {
      const response = await reviewOpenai.responses.create({
        model,
        input: [{ role: "user", content } as any],
      });
      const parsed = safeParseJson<{ summary: string; sections: ClawSenseReviewSection[]; keyWindowIds?: string[] }>(
        response.output_text,
      );
      if (!parsed || !parsed.summary || !Array.isArray(parsed.sections)) {
        return null;
      }

      const keyWindowIds = dedupeStrings(
        (parsed.keyWindowIds ?? []).filter((windowId) => keyWindows.some((window) => window.windowId === windowId)),
      );
      const selectedWindowIds = keyWindowIds.length
        ? keyWindowIds
        : keyWindows.map((window) => window.windowId).slice(0, 3);
      const keyEventIds = windows
        .filter((window) => selectedWindowIds.includes(window.windowId))
        .flatMap((window) => window.events.map((event) => event.eventId));
      const keyArtifactIds = windows
        .filter((window) => selectedWindowIds.includes(window.windowId))
        .flatMap((window) => window.artifacts.map((artifact) => artifact.artifactId));

      return {
        reviewId: randomId(),
        date,
        generatedAt: Date.now(),
        mode: "multimodal",
        model,
        summary: parsed.summary.trim() || fallback.summary,
        sections: normalizeReviewSections(parsed.sections, fallback.sections),
        keyEventIds: keyEventIds.length ? keyEventIds : fallback.keyEventIds,
        keyArtifactIds: keyArtifactIds.length ? keyArtifactIds : fallback.keyArtifactIds,
      };
    } catch (error) {
      this.logger.warn(`[clawsense] multimodal daily review failed, using heuristic fallback: ${String(error)}`);
      return null;
    }
  }
}

function buildHeuristicReview(
  date: string,
  windows: ReviewWindow[],
  people: ClawSensePersonAnnotation[],
): ClawSenseDailyReview {
  const rankedWindows = windows.slice().sort((left, right) => right.score - left.score);
  const topWindows = rankedWindows.slice(0, 6);
  const sections = buildFallbackSections(date, windows, people);

  return {
    reviewId: randomId(),
    date,
    generatedAt: Date.now(),
    mode: "heuristic",
    summary: buildHeuristicSummary(date, topWindows, sections),
    sections,
    keyEventIds: topWindows.flatMap((window) => window.events.map((event) => event.eventId)),
    keyArtifactIds: topWindows.flatMap((window) => window.artifacts.map((artifact) => artifact.artifactId)),
  };
}

function buildHeuristicConsolidation(params: {
  date: string;
  review: ClawSenseDailyReview;
  windows: ReviewWindow[];
  people: ClawSensePersonAnnotation[];
  speakers: ClawSenseSpeakerAnnotation[];
}): ClawSenseDailyConsolidation {
  const rankedWindows = params.windows.slice().sort((left, right) => right.score - left.score);
  const keyWindows = rankedWindows.slice(0, 6);
  const keyWindowIds = keyWindows.slice(0, 3).map((window) => window.windowId);
  const eventCount = params.windows.reduce((sum, window) => sum + window.events.length, 0);
  const imageCount = params.windows.reduce((sum, window) => sum + window.imageCount, 0);
  const audioCount = params.windows.reduce((sum, window) => sum + window.audioCount, 0);
  const audioWindowCount = params.windows.filter((window) => window.audioCount > 0).length;
  const transcriptReadyWindows = params.windows.filter((window) => isUsableTranscriptText(window.transcriptText)).length;
  const degradedEventCount = params.windows
    .flatMap((window) => window.events)
    .filter((event) => event.analysisStatus === "degraded").length;
  const projectRefCounts = countStringOccurrences(
    params.windows.flatMap((window) => window.events.flatMap((event) => event.projectRefs)),
  );
  const tagCounts = countStringOccurrences(
    params.windows.flatMap((window) => window.events.flatMap((event) => event.tags).filter((tag) => isUserFacingTag(tag))),
  );
  const projectWindowMap = collectProjectWindowMap(params.windows);
  const tagWindowMap = collectTagWindowMap(params.windows);

  const projects: ClawSenseDailyConsolidation["projects"] = (
    projectRefCounts.size
      ? Array.from(projectRefCounts.entries())
          .sort((left, right) => right[1] - left[1])
          .slice(0, 6)
          .map(([ref, evidenceCount]) => ({
            ref,
            label: humanizeLabel(ref),
            source: "project-ref" as const,
            evidenceCount,
            windowIds: Array.from(projectWindowMap.get(ref) ?? []),
          }))
      : Array.from(tagCounts.entries())
          .sort((left, right) => right[1] - left[1])
          .slice(0, 6)
          .map(([ref, evidenceCount]) => ({
            ref,
            label: humanizeLabel(ref),
            source: "tag" as const,
            evidenceCount,
            windowIds: Array.from(tagWindowMap.get(ref) ?? []),
          }))
  );

  const sectionToday = pickReviewSectionItems(params.review, "Today at a glance");
  const sectionTimeline = pickReviewSectionItems(params.review, "时间线回顾");
  const sectionFollowUps = pickReviewSectionItems(params.review, "今天遗漏但值得追问的点");
  const sectionTomorrow = pickReviewSectionItems(params.review, "明天建议关注的事情");
  const sectionProjects = pickReviewSectionItems(params.review, "关键项目 / 主题");
  const sectionDetails = pickReviewSectionItems(params.review, "值得注意的细节");
  const signalCandidates = collectConsolidationSignalCandidates(keyWindows);

  const keyInsights = dedupeStrings([...sectionToday, ...sectionTimeline, ...sectionDetails])
    .slice(0, 6);
  const tasks = dedupeStrings([
    ...sectionTomorrow,
    ...signalCandidates.taskSignals,
    ...projects.slice(0, 3).map((project) => `继续推进 ${project.label}，并确认今天提到的下一步和负责人。`),
  ]).slice(0, 6);
  const attentionItems = dedupeStrings([
    ...sectionFollowUps,
    ...signalCandidates.attentionSignals,
    ...(degradedEventCount > 0
      ? [`当前仍有 ${degradedEventCount} 条降级事件，建议先补强关键窗口转写和人物标注。`]
      : []),
  ]).slice(0, 6);

  const learningPoints = dedupeStrings([
    ...sectionProjects.filter((item) => looksLikeLearningSignal(item)),
    ...sectionDetails.filter((item) => looksLikeLearningSignal(item)),
    ...signalCandidates.learningSignals,
    ...projects
      .filter((project) => looksLikeLearningSignal(project.label))
      .map((project) => `学习主线：${project.label}`),
  ]).slice(0, 6);

  const peopleByRefCount = countStringOccurrences(
    params.windows.flatMap((window) => window.events.flatMap((event) => event.peopleRefs)),
  );
  const people: ClawSenseDailyConsolidation["people"] = [
    ...params.people.map((person) => ({
      personRef: person.personRef,
      displayName: person.displayName,
      relationship: person.relationship,
      status: "confirmed" as const,
      evidenceCount: peopleByRefCount.get(person.personRef) ?? Math.max(person.eventIds.length, 1),
    })),
    ...params.speakers.map((speaker) => ({
      speakerRef: speaker.speakerRef,
      displayName: speaker.displayName,
      relationship: speaker.relationship,
      status: "confirmed" as const,
      evidenceCount: Math.max(speaker.eventIds.length, 1),
    })),
  ]
    .sort((left, right) => right.evidenceCount - left.evidenceCount)
    .slice(0, 8);

  if (people.length === 0) {
    const hintedSpeakerRefs = collectSpeakerRefsFromWindows(params.windows).slice(0, 3);
    for (const hintedRef of hintedSpeakerRefs) {
      people.push({
        speakerRef: hintedRef,
        displayName: hintedRef,
        status: "hint",
        evidenceCount: 1,
      });
    }
  }

  return {
    consolidationId: randomId(),
    date: params.date,
    generatedAt: Date.now(),
    sourceReviewId: params.review.reviewId,
    summary: params.review.summary,
    keyInsights: keyInsights.length
      ? keyInsights
      : keyWindows.map((window) => `${toTimeLabel(window.startedAt)}：${resolveWindowDisplaySummary(window)}`).slice(0, 3),
    tasks,
    attentionItems,
    learningPoints,
    keyWindowIds,
    people,
    projects,
    stats: {
      windowCount: params.windows.length,
      eventCount,
      audioWindowCount,
      transcriptReadyWindows,
      imageCount,
      audioCount,
      degradedEventCount,
    },
  };
}

function collectConsolidationSignalCandidates(windows: ReviewWindow[]): {
  taskSignals: string[];
  learningSignals: string[];
  attentionSignals: string[];
} {
  const segments = windows.flatMap((window) => {
    const baseTexts = [
      window.transcriptText,
      window.primarySummary,
      ...window.events.flatMap((event) => [event.summary, event.transcript ?? ""]),
    ]
      .map((text) => normalizeSemanticText(text))
      .filter(Boolean)
      .slice(0, 6);
    return baseTexts.flatMap((text) => splitSignalSentences(text));
  });

  const taskSignals = dedupeStrings(
    segments
      .filter((segment) => looksLikeTaskSignal(segment))
      .map((segment) => toConsolidationSignalLine(segment, "任务候选：")),
  ).slice(0, 6);
  const learningSignals = dedupeStrings(
    segments
      .filter((segment) => looksLikeLearningSignal(segment))
      .map((segment) => toConsolidationSignalLine(segment, "学习点：")),
  ).slice(0, 6);
  const attentionSignals = dedupeStrings(
    segments
      .filter((segment) => looksLikeAttentionSignal(segment))
      .map((segment) => toConsolidationSignalLine(segment, "待确认：")),
  ).slice(0, 6);

  return {
    taskSignals,
    learningSignals,
    attentionSignals,
  };
}

function splitSignalSentences(text: string): string[] {
  const normalized = normalizeSemanticText(text);
  if (!normalized) {
    return [];
  }
  return normalized
    .replace(/[，,]\s*/g, "，")
    .split(/[。！？；;\n]/)
    .map((segment) => normalizeSemanticText(segment))
    .filter((segment) => segment.length >= 8 && !isLowSignalSemanticText(segment));
}

function looksLikeTaskSignal(text: string): boolean {
  return /需要|要|安排|跟进|确认|提交|准备|完成|提醒|明天|下周|会后|课后|复习|作业|纪要|报价|上线|排期|同步|落实|推进/.test(
    text,
  );
}

function looksLikeAttentionSignal(text: string): boolean {
  return /待确认|不确定|可能|建议后续确认|仍需|缺少|补充|需要再看|暂不清楚|待补|问题|风险/.test(text);
}

function toConsolidationSignalLine(text: string, prefix: string): string {
  const normalized = truncateText(toSingleLine(text), 92);
  return normalized.startsWith(prefix) ? normalized : `${prefix}${normalized}`;
}

function groupWindows(
  events: ClawSenseCaptureEvent[],
  artifactById: Map<string, ClawSenseArtifactRecord>,
): ReviewWindow[] {
  const windowMap = new Map<string, ReviewWindow>();
  const latestSessionWindowBySourceWindow = new Map<string, { groupedWindowId: string; lastCapturedAt: number }>();
  const sorted = events.slice().sort((left, right) => left.capturedAt - right.capturedAt);
  for (const event of sorted) {
    const sessionHint = event.modality === "audio" ? parseClawSenseAudioSessionHint(event.note) : null;
    const groupedWindowId = resolveGroupedWindowId(
      event,
      sessionHint,
      latestSessionWindowBySourceWindow,
    );
    const startedAt = sessionHint?.sessionStart && sessionHint.sessionStart <= event.capturedAt
      ? sessionHint.sessionStart
      : event.capturedAt;
    const endedAt = sessionHint?.clipMs ? event.capturedAt + Math.max(sessionHint.clipMs, 0) : event.capturedAt;
    const current =
      windowMap.get(groupedWindowId) ??
      {
        windowId: groupedWindowId,
        deviceId: event.deviceId,
        startedAt,
        endedAt,
        events: [],
        artifacts: [],
        primarySummary: "",
        transcriptText: "",
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        score: 0,
        summaryStrength: Number.NEGATIVE_INFINITY,
        summaryCapturedAt: 0,
      };
    current.events.push(event);
    current.startedAt = Math.min(current.startedAt, startedAt);
    current.endedAt = Math.max(current.endedAt, endedAt);
    if (event.modality === "audio") {
      current.audioCount += 1;
    } else if (event.modality === "image") {
      current.imageCount += 1;
    } else {
      current.videoCount += 1;
    }
    const transcriptText = cleanAssistantSelfTalkText(event.transcript);
    if (transcriptText) {
      current.transcriptText = [current.transcriptText, transcriptText].filter(Boolean).join("\n");
    }
    const artifact = artifactById.get(event.artifactId);
    if (artifact) {
      current.artifacts.push(artifact);
    }
    updateWindowPrimarySummary(current, event);
    current.score =
      current.audioCount * 2 +
      current.imageCount * 3 +
      current.videoCount * 3 +
      (current.transcriptText ? 4 : 0) +
      new Set(current.events.flatMap((item) => item.peopleRefs)).size * 2;
    windowMap.set(groupedWindowId, current);
  }
  return Array.from(windowMap.values())
    .map(finalizeWindowSummary)
    .sort((left, right) => right.score - left.score);
}

function resolveGroupedWindowId(
  event: ClawSenseCaptureEvent,
  sessionHint: ReturnType<typeof parseClawSenseAudioSessionHint>,
  latestSessionWindowBySourceWindow: Map<string, { groupedWindowId: string; lastCapturedAt: number }>,
): string {
  if (event.modality === "audio" && sessionHint?.session) {
    const groupedWindowId = `audio-session::${event.deviceId}::${sessionHint.session}`;
    latestSessionWindowBySourceWindow.set(event.windowId, {
      groupedWindowId,
      lastCapturedAt: event.capturedAt,
    });
    return groupedWindowId;
  }

  if (event.captureContext === "active-window") {
    const latestSessionWindow = latestSessionWindowBySourceWindow.get(event.windowId);
    if (
      latestSessionWindow &&
      event.capturedAt - latestSessionWindow.lastCapturedAt <= ACTIVE_IMAGE_SESSION_ATTACH_GAP_MS
    ) {
      latestSessionWindowBySourceWindow.set(event.windowId, {
        groupedWindowId: latestSessionWindow.groupedWindowId,
        lastCapturedAt: event.capturedAt,
      });
      return latestSessionWindow.groupedWindowId;
    }
  }

  return event.windowId;
}

function updateWindowPrimarySummary(window: ReviewWindow, event: ClawSenseCaptureEvent): void {
  const candidate = selectWindowSummaryCandidate(event);
  if (!candidate.text) {
    return;
  }
  if (
    candidate.strength > window.summaryStrength ||
    (candidate.strength === window.summaryStrength && event.capturedAt >= window.summaryCapturedAt)
  ) {
    window.primarySummary = candidate.text;
    window.summaryStrength = candidate.strength;
    window.summaryCapturedAt = event.capturedAt;
  }
}

function selectWindowSummaryCandidate(
  event: ClawSenseCaptureEvent,
): { text: string; strength: number } {
  const summary = cleanAssistantSelfTalkText(event.summary);
  const transcript = cleanAssistantSelfTalkText(event.transcript);
  const transcriptExcerpt = transcript ? truncateText(toSingleLine(transcript), 180) : "";
  const hasStrongSummary = event.modality === "audio"
    ? isUsableAudioSemanticSummaryText(summary)
    : isUsableVisualSummaryText(summary);
  const hasTranscript = isUsableTranscriptText(transcript);

  if (hasStrongSummary) {
    return {
      text: summary,
      strength: hasTranscript ? 5 : event.analysisStatus === "succeeded" ? 4 : 3,
    };
  }
  if (hasTranscript) {
    return {
      text: transcriptExcerpt,
      strength: 4,
    };
  }
  if (summary && !isLowSignalSemanticText(summary)) {
    return {
      text: summary,
      strength: event.analysisStatus === "degraded" ? 1 : 2,
    };
  }
  return {
    text: "",
    strength: Number.NEGATIVE_INFINITY,
  };
}

function finalizeWindowSummary(window: ReviewWindow): ReviewWindow {
  if (!window.primarySummary || isLowValueText(window.primarySummary)) {
    window.primarySummary = resolveWindowDisplaySummary(window);
    window.summaryStrength = Math.max(window.summaryStrength, 0);
    window.summaryCapturedAt = Math.max(window.summaryCapturedAt, window.endedAt);
  }
  return window;
}

function resolveWindowDisplaySummary(window: ReviewWindow): string {
  const summary = cleanAssistantSelfTalkText(window.primarySummary);
  if (summary && !isLowValueText(summary)) {
    return summary;
  }
  const transcript = cleanAssistantSelfTalkText(window.transcriptText);
  if (isUsableTranscriptText(transcript)) {
    return truncateText(toSingleLine(transcript), 180);
  }
  const hasVisual = window.imageCount > 0 || window.videoCount > 0;
  if (window.audioCount > 0 && hasVisual) {
    return "采集到一段同时包含对话和画面的连续窗口，当前语义仍待补强。";
  }
  if (window.audioCount > 0) {
    return "采集到一段连续对话，当前语义仍待补强。";
  }
  if (hasVisual) {
    return "采集到一组画面片段，当前视觉语义仍待补强。";
  }
  return "采集到一个事件窗口，当前语义仍待补强。";
}

function cleanAssistantSelfTalkText(value: string | null | undefined): string {
  const normalized = normalizeSemanticText(value ?? undefined);
  if (!normalized) {
    return "";
  }
  const segments = normalized
    .split(/[。！？!?；;\n]/)
    .map((segment) => normalizeSemanticText(segment))
    .filter(Boolean);
  const kept = segments.filter((segment) => !looksLikeAssistantSelfTalkText(segment));
  if (kept.length === segments.length) {
    return normalized;
  }
  return kept.join("。");
}

function looksLikeAssistantSelfTalkText(value: string): boolean {
  const normalized = normalizeSemanticText(value);
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
    /^这次我没有听清/,
    /^最近这个时间窗/,
    /^场景上看[，,]/,
    /^刚才.*(重点|说了什么|聊了什么|讨论).*场景上看/,
    /当前最值得注意的是/,
  ].some((pattern) => pattern.test(normalized));
}

function selectAssistantContextWindows(params: {
  windows: ReviewWindow[];
  question?: string;
  maxWindows: number;
  semanticWindowIds?: string[];
}): ReviewWindow[] {
  if (params.windows.length <= params.maxWindows) {
    return params.windows.slice().sort((left, right) => left.startedAt - right.startedAt);
  }

  const semanticCandidates = params.semanticWindowIds?.length
    ? params.semanticWindowIds
        .map((windowId) => params.windows.find((window) => window.windowId === windowId))
        .filter((window): window is ReviewWindow => Boolean(window))
        .slice(0, Math.min(params.maxWindows, 4))
    : [];
  const question = params.question;
  const questionCandidates = question
    ? params.windows
        .slice()
        .map((window) => ({
          window,
          score: scoreWindowAgainstQuestion(window, question),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || right.window.endedAt - left.window.endedAt)
        .map((item) => item.window)
        .slice(0, Math.min(params.maxWindows, 4))
    : [];
  const keyCandidates = params.windows
    .slice()
    .sort((left, right) => right.score - left.score || right.endedAt - left.endedAt)
    .slice(0, Math.min(params.maxWindows, 4));
  const recentCandidates = params.windows
    .slice()
    .sort((left, right) => right.endedAt - left.endedAt)
    .slice(0, Math.min(params.maxWindows, 4));

  const merged = new Map<string, ReviewWindow>();
  for (const candidate of [...semanticCandidates, ...questionCandidates, ...keyCandidates, ...recentCandidates]) {
    if (!merged.has(candidate.windowId)) {
      merged.set(candidate.windowId, candidate);
    }
    if (merged.size >= params.maxWindows) {
      break;
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => left.startedAt - right.startedAt)
    .slice(0, params.maxWindows);
}

function scoreWindowAgainstQuestion(window: ReviewWindow, question: string): number {
  const normalizedQuestion = normalizeSemanticText(question).toLowerCase();
  if (!normalizedQuestion) {
    return 0;
  }
  const terms = extractQuestionTerms(normalizedQuestion);
  if (terms.length === 0) {
    return 0;
  }
  const haystack = [
    window.primarySummary,
    window.transcriptText,
    ...window.events.map((event) =>
      [
        event.summary,
        event.transcript ?? "",
        sanitizeUserFacingNoteText(event.note),
        event.captureContext,
        ...event.peopleRefs,
        ...event.projectRefs,
        ...event.tags,
      ].join(" "),
    ),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) {
      continue;
    }
    score += term.length >= 4 ? 4 : 2;
  }

  if (/人物|谁|同事|老板|老师|同学|客户|发言者|speaker/.test(normalizedQuestion) && window.audioCount > 0) {
    score += 2;
  }
  if (/会议|课堂|讨论|对话|讲了什么|说了什么|任务|项目|学习|要点|进展|跟进/.test(normalizedQuestion)) {
    if (window.audioCount > 0 || Boolean(window.transcriptText.trim())) {
      score += 2;
    }
  }
  if (/图片|画面|场景|环境|看到了|看到什么|视频|录像|片段/.test(normalizedQuestion) && (window.imageCount > 0 || window.videoCount > 0)) {
    score += 2;
  }
  return score;
}

function extractQuestionTerms(normalizedQuestion: string): string[] {
  const englishTerms =
    normalizedQuestion.match(/[a-z0-9_][a-z0-9_-]{1,}/g)?.filter((token) => token.length >= 2) ?? [];
  const keywordTerms = QUESTION_KEYWORD_HINTS.filter((token) => normalizedQuestion.includes(token));
  const identityTerms = Array.from(
    normalizedQuestion.matchAll(/(?:和|与|跟|问|找|关于|有关|回顾|看看)([\u4e00-\u9fffA-Za-z0-9_-]{2,12})/g),
  )
    .map((match) => normalizeSemanticText(match[1]).toLowerCase())
    .concat(
      Array.from(
        normalizedQuestion.matchAll(
          /([\u4e00-\u9fffA-Za-z0-9_-]{2,12})(?:之前|以前|历史|聊了什么|说了什么|讲了什么|出现过)/g,
        ),
      ).map((match) => normalizeSemanticText(match[1]).toLowerCase()),
    )
    .filter(Boolean);

  const merged = dedupeStrings([...englishTerms, ...keywordTerms, ...identityTerms].map((value) => value.trim()));
  return merged.filter((token) => token.length >= 2 && !QUESTION_STOP_TOKENS.has(token));
}

const QUESTION_KEYWORD_HINTS = [
  "老板",
  "同事",
  "老师",
  "同学",
  "客户",
  "会议",
  "课堂",
  "学习",
  "作业",
  "考试",
  "项目",
  "任务",
  "报价",
  "演示",
  "复盘",
  "讨论",
  "决定",
  "风险",
  "跟进",
  "人物",
  "发言者",
  "speaker",
];

const QUESTION_STOP_TOKENS = new Set([
  "今天",
  "昨天",
  "前天",
  "大前天",
  "最近",
  "上周",
  "本周",
  "发生",
  "什么",
  "哪些",
  "还有",
  "一下",
  "问下",
  "看看",
  "情况",
  "内容",
  "记录",
  "历史",
  "之前",
  "以前",
]);

const OFFICE_SCENARIO_KEYWORDS = [
  "会议",
  "办公",
  "老板",
  "同事",
  "客户",
  "项目",
  "演示",
  "报价",
  "需求",
  "复盘",
  "meeting",
  "office",
  "standup",
  "client",
  "proposal",
];

const OFFICE_TASK_KEYWORDS = [
  "任务",
  "待办",
  "跟进",
  "截止",
  "提测",
  "纪要",
  "排期",
  "优先级",
  "action item",
  "follow up",
  "deadline",
  "todo",
];

const SCHOOL_SCENARIO_KEYWORDS = [
  "课堂",
  "教室",
  "老师",
  "同学",
  "上课",
  "作业",
  "考试",
  "学习",
  "课程",
  "讲义",
  "class",
  "lecture",
  "study",
  "teacher",
  "homework",
];

const SCHOOL_LEARNING_KEYWORDS = [
  "重点",
  "知识点",
  "公式",
  "概念",
  "题目",
  "作业",
  "复习",
  "实验",
  "lesson",
  "topic",
  "exercise",
  "quiz",
];

const STABILITY_FAILURE_KEYWORDS = [
  "unauthorized",
  "ingest_queue_full",
  "queue_full",
  "request_timeout",
  "upload_timeout",
  "heartbeat_timeout",
  "connection",
  "network",
];

const SEMANTIC_ANALYSIS_FAILURE_PREFIXES = [
  "openai_stt_",
  "runtime_stt_",
  "primary_multimodal_",
  "vision_summary_",
  "video_summary_",
  "query_time_asr_",
];

function hasDataPlaneInstabilitySignal(analysisFailureReason: string | undefined): boolean {
  const reasons = (analysisFailureReason ?? "")
    .toLowerCase()
    .split("|")
    .map((reason) => reason.trim())
    .filter(Boolean);
  return reasons.some((reason) => {
    if (SEMANTIC_ANALYSIS_FAILURE_PREFIXES.some((prefix) => reason.startsWith(prefix))) {
      return false;
    }
    return STABILITY_FAILURE_KEYWORDS.some((keyword) => reason.includes(keyword));
  });
}

const IDENTITY_GUESS_PATTERNS = [
  /可能是你/u,
  /可能是同事/u,
  /可能是.*参与者/u,
];

function selectRelevantPeople(
  windows: ReviewWindow[],
  people: ClawSensePersonAnnotation[],
): ClawSensePersonAnnotation[] {
  const eventIds = new Set(windows.flatMap((window) => window.events.map((event) => event.eventId)));
  const personRefs = new Set(windows.flatMap((window) => window.events.flatMap((event) => event.peopleRefs)));
  return people.filter(
    (person) => person.eventIds.some((eventId) => eventIds.has(eventId)) || personRefs.has(person.personRef),
  );
}

function selectRelevantSpeakers(
  windows: ReviewWindow[],
  speakers: ClawSenseSpeakerAnnotation[],
): ClawSenseSpeakerAnnotation[] {
  const windowIds = new Set(windows.map((window) => window.windowId));
  const deviceIds = new Set(windows.map((window) => window.deviceId));
  const eventIds = new Set(windows.flatMap((window) => window.events.map((event) => event.eventId)));
  return speakers.filter(
    (speaker) =>
      (speaker.windowId && windowIds.has(speaker.windowId)) ||
      (speaker.deviceId && deviceIds.has(speaker.deviceId)) ||
      speaker.eventIds.some((eventId) => eventIds.has(eventId)),
  );
}

type HistoricalIdentityTarget =
  | {
      kind: "person";
      ref: string;
      displayName: string;
      relationship?: string;
      notes?: string;
      nextWatchFor?: string;
      personRefs: Set<string>;
      eventIds: Set<string>;
    }
  | {
      kind: "speaker";
      ref: string;
      displayName: string;
      relationship?: string;
      notes?: string;
      nextWatchFor?: string;
      eventIds: Set<string>;
      windowIds: Set<string>;
    };

type HistoricalProjectTarget = {
  ref: string;
  label: string;
  source: "project-ref" | "tag";
  projectRefs: Set<string>;
  tags: Set<string>;
};

function resolveHistoricalIdentityTargets(params: {
  question: string;
  currentPersonRefs: string[];
  currentSpeakerRefs: string[];
  people: ClawSensePersonAnnotation[];
  speakers: ClawSenseSpeakerAnnotation[];
}): HistoricalIdentityTarget[] {
  const normalizedQuestion = params.question.toLowerCase();
  const singularIdentityIntent = hasSingularIdentityIntent(normalizedQuestion);
  const currentPersonRefSet = new Set(params.currentPersonRefs);
  const currentSpeakerRefSet = new Set(params.currentSpeakerRefs);
  const scoredPeople = params.people
    .map((person) => ({
      person,
      score:
        scoreIdentityQuestionMatch(
          normalizedQuestion,
          person.displayName,
          person.relationship,
          person.notes,
        ) +
        (normalizedQuestion.includes(person.personRef.toLowerCase()) ? 100 : 0) +
        (currentPersonRefSet.has(person.personRef) ? 12 : 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.person.updatedAt - left.person.updatedAt);
  const scoredSpeakers = params.speakers
    .map((speaker) => ({
      speaker,
      score:
        scoreIdentityQuestionMatch(
          normalizedQuestion,
          speaker.displayName,
          speaker.relationship,
          speaker.notes,
        ) +
        (normalizedQuestion.includes(speaker.speakerRef.toLowerCase()) ? 100 : 0) +
        (currentSpeakerRefSet.has(speaker.speakerRef) ? 12 : 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.speaker.updatedAt - left.speaker.updatedAt);
  const explicitPeopleCandidates =
    singularIdentityIntent && currentPersonRefSet.size > 0
      ? scoredPeople.filter((item) => currentPersonRefSet.has(item.person.personRef))
      : scoredPeople;
  const explicitSpeakerCandidates =
    singularIdentityIntent && currentSpeakerRefSet.size > 0
      ? scoredSpeakers.filter((item) => currentSpeakerRefSet.has(item.speaker.speakerRef))
      : scoredSpeakers;
  const explicitPeople =
    explicitPeopleCandidates.length > 0
      ? explicitPeopleCandidates.map((item) => item.person)
      : scoredPeople.map((item) => item.person);
  const explicitSpeakers =
    explicitSpeakerCandidates.length > 0
      ? explicitSpeakerCandidates.map((item) => item.speaker)
      : scoredSpeakers.map((item) => item.speaker);
  const personIdentityKeys = new Set(
    explicitPeople.map((person) => `${person.displayName}::${person.relationship ?? ""}`),
  );

  const resolved: HistoricalIdentityTarget[] = [];
  for (const person of explicitPeople) {
    resolved.push({
      kind: "person",
      ref: person.personRef,
      displayName: person.displayName,
      relationship: person.relationship,
      notes: person.notes,
      nextWatchFor: person.nextWatchFor,
      personRefs: new Set([person.personRef]),
      eventIds: new Set(person.eventIds),
    });
  }

  const speakerGroups = groupSpeakersByIdentity(explicitSpeakers);
  for (const group of speakerGroups) {
    if (personIdentityKeys.has(`${group.displayName}::${group.relationship ?? ""}`)) {
      continue;
    }
    resolved.push({
      kind: "speaker",
      ref: group.primaryRef,
      displayName: group.displayName,
      relationship: group.relationship,
      notes: group.notes,
      eventIds: group.eventIds,
      windowIds: group.windowIds,
    });
  }

  if (resolved.length > 0) {
    return dedupeHistoricalTargets(resolved);
  }

  if (!looksHistoricalIdentityQuestion(normalizedQuestion)) {
    return [];
  }

  const fallbackPeople = params.people
    .filter((item) => currentPersonRefSet.has(item.personRef))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (fallbackPeople.length > 0) {
    const picked = singularIdentityIntent ? fallbackPeople.slice(0, 1) : fallbackPeople.slice(0, 2);
    return picked.map((person) => ({
      kind: "person",
      ref: person.personRef,
      displayName: person.displayName,
      relationship: person.relationship,
      notes: person.notes,
      nextWatchFor: person.nextWatchFor,
      personRefs: new Set([person.personRef]),
      eventIds: new Set(person.eventIds),
    }));
  }

  if (currentSpeakerRefSet.size >= 1) {
    const fallbackSpeakers = params.speakers
      .filter((speaker) => currentSpeakerRefSet.has(speaker.speakerRef))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const groups = groupSpeakersByIdentity(fallbackSpeakers);
    if (groups.length > 0) {
      const picked = singularIdentityIntent ? groups.slice(0, 1) : groups.slice(0, 2);
      return picked.map((group) => ({
        kind: "speaker",
        ref: group.primaryRef,
        displayName: group.displayName,
        relationship: group.relationship,
        notes: group.notes,
        eventIds: group.eventIds,
        windowIds: group.windowIds,
      }));
    }
  }

  return [];
}

function resolveHistoricalProjectTargets(params: {
  question: string;
  currentProjectRefs: string[];
  currentTags: string[];
  events: ClawSenseCaptureEvent[];
}): HistoricalProjectTarget[] {
  const normalizedQuestion = params.question.toLowerCase();
  const candidates = collectHistoricalProjectCandidates(params.events, params.currentProjectRefs, params.currentTags);
  const explicitMatches = candidates.filter((target) => includesProjectToken(normalizedQuestion, target));
  if (explicitMatches.length > 0) {
    const prioritized = explicitMatches.some((target) => target.source === "project-ref")
      ? explicitMatches.filter((target) => target.source === "project-ref")
      : explicitMatches;
    return dedupeHistoricalProjectTargets(prioritized).slice(0, 3);
  }

  if (!looksHistoricalProjectQuestion(normalizedQuestion)) {
    return [];
  }

  if (params.currentProjectRefs.length === 1) {
    const fallback = candidates.find((target) => target.projectRefs.has(params.currentProjectRefs[0]));
    if (fallback) {
      return [fallback];
    }
  }

  const userFacingCurrentTags = params.currentTags.filter((tag) => isUserFacingTag(tag));
  if (userFacingCurrentTags.length === 1) {
    const fallback = candidates.find((target) => target.tags.has(userFacingCurrentTags[0]));
    if (fallback) {
      return [fallback];
    }
  }

  return [];
}

function groupSpeakersByIdentity(speakers: ClawSenseSpeakerAnnotation[]): Array<{
  primaryRef: string;
  displayName: string;
  relationship?: string;
  notes?: string;
  latestUpdatedAt: number;
  eventIds: Set<string>;
  windowIds: Set<string>;
}> {
  const groups = new Map<string, {
    primaryRef: string;
    displayName: string;
    relationship?: string;
    notes?: string;
    latestUpdatedAt: number;
    eventIds: Set<string>;
    windowIds: Set<string>;
  }>();

  for (const speaker of speakers) {
    const key = `${speaker.displayName}::${speaker.relationship ?? ""}`;
      const current = groups.get(key) ?? {
        primaryRef: speaker.speakerRef,
        displayName: speaker.displayName,
        relationship: speaker.relationship,
        notes: speaker.notes,
        latestUpdatedAt: speaker.updatedAt,
        eventIds: new Set<string>(),
        windowIds: new Set<string>(),
      };
    current.latestUpdatedAt = Math.max(current.latestUpdatedAt, speaker.updatedAt);
    for (const eventId of speaker.eventIds) {
      current.eventIds.add(eventId);
    }
    if (speaker.windowId) {
      current.windowIds.add(speaker.windowId);
    }
    groups.set(key, current);
  }

  return Array.from(groups.values()).sort((left, right) => right.latestUpdatedAt - left.latestUpdatedAt);
}

function resolveAcceptanceCriterionGoal(id: PhaseAcceptanceCriterionId): string {
  if (id === "office-recap") {
    return "办公场景回答里，能稳定给出任务、人和待确认重点。";
  }
  if (id === "school-recap") {
    return "课堂/上学场景回答里，能稳定给出学习点、待确认问题和发言者线索。";
  }
  if (id === "audio-reinforcement") {
    return "关键音频窗口有可引用 transcript，聊天页不再长期回落到降级摘要。";
  }
  if (id === "video-evidence") {
    return "视频证据链可回放，并至少具备关键帧或可引用视频摘要。";
  }
  return "设备心跳稳定，人物/speaker 标注可复用，回答能长期复现。";
}

function resolveAcceptanceCriterionCommands(id: PhaseAcceptanceCriterionId): string[] {
  if (id === "office-recap") {
    return [
      "openclaw clawsense annotate-suggestions today --question \"今天办公期间有哪些人物线索需要补标注？\"",
      "openclaw clawsense evidence today --focus what_happened --question \"今天办公期间有哪些任务和人物线索？\"",
      "openclaw clawsense review today",
    ];
  }
  if (id === "school-recap") {
    return [
      "openclaw clawsense annotate-suggestions today --question \"今天课堂里的老师、同学或发言者分别是谁？\"",
      "openclaw clawsense evidence today --focus what_happened --question \"今天课堂里的学习要点和待确认问题有哪些？\"",
      "openclaw clawsense review today",
    ];
  }
  if (id === "audio-reinforcement") {
    return [
      "openclaw clawsense backfill-audio today --max 6",
      "openclaw clawsense evidence today --focus watch_for --question \"今天哪些音频片段还没有可引用 transcript？\"",
    ];
  }
  if (id === "video-evidence") {
    return [
      "openclaw config set plugins.entries.clawsense.config.hostModelVideoMode '\"keyframes\"' --strict-json",
      "openclaw clawsense evidence today --focus what_happened --modality video --question \"今天有哪些视频片段和关键帧值得回看？\"",
      "openclaw clawsense media today",
    ];
  }
  return [
    "openclaw clawsense annotate-suggestions today --question \"当前有哪些 speaker/person 需要补标注？\"",
    "openclaw clawsense devices",
    "openclaw clawsense doctor",
  ];
}

function parseVideoRequestId(note: string | undefined): string | undefined {
  const text = (note ?? "").trim();
  if (!text) {
    return undefined;
  }
  const requestId = text.match(/\bvideoRequestId=([^\s]+)/i)?.[1]?.trim();
  return requestId || undefined;
}

function isVideoKeyframeCaptureEvent(event: ClawSenseCaptureEvent): boolean {
  if (event.modality !== "image") {
    return false;
  }
  const note = (event.note ?? "").trim();
  return /\bvideoKeyframe=1\b/i.test(note) || /\bkeyframe=\d+\b/i.test(note);
}

function dedupeHistoricalTargets(targets: HistoricalIdentityTarget[]): HistoricalIdentityTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.ref}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectHistoricalProjectCandidates(
  events: ClawSenseCaptureEvent[],
  currentProjectRefs: string[],
  currentTags: string[],
): HistoricalProjectTarget[] {
  const candidates = new Map<string, HistoricalProjectTarget>();

  const pushProjectRef = (projectRef: string) => {
    const normalized = projectRef.trim();
    if (!normalized) {
      return;
    }
    const key = `project:${normalized}`;
    const current = candidates.get(key) ?? {
      ref: normalized,
      label: humanizeProjectHistoryLabel(normalized),
      source: "project-ref" as const,
      projectRefs: new Set<string>(),
      tags: new Set<string>(),
    };
    current.projectRefs.add(normalized);
    candidates.set(key, current);
  };

  const pushTag = (tag: string) => {
    const normalized = tag.trim();
    if (!normalized || !isUserFacingTag(normalized)) {
      return;
    }
    const key = `tag:${normalized}`;
    const current = candidates.get(key) ?? {
      ref: key,
      label: humanizeProjectHistoryLabel(normalized),
      source: "tag" as const,
      projectRefs: new Set<string>(),
      tags: new Set<string>(),
    };
    current.tags.add(normalized);
    candidates.set(key, current);
  };

  for (const projectRef of currentProjectRefs) {
    pushProjectRef(projectRef);
  }
  for (const tag of currentTags) {
    pushTag(tag);
  }
  for (const event of events) {
    for (const projectRef of event.projectRefs) {
      pushProjectRef(projectRef);
    }
    for (const tag of event.tags) {
      pushTag(tag);
    }
  }

  return Array.from(candidates.values());
}

function dedupeHistoricalProjectTargets(targets: HistoricalProjectTarget[]): HistoricalProjectTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.source}:${target.label.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function looksHistoricalIdentityQuestion(question: string): boolean {
  return /之前|以前|历史|过往|过去|出现过|见过|记录过|回顾.*(这个人|此人|这个发言者|这个speaker|这个 speaker)/.test(
    question,
  );
}

function hasSingularIdentityIntent(question: string): boolean {
  return /(这个人|此人|这位|这个发言者|这个speaker|这个 speaker|这位老板|这位老师|这位同事|这位同学|这个老板|这个老师|这个同事|这个同学)/.test(
    question,
  );
}

function looksHistoricalProjectQuestion(question: string): boolean {
  return /之前|以前|历史|过往|过去|出现过|记录过|回顾.*(这个项目|这个主题|这条主线)|这个项目.*之前|这个主题.*之前/.test(
    question,
  );
}

function scoreIdentityQuestionMatch(
  question: string,
  displayName: string,
  relationship?: string,
  notes?: string,
): number {
  let score = 0;
  const normalizedName = displayName.trim().toLowerCase();
  if (normalizedName.length >= 2 && question.includes(normalizedName)) {
    score += 120;
  }
  const aliasTokens = extractIdentityAliasTokens(displayName);
  score += Math.min(
    80,
    aliasTokens.filter((token) => token.length >= 2 && question.includes(token)).length * 40,
  );
  const relationshipTokens = extractIdentityAliasTokens(relationship);
  score += Math.min(50, relationshipTokens.filter((token) => question.includes(token)).length * 25);
  const noteTokens = extractIdentityAliasTokens(notes).filter((token) => token.length >= 3);
  score += Math.min(30, noteTokens.filter((token) => question.includes(token)).length * 10);
  return score;
}

function extractIdentityAliasTokens(value?: string): string[] {
  const normalized = normalizeSemanticText(value ?? "").toLowerCase();
  if (!normalized) {
    return [];
  }
  const words = normalized.split(/[\s,，、/|]+/g).map((token) => token.trim()).filter(Boolean);
  const compactTokens = normalized
    .split(/[^\p{L}\p{N}_-]+/gu)
    .map((token) => token.trim())
    .filter(Boolean);
  return dedupeStrings(words.concat(compactTokens)).filter((token) => token.length >= 2);
}

function includesProjectToken(question: string, target: HistoricalProjectTarget): boolean {
  const label = target.label.trim().toLowerCase();
  if (label.length >= 2 && question.includes(label)) {
    return true;
  }
  if (target.projectRefs.size > 0 && Array.from(target.projectRefs).some((ref) => question.includes(ref.toLowerCase()))) {
    return true;
  }
  return Array.from(target.tags).some((tag) => question.includes(tag.toLowerCase()));
}

function windowMatchesKeywords(window: ReviewWindow, keywords: string[]): boolean {
  return countWindowKeywordHits(window, keywords) > 0;
}

function countWindowKeywordHits(window: ReviewWindow, keywords: string[]): number {
  return countKeywordHits(buildWindowSearchText(window), keywords);
}

function buildWindowSearchText(window: ReviewWindow): string {
  return normalizeSemanticText([
    window.primarySummary,
    window.transcriptText,
    ...window.events.map((event) =>
      [
        event.summary,
        event.transcript ?? "",
        sanitizeUserFacingNoteText(event.note),
        ...event.tags,
        ...event.projectRefs,
        ...event.peopleRefs,
      ].join(" "),
    ),
  ].join(" ")).toLowerCase();
}

function containsIdentityGuessPattern(window: ReviewWindow): boolean {
  const text = buildWindowSearchText(window);
  return IDENTITY_GUESS_PATTERNS.some((pattern) => pattern.test(text));
}

function collectSpeakerRefsFromWindows(windows: ReviewWindow[]): string[] {
  return dedupeStrings(
    windows.flatMap((window) =>
      extractSpeakerRefs(
        [
          window.primarySummary,
          window.transcriptText,
          ...window.events.flatMap((event) => [
            event.summary,
            event.transcript ?? "",
            sanitizeUserFacingNoteText(event.note),
          ]),
        ].join(" "),
      ),
    ),
  )
    .map((ref) => normalizeSpeakerRef(ref))
    .filter(Boolean);
}

function extractSpeakerRefs(text: string): string[] {
  return Array.from(text.matchAll(/speaker[\s_-]?(\d{1,3})/gi)).map((match) => `speaker_${match[1]}`);
}

function normalizeSpeakerRef(speakerRef: string): string {
  const normalized = speakerRef.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const match = normalized.match(/^speaker_?(\d{1,3})$/);
  if (!match) {
    return normalized;
  }
  return `speaker_${match[1]}`;
}

function doesWindowMatchHistoricalTarget(
  window: ReviewWindow,
  target: HistoricalIdentityTarget,
): boolean {
  if (target.kind === "person") {
    return (
      window.events.some((event) => event.peopleRefs.some((personRef) => target.personRefs.has(personRef))) ||
      window.events.some((event) => target.eventIds.has(event.eventId))
    );
  }
  return (
    target.windowIds.has(window.windowId) ||
    window.events.some((event) => target.eventIds.has(event.eventId))
  );
}

function doesWindowMatchHistoricalProjectTarget(
  window: ReviewWindow,
  target: HistoricalProjectTarget,
): boolean {
  return window.events.some(
    (event) =>
      event.projectRefs.some((projectRef) => target.projectRefs.has(projectRef)) ||
      event.tags.some((tag) => target.tags.has(tag)),
  );
}

function buildFallbackSections(
  date: string,
  windows: ReviewWindow[],
  people: ClawSensePersonAnnotation[],
): ClawSenseReviewSection[] {
  const rankedWindows = windows.slice().sort((left, right) => right.score - left.score);
  const timelineWindows = windows.slice().sort((left, right) => left.startedAt - right.startedAt);
  const topWindows = rankedWindows.slice(0, 6);
  const eventCount = windows.reduce((sum, window) => sum + window.events.length, 0);
  const imageCount = windows.reduce((sum, window) => sum + window.imageCount, 0);
  const videoCount = windows.reduce((sum, window) => sum + window.videoCount, 0);
  const audioCount = windows.reduce((sum, window) => sum + window.audioCount, 0);
  const peopleByRef = new Map(people.map((person) => [person.personRef, person]));
  const peopleCounts = countStringOccurrences(windows.flatMap((window) => window.events.flatMap((event) => event.peopleRefs)));
  const projectCounts = countStringOccurrences(
    windows.flatMap((window) => window.events.flatMap((event) => event.projectRefs)),
  );
  const tagCounts = countStringOccurrences(windows.flatMap((window) => window.events.flatMap((event) => event.tags)));
  const userFacingTagCounts = new Map(
    Array.from(tagCounts.entries()).filter(([tag]) => isUserFacingTag(tag)),
  );
  const peopleItems = dedupeStrings([
    ...Array.from(peopleCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([personRef, count]) => {
        const person = peopleByRef.get(personRef);
        if (!person) {
          return `${formatUnknownPersonLabel(personRef)}：在 ${count} 个事件里出现，建议补充身份、关系和下次再见时要注意什么。`;
        }
        const parts = [`${person.displayName}：在 ${count} 个事件里出现`];
        if (person.relationship) {
          parts.push(`关系：${person.relationship}`);
        }
        if (person.nextWatchFor) {
          parts.push(`下次留意：${person.nextWatchFor}`);
        } else if (person.notes) {
          parts.push(`备注：${truncateText(person.notes, 48)}`);
        }
        return parts.join("，");
      }),
    ...people
      .filter((person) => !peopleCounts.has(person.personRef))
      .slice(0, 2)
      .map((person) => {
        const parts = [`${person.displayName}：今天已有注释，但还没有足够多的事件引用`];
        if (person.nextWatchFor) {
          parts.push(`下次留意：${person.nextWatchFor}`);
        }
        return parts.join("，");
      }),
    ...(!peopleCounts.size
      ? topWindows
          .filter((window) => window.audioCount > 0 || Boolean(window.transcriptText.trim()))
          .slice(0, 2)
          .map((window) => {
            const topicHint = pickWindowTheme(window);
            return `${toTimeLabel(window.startedAt)} 左右出现了一位待确认的对话对象${topicHint ? `，当前线索更像在聊“${topicHint}”` : ""}。`;
          })
      : []),
  ]).slice(0, MAX_SECTION_ITEMS);
  const projectItems = dedupeStrings(
    projectCounts.size
      ? Array.from(projectCounts.entries())
          .sort((left, right) => right[1] - left[1])
          .map(([projectRef, count]) => `${humanizeLabel(projectRef)}：在 ${count} 个窗口里反复出现，像是今天需要继续跟进的主线。`)
      : [
          ...Array.from(userFacingTagCounts.entries())
            .sort((left, right) => right[1] - left[1])
            .map(([tag, count]) => `${humanizeLabel(tag)}：作为临时主题，在 ${count} 个窗口里反复出现。`),
          ...topWindows
            .map((window) => pickWindowTheme(window))
            .filter(Boolean)
            .map((topic) => `围绕“${topic}”的信息比较集中，建议把它当成今天的暂定主题继续追问。`),
        ],
  ).slice(0, MAX_SECTION_ITEMS);
  const detailItems = topWindows
    .filter(
      (window) =>
        window.imageCount > 0 ||
        window.videoCount > 0 ||
        Boolean(window.transcriptText.trim()) ||
        window.events.some((event) => Boolean(sanitizeUserFacingNoteText(event.note))),
    )
    .map((window) => {
      const detailParts: string[] = [];
      const noteText = dedupeStrings(window.events.map((event) => sanitizeUserFacingNoteText(event.note))).join("；");
      const lead = buildWindowInsight(window);
      if (window.transcriptText.trim()) {
        detailParts.push(`语音片段：${truncateText(toSingleLine(window.transcriptText), 96)}`);
      }
      if (noteText) {
        detailParts.push(`补充：${truncateText(noteText, 84)}`);
      }
      if (!detailParts.length && (window.imageCount > 0 || window.videoCount > 0)) {
        detailParts.push("包含图片快照，建议回看原始画面确认场景细节。");
      }
      return `${toTimeLabel(window.startedAt)}：${lead}${detailParts.length ? `；${detailParts.join("；")}` : ""}`;
    })
    .slice(0, MAX_SECTION_ITEMS);
  const followUpItems = dedupeStrings(
    topWindows.flatMap((window) => {
      const items: string[] = [];
      const timeLabel = toTimeLabel(window.startedAt);
      const windowPeopleRefs = dedupeStrings(window.events.flatMap((event) => event.peopleRefs));
      const unresolvedPeople = windowPeopleRefs.filter((personRef) => !peopleByRef.has(personRef));
      const windowProjects = dedupeStrings(window.events.flatMap((event) => event.projectRefs));
      const windowTags = dedupeStrings(window.events.flatMap((event) => event.tags).filter((tag) => isUserFacingTag(tag)));
      const noteText = dedupeStrings(window.events.map((event) => sanitizeUserFacingNoteText(event.note))).join("；");
      const topicHint = pickWindowTheme(window);

      if (unresolvedPeople.length) {
        items.push(
          `${timeLabel} 左右出现的 ${unresolvedPeople.map((personRef) => formatUnknownPersonLabel(personRef)).join("、")} 分别是谁？你和他们是什么关系？`,
        );
      } else if (!windowPeopleRefs.length) {
        items.push(`${timeLabel} 左右和你一起出现的人是谁？这段互动为什么重要？`);
      }

      if (!windowProjects.length) {
        items.push(
          `${timeLabel} 左右这段${topicHint ? `更像在处理“${topicHint}”，` : ""}它到底对应哪个项目、任务或生活主题${windowTags.length ? `？目前只看到临时标签 ${windowTags.map((tag) => humanizeLabel(tag)).join(" / ")}` : "？"}`,
        );
      }

      if (window.transcriptText.trim()) {
        items.push(`${timeLabel} 左右这段对话最后定下了什么？有没有明确的结论、承诺或下一步？`);
      } else if (window.audioCount > 0) {
        items.push(`${timeLabel} 左右的音频转写还不够清楚，当时在聊什么，最后有没有结论？`);
      }

      if ((window.imageCount > 0 || window.videoCount > 0) && !noteText) {
        items.push(`${timeLabel} 左右画面里最值得记住的地点、物件或动作是什么？`);
      }
      return items;
    }),
  ).slice(0, MAX_SECTION_ITEMS);
  const primaryTopics = projectCounts.size
    ? Array.from(projectCounts.keys())
    : Array.from(userFacingTagCounts.keys()).length
      ? Array.from(userFacingTagCounts.keys())
      : topWindows.map((window) => pickWindowTheme(window)).filter(Boolean);
  const tomorrowItems = dedupeStrings([
    ...people
      .filter((person) => person.nextWatchFor)
      .slice(0, 2)
      .map((person) => `如果明天再遇到 ${person.displayName}，优先留意：${person.nextWatchFor}`),
    primaryTopics[0] ? `围绕 ${humanizeLabel(primaryTopics[0])} 继续补齐决定、结论或下一步。` : "",
    topWindows[0] ? `优先回看 ${toTimeLabel(topWindows[0].startedAt)} 左右的关键窗口，确认当时有没有遗漏问题。` : "",
  ]).slice(0, 3);

  return [
    {
      title: "Today at a glance",
      items: windows.length
        ? normalizeItems([
            `这一天共整理出 ${windows.length} 个事件窗口，覆盖 ${eventCount} 条原始事件，其中音频 ${audioCount} 条、图片 ${imageCount} 条、视频 ${videoCount} 条。`,
            topWindows[0]
              ? `最值得先回看的窗口出现在 ${toTimeLabel(topWindows[0].startedAt)} 左右：${topWindows[0].primarySummary}`
              : `ClawSense 在 ${date} 记录了素材，但还缺少足够强的重点窗口。`,
            peopleItems.length || projectItems.length
              ? "人物和主题已经开始浮现，但仍建议优先补全待确认人物与项目标签。"
              : "当前仍以原始事实线索为主，人物和项目标签需要继续补充。",
          ]).slice(0, MAX_SECTION_ITEMS)
        : [
            "今天还没有采集到可用于回顾的事件窗口。",
            "建议先确认设备在线、音频上传和基线图片采样是否正常。",
          ],
    },
    {
      title: "时间线回顾",
      items: timelineWindows.length
        ? timelineWindows
            .slice(0, MAX_TIMELINE_ITEMS)
            .map(
              (window) => {
                const refs = [`音频 ${window.audioCount}`, `图片 ${window.imageCount}`, `视频 ${window.videoCount}`];
                const peopleCount = new Set(window.events.flatMap((event) => event.peopleRefs)).size;
                const projectCount = new Set(window.events.flatMap((event) => event.projectRefs)).size;
                if (peopleCount) {
                  refs.push(`人物 ${peopleCount}`);
                }
                if (projectCount) {
                  refs.push(`项目 ${projectCount}`);
                }
                return `${toTimeLabel(window.startedAt)} - ${window.primarySummary}（${refs.join("，")}）`;
              },
            )
        : ["时间线上还没有可归并的 ClawSense 事件。"],
    },
    {
      title: "关键人物",
      items: peopleItems.length ? peopleItems : ["今天还没有被明确标注的人物；如果你知道是谁，补一个名字就能让后续 review 更像助理。"],
    },
    {
      title: "关键项目 / 主题",
      items: projectItems.length ? projectItems : ["今天的主线还没有被说成用户能懂的项目或主题，下一步可以直接回答 review 里的追问把它补清楚。"],
    },
    {
      title: "值得注意的细节",
      items: detailItems.length ? detailItems : ["当前没有可展开的音频或图片细节。"],
    },
    {
      title: "今天遗漏但值得追问的点",
      items: followUpItems.length
        ? followUpItems
        : ["今天还有哪一段你主观觉得重要，但 ClawSense 没有完整采到或没有讲清楚？"],
    },
    {
      title: "明天建议关注的事情",
      items: tomorrowItems.length
        ? tomorrowItems
        : ["如果明天还会继续今天的主线，优先补清关键人物身份、项目名和最后结论。"],
    },
  ];
}

function normalizeReviewSections(
  sections: ClawSenseReviewSection[],
  fallbackSections: ClawSenseReviewSection[],
): ClawSenseReviewSection[] {
  const parsedByTitle = new Map(
    sections.map((section) => [section.title.trim(), normalizeItems(section.items)]),
  );
  const fallbackByTitle = new Map(
    fallbackSections.map((section) => [section.title, normalizeItems(section.items)]),
  );
  return REVIEW_SECTION_TITLES.map((title) => ({
    title,
    items: limitSectionItems(
      title,
      parsedByTitle.get(title)?.length ? parsedByTitle.get(title)! : fallbackByTitle.get(title) ?? ["待补充"],
    ),
  }));
}

function normalizeItems(items: string[] | undefined): string[] {
  return dedupeStrings(
    (items ?? []).map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean),
  );
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function limitSectionItems(title: string, items: string[]): string[] {
  return items.slice(0, title === "时间线回顾" ? MAX_TIMELINE_ITEMS : MAX_SECTION_ITEMS);
}

function countStringOccurrences(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function pickReviewSectionItems(review: ClawSenseDailyReview, title: string): string[] {
  return normalizeItems(review.sections.find((section) => section.title === title)?.items);
}

function looksLikeLearningSignal(value: string): boolean {
  return /(老师|课堂|课程|作业|复习|考试|实验|教室|\bclass\b|\blecture\b|\bstudy\b|\bhomework\b|\bexam\b|\blab\b)/i
    .test(value);
}

function collectProjectWindowMap(windows: ReviewWindow[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const window of windows) {
    const refs = dedupeStrings(window.events.flatMap((event) => event.projectRefs));
    for (const ref of refs) {
      const set = map.get(ref) ?? new Set<string>();
      set.add(window.windowId);
      map.set(ref, set);
    }
  }
  return map;
}

function collectTagWindowMap(windows: ReviewWindow[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const window of windows) {
    const tags = dedupeStrings(
      window.events.flatMap((event) => event.tags).filter((tag) => isUserFacingTag(tag)),
    );
    for (const tag of tags) {
      const set = map.get(tag) ?? new Set<string>();
      set.add(window.windowId);
      map.set(tag, set);
    }
  }
  return map;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = toSingleLine(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeUserFacingNoteText(value: string | undefined): string {
  const normalized = normalizeSemanticText(value);
  if (!normalized) {
    return "";
  }
  const cleaned = normalized
    .replace(/\bvideoRequestId=[^\s]+\b/gi, "")
    .replace(/\bvideoKeyframe=1\b/gi, "")
    .replace(/\bkeyframe=\d+\b/gi, "")
    .replace(/\bactive-window\b/gi, "")
    .replace(/\bbaseline-snapshot\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function buildHeuristicSummary(
  date: string,
  topWindows: ReviewWindow[],
  sections: ClawSenseReviewSection[],
): string {
  if (!topWindows.length) {
    return `ClawSense 在 ${date} 还没有采集到可用于回顾的事件。`;
  }
  const topWindow = topWindows[0];
  const topic = pickWindowTheme(topWindow) || "今天最值得回看的那段互动";
  const followUpSection = sections.find((section) => section.title === "今天遗漏但值得追问的点");
  const firstFollowUp = followUpSection?.items[0];
  const base = `今天的主线更像围绕“${topic}”展开，最值得先回看的是 ${toTimeLabel(topWindow.startedAt)} 左右的窗口。`;
  return firstFollowUp ? `${base} 当前最该补清的是：${firstFollowUp}` : base;
}

function buildWindowInsight(window: ReviewWindow): string {
  const summary = pickWindowTheme(window) || "这段窗口留下了一些可继续追问的线索";
  const hasVisual = window.imageCount > 0 || window.videoCount > 0;
  if (window.audioCount > 0 && hasVisual && window.transcriptText.trim()) {
    return `这是今天信息最完整的一段，围绕“${summary}”同时留下了对话和画面线索`;
  }
  if (window.transcriptText.trim()) {
    return `这段窗口围绕“${summary}”留下了可继续追问的对话线索`;
  }
  if (hasVisual) {
    return `这段窗口围绕“${summary}”主要保留了画面线索，适合回看场景和物件`;
  }
  return summary;
}

function pickWindowTheme(window: ReviewWindow): string {
  const candidates = [
    window.primarySummary,
    window.transcriptText,
    ...window.events.map((event) => sanitizeUserFacingNoteText(event.note)),
  ];
  for (const candidate of candidates) {
    const cleaned = truncateText(toSingleLine(candidate), 36);
    if (cleaned && !isLowValueText(cleaned)) {
      return cleaned;
    }
  }
  return "";
}

function formatUnknownPersonLabel(personRef: string): string {
  return `待确认人物（ref: ${personRef}）`;
}

function isUserFacingTag(tag: string): boolean {
  const normalized = tag.trim();
  if (!normalized || SYSTEM_TAGS.has(normalized)) {
    return false;
  }
  return true;
}

function humanizeLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return PROJECT_LABEL_ALIASES[normalized] ?? value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function humanizeProjectHistoryLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return PROJECT_LABEL_ALIASES[normalized] ?? humanizeLabel(value);
}

const PROJECT_LABEL_ALIASES: Record<string, string> = {
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

function isLowValueText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return true;
  }
  return isLowSignalSemanticText(normalized) || /^unused$/i.test(normalized) || normalized === "暂无摘要";
}

function safeParseJson<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function toTimeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function startOfLocalDate(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

function extractSimpleQueryTerms(question: string | undefined): string[] {
  if (!question) {
    return [];
  }
  return Array.from(
    new Set(
      (question.match(/[\p{L}\p{N}\u4e00-\u9fff]{2,}/gu) ?? [])
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function combineFailureReasons(...reasons: Array<string | undefined>): string | undefined {
  const filtered = reasons.filter(Boolean);
  return filtered.length > 0 ? Array.from(new Set(filtered)).join("|") : undefined;
}

function inferBackfillSttProvider(
  analysisProvider: string | undefined,
): ClawSenseCaptureEvent["sttProvider"] | undefined {
  if (!analysisProvider) {
    return undefined;
  }
  if (analysisProvider.startsWith("openai-stt:")) {
    return "openai-fallback";
  }
  if (analysisProvider.includes("-stt:")) {
    return "compatible-fallback";
  }
  return undefined;
}

function countKeywordHits(text: string, keywords: string[]): number {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

function scoreAudioBackfillCandidate(params: {
  event: ClawSenseCaptureEvent;
  artifact: ClawSenseArtifactRecord;
  window?: ReviewWindow;
  now: number;
}): number {
  const sessionHint = parseClawSenseAudioSessionHint(params.event.note);
  const voicedRatio =
    sessionHint?.clipMs && sessionHint?.voicedMs
      ? Math.min(1, sessionHint.voicedMs / Math.max(sessionHint.clipMs, 1))
      : 0;
  const sizePenalty =
    params.artifact.sizeBytes <= AUDIO_BACKFILL_MAX_ARTIFACT_BYTES
      ? 0
      : Math.ceil((params.artifact.sizeBytes - AUDIO_BACKFILL_MAX_ARTIFACT_BYTES) / (128 * 1024)) * 12;
  const recencyHours = Math.max(0, (params.now - params.event.capturedAt) / (60 * 60 * 1000));
  const recencyBonus = Math.max(0, 12 - Math.floor(recencyHours));
  const visualBonus = Math.min(12, ((params.window?.imageCount ?? 0) + (params.window?.videoCount ?? 0)) * 3);
  const relationBonus = Math.min(
    10,
    ((params.window?.events.flatMap((event) => event.peopleRefs).length ?? 0) > 0 ? 4 : 0) +
      ((params.window?.events.flatMap((event) => event.projectRefs).length ?? 0) > 0 ? 3 : 0) +
      ((params.window?.events.flatMap((event) => event.tags).length ?? 0) > 0 ? 3 : 0),
  );
  const contextualText = normalizeSemanticText([
    params.event.summary,
    params.window?.primarySummary ?? "",
    params.window?.transcriptText ?? "",
    ...(params.window?.events ?? [])
      .filter((event) => event.modality === "image" || event.modality === "video")
      .map((event) => event.summary),
    ...params.event.tags,
    ...params.event.projectRefs,
  ].join(" "));
  const scenarioBonus =
    countKeywordHits(contextualText.toLowerCase(), [
      "会议",
      "项目",
      "演示",
      "老板",
      "同事",
      "办公室",
      "课堂",
      "老师",
      "课程",
      "作业",
      "实验",
      "教室",
      "lecture",
      "meeting",
      "office",
      "class",
      "study",
    ]) * 4;
  const failureBonus = params.event.analysisFailureReason?.includes("runtime_stt_empty") ? 4 : 0;
  const attemptPenalty = (params.event.audioBackfillAttemptCount ?? 0) * 14;

  return Math.round(
    50 +
      voicedRatio * 18 +
      recencyBonus +
    visualBonus +
      relationBonus +
      scenarioBonus +
      failureBonus -
      sizePenalty -
      attemptPenalty,
  );
}

function shouldAttemptAudioBackfill(event: ClawSenseCaptureEvent, now: number): boolean {
  if (event.modality !== "audio") {
    return false;
  }
  if (normalizeSemanticText(event.transcript)) {
    return false;
  }
  if (event.analysisStatus !== "degraded") {
    return false;
  }
  if (
    typeof event.lastAudioBackfillAttemptAt === "number" &&
    now - event.lastAudioBackfillAttemptAt < AUDIO_BACKFILL_COOLDOWN_MS
  ) {
    return false;
  }
  return true;
}

function resolveMaintenanceBackfillBatchSize(pendingCandidates: number): number {
  if (pendingCandidates >= 30) {
    return 6;
  }
  if (pendingCandidates >= 12) {
    return 5;
  }
  if (pendingCandidates >= 6) {
    return 4;
  }
  return 3;
}

function pickBestAudioArtifact(
  artifacts: ClawSenseArtifactRecord[],
): ClawSenseArtifactRecord | undefined {
  return pickQueryTimeAudioArtifacts(artifacts, 1)[0];
}

function pickQueryTimeAudioArtifacts(
  artifacts: ClawSenseArtifactRecord[],
  maxArtifacts = MAX_QUERY_TIME_AUDIO_ARTIFACTS_PER_WINDOW,
): ClawSenseArtifactRecord[] {
  return artifacts
    .filter((artifact) => artifact.modality === "audio" && !artifact.deletedAt)
    .sort((left, right) => {
      const leftFits = left.sizeBytes <= MAX_QUERY_TIME_AUDIO_ARTIFACT_BYTES ? 0 : 1;
      const rightFits = right.sizeBytes <= MAX_QUERY_TIME_AUDIO_ARTIFACT_BYTES ? 0 : 1;
      return leftFits - rightFits || left.sizeBytes - right.sizeBytes || right.capturedAt - left.capturedAt;
    })
    .slice(0, Math.max(1, maxArtifacts));
}

function randomId(): string {
  return `review_${Math.random().toString(36).slice(2, 10)}`;
}

function buildAssistantContextSummary(
  scope: "last-hour" | "today" | "custom-range",
  date: string,
  windows: ReviewWindow[],
  range?: { startAt: number; endAt: number; recentActivity?: RecentActivitySnapshot },
): string {
  if (!windows.length) {
    const recentActivity = range?.recentActivity;
    if (recentActivity?.lastSeenAt) {
      const recentLabel = `${toLocalDateKey(recentActivity.lastSeenAt)} ${toTimeLabel(recentActivity.lastSeenAt)}`;
      const densityLabel =
        recentActivity.priorWindowCount > 0
          ? `过去 ${recentActivity.lookbackDays} 天内共出现 ${recentActivity.priorWindowCount} 个窗口（${recentActivity.priorEventCount} 条事件）`
          : `过去 ${recentActivity.lookbackDays} 天内有历史记录`;
      if (scope === "last-hour") {
        return `过去一小时还没有采集到可用于总结的 ClawSense 事件。最近一次有效记录在 ${recentLabel}；${densityLabel}。`;
      }
      if (scope === "custom-range" && range) {
        return `ClawSense 在 ${formatContextRange(range.startAt, range.endAt)} 还没有采集到可用于回顾的事件。最近一次有效记录在 ${recentLabel}；${densityLabel}。`;
      }
      return `ClawSense 在 ${date} 还没有采集到可用于回顾的事件。最近一次有效记录在 ${recentLabel}；${densityLabel}。`;
    }
    if (scope === "last-hour") {
      return "过去一小时还没有采集到可用于总结的 ClawSense 事件。";
    }
    if (scope === "custom-range" && range) {
      return `ClawSense 在 ${formatContextRange(range.startAt, range.endAt)} 还没有采集到可用于回顾的事件。`;
    }
    return `ClawSense 在 ${date} 还没有采集到可用于回顾的事件。`;
  }
  const focus = windows.slice().sort((left, right) => right.score - left.score)[0] ?? windows[0];
  const recentConversation = windows
    .filter((window) => window.audioCount > 0 || Boolean(window.transcriptText.trim()))
    .sort((left, right) => right.endedAt - left.endedAt)[0];
  const lead = (() => {
    if (scope === "last-hour") {
      return `过去一小时共整理出 ${windows.length} 个事件窗口，最值得先回看的是 ${toTimeLabel(focus.startedAt)} 左右的窗口：${focus.primarySummary}`;
    }
    if (scope === "custom-range" && range) {
      return `${formatContextRange(range.startAt, range.endAt)} 这段时间共整理出 ${windows.length} 个事件窗口，最值得先回看的是 ${toTimeLabel(focus.startedAt)} 左右的窗口：${focus.primarySummary}`;
    }
    return `今天目前共整理出 ${windows.length} 个事件窗口，最值得先回看的是 ${toTimeLabel(focus.startedAt)} 左右的窗口：${focus.primarySummary}`;
  })();
  if (!recentConversation?.transcriptText.trim()) {
    return lead;
  }
  return `${lead} 最近一段可读对话是：${truncateText(toSingleLine(recentConversation.transcriptText), 120)}`;
}

function formatContextRange(startAt: number, endAt: number): string {
  const startDate = toLocalDateKey(startAt);
  const endDate = toLocalDateKey(endAt);
  if (startDate === endDate) {
    return `${startDate} ${toTimeLabel(startAt)}-${toTimeLabel(endAt)}`;
  }
  return `${startDate} ${toTimeLabel(startAt)} - ${endDate} ${toTimeLabel(endAt)}`;
}

function buildArtifactPayload(
  artifact: ClawSenseArtifactRecord | undefined,
  artifactUrlBase: string,
):
  | {
      artifactId: string;
      fileName: string;
      mime?: string;
      available: boolean;
      sizeBytes: number;
      url: string;
    }
  | undefined {
  if (!artifact) {
    return undefined;
  }
  return {
    artifactId: artifact.artifactId,
    fileName: artifact.fileName,
    mime: artifact.mime,
    available: !artifact.deletedAt,
    sizeBytes: artifact.sizeBytes,
    url: `${artifactUrlBase}?id=${encodeURIComponent(artifact.artifactId)}`,
  };
}
