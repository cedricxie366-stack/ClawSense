import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Connection, Table } from "@lancedb/lancedb";
import type { ClawSenseConfig } from "./config.js";
import type { OpenClawConfig, PluginLogger } from "./openclaw-types.js";
import {
  resolveOpenAiClient,
  resolveOpenAiClientForProvider,
  resolvePrimaryMultimodalModel,
  transcribeAudioWithFallbackModel,
  understandAudioWithPrimaryModel,
} from "./openai-client.js";
import { transcribeAudioWithLocalAsr } from "./local-asr.js";
import type { AudioSpeakerTimelineSegment, AudioTranscriptSegment } from "./openai-client.js";
import type {
  ClawSenseArtifactRecord,
  ClawSenseCaptureEvent,
  ClawSenseDeviceRecord,
  ClawSenseIngestReceipt,
  ClawSenseStateStore,
} from "./state-store.js";
import {
  classifyVideoError,
  buildAudioDegradedSummary,
  buildImageDegradedSummary,
  buildVideoDegradedSummary,
  classifyRuntimeSttError,
  classifyVisionError,
  estimateAudioDurationMs,
  isLikelySensorMetricNote,
  isSupportedAudioMime,
  isSupportedImageMime,
  isSupportedVideoMime,
  isUsableAudioSemanticSummaryText,
  isUsableTranscriptText,
  isUsableVisualSummaryText,
  normalizeSemanticText,
  resolveArtifactMime,
  stripTrailingSlash,
  toSafeSlug,
} from "./utils.js";

type LanceRow = {
  id: string;
  namespace: string;
  deviceId: string;
  modality: "audio" | "image" | "video";
  summary: string;
  transcript: string;
  note: string;
  sourcePath: string;
  createdAt: number;
  vector: number[];
};

export type ClawSenseMemorySearchHit = {
  memoryId: string;
  eventId: string;
  score: number;
  namespace: string;
  deviceId: string;
  modality: "audio" | "image" | "video";
  summary: string;
  transcript?: string;
  note?: string;
  createdAt: number;
};

type AudioAnalysisResult = {
  transcript: string;
  transcriptSegments?: AudioTranscriptSegment[];
  speakerTimelineSegments?: AudioSpeakerTimelineSegment[];
  summary?: string;
  analysisMode:
    | "runtime-stt"
    | "runtime-stt-fallback"
    | "openai-stt-fallback"
    | "local-asr"
    | "metadata-only";
  analysisProvider: string;
  analysisStatus: "succeeded" | "degraded";
  analysisFailureReason?: string;
  sttProvider?: "runtime" | "openai-fallback" | "compatible-fallback" | "local-asr";
};

type ImageAnalysisResult = {
  summary: string;
  analysisMode: "multimodal-preview" | "metadata-only";
  analysisProvider: string;
  analysisStatus: "succeeded" | "degraded";
  analysisFailureReason?: string;
};

type VideoAnalysisResult = {
  summary: string;
  analysisMode: "multimodal-preview" | "metadata-only";
  analysisProvider: string;
  analysisStatus: "succeeded" | "degraded";
  analysisFailureReason?: string;
};

type AudioInputDiagnostics = {
  mime: string;
  durationMs?: number;
  tooShort: boolean;
  unsupportedFormat: boolean;
  mimeMismatch: boolean;
};

type ImageInputDiagnostics = {
  mime: string;
  unsupportedFormat: boolean;
  mimeMismatch: boolean;
};

type VideoInputDiagnostics = {
  mime: string;
  unsupportedFormat: boolean;
  mimeMismatch: boolean;
};

type ClawSenseAnalysisCallbacks = {
  describeImage: (args: {
    buffer: Buffer;
    fileName: string;
    mime?: string;
  }) => Promise<{ text: string; analysisProvider?: string; analysisFailureReason?: string }>;
  describeVideo?: (args: {
    buffer: Buffer;
    fileName: string;
    mime?: string;
  }) => Promise<{ text: string; analysisProvider?: string; analysisFailureReason?: string }>;
  transcribeAudio: (args: { filePath: string; mime?: string }) => Promise<{ text?: string }>;
};

type StoredCaptureAnalysis = {
  summary: string;
  transcript?: string;
  transcriptSegments?: AudioTranscriptSegment[];
  speakerTimelineSegments?: AudioSpeakerTimelineSegment[];
  analysisMode: ClawSenseCaptureEvent["analysisMode"];
  analysisProvider?: ClawSenseCaptureEvent["analysisProvider"];
  analysisStatus?: ClawSenseCaptureEvent["analysisStatus"];
  analysisFailureReason?: ClawSenseCaptureEvent["analysisFailureReason"];
  sttProvider?: ClawSenseCaptureEvent["sttProvider"];
};

const TABLE_NAME = "memories";
const MIN_SPEECH_CLIP_DURATION_MS = 1_200;
const NEVER_EXPIRE_TIMESTAMP = 253402300799000;

export class ClawSenseMemoryStore {
  private db: Connection | null = null;
  private table: Table | null = null;
  private initPromise: Promise<void> | null = null;
  private journalOnlyMode = false;
  private readonly cfg: ClawSenseConfig;
  private readonly runtimeConfig: OpenClawConfig;
  private readonly logger: PluginLogger;
  private readonly stateStore: ClawSenseStateStore;
  private readonly resolveStateDir: () => string;
  private readonly openai;
  private readonly providerOpenAiClients = new Map<string, ReturnType<typeof resolveOpenAiClient>>();
  private warnedMultimodalEmbeddingFallback = false;
  private warnedEmbeddingRequestFallback = false;

  constructor(params: {
    cfg: ClawSenseConfig;
    runtimeConfig: OpenClawConfig;
    logger: PluginLogger;
    stateStore: ClawSenseStateStore;
    resolveStateDir: () => string;
  }) {
    this.cfg = params.cfg;
    this.runtimeConfig = params.runtimeConfig;
    this.logger = params.logger;
    this.stateStore = params.stateStore;
    this.resolveStateDir = params.resolveStateDir;
    this.openai = resolveOpenAiClient(params.cfg, params.runtimeConfig);
  }

