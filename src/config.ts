import { Type } from "@sinclair/typebox";

export const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const DEFAULT_GATEWAY_PORT = 3000;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
const DEFAULT_MEMORY_NAMESPACE = "clawsense";
const DEFAULT_VISION_PROVIDER = "openai";
const DEFAULT_VISION_MODEL = "gpt-4.1-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_RETRIEVAL_EMBEDDING_BACKEND = "text";
const DEFAULT_HOST_MODEL_VIDEO_MODE = "none";
const DEFAULT_HOST_MODEL_AUDIO_MODE = "balanced";
const DEFAULT_HOST_MODEL_IMAGE_MODE = "multimodal";
const DEFAULT_MAX_PENDING_TOKENS = 10;
const DEFAULT_ARTIFACT_RETENTION_DAYS = 7;
const DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_ANALYSIS_MODE = "multimodal-preferred";
const DEFAULT_STT_FALLBACK_MODEL = "whisper-1";
const DEFAULT_LOCAL_ASR_BACKEND = "none";
const DEFAULT_LOCAL_ASR_LANGUAGE = "zh";
const DEFAULT_LOCAL_ASR_NUM_THREADS = 2;
const DEFAULT_LOCAL_ASR_TIMEOUT_MS = 120_000;
const DEFAULT_ASSISTANT_QUERY_AUDIO_KEEP_COUNT = 10;
const DEFAULT_ASR_WORKER_ENABLED = false;
const DEFAULT_ASR_WORKER_INTERVAL_SECONDS = 15 * 60;
const DEFAULT_ASR_WORKER_BATCH_SIZE = 3;
const DEFAULT_ASR_WORKER_MAX_JOBS = 24;
const DEFAULT_ASR_WORKER_LOOKBACK_DAYS = 2;
const DEFAULT_ASR_WORKER_PROVIDER = "local-asr";
const DEFAULT_ASR_WORKER_INCLUDE_TRANSCRIBED = true;