  async ingest(params: {
    device: ClawSenseDeviceRecord;
    modality: "audio" | "image" | "video";
    body: Buffer;
    fileName: string;
    mime?: string;
    capturedAt?: number;
    note?: string;
    describeImage: ClawSenseAnalysisCallbacks["describeImage"];
    describeVideo?: ClawSenseAnalysisCallbacks["describeVideo"];
    transcribeAudio: ClawSenseAnalysisCallbacks["transcribeAudio"];
  }): Promise<ClawSenseIngestReceipt> {
    const createdAt = params.capturedAt ?? Date.now();
    const mediaInput = resolveArtifactMime({
      body: params.body,
      fileName: params.fileName,
      mime: params.mime,
      modality: params.modality,
    });
    const audioInput =
      params.modality === "audio"
        ? buildAudioInputDiagnostics(params.body, mediaInput.mime, mediaInput.mismatch)
        : null;
    const imageInput =
      params.modality === "image"
        ? buildImageInputDiagnostics(mediaInput.mime, mediaInput.mismatch)
        : null;
    const videoInput =
      params.modality === "video"
        ? buildVideoInputDiagnostics(mediaInput.mime, mediaInput.mismatch)
        : null;
    const stored = await this.writeBinaryArtifact({
      body: params.body,
      fileName: params.fileName,
      capturedAt: createdAt,
      modality: params.modality,
      device: params.device,
    });

    try {
      const analysis = await this.analyzeStoredCapture({
        modality: params.modality,
        body: params.body,
        fileName: stored.fileName,
        requestedFileName: params.fileName,
        absolutePath: stored.absolutePath,
        mime: mediaInput.mime,
        audioInput,
        imageInput,
        videoInput,
        note: params.note,
        describeImage: params.describeImage,
        describeVideo: params.describeVideo,
        transcribeAudio: params.transcribeAudio,
      });

      const embeddingText = [
        `source=${this.cfg.memoryNamespace}`,
        `device=${params.device.deviceId}`,
        `modality=${params.modality}`,
        analysis.summary,
        analysis.transcript ?? "",
        params.note ?? "",
      ]
        .filter(Boolean)
        .join("\n");

      const memoryId = randomUUID();
      const retrievalEmbeddingsEnabled = this.resolveEffectiveEmbeddingBackend() !== "none";
      let embeddingModel: string | undefined;
      if (retrievalEmbeddingsEnabled && !this.journalOnlyMode) {
        try {
          await this.ensureTable();
          if (this.table) {
            const row: LanceRow = {
              id: memoryId,
              namespace: this.cfg.memoryNamespace,
              deviceId: params.device.deviceId,
              modality: params.modality,
              summary: analysis.summary,
              transcript: analysis.transcript ?? "",
              note: params.note ?? "",
              sourcePath: stored.absolutePath,
              createdAt,
              vector: await this.embed(embeddingText),
            };
            await this.table.add([row]);
            embeddingModel = this.cfg.embeddingModel;
          }
        } catch (error) {
          this.enableJournalOnlyMode(error);
        }
      }

      const { artifact, event } = await this.stateStore.recordCapture({
        memoryId,
        namespace: this.cfg.memoryNamespace,
        deviceId: params.device.deviceId,
        modality: params.modality,
        summary: analysis.summary,
        transcript: analysis.transcript || undefined,
        transcriptSegments: analysis.transcriptSegments,
        speakerTimelineSegments: analysis.speakerTimelineSegments,
        note: params.note || undefined,
        createdAt,
        capturedAt: createdAt,
        sourcePath: stored.absolutePath,
        fileName: stored.fileName,
        mime: mediaInput.mime,
        sizeBytes: params.body.length,
        storageRelPath: stored.relativePath,
        retentionExpiresAt: resolveRetentionExpiresAt(createdAt, this.cfg.artifactRetentionDays),
        embeddingModel,
        analysisMode: analysis.analysisMode,
        analysisProvider: analysis.analysisProvider,
        analysisStatus: analysis.analysisStatus,
        analysisFailureReason: analysis.analysisFailureReason,
        sttProvider: analysis.sttProvider,
      });

      await this.pruneExpiredArtifacts();
      await this.enforceArtifactBudget();

      return {
        memoryId,
        deviceId: params.device.deviceId,
        modality: params.modality,
        summary: analysis.summary,
        transcript: analysis.transcript || undefined,
        transcriptSegments: analysis.transcriptSegments,
        speakerTimelineSegments: analysis.speakerTimelineSegments,
        createdAt,
        storedAt: stored.absolutePath,
        namespace: this.cfg.memoryNamespace,
        windowId: event.windowId,
        artifactId: artifact.artifactId,
        analysisMode: event.analysisMode,
      };
    } catch (error) {
      await fs.unlink(stored.absolutePath).catch(() => {});
      throw error;
    }
  }

  async ingestPending(params: {
    device: ClawSenseDeviceRecord;
    modality: "audio" | "image" | "video";
    body: Buffer;
    fileName: string;
    mime?: string;
    capturedAt?: number;
    note?: string;
  }): Promise<ClawSenseIngestReceipt> {
    const createdAt = params.capturedAt ?? Date.now();
    const mediaInput = resolveArtifactMime({
      body: params.body,
      fileName: params.fileName,
      mime: params.mime,
      modality: params.modality,
    });
    const stored = await this.writeBinaryArtifact({
      body: params.body,
      fileName: params.fileName,
      capturedAt: createdAt,
      modality: params.modality,
      device: params.device,
    });
    const memoryId = randomUUID();
    const summary = buildPendingSummary(params.modality, params.note);
    const { artifact, event } = await this.stateStore.recordCapture({
      memoryId,
      namespace: this.cfg.memoryNamespace,
      deviceId: params.device.deviceId,
      modality: params.modality,
      summary,
      note: params.note || undefined,
      createdAt,
      capturedAt: createdAt,
      sourcePath: stored.absolutePath,
      fileName: stored.fileName,
      mime: mediaInput.mime,
      sizeBytes: params.body.length,
      storageRelPath: stored.relativePath,
      retentionExpiresAt: resolveRetentionExpiresAt(createdAt, this.cfg.artifactRetentionDays),
      analysisMode: "metadata-only",
      analysisProvider: "analysis-queue",
      analysisStatus: "degraded",
      analysisFailureReason: "analysis_pending",
    });

    await this.pruneExpiredArtifacts();
    await this.enforceArtifactBudget();

    return {
      memoryId,
      deviceId: params.device.deviceId,
      modality: params.modality,
      summary,
      createdAt,
      storedAt: stored.absolutePath,
      namespace: this.cfg.memoryNamespace,
      windowId: event.windowId,
      artifactId: artifact.artifactId,
      analysisMode: event.analysisMode,
    };
  }