export const clawsenseConfigSchema = Type.Object(
  {
    publicBaseUrl: Type.Optional(Type.String()),
    gatewayPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    openaiApiKey: Type.Optional(Type.String()),
    openaiBaseUrl: Type.Optional(Type.String()),
    visionProvider: Type.Optional(Type.String()),
    visionModel: Type.Optional(Type.String()),
    embeddingModel: Type.Optional(Type.String()),
    embeddingDimensions: Type.Optional(Type.Integer({ minimum: 1 })),
    retrievalEmbeddingBackend: Type.Optional(Type.String()),
    hostModelAudioMode: Type.Optional(Type.String()),
    hostModelImageMode: Type.Optional(Type.String()),
    hostModelVideoMode: Type.Optional(Type.String()),
    memoryDbPath: Type.Optional(Type.String()),
    memoryNamespace: Type.Optional(Type.String()),
    pairingTtlSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    maxPendingTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    heartbeatIntervalSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    artifactRetentionDays: Type.Optional(Type.Number({ minimum: 0 })),
    maxArtifactBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    mediaRoot: Type.Optional(Type.String()),
    analysisMode: Type.Optional(Type.String()),
    reviewModel: Type.Optional(Type.String()),
    sttFallbackModel: Type.Optional(Type.String()),
    localAsrBackend: Type.Optional(Type.String()),
    localAsrModelDir: Type.Optional(Type.String()),
    localAsrModelFile: Type.Optional(Type.String()),
    localAsrTokensFile: Type.Optional(Type.String()),
    localAsrLanguage: Type.Optional(Type.String()),
    localAsrNumThreads: Type.Optional(Type.Integer({ minimum: 1 })),
    localAsrTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    localAsrCommand: Type.Optional(Type.String()),
    localAsrWhisperCommand: Type.Optional(Type.String()),
    localAsrWhisperModel: Type.Optional(Type.String()),
    localAsrFunAsrCommand: Type.Optional(Type.String()),
    localAsrFunAsrModel: Type.Optional(Type.String()),
    assistantQueryAudioKeepCount: Type.Optional(Type.Integer({ minimum: 0 })),
    asrWorkerEnabled: Type.Optional(Type.Boolean()),
    asrWorkerIntervalSeconds: Type.Optional(Type.Integer({ minimum: 60 })),
    asrWorkerBatchSize: Type.Optional(Type.Integer({ minimum: 1 })),
    asrWorkerMaxJobs: Type.Optional(Type.Integer({ minimum: 1 })),
    asrWorkerLookbackDays: Type.Optional(Type.Integer({ minimum: 1 })),
    asrWorkerProvider: Type.Optional(Type.String()),
    asrWorkerIncludeTranscribed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type ClawSenseConfig = {
  publicBaseUrl?: string;
  gatewayPort: number;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  visionProvider: string;
  visionModel: string;
  embeddingModel: string;
  embeddingDimensions?: number;
  retrievalEmbeddingBackend: "none" | "text" | "multimodal";
  hostModelAudioMode: "balanced" | "asr-first";
  hostModelImageMode: "multimodal" | "metadata-only";
  hostModelVideoMode: "none" | "keyframes" | "direct";
  memoryDbPath?: string;
  memoryNamespace: string;
  pairingTtlSeconds: number;
  maxPendingTokens: number;
  heartbeatIntervalSeconds: number;
  artifactRetentionDays: number;
  maxArtifactBytes: number;
  mediaRoot?: string;
  analysisMode: string;
  reviewModel?: string;
  sttFallbackModel: string;
  localAsrBackend: "none" | "whisper" | "funasr" | "sherpa-onnx-sensevoice";
  localAsrModelDir?: string;
  localAsrModelFile?: string;
  localAsrTokensFile?: string;
  localAsrLanguage: string;
  localAsrNumThreads: number;
  localAsrTimeoutMs: number;
  localAsrCommand?: string;
  localAsrWhisperCommand?: string;
  localAsrWhisperModel?: string;
  localAsrFunAsrCommand?: string;
  localAsrFunAsrModel?: string;
  assistantQueryAudioKeepCount: number;
  asrWorkerEnabled: boolean;
  asrWorkerIntervalSeconds: number;
  asrWorkerBatchSize: number;
  asrWorkerMaxJobs: number;
  asrWorkerLookbackDays: number;
  asrWorkerProvider: "auto" | "local-asr" | "compatible-asr";
  asrWorkerIncludeTranscribed: boolean;
};

export function resolveClawSenseConfig(raw: Record<string, unknown> | undefined): ClawSenseConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  return {
    publicBaseUrl: readOptionalString(cfg.publicBaseUrl),
    gatewayPort: readOptionalInteger(cfg.gatewayPort, { min: 1, max: 65535 }) ?? DEFAULT_GATEWAY_PORT,
    openaiApiKey: readOptionalString(cfg.openaiApiKey),
    openaiBaseUrl: readOptionalString(cfg.openaiBaseUrl),
    visionProvider: readOptionalString(cfg.visionProvider) ?? DEFAULT_VISION_PROVIDER,
    visionModel: readOptionalString(cfg.visionModel) ?? DEFAULT_VISION_MODEL,
    embeddingModel: readOptionalString(cfg.embeddingModel) ?? DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: readOptionalInteger(cfg.embeddingDimensions, { min: 1 }) ?? DEFAULT_EMBEDDING_DIMENSIONS,
    retrievalEmbeddingBackend: normalizeRetrievalEmbeddingBackend(
      readOptionalString(cfg.retrievalEmbeddingBackend),
    ),
    hostModelAudioMode: normalizeHostModelAudioMode(readOptionalString(cfg.hostModelAudioMode)),
    hostModelImageMode: normalizeHostModelImageMode(readOptionalString(cfg.hostModelImageMode)),
    hostModelVideoMode: normalizeHostModelVideoMode(readOptionalString(cfg.hostModelVideoMode)),
    memoryDbPath: readOptionalString(cfg.memoryDbPath),
    memoryNamespace: readOptionalString(cfg.memoryNamespace) ?? DEFAULT_MEMORY_NAMESPACE,
    pairingTtlSeconds: readOptionalInteger(cfg.pairingTtlSeconds, { min: 1 }) ?? DEFAULT_PAIRING_TTL_SECONDS,
    maxPendingTokens: readOptionalInteger(cfg.maxPendingTokens, { min: 1 }) ?? DEFAULT_MAX_PENDING_TOKENS,
    heartbeatIntervalSeconds:
      readOptionalInteger(cfg.heartbeatIntervalSeconds, { min: 1 }) ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    artifactRetentionDays:
      readOptionalNumber(cfg.artifactRetentionDays, { min: 0 }) ?? DEFAULT_ARTIFACT_RETENTION_DAYS,
    maxArtifactBytes: readOptionalInteger(cfg.maxArtifactBytes, { min: 0 }) ?? DEFAULT_MAX_ARTIFACT_BYTES,
    mediaRoot: readOptionalString(cfg.mediaRoot),
    analysisMode: readOptionalString(cfg.analysisMode) ?? DEFAULT_ANALYSIS_MODE,
    reviewModel: readOptionalString(cfg.reviewModel),
    sttFallbackModel: readOptionalString(cfg.sttFallbackModel) ?? DEFAULT_STT_FALLBACK_MODEL,
    localAsrBackend: normalizeLocalAsrBackend(readOptionalString(cfg.localAsrBackend)),
    localAsrModelDir: readOptionalString(cfg.localAsrModelDir),
    localAsrModelFile: readOptionalString(cfg.localAsrModelFile),
    localAsrTokensFile: readOptionalString(cfg.localAsrTokensFile),
    localAsrLanguage: readOptionalString(cfg.localAsrLanguage) ?? DEFAULT_LOCAL_ASR_LANGUAGE,
    localAsrNumThreads:
      readOptionalInteger(cfg.localAsrNumThreads, { min: 1 }) ?? DEFAULT_LOCAL_ASR_NUM_THREADS,
    localAsrTimeoutMs:
      readOptionalInteger(cfg.localAsrTimeoutMs, { min: 1 }) ?? DEFAULT_LOCAL_ASR_TIMEOUT_MS,
    localAsrCommand: readOptionalString(cfg.localAsrCommand),
    localAsrWhisperCommand: readOptionalString(cfg.localAsrWhisperCommand),
    localAsrWhisperModel: readOptionalString(cfg.localAsrWhisperModel),
    localAsrFunAsrCommand: readOptionalString(cfg.localAsrFunAsrCommand),
    localAsrFunAsrModel: readOptionalString(cfg.localAsrFunAsrModel),
    assistantQueryAudioKeepCount:
      readOptionalInteger(cfg.assistantQueryAudioKeepCount, { min: 0 }) ??
      DEFAULT_ASSISTANT_QUERY_AUDIO_KEEP_COUNT,
    asrWorkerEnabled: typeof cfg.asrWorkerEnabled === "boolean"
      ? cfg.asrWorkerEnabled
      : DEFAULT_ASR_WORKER_ENABLED,
    asrWorkerIntervalSeconds:
      readOptionalInteger(cfg.asrWorkerIntervalSeconds, { min: 60 }) ??
      DEFAULT_ASR_WORKER_INTERVAL_SECONDS,
    asrWorkerBatchSize:
      readOptionalInteger(cfg.asrWorkerBatchSize, { min: 1 }) ??
      DEFAULT_ASR_WORKER_BATCH_SIZE,
    asrWorkerMaxJobs:
      readOptionalInteger(cfg.asrWorkerMaxJobs, { min: 1 }) ??
      DEFAULT_ASR_WORKER_MAX_JOBS,
    asrWorkerLookbackDays:
      readOptionalInteger(cfg.asrWorkerLookbackDays, { min: 1 }) ??
      DEFAULT_ASR_WORKER_LOOKBACK_DAYS,
    asrWorkerProvider: normalizeAsrWorkerProvider(readOptionalString(cfg.asrWorkerProvider)),
    asrWorkerIncludeTranscribed: typeof cfg.asrWorkerIncludeTranscribed === "boolean"
      ? cfg.asrWorkerIncludeTranscribed
      : DEFAULT_ASR_WORKER_INCLUDE_TRANSCRIBED,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(
  value: unknown,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (typeof bounds.min === "number" && value < bounds.min) {
    return undefined;
  }
  if (typeof bounds.max === "number" && value > bounds.max) {
    return undefined;
  }
  return value;
}

function readOptionalInteger(
  value: unknown,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const numberValue = readOptionalNumber(value, bounds);
  return typeof numberValue === "number" && Number.isInteger(numberValue) ? numberValue : undefined;
}

function normalizeRetrievalEmbeddingBackend(
  value?: string,
): ClawSenseConfig["retrievalEmbeddingBackend"] {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "none" || normalized === "multimodal") {
    return normalized;
  }
  return DEFAULT_RETRIEVAL_EMBEDDING_BACKEND;
}

function normalizeHostModelVideoMode(value?: string): ClawSenseConfig["hostModelVideoMode"] {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "keyframes" || normalized === "direct") {
    return normalized;
  }
  return DEFAULT_HOST_MODEL_VIDEO_MODE;
}

function normalizeHostModelAudioMode(value?: string): ClawSenseConfig["hostModelAudioMode"] {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "asr-first") {
    return normalized;
  }
  return DEFAULT_HOST_MODEL_AUDIO_MODE;
}