  async analyzeCaptureArtifact(params: {
    artifactId: string;
    describeImage: ClawSenseAnalysisCallbacks["describeImage"];
    describeVideo?: ClawSenseAnalysisCallbacks["describeVideo"];
    transcribeAudio: ClawSenseAnalysisCallbacks["transcribeAudio"];
  }): Promise<{ updated: boolean; event: ClawSenseCaptureEvent | null }> {
    const artifact = await this.stateStore.getArtifact(params.artifactId);
    if (!artifact || artifact.deletedAt) {
      return { updated: false, event: null };
    }
    const event = (await this.stateStore.listEvents()).find((item) => item.artifactId === artifact.artifactId);
    if (!event) {
      return { updated: false, event: null };
    }
    const body = await fs.readFile(artifact.storagePath);
    const mediaInput = resolveArtifactMime({
      body,
      fileName: artifact.fileName,
      mime: artifact.mime,
      modality: artifact.modality,
    });
    const audioInput =
      artifact.modality === "audio"
        ? buildAudioInputDiagnostics(body, mediaInput.mime, mediaInput.mismatch)
        : null;
    const imageInput =
      artifact.modality === "image"
        ? buildImageInputDiagnostics(mediaInput.mime, mediaInput.mismatch)
        : null;
    const videoInput =
      artifact.modality === "video"
        ? buildVideoInputDiagnostics(mediaInput.mime, mediaInput.mismatch)
        : null;
    const analysis = await this.analyzeStoredCapture({
      modality: artifact.modality,
      body,
      fileName: artifact.fileName,
      requestedFileName: artifact.fileName,
      absolutePath: artifact.storagePath,
      mime: mediaInput.mime,
      audioInput,
      imageInput,
      videoInput,
      note: event.note,
      describeImage: params.describeImage,
      describeVideo: params.describeVideo,
      transcribeAudio: params.transcribeAudio,
    });

    return await this.stateStore.backfillCaptureAnalysis({
      artifactId: artifact.artifactId,
      summary: analysis.summary,
      transcript: analysis.transcript,
      transcriptSegments: analysis.transcriptSegments,
      speakerTimelineSegments: analysis.speakerTimelineSegments,
      analysisMode: analysis.analysisMode,
      analysisProvider: analysis.analysisProvider,
      analysisStatus: analysis.analysisStatus,
      analysisFailureReason: analysis.analysisFailureReason,
      sttProvider: analysis.sttProvider,
    });
  }

  async searchRelevantMemories(params: {
    question: string;
    startAt?: number;
    endAt?: number;
    deviceId?: string;
    modality?: "audio" | "image" | "video";
    limit?: number;
  }): Promise<ClawSenseMemorySearchHit[]> {
    const question = normalizeSemanticText(params.question);
    if (!question || this.journalOnlyMode || this.resolveEffectiveEmbeddingBackend() === "none") {
      return [];
    }

    const limit = Math.max(1, Math.min(params.limit ?? 12, 32));
    const scanLimit = Math.max(limit * 4, 16);
    const startAt = Number.isFinite(params.startAt) ? Number(params.startAt) : undefined;
    const endAt = Number.isFinite(params.endAt) ? Number(params.endAt) : undefined;

    try {
      await this.ensureTable();
    } catch (error) {
      this.logger.warn(`[clawsense] semantic memory search unavailable during table init: ${String(error)}`);
      return [];
    }
    if (!this.table) {
      return [];
    }

    let queryVector: number[];
    try {
      queryVector = await this.embed(question);
    } catch (error) {
      this.logger.warn(`[clawsense] semantic memory search failed to compute embedding: ${String(error)}`);
      return [];
    }

    const rows = await this.runVectorSearchRows(queryVector, scanLimit);
    if (rows.length === 0) {
      return [];
    }

    const normalized = rows
      .map((row) => normalizeSearchRow(row))
      .filter((row): row is NormalizedMemorySearchRow => Boolean(row))
      .filter((row) => row.namespace === this.cfg.memoryNamespace)
      .filter((row) => (params.deviceId ? row.deviceId === params.deviceId : true))
      .filter((row) => {
        if (!params.modality) {
          return true;
        }
        if (params.modality === "video") {
          return row.modality === "video" || isVideoKeyframeSearchRow(row);
        }
        return row.modality === params.modality;
      })
      .filter((row) => (typeof startAt === "number" ? row.createdAt >= startAt : true))
      .filter((row) => (typeof endAt === "number" ? row.createdAt <= endAt : true))
      .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt);

    const deduped = new Map<string, NormalizedMemorySearchRow>();
    for (const item of normalized) {
      if (!deduped.has(item.memoryId)) {
        deduped.set(item.memoryId, item);
      }
      if (deduped.size >= limit) {
        break;
      }
    }

    return Array.from(deduped.values()).map((item) => ({
      memoryId: item.memoryId,
      eventId: item.memoryId,
      score: item.score,
      namespace: item.namespace,
      deviceId: item.deviceId,
      modality: item.modality,
      summary: item.summary,
      transcript: item.transcript || undefined,
      note: item.note || undefined,
      createdAt: item.createdAt,
    }));
  }

  async pruneExpiredArtifacts(now = Date.now()): Promise<void> {
    const expired = await this.stateStore.pruneExpiredArtifacts(now);
    for (const artifact of expired) {
      if (!artifact.deletedAt || !artifact.storagePath) {
        continue;
      }
      await fs.unlink(artifact.storagePath).catch(() => {});
    }
    await this.enforceArtifactBudget(now);
  }

  private async writeBinaryArtifact(params: {
    body: Buffer;
    fileName: string;
    capturedAt: number;
    modality: "audio" | "image" | "video";
    device: ClawSenseDeviceRecord;
  }): Promise<{ absolutePath: string; relativePath: string; fileName: string }> {
    const root = this.resolveMediaRoot();
    const captured = new Date(params.capturedAt);
    const year = String(captured.getFullYear());
    const month = String(captured.getMonth() + 1).padStart(2, "0");
    const day = String(captured.getDate()).padStart(2, "0");
    const hh = String(captured.getHours()).padStart(2, "0");
    const mm = String(captured.getMinutes()).padStart(2, "0");
    const ss = String(captured.getSeconds()).padStart(2, "0");
    const safeFileName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const extension = path.extname(safeFileName) ||
      (params.modality === "audio" ? ".wav" : params.modality === "video" ? ".mp4" : ".jpg");
    const basename = `${hh}${mm}${ss}-${params.modality}-${randomUUID()}${extension}`;
    const deviceAlias = toSafeSlug(params.device.name) || params.device.deviceId.slice(0, 8);
    const relativePath = path.join(year, month, day, deviceAlias, basename);
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, params.body);
    return {
      absolutePath,
      relativePath: stripTrailingSlash(relativePath.replace(/\\/g, "/")),
      fileName: basename,
    };
  }

  private resolveMediaRoot(): string {
    return this.cfg.mediaRoot?.trim()
      ? path.resolve(this.cfg.mediaRoot)
      : path.join(this.resolveStateDir(), "plugins", "clawsense", "media");
  }

  private async enforceArtifactBudget(now = Date.now()): Promise<void> {
    if (this.cfg.maxArtifactBytes <= 0) {
      return;
    }
    const artifacts = (await this.stateStore.listArtifacts())
      .filter((artifact) => !artifact.deletedAt)
      .sort((left, right) => left.createdAt - right.createdAt);
    let totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    if (totalBytes <= this.cfg.maxArtifactBytes) {
      return;
    }

    const toDelete: ClawSenseArtifactRecord[] = [];
    for (const artifact of artifacts) {
      if (totalBytes <= this.cfg.maxArtifactBytes) {
        break;
      }
      toDelete.push(artifact);
      totalBytes -= artifact.sizeBytes;
    }
    if (toDelete.length === 0) {
      return;
    }

    const deleted = await this.stateStore.markArtifactsDeleted(
      toDelete.map((artifact) => artifact.artifactId),
      now,
    );
    for (const artifact of deleted) {
      if (!artifact.storagePath) {
        continue;
      }
      await fs.unlink(artifact.storagePath).catch(() => {});
    }
    this.logger.info(
      `[clawsense] artifact budget exceeded; pruned ${deleted.length} oldest raw artifact(s) to stay under ${this.cfg.maxArtifactBytes} bytes`,
    );
  }

  private async ensureTable(): Promise<void> {
    if (this.journalOnlyMode) {
      return;
    }
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const lancedb = await import("@lancedb/lancedb");
    const dbPath =
      this.cfg.memoryDbPath ??
      path.join(os.homedir(), ".openclaw", "memory", "clawsense-lancedb");
    this.db = await lancedb.connect(dbPath);
    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      return;
    }

    const vectorSize = this.cfg.embeddingDimensions ?? 1536;
    this.table = await this.db.createTable(TABLE_NAME, [
      {
        id: "__schema__",
        namespace: this.cfg.memoryNamespace,
        deviceId: "",
        modality: "audio",
        summary: "",
        transcript: "",
        note: "",
        sourcePath: "",
        createdAt: 0,
        vector: Array.from({ length: vectorSize }, () => 0),
      },
    ]);
    await this.table.delete('id = "__schema__"');
    this.logger.info(`[clawsense] memory table initialized at ${dbPath}`);
  }

  private async embed(input: string): Promise<number[]> {
    if (!this.openai) {
      this.logger.warn(
        "[clawsense] OpenAI embedding client unavailable; using deterministic fallback vectors",
      );
      return fallbackEmbed(input, this.cfg.embeddingDimensions ?? 1536);
    }
    const response = await this.openai.embeddings.create({
      model: this.cfg.embeddingModel,
      input,
      dimensions: this.cfg.embeddingDimensions,
    }).catch((error) => {
      if (!this.warnedEmbeddingRequestFallback) {
        this.warnedEmbeddingRequestFallback = true;
        this.logger.warn(
          "[clawsense] embedding request failed; using deterministic fallback vectors. Configure embeddingModel or set retrievalEmbeddingBackend=none to silence semantic recall fallback.",
        );
      }
      return undefined;
    });
    return response?.data[0]?.embedding ?? fallbackEmbed(input, this.cfg.embeddingDimensions ?? 1536);
  }

  private resolveEffectiveEmbeddingBackend(): "none" | "text" {
    if (this.cfg.retrievalEmbeddingBackend === "none") {
      return "none";
    }
    if (this.cfg.retrievalEmbeddingBackend === "multimodal") {
      if (!this.warnedMultimodalEmbeddingFallback) {
        this.warnedMultimodalEmbeddingFallback = true;
        this.logger.warn(
          "[clawsense] retrievalEmbeddingBackend=multimodal is not native yet; falling back to text embeddings for this build",
        );
      }
      return "text";
    }
    return "text";
  }

  private async runVectorSearchRows(vector: number[], limit: number): Promise<Array<Record<string, unknown>>> {
    if (!this.table) {
      return [];
    }
    const table = this.table as unknown as {
      search?: (query: number[]) => unknown;
    };
    if (typeof table.search !== "function") {
      return [];
    }

    try {
      const query = table.search(vector);
      const limited = applySearchLimit(query, limit);
      const rows = await resolveSearchRows(limited);
      return rows;
    } catch (error) {
      this.logger.warn(`[clawsense] semantic memory search execution failed: ${String(error)}`);
      return [];
    }
  }

  private async safeTranscribeAudio(params: {
    filePath: string;
    fileName: string;
    body: Buffer;
    input: AudioInputDiagnostics;
    transcribeAudio: (args: { filePath: string; mime?: string }) => Promise<{ text?: string }>;
  }): Promise<AudioAnalysisResult> {
    let failureReason = params.input.mimeMismatch ? "audio_mime_mismatch" : undefined;
    if (params.input.unsupportedFormat) {
      return degradedAudioAnalysisResult(
        combineFailureReasons(failureReason, "audio_format_unsupported"),
        "metadata-only",
        "metadata-only",
      );
    }
    if (params.input.tooShort) {
      return degradedAudioAnalysisResult(
        combineFailureReasons(failureReason, "audio_clip_too_short"),
        "metadata-only",
        "metadata-only",
      );
    }

    const primaryProviderId = resolvePrimaryMultimodalModel(this.cfg, this.runtimeConfig).providerId;
    const fallbackSttModel = this.cfg.sttFallbackModel.trim();
    const fallbackSttProviderId =
      fallbackSttModel.toLowerCase() === "whisper-1"
        ? "openai"
        : primaryProviderId ?? this.cfg.visionProvider;

    const attemptAsrFallback = async (attempt: {
      failureReason?: string;
      providerChainPrefix: string;
    }): Promise<{
      result?: AudioAnalysisResult;
      failureReason?: string;
      provider?: string;
    }> => {
      const asrAttempt = await transcribeAudioWithFallbackModel({
        cfg: this.cfg,
        runtimeConfig: this.runtimeConfig,
        body: params.body,
        fileName: path.basename(params.filePath),
        mime: params.input.mime,
        providerId: fallbackSttProviderId,
        openai: this.resolveMultimodalClient(fallbackSttProviderId),
      });
      const text = normalizeSemanticText(asrAttempt.transcript);
      if (isUsableTranscriptText(text)) {
        return {
          result: {
            transcript: text,
            analysisMode: "openai-stt-fallback",
            analysisProvider: `${attempt.providerChainPrefix}+${asrAttempt.analysisProvider}`,
            analysisStatus: "succeeded",
            analysisFailureReason: attempt.failureReason,
            sttProvider: asrAttempt.analysisProvider.startsWith("openai-stt:")
              ? "openai-fallback"
              : "compatible-fallback",
          },
          failureReason: attempt.failureReason,
          provider: asrAttempt.analysisProvider,
        };
      }
      return {
        failureReason: combineFailureReasons(attempt.failureReason, asrAttempt.analysisFailureReason),
        provider: asrAttempt.analysisProvider,
      };
    };

    const attemptLocalAsr = async (attempt: {
      failureReason?: string;
      providerChainPrefix: string;
    }): Promise<{
      result?: AudioAnalysisResult;
      failureReason?: string;
      provider?: string;
    }> => {
      const localAttempt = await transcribeAudioWithLocalAsr({
        cfg: this.cfg,
        filePath: params.filePath,
        resolveStateDir: this.resolveStateDir,
        logger: this.logger,
      });
      if (localAttempt.analysisFailureReason === "query_time_local_asr_disabled") {
        return {
          failureReason: attempt.failureReason,
        };
      }
      const text = normalizeSemanticText(localAttempt.transcript);
      if (isUsableTranscriptText(text)) {
        return {
          result: {
            transcript: text,
            transcriptSegments: localAttempt.transcriptSegments,
            speakerTimelineSegments: localAttempt.speakerTimelineSegments,
            analysisMode: "local-asr",
            analysisProvider: `${attempt.providerChainPrefix}+${localAttempt.analysisProvider}`,
            analysisStatus: "succeeded",
            analysisFailureReason: attempt.failureReason,
            sttProvider: "local-asr",
          },
          failureReason: attempt.failureReason,
          provider: localAttempt.analysisProvider,
        };
      }
      return {
        failureReason: combineFailureReasons(attempt.failureReason, localAttempt.analysisFailureReason),
        provider: localAttempt.analysisProvider,
      };
    };

    const attemptMultimodalFallback = async (attempt: {
      failureReason?: string;
      providerChainPrefix: string;
    }): Promise<{
      result?: AudioAnalysisResult;
      failureReason?: string;
      provider?: string;
    }> => {
      const multimodalAttempt = await understandAudioWithPrimaryModel({
        primaryOpenai: this.resolveMultimodalClient(primaryProviderId),
        fallbackOpenai: this.resolveMultimodalClient(this.cfg.visionProvider),
        cfg: this.cfg,
        runtimeConfig: this.runtimeConfig,
        body: params.body,
        fileName: params.fileName,
        mime: params.input.mime,
      });
      const semanticSummary = normalizeSemanticText(multimodalAttempt.summary);
      const multimodalTranscript = normalizeSemanticText(multimodalAttempt.transcript);
      if (multimodalTranscript || isUsableAudioSemanticSummaryText(semanticSummary)) {
        return {
          result: {
            transcript: multimodalTranscript,
            summary: isUsableAudioSemanticSummaryText(semanticSummary) ? semanticSummary : undefined,
            analysisMode: "runtime-stt-fallback",
            analysisProvider: `${attempt.providerChainPrefix}${multimodalAttempt.analysisProvider}`,
            analysisStatus: "succeeded",
            analysisFailureReason: attempt.failureReason,
          },
          failureReason: attempt.failureReason,
          provider: multimodalAttempt.analysisProvider,
        };
      }
      return {
        failureReason: combineFailureReasons(attempt.failureReason, multimodalAttempt.analysisFailureReason),
        provider: multimodalAttempt.analysisProvider,
      };
    };

    let runtimeFailureReason: string | undefined = failureReason;
    try {
      const response = await params.transcribeAudio({
        filePath: params.filePath,
        mime: params.input.mime,
      });
      const text = normalizeSemanticText(response.text);
      if (isUsableTranscriptText(text)) {
        return {
          transcript: text,
          analysisMode: "runtime-stt",
          analysisProvider: "runtime",
          analysisStatus: "succeeded",
          sttProvider: "runtime",
        };
      }
      runtimeFailureReason = combineFailureReasons(
        runtimeFailureReason,
        text ? "runtime_stt_low_signal" : "runtime_stt_empty",
      );
      this.logger.warn(
        `[clawsense] runtime STT produced ${text ? "low-signal" : "empty"} transcript; trying local ASR before host-model fallbacks`,
      );
    } catch (error) {
      runtimeFailureReason = combineFailureReasons(runtimeFailureReason, classifyRuntimeSttError(error));
      this.logger.warn(`[clawsense] runtime STT failed; trying local ASR before host-model fallbacks: ${String(error)}`);
    }

    const localAfterRuntime = await attemptLocalAsr({
      failureReason: runtimeFailureReason,
      providerChainPrefix: "runtime",
    });
    if (localAfterRuntime.result) {
      return localAfterRuntime.result;
    }
    runtimeFailureReason = localAfterRuntime.failureReason;

    if (this.cfg.hostModelAudioMode === "asr-first") {
      this.logger.warn("[clawsense] hostModelAudioMode=asr-first, trying compatible ASR before multimodal audio understanding");
      const asrFirst = await attemptAsrFallback({
        failureReason: runtimeFailureReason,
        providerChainPrefix: "runtime",
      });
      if (asrFirst.result) {
        return asrFirst.result;
      }
      const multimodalAfterAsr = await attemptMultimodalFallback({
        failureReason: asrFirst.failureReason,
        providerChainPrefix: "runtime+",
      });
      if (multimodalAfterAsr.result) {
        return multimodalAfterAsr.result;
      }
      return degradedAudioAnalysisResult(
        multimodalAfterAsr.failureReason,
        `runtime+${asrFirst.provider ?? "asr-fallback"}+${multimodalAfterAsr.provider ?? "multimodal"}`,
        "runtime-stt-fallback",
      );
    }

    const multimodalFirst = await attemptMultimodalFallback({
      failureReason: runtimeFailureReason,
      providerChainPrefix: "runtime+",
    });
    if (multimodalFirst.result) {
      return multimodalFirst.result;
    }
    this.logger.warn(
      `[clawsense] primary multimodal audio understanding returned no reliable summary; trying compatible ASR fallback`,
    );
    const asrAfterMultimodal = await attemptAsrFallback({
      failureReason: multimodalFirst.failureReason,
      providerChainPrefix: `runtime+${multimodalFirst.provider ?? "primary-multimodal"}`,
    });
    if (asrAfterMultimodal.result) {
      return asrAfterMultimodal.result;
    }
    this.logger.warn(
      `[clawsense] compatible ASR fallback produced no reliable transcript (${asrAfterMultimodal.failureReason ?? "empty"}); storing degraded audio summary`,
    );
    return degradedAudioAnalysisResult(
      asrAfterMultimodal.failureReason,
      `runtime+${multimodalFirst.provider ?? "primary-multimodal"}+${asrAfterMultimodal.provider ?? "asr-fallback"}`,
      "runtime-stt-fallback",
    );
  }

  private async analyzeStoredCapture(params: {
    modality: "audio" | "image" | "video";
    body: Buffer;
    fileName: string;
    requestedFileName: string;
    absolutePath: string;
    mime: string;
    audioInput: AudioInputDiagnostics | null;
    imageInput: ImageInputDiagnostics | null;
    videoInput: VideoInputDiagnostics | null;
    note?: string;
    describeImage: ClawSenseAnalysisCallbacks["describeImage"];
    describeVideo?: ClawSenseAnalysisCallbacks["describeVideo"];
    transcribeAudio: ClawSenseAnalysisCallbacks["transcribeAudio"];
  }): Promise<StoredCaptureAnalysis> {
    const audioResult =
      params.modality === "audio"
        ? await this.safeTranscribeAudio({
            filePath: params.absolutePath,
            fileName: params.fileName,
            body: params.body,
            input: params.audioInput!,
            transcribeAudio: params.transcribeAudio,
          })
        : null;
    const imageResult =
      params.modality === "image"
        ? await this.safeDescribeImage({
            buffer: params.body,
            fileName: params.requestedFileName,
            input: params.imageInput!,
            note: params.note,
            describeImage: params.describeImage,
          })
        : null;
    const videoResult =
      params.modality === "video"
        ? await this.safeDescribeVideo({
            buffer: params.body,
            fileName: params.requestedFileName,
            input: params.videoInput!,
            note: params.note,
            describeVideo: params.describeVideo,
          })
        : null;

    if (params.modality === "audio") {
      return {
        summary: summarizeAudio({
          transcript: audioResult?.transcript ?? "",
          semanticSummary: audioResult?.summary,
          note: params.note,
          analysisFailureReason: audioResult?.analysisFailureReason,
        }),
        transcript: audioResult?.transcript || undefined,
        transcriptSegments: audioResult?.transcriptSegments,
        speakerTimelineSegments: audioResult?.speakerTimelineSegments,
        analysisMode: audioResult?.analysisMode ?? "metadata-only",
        analysisProvider: audioResult?.analysisProvider ?? "metadata-only",
        analysisStatus: audioResult?.analysisStatus ?? "degraded",
        analysisFailureReason: audioResult?.analysisFailureReason,
        sttProvider: audioResult?.sttProvider,
      };
    }
    if (params.modality === "image") {
      return {
        summary: imageResult?.summary ?? buildImageDegradedSummary(params.note, imageResult?.analysisFailureReason),
        analysisMode: imageResult?.analysisMode ?? "metadata-only",
        analysisProvider: imageResult?.analysisProvider ?? "metadata-only",
        analysisStatus: imageResult?.analysisStatus ?? "degraded",
        analysisFailureReason: imageResult?.analysisFailureReason,
      };
    }
    return {
      summary: videoResult?.summary ?? buildVideoDegradedSummary(params.note, videoResult?.analysisFailureReason),
      analysisMode: videoResult?.analysisMode ?? "metadata-only",
      analysisProvider: videoResult?.analysisProvider ?? "metadata-only",
      analysisStatus: videoResult?.analysisStatus ?? "degraded",
      analysisFailureReason: videoResult?.analysisFailureReason,
    };
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
    // Explicit provider lookups, including "openai", must resolve their own client/baseURL.
    const resolvedClient = resolveOpenAiClientForProvider(this.cfg, this.runtimeConfig, normalized);
    this.providerOpenAiClients.set(normalized, resolvedClient);
    return resolvedClient;
  }

  private async safeDescribeImage(params: {
    buffer: Buffer;
    fileName: string;
    input: ImageInputDiagnostics;
    note?: string;
    describeImage: (args: {
      buffer: Buffer;
      fileName: string;
      mime?: string;
    }) => Promise<{ text: string; analysisProvider?: string; analysisFailureReason?: string }>;
  }): Promise<ImageAnalysisResult> {
    const baseFailureReason = params.input.mimeMismatch ? "image_mime_mismatch" : undefined;
    if (params.input.unsupportedFormat) {
      return degradedImageAnalysisResult(
        params.note,
        combineFailureReasons(baseFailureReason, "image_format_unsupported"),
        "metadata-only",
      );
    }
    if (this.cfg.hostModelImageMode === "metadata-only") {
      return degradedImageAnalysisResult(
        params.note,
        combineFailureReasons(baseFailureReason, "image_analysis_disabled_by_mode"),
        "metadata-only",
      );
    }
    try {
      const response = await params.describeImage({
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.input.mime,
      });
      const text = normalizeSemanticText(response.text);
      if (isUsableVisualSummaryText(text)) {
        return {
          summary: text,
          analysisMode: "multimodal-preview",
          analysisProvider: response.analysisProvider ?? this.cfg.visionProvider,
          analysisStatus: "succeeded",
          analysisFailureReason: response.analysisFailureReason,
        };
      }
      this.logger.warn(
        `[clawsense] image description produced ${text ? "low-signal" : "empty"} output; storing degraded image summary`,
      );
      return degradedImageAnalysisResult(
        params.note,
        combineFailureReasons(
          baseFailureReason,
          response.analysisFailureReason,
          text ? "vision_summary_low_signal" : "vision_summary_empty",
        ),
        response.analysisProvider ?? this.cfg.visionProvider,
      );
    } catch (error) {
      this.logger.warn(`[clawsense] image description failed, storing fallback summary: ${String(error)}`);
      return degradedImageAnalysisResult(
        params.note,
        combineFailureReasons(baseFailureReason, classifyVisionError(error)),
        this.cfg.visionProvider,
      );
    }
  }

  private async safeDescribeVideo(params: {
    buffer: Buffer;
    fileName: string;
    input: VideoInputDiagnostics;
    note?: string;
    describeVideo?: (args: {
      buffer: Buffer;
      fileName: string;
      mime?: string;
    }) => Promise<{ text: string; analysisProvider?: string; analysisFailureReason?: string }>;
  }): Promise<VideoAnalysisResult> {
    const baseFailureReason = params.input.mimeMismatch ? "video_mime_mismatch" : undefined;
    if (params.input.unsupportedFormat) {
      return degradedVideoAnalysisResult(
        params.note,
        combineFailureReasons(baseFailureReason, "video_format_unsupported"),
        "video-metadata-only",
      );
    }
    if (this.cfg.hostModelVideoMode !== "direct") {
      return degradedVideoAnalysisResult(
        params.note,
        combineFailureReasons(baseFailureReason, "video_analysis_disabled_by_mode"),
        "video-metadata-only",
      );
    }
    if (!params.describeVideo) {
      return degradedVideoAnalysisResult(
        params.note,
        combineFailureReasons(baseFailureReason, "video_provider_unavailable"),
        "video-metadata-only",
      );
    }

    try {
      const response = await params.describeVideo({
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.input.mime,
      });
      const text = normalizeSemanticText(response.text);
      if (isUsableVisualSummaryText(text)) {
        return {
          summary: text,
          analysisMode: "multimodal-preview",
          analysisProvider: response.analysisProvider ?? this.cfg.visionProvider,
          analysisStatus: "succeeded",
          analysisFailureReason: response.analysisFailureReason,
        };
      }
      this.logger.warn(
        `[clawsense] video description produced ${text ? "low-signal" : "empty"} output; storing degraded video summary`,
      );
      return degradedVideoAnalysisResult(
        params.note,
        combineFailureReasons(
          baseFailureReason,
          response.analysisFailureReason,
          text ? "video_summary_low_signal" : "video_summary_empty",
        ),
        response.analysisProvider ?? this.cfg.visionProvider,
      );
    } catch (error) {
      this.logger.warn(`[clawsense] video description failed, storing fallback summary: ${String(error)}`);
      return degradedVideoAnalysisResult(
        params.note,
        combineFailureReasons(baseFailureReason, classifyVideoError(error)),
        this.cfg.visionProvider,
      );
    }
  }

  private enableJournalOnlyMode(error: unknown): void {
    if (!this.journalOnlyMode) {
      this.logger.warn(
        `[clawsense] LanceDB unavailable; falling back to journal-only memory storage: ${String(error)}`,
      );
    }
    this.journalOnlyMode = true;
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }
}