function normalizeHostModelImageMode(value?: string): ClawSenseConfig["hostModelImageMode"] {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "metadata-only") {
    return normalized;
  }
  return DEFAULT_HOST_MODEL_IMAGE_MODE;
}

function normalizeLocalAsrBackend(value?: string): ClawSenseConfig["localAsrBackend"] {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "whisper" || normalized === "faster-whisper" || normalized === "openai-whisper") {
    return "whisper";
  }
  if (normalized === "funasr" || normalized === "fun-asr" || normalized === "funasr-sensevoice") {
    return "funasr";
  }
  if (
    normalized === "sherpa-onnx-sensevoice" ||
    normalized === "sherpa-sensevoice" ||
    normalized === "sensevoice"
  ) {
    return "sherpa-onnx-sensevoice";
  }
  return DEFAULT_LOCAL_ASR_BACKEND;
}

function normalizeAsrWorkerProvider(value?: string): ClawSenseConfig["asrWorkerProvider"] {
  const normalized = value?.toLowerCase().trim();
  if (normalized === "auto") {
    return "auto";
  }
  if (normalized === "local-asr" || normalized === "local" || normalized === "funasr" || normalized === "whisper") {
    return "local-asr";
  }
  if (
    normalized === "compatible-asr" ||
    normalized === "compatible" ||
    normalized === "cloud" ||
    normalized === "stt"
  ) {
    return "compatible-asr";
  }
  return DEFAULT_ASR_WORKER_PROVIDER;
}