function isVideoKeyframeSearchRow(row: NormalizedMemorySearchRow): boolean {
  if (row.modality !== "image") {
    return false;
  }
  const note = row.note ?? "";
  return /\bvideoKeyframe=1\b/i.test(note) || /\bkeyframe=\d+\b/i.test(note);
}

function resolveRetentionExpiresAt(createdAt: number, retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return NEVER_EXPIRE_TIMESTAMP;
  }
  return createdAt + retentionDays * 24 * 60 * 60 * 1000;
}

function summarizeAudio(params: {
  transcript: string;
  semanticSummary?: string;
  note?: string;
  analysisFailureReason?: string;
}): string {
  const semanticSummary = normalizeSemanticText(params.semanticSummary);
  const trimmed = normalizeSemanticText(params.transcript);
  const cleanedNote = normalizeSemanticText(params.note);
  if (semanticSummary) {
    return cleanedNote && !isLikelySensorMetricNote(cleanedNote)
      ? `${semanticSummary}\n\nOperator note: ${cleanedNote}`
      : semanticSummary;
  }
  if (trimmed) {
    return cleanedNote && !isLikelySensorMetricNote(cleanedNote)
      ? `${trimmed}\n\nOperator note: ${cleanedNote}`
      : trimmed;
  }
  return buildAudioDegradedSummary(params.note, params.analysisFailureReason);
}

function buildPendingSummary(modality: "audio" | "image" | "video", note: string | undefined): string {
  const cleanedNote = normalizeSemanticText(note);
  const suffix = cleanedNote ? ` Sensor note: ${cleanedNote}.` : "";
  if (modality === "audio") {
    return `Audio captured; analysis is pending.${suffix}`;
  }
  if (modality === "image") {
    return `Image captured; visual analysis is pending.${suffix}`;
  }
  return `Video captured; analysis is pending.${suffix}`;
}

function degradedAudioAnalysisResult(
  analysisFailureReason: string | undefined,
  analysisProvider: string,
  analysisMode: AudioAnalysisResult["analysisMode"],
): AudioAnalysisResult {
  return {
    transcript: "",
    analysisMode,
    analysisProvider,
    analysisStatus: "degraded",
    analysisFailureReason,
  };
}

function degradedImageAnalysisResult(
  note: string | undefined,
  analysisFailureReason: string | undefined,
  analysisProvider: string,
): ImageAnalysisResult {
  return {
    summary: buildImageDegradedSummary(note, analysisFailureReason),
    analysisMode: "metadata-only",
    analysisProvider,
    analysisStatus: "degraded",
    analysisFailureReason,
  };
}

function degradedVideoAnalysisResult(
  note: string | undefined,
  analysisFailureReason: string | undefined,
  analysisProvider: string,
): VideoAnalysisResult {
  return {
    summary: buildVideoDegradedSummary(note, analysisFailureReason),
    analysisMode: "metadata-only",
    analysisProvider,
    analysisStatus: "degraded",
    analysisFailureReason,
  };
}

function combineFailureReasons(...reasons: Array<string | undefined>): string | undefined {
  const filtered = reasons.filter(Boolean);
  return filtered.length > 0 ? Array.from(new Set(filtered)).join("|") : undefined;
}

function buildAudioInputDiagnostics(
  body: Buffer,
  mime: string,
  mimeMismatch: boolean,
): AudioInputDiagnostics {
  const durationMs = estimateAudioDurationMs(body, mime);
  return {
    mime,
    durationMs,
    tooShort: typeof durationMs === "number" && durationMs < MIN_SPEECH_CLIP_DURATION_MS,
    unsupportedFormat: !isSupportedAudioMime(mime),
    mimeMismatch,
  };
}

function buildImageInputDiagnostics(mime: string, mimeMismatch: boolean): ImageInputDiagnostics {
  return {
    mime,
    unsupportedFormat: !isSupportedImageMime(mime),
    mimeMismatch,
  };
}

function buildVideoInputDiagnostics(mime: string, mimeMismatch: boolean): VideoInputDiagnostics {
  return {
    mime,
    unsupportedFormat: !isSupportedVideoMime(mime),
    mimeMismatch,
  };
}

function fallbackEmbed(input: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const normalized = input.trim() || "clawsense";
  for (let index = 0; index < dimensions; index += 1) {
    const digest = createHash("sha256")
      .update(normalized)
      .update(":")
      .update(String(index))
      .digest();
    const value = digest.readUInt32BE(0) / 0xffffffff;
    vector[index] = value * 2 - 1;
  }
  return vector;
}

type NormalizedMemorySearchRow = {
  memoryId: string;
  namespace: string;
  deviceId: string;
  modality: "audio" | "image" | "video";
  summary: string;
  transcript: string;
  note: string;
  createdAt: number;
  score: number;
};

function applySearchLimit(searchQuery: unknown, limit: number): unknown {
  const query = searchQuery as {
    limit?: (count: number) => unknown;
  };
  if (query && typeof query.limit === "function") {
    return query.limit(limit);
  }
  return searchQuery;
}

async function resolveSearchRows(searchQuery: unknown): Promise<Array<Record<string, unknown>>> {
  if (Array.isArray(searchQuery)) {
    return searchQuery as Array<Record<string, unknown>>;
  }
  if (!searchQuery || typeof searchQuery !== "object") {
    return [];
  }
  const query = searchQuery as {
    toArray?: () => Promise<unknown>;
    execute?: () => Promise<unknown>;
  };
  if (typeof query.toArray === "function") {
    const rows = await query.toArray();
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  }
  if (typeof query.execute === "function") {
    const rows = await query.execute();
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
  }
  return [];
}

function normalizeSearchRow(row: Record<string, unknown>): NormalizedMemorySearchRow | null {
  const memoryId = typeof row.id === "string" ? row.id : typeof row.memoryId === "string" ? row.memoryId : "";
  const namespace = typeof row.namespace === "string" ? row.namespace : "";
  const deviceId = typeof row.deviceId === "string" ? row.deviceId : "";
  const modality =
    row.modality === "audio" || row.modality === "image" || row.modality === "video"
      ? row.modality
      : undefined;
  const summary = typeof row.summary === "string" ? row.summary : "";
  const transcript = typeof row.transcript === "string" ? row.transcript : "";
  const note = typeof row.note === "string" ? row.note : "";
  const createdAt = Number(row.createdAt);
  if (!memoryId || !namespace || !deviceId || !modality || !Number.isFinite(createdAt)) {
    return null;
  }

  const rawScore = toFiniteNumber(row.score)
    ?? toFiniteNumber(row._score)
    ?? toFiniteNumber(row.relevance)
    ?? toFiniteNumber(row._relevance);
  const distance = toFiniteNumber(row.distance) ?? toFiniteNumber(row._distance);
  const derivedScore = typeof rawScore === "number"
    ? rawScore
    : typeof distance === "number"
      ? 1 / (1 + Math.max(distance, 0))
      : 0;

  return {
    memoryId,
    namespace,
    deviceId,
    modality,
    summary,
    transcript,
    note,
    createdAt,
    score: derivedScore,
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
