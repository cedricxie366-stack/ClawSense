import OpenAI from "openai";
import type { ClawSenseConfig } from "./config.js";
import type { OpenClawConfig } from "./openclaw-types.js";
import {
  classifyPrimaryMultimodalError,
  classifyOpenAiSttError,
  classifyVideoError,
  inferMimeFromName,
  isUsableAudioSemanticSummaryText,
  isUsableTranscriptText,
  isUsableVisualSummaryText,
  normalizeSemanticText,
  safeParseJsonObject,
} from "./utils.js";

export type PrimaryMultimodalModelResolution = {
  model: string;
  source: "runtime-primary" | "runtime-image" | "vision-model";
  analysisProvider: string;
  providerId?: string;
};

export type PrimaryMultimodalModelModality = "default" | "image" | "video" | "audio";

export type ReviewModelResolution = {
  model: string;
  source: "review-model" | "runtime-primary" | "runtime-image" | "vision-model";
  providerId?: string;
};

export type ImageAnalysisAttempt = {
  text: string;
  analysisProvider: string;
  analysisFailureReason?: string;
};

export type VideoAnalysisAttempt = {
  text: string;
  analysisProvider: string;
  analysisFailureReason?: string;
};

export type AudioUnderstandingAttempt = {
  transcript?: string;
  summary?: string;
  analysisProvider: string;
  analysisFailureReason?: string;
};

export type AudioTranscriptionAttempt = {
  transcript?: string;
  analysisProvider: string;
  analysisFailureReason?: string;
};

type AudioUnderstandingRouteAttempt = {
  transcript?: string;
  summary?: string;
  analysisFailureReason?: string;
};

export function resolveOpenAiClient(
  cfg: ClawSenseConfig,
  runtimeConfig: OpenClawConfig,
): OpenAI | null {
  const resolved = resolveCompatibleProviderCredentials(cfg, runtimeConfig);
  return resolved ? new OpenAI({ apiKey: resolved.apiKey, baseURL: resolved.baseURL }) : null;
}

export function resolveOpenAiClientForProvider(
  cfg: ClawSenseConfig,
  runtimeConfig: OpenClawConfig,
  providerId?: string,
): OpenAI | null {
  const resolved = resolveCompatibleProviderCredentials(cfg, runtimeConfig, providerId);
  return resolved ? new OpenAI({ apiKey: resolved.apiKey, baseURL: resolved.baseURL }) : null;
}

export function resolvePrimaryMultimodalModel(
  cfg: ClawSenseConfig,
  runtimeConfig: OpenClawConfig,
  modality: PrimaryMultimodalModelModality = "default",
): PrimaryMultimodalModelResolution {
  const defaults =
    ((runtimeConfig as Record<string, unknown>).agents as Record<string, unknown> | undefined)?.defaults as
      | Record<string, unknown>
      | undefined;
  const imageModelDefaults = (defaults?.imageModel as Record<string, unknown> | undefined) ?? {};
  const modelDefaults = (defaults?.model as Record<string, unknown> | undefined) ?? {};
  const prefersImageModel = modality === "image" || modality === "video";
  const candidates = prefersImageModel
    ? [
        { modelDefaults: imageModelDefaults, source: "runtime-image" as const },
        { modelDefaults, source: "runtime-primary" as const },
      ]
    : [{ modelDefaults, source: "runtime-primary" as const }];
  for (const candidate of candidates) {
    const resolved = resolveRuntimePrimaryModelCandidate(candidate.modelDefaults, defaults, runtimeConfig);
    if (resolved) {
      return {
        model: resolved.model,
        source: candidate.source,
        analysisProvider: `primary-multimodal:${candidate.source}`,
        providerId: resolved.providerId,
      };
    }
  }
  return {
    model: cfg.visionModel,
    source: "vision-model",
    analysisProvider: "primary-multimodal:vision-model",
    providerId: cfg.visionProvider,
  };
}

export function resolveReviewGenerationModel(
  cfg: ClawSenseConfig,
  runtimeConfig: OpenClawConfig,
): ReviewModelResolution {
  const configured = cfg.reviewModel?.trim();
  if (configured) {
    const parsedReview = resolveLooseProviderQualifiedModelRef(configured);
    return {
      model: parsedReview.model,
      source: "review-model",
      providerId: parsedReview.providerId,
    };
  }
  const primary = resolvePrimaryMultimodalModel(cfg, runtimeConfig);
  return {
    model: primary.model,
    source: primary.source,
    providerId: primary.providerId,
  };
}

export async function analyzeImageWithPrimaryModel(params: {
  cfg: ClawSenseConfig;
  runtimeConfig: OpenClawConfig;
  buffer: Buffer;
  fileName: string;
  mime?: string;
  primaryOpenai?: OpenAI | null;
  fallbackOpenai?: OpenAI | null;
}): Promise<ImageAnalysisAttempt> {
  const primary = resolvePrimaryMultimodalModel(params.cfg, params.runtimeConfig, "image");
  const fallbackTarget = resolveVisionFallbackTarget({
    primaryModel: primary.model,
    primaryProviderId: primary.providerId,
    cfg: params.cfg,
  });
  const fallbackModel = fallbackTarget.model;
  const primaryOpenai =
    params.primaryOpenai ?? resolveOpenAiClientForProvider(params.cfg, params.runtimeConfig, primary.providerId);
  const fallbackOpenai = fallbackTarget.enabled && fallbackModel
    ? params.fallbackOpenai ??
      resolveOpenAiClientForProvider(params.cfg, params.runtimeConfig, fallbackTarget.providerId)
    : null;
  const imageMime = params.mime ?? inferMimeFromName(params.fileName, "image");
  const imageUrl = `data:${imageMime};base64,${params.buffer.toString("base64")}`;

  const promptAttempts = [
    "请用简体中文描述这张图片，作为 ClawSense 可穿戴记忆预览，控制在 2 句以内。重点写清楚可见的人、环境、物品、屏幕内容或直接可观察到的动作；如有必要，只基于画面事实提到保守的“值得留意的社交线索”。不要推断性格、动机、内心状态、关系身份或团队动态。不要使用“summary unavailable”等泛化占位语。",
    "请用一句简体中文概括这张图片。只描述画面中可见的内容、场景和直接可观察到的活动，不要把猜测写成事实。",
  ];
  const primaryAttempt = primaryOpenai
    ? await attemptImageSummary({
        openai: primaryOpenai,
        model: primary.model,
        fileName: params.fileName,
        imageUrl,
        prompts: promptAttempts,
        route: "primary",
      })
    : {
        text: "",
        analysisFailureReason: "primary_multimodal_unavailable",
      };
  if (primaryAttempt.text) {
    return {
      text: primaryAttempt.text,
      analysisProvider: primary.analysisProvider,
      analysisFailureReason: primaryAttempt.analysisFailureReason,
    };
  }
  if (!fallbackModel) {
    return {
      text: "",
      analysisProvider: primary.analysisProvider,
      analysisFailureReason: primaryAttempt.analysisFailureReason,
    };
  }

  const fallbackAttempt = fallbackOpenai
    ? await attemptImageSummary({
        openai: fallbackOpenai,
        model: fallbackModel,
        fileName: params.fileName,
        imageUrl,
        prompts: promptAttempts,
        route: "fallback",
      })
    : {
        text: "",
        analysisFailureReason: "vision_provider_unavailable",
      };
  return {
    text: fallbackAttempt.text,
    analysisProvider: `${primary.analysisProvider}+${fallbackTarget.providerId}-vision-fallback`,
    analysisFailureReason: combineFailureReasons(
      primaryAttempt.analysisFailureReason,
      fallbackAttempt.text ? undefined : fallbackAttempt.analysisFailureReason,
    ),
  };
}

export async function understandAudioWithPrimaryModel(params: {
  cfg: ClawSenseConfig;
  runtimeConfig: OpenClawConfig;
  body: Buffer;
  fileName: string;
  mime?: string;
  primaryOpenai?: OpenAI | null;
  fallbackOpenai?: OpenAI | null;
}): Promise<AudioUnderstandingAttempt> {
  const primary = resolvePrimaryMultimodalModel(params.cfg, params.runtimeConfig);
  const fallbackTarget = resolveVisionFallbackTarget({
    primaryModel: primary.model,
    primaryProviderId: primary.providerId,
    cfg: params.cfg,
  });
  const fallbackModel = fallbackTarget.model;
  const primaryOpenai =
    params.primaryOpenai ?? resolveOpenAiClientForProvider(params.cfg, params.runtimeConfig, primary.providerId);
  const fallbackOpenai = fallbackTarget.enabled && fallbackModel
    ? params.fallbackOpenai ??
      resolveOpenAiClientForProvider(params.cfg, params.runtimeConfig, fallbackTarget.providerId)
    : null;

  const format = resolveAudioChatFormat(params.mime, params.fileName);
  if (!format) {
    return {
      analysisProvider: primary.analysisProvider,
      analysisFailureReason: "primary_multimodal_input_format_error",
    };
  }

  const instructions =
    "You analyze a short wearable audio clip for ClawSense daily review. Return JSON only with keys transcript, summary, and transcriptConfidence. transcript must stay empty unless the speech is clearly intelligible word-for-word. summary must stay conservative, use wording like '听起来像在讨论……', '值得留意的社交线索是……', or '可能与……有关，建议后续确认'. Only mention directly audible topic, context, task, or social cue. Never infer personality, motive, inner state, or microexpressions.";
  const filePrompt = `File name: ${params.fileName}. Prefer Chinese output for summary. If the audio is unclear, say so conservatively without inventing details.`;
  const primaryAttempt = primaryOpenai
    ? await attemptAudioUnderstanding({
        openai: primaryOpenai,
        model: primary.model,
        fileName: params.fileName,
        prompt: filePrompt,
        instructions,
        body: params.body,
        format,
      })
    : {
        analysisFailureReason: "primary_multimodal_unavailable",
      };
  if (primaryAttempt.transcript || primaryAttempt.summary) {
    return {
      transcript: primaryAttempt.transcript,
      summary: primaryAttempt.summary,
      analysisProvider: primary.analysisProvider,
    };
  }
  if (!fallbackModel) {
    return {
      analysisProvider: primary.analysisProvider,
      analysisFailureReason: primaryAttempt.analysisFailureReason,
    };
  }

  const fallbackAttempt = fallbackOpenai
    ? await attemptAudioUnderstanding({
        openai: fallbackOpenai,
        model: fallbackModel,
        fileName: params.fileName,
        prompt: filePrompt,
        instructions,
        body: params.body,
        format,
      })
    : {
        analysisFailureReason: "vision_provider_unavailable",
      };
  if (fallbackAttempt.transcript || fallbackAttempt.summary) {
    return {
      transcript: fallbackAttempt.transcript,
      summary: fallbackAttempt.summary,
      analysisProvider: `${primary.analysisProvider}+${fallbackTarget.providerId}-audio-fallback`,
      analysisFailureReason: primaryAttempt.analysisFailureReason,
    };
  }

  return {
    analysisProvider: `${primary.analysisProvider}+${fallbackTarget.providerId}-audio-fallback`,
    analysisFailureReason: combineFailureReasons(
      primaryAttempt.analysisFailureReason,
      fallbackAttempt.analysisFailureReason,
    ),
  };
}

export async function analyzeVideoWithPrimaryModel(params: {
  cfg: ClawSenseConfig;
  runtimeConfig: OpenClawConfig;
  buffer: Buffer;
  fileName: string;
  mime?: string;
  primaryOpenai?: OpenAI | null;
  fallbackOpenai?: OpenAI | null;
}): Promise<VideoAnalysisAttempt> {
  const primary = resolvePrimaryMultimodalModel(params.cfg, params.runtimeConfig, "video");
  const fallbackTarget = resolveVisionFallbackTarget({
    primaryModel: primary.model,
    primaryProviderId: primary.providerId,
    cfg: params.cfg,
  });
  const fallbackModel = fallbackTarget.model;
  const primaryOpenai =
    params.primaryOpenai ?? resolveOpenAiClientForProvider(params.cfg, params.runtimeConfig, primary.providerId);
  const fallbackOpenai = fallbackTarget.enabled && fallbackModel
    ? params.fallbackOpenai ??
      resolveOpenAiClientForProvider(params.cfg, params.runtimeConfig, fallbackTarget.providerId)
    : null;
  const promptAttempts = [
    "请用简体中文描述这段短视频，作为 ClawSense 可穿戴记忆证据，控制在 2 句以内。重点写清楚可见的人、环境、物品、屏幕内容和直接可观察到的动作；只提到画面明确支持的社交或任务线索。不要推断动机、性格、内心状态或隐藏关系。",
    "请用一句简体中文概括这段视频。说明哪里发生了什么可见事情，不要把猜测写成事实。",
  ];
  const primaryAttempt = primaryOpenai
    ? await attemptVideoSummary({
        openai: primaryOpenai,
        model: primary.model,
        fileName: params.fileName,
        body: params.buffer,
        prompts: promptAttempts,
        route: "primary",
      })
    : {
        text: "",
        analysisFailureReason: "primary_multimodal_unavailable",
      };
  if (primaryAttempt.text) {
    return {
      text: primaryAttempt.text,
      analysisProvider: primary.analysisProvider,
      analysisFailureReason: primaryAttempt.analysisFailureReason,
    };
  }
  if (!fallbackModel) {
    return {
      text: "",
      analysisProvider: primary.analysisProvider,
      analysisFailureReason: primaryAttempt.analysisFailureReason,
    };
  }

  const fallbackAttempt = fallbackOpenai
    ? await attemptVideoSummary({
        openai: fallbackOpenai,
        model: fallbackModel,
        fileName: params.fileName,
        body: params.buffer,
        prompts: promptAttempts,
        route: "fallback",
      })
    : {
        text: "",
        analysisFailureReason: "video_provider_unavailable",
      };
  return {
    text: fallbackAttempt.text,
    analysisProvider: `${primary.analysisProvider}+${fallbackTarget.providerId}-video-fallback`,
    analysisFailureReason: combineFailureReasons(
      primaryAttempt.analysisFailureReason,
      fallbackAttempt.text ? undefined : fallbackAttempt.analysisFailureReason,
    ),
  };
}

export async function transcribeAudioWithFallbackModel(params: {
  cfg: ClawSenseConfig;
  runtimeConfig: OpenClawConfig;
  body: Buffer;
  fileName: string;
  mime?: string;
  providerId?: string;
  model?: string;
  openai?: OpenAI | null;
}): Promise<AudioTranscriptionAttempt> {
  const model = readOptionalString(params.model) ?? params.cfg.sttFallbackModel;
  const providerId = resolveAudioTranscriptionProviderId(params.cfg, params.runtimeConfig, params.providerId, model);
  const openai = params.openai ?? resolveOpenAiClientForProvider(params.cfg, params.runtimeConfig, providerId);
  const analysisProvider = `${providerId}-stt:${model}`;
  if (!openai) {
    return {
      analysisProvider,
      analysisFailureReason: "query_time_asr_unavailable",
    };
  }

  if (supportsCompatibleChatAsr(model)) {
    const format = resolveAudioChatFormat(params.mime, params.fileName);
    if (!format) {
      return {
        analysisProvider,
        analysisFailureReason: "query_time_asr_format_error",
      };
    }
    try {
      const completion = await openai.chat.completions.create({
        model,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: {
                  data: buildAudioDataUrl(params.body, params.fileName, params.mime),
                  format,
                },
              },
            ],
          },
        ],
        asr_options: {
          enable_itn: false,
        },
      } as never);
      const transcript = normalizeSemanticText(extractChatCompletionText(completion));
      if (isUsableTranscriptText(transcript)) {
        return {
          transcript,
          analysisProvider,
        };
      }
      return {
        analysisProvider,
        analysisFailureReason: transcript ? "query_time_asr_low_signal" : "query_time_asr_empty",
      };
    } catch (error) {
      return {
        analysisProvider,
        analysisFailureReason: classifyOpenAiSttError(error),
      };
    }
  }

  try {
    const file = new File([new Uint8Array(params.body)], params.fileName, {
      type: params.mime ?? inferMimeFromName(params.fileName, "audio"),
    });
    const response = await openai.audio.transcriptions.create({
      file,
      model,
    });
    const transcript = normalizeSemanticText(response.text);
    if (isUsableTranscriptText(transcript)) {
      return {
        transcript,
        analysisProvider,
      };
    }
    return {
      analysisProvider,
      analysisFailureReason: transcript ? "query_time_asr_low_signal" : "query_time_asr_empty",
    };
  } catch (error) {
    return {
      analysisProvider,
      analysisFailureReason: classifyOpenAiSttError(error),
    };
  }
}

export function extractChatCompletionText(response: {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> | null } }>;
}): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
      .join(" ");
  }
  return "";
}

function extractChatCompletionDeltaText(chunk: {
  choices?: Array<{ delta?: { content?: string | Array<{ type?: string; text?: string }> | null } }>;
}): string {
  const content = chunk.choices?.[0]?.delta?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
      .join(" ");
  }
  return "";
}

function shouldRetryAudioChatWithStreaming(error: unknown, failureReason: string): boolean {
  if (failureReason === "primary_multimodal_input_format_error") {
    return true;
  }
  const text = String(error).toLowerCase();
  return text.includes("stream") && text.includes("required");
}

function resolveVisionFallbackTarget(params: {
  primaryModel: string;
  primaryProviderId?: string;
  cfg: ClawSenseConfig;
}): { enabled: boolean; model?: string; providerId: string } {
  const fallbackModel = params.cfg.visionModel.trim();
  const fallbackProviderId = normalizeProviderId(params.cfg.visionProvider) ?? "openai";
  if (!fallbackModel) {
    return {
      enabled: false,
      providerId: fallbackProviderId,
    };
  }

  const normalizedPrimaryProviderId = normalizeProviderId(params.primaryProviderId);
  const hasModelSwitch = fallbackModel !== params.primaryModel;
  const hasProviderSwitch = Boolean(
    normalizedPrimaryProviderId && normalizedPrimaryProviderId !== fallbackProviderId,
  );
  const enabled = hasModelSwitch || hasProviderSwitch;
  return {
    enabled,
    model: enabled ? fallbackModel : undefined,
    providerId: fallbackProviderId,
  };
}

function normalizeProviderId(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveRuntimePrimaryModelCandidate(
  modelDefaults: Record<string, unknown>,
  agentDefaults: Record<string, unknown> | undefined,
  runtimeConfig: OpenClawConfig,
): { model: string; providerId?: string } | null {
  const configuredPrimary = modelDefaults.primary;
  const primaryProviderId = readOptionalString(
    (configuredPrimary as Record<string, unknown> | undefined)?.provider,
  );
  const providerId =
    primaryProviderId ??
    readOptionalString(modelDefaults.provider) ??
    readOptionalString(agentDefaults?.provider) ??
    readOptionalString(
      (((runtimeConfig as Record<string, unknown>).models as Record<string, unknown> | undefined)
        ?.defaultProvider),
    );

  if (typeof configuredPrimary === "string" && configuredPrimary.trim()) {
    const parsedPrimary = resolveProviderQualifiedModelRef(configuredPrimary.trim(), runtimeConfig);
    return {
      model: parsedPrimary.model,
      providerId: providerId ?? parsedPrimary.providerId,
    };
  }
  if (configuredPrimary && typeof configuredPrimary === "object") {
    const resolvedModel =
      readOptionalString((configuredPrimary as Record<string, unknown>).model) ??
      readOptionalString((configuredPrimary as Record<string, unknown>).id) ??
      readOptionalString((configuredPrimary as Record<string, unknown>).name);
    if (resolvedModel) {
      const parsedPrimary = resolveProviderQualifiedModelRef(resolvedModel, runtimeConfig);
      return {
        model: parsedPrimary.model,
        providerId: providerId ?? parsedPrimary.providerId,
      };
    }
  }
  return null;
}

function resolveProviderQualifiedModelRef(
  rawModelRef: string,
  runtimeConfig: OpenClawConfig,
): { model: string; providerId?: string } {
  const trimmed = rawModelRef.trim();
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return { model: trimmed };
  }
  const candidateProviderId = trimmed.slice(0, separatorIndex).trim();
  const candidateModel = trimmed.slice(separatorIndex + 1).trim();
  if (!candidateProviderId || !candidateModel) {
    return { model: trimmed };
  }
  const root = runtimeConfig as Record<string, unknown>;
  const defaults =
    ((root.agents as Record<string, unknown> | undefined)?.defaults as Record<string, unknown> | undefined) ?? {};
  const configuredModels = (defaults.models as Record<string, unknown> | undefined) ?? {};
  const knownProvider =
    Boolean(resolveProviderMap(runtimeConfig, candidateProviderId)) ||
    Object.prototype.hasOwnProperty.call(configuredModels, trimmed);
  if (!knownProvider) {
    return { model: trimmed };
  }
  return {
    model: candidateModel,
    providerId: candidateProviderId,
  };
}

function resolveLooseProviderQualifiedModelRef(rawModelRef: string): { model: string; providerId?: string } {
  const trimmed = rawModelRef.trim();
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return { model: trimmed };
  }
  const candidateProviderId = trimmed.slice(0, separatorIndex).trim();
  const candidateModel = trimmed.slice(separatorIndex + 1).trim();
  if (!candidateProviderId || !candidateModel) {
    return { model: trimmed };
  }
  return {
    model: candidateModel,
    providerId: candidateProviderId,
  };
}

async function attemptAudioUnderstanding(params: {
  openai: OpenAI;
  model: string;
  fileName: string;
  prompt: string;
  instructions: string;
  body: Buffer;
  format: "wav" | "mp3";
}): Promise<AudioUnderstandingRouteAttempt> {
  const responsesAttempt = await attemptAudioUnderstandingWithResponses(params);
  if (responsesAttempt.transcript || responsesAttempt.summary) {
    return responsesAttempt;
  }
  const chatAttempt = await attemptAudioUnderstandingWithChat(params);
  if (chatAttempt.transcript || chatAttempt.summary) {
    return chatAttempt;
  }
  return {
    analysisFailureReason: combineFailureReasons(
      responsesAttempt.analysisFailureReason,
      chatAttempt.analysisFailureReason,
    ),
  };
}

type CompatibleProviderCredentials = {
  providerId: string;
  apiKey: string;
  baseURL?: string;
};

const API_KEY_PLACEHOLDER_VALUES = new Set([
  "$api-key",
  "${api-key}",
  "${api_key}",
  "api-key",
  "your-api-key",
  "your_api_key",
  "<api-key>",
  "<your-api-key>",
  "replace-with-your-api-key",
  "replace_me",
  "changeme",
]);

function resolveCompatibleProviderCredentials(
  cfg: ClawSenseConfig,
  runtimeConfig: OpenClawConfig,
  preferredProviderId?: string,
): CompatibleProviderCredentials | null {
  const explicitApiKey = readValidApiKey(cfg.openaiApiKey) ?? readValidApiKey(process.env.OPENAI_API_KEY);
  const explicitBaseUrl =
    readOptionalString(cfg.openaiBaseUrl) ?? readOptionalString(process.env.OPENAI_BASE_URL);
  if (explicitApiKey && (!preferredProviderId || preferredProviderId === "openai")) {
    return {
      providerId: "openai",
      apiKey: explicitApiKey,
      baseURL: explicitBaseUrl,
    };
  }

  const primary = resolvePrimaryMultimodalModel(cfg, runtimeConfig);
  const candidateProviderIds = preferredProviderId
    ? dedupeStrings([preferredProviderId])
    : dedupeStrings([primary.providerId, cfg.visionProvider, "openai"]);
  for (const providerId of candidateProviderIds) {
    const providerMap = resolveProviderMap(runtimeConfig, providerId);
    const apiKey = readValidApiKey(providerMap?.apiKey);
    if (!apiKey) {
      continue;
    }
    return {
      providerId,
      apiKey,
      baseURL:
        readOptionalString(providerMap?.baseUrl) ??
        readOptionalString(providerMap?.baseURL) ??
        explicitBaseUrl,
    };
  }
  if (explicitApiKey) {
    const preferredIsKnownProvider =
      !!preferredProviderId && !!resolveProviderMap(runtimeConfig, preferredProviderId);
    // For non-openai provider ids, explicit OpenAI-compatible credentials are only safe when baseURL
    // is explicitly provided by user config/env and the provider is a known runtime provider.
    if (
      preferredProviderId &&
      preferredProviderId !== "openai" &&
      (!explicitBaseUrl || !preferredIsKnownProvider)
    ) {
      return null;
    }
    return {
      providerId: preferredProviderId ?? "openai",
      apiKey: explicitApiKey,
      baseURL: explicitBaseUrl,
    };
  }
  return null;
}

function resolveProviderMap(
  runtimeConfig: OpenClawConfig,
  providerId: string,
): Record<string, unknown> | undefined {
  const root = runtimeConfig as Record<string, unknown>;
  const models = (root.models as Record<string, unknown> | undefined) ?? {};
  const topProviders = (root.providers as Record<string, unknown> | undefined) ?? {};
  const modelProviders = (models.providers as Record<string, unknown> | undefined) ?? {};
  const candidate = modelProviders[providerId] ?? topProviders[providerId];
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : undefined;
}

function resolveAudioTranscriptionProviderId(
  cfg: ClawSenseConfig,
  runtimeConfig: OpenClawConfig,
  preferredProviderId: string | undefined,
  model: string,
): string {
  const explicitProviderId = preferredProviderId?.trim();
  if (explicitProviderId) {
    return explicitProviderId;
  }
  if (model.trim().toLowerCase() === "whisper-1") {
    return "openai";
  }
  const primary = resolvePrimaryMultimodalModel(cfg, runtimeConfig);
  return primary.providerId ?? (cfg.visionProvider.trim() || "openai");
}

function supportsCompatibleChatAsr(model: string): boolean {
  return model.trim().toLowerCase().startsWith("qwen3-asr-flash");
}

function buildAudioDataUrl(body: Buffer, fileName: string, mime?: string): string {
  const normalizedMime = mime ?? inferMimeFromName(fileName, "audio");
  return `data:${normalizedMime};base64,${body.toString("base64")}`;
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

function readValidApiKey(value: unknown): string | undefined {
  const key = readOptionalString(value);
  if (!key) {
    return undefined;
  }
  return isLikelyApiKeyPlaceholder(key) ? undefined : key;
}

function isLikelyApiKeyPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("$")) {
    return true;
  }
  if (normalized.startsWith("${") && normalized.endsWith("}")) {
    return true;
  }
  return API_KEY_PLACEHOLDER_VALUES.has(normalized);
}

async function attemptAudioUnderstandingWithResponses(params: {
  openai: OpenAI;
  model: string;
  fileName: string;
  prompt: string;
  instructions: string;
  body: Buffer;
}): Promise<AudioUnderstandingRouteAttempt> {
  try {
    const response = await params.openai.responses.create({
      model: params.model,
      instructions: params.instructions,
      max_output_tokens: 240,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: params.prompt,
            },
            {
              type: "input_file",
              file_data: params.body.toString("base64"),
              filename: params.fileName,
            },
          ],
        },
      ],
    });
    return parseAudioUnderstandingResult(normalizeSemanticText(response.output_text));
  } catch (error) {
    return {
      analysisFailureReason: classifyPrimaryMultimodalError(error, "audio"),
    };
  }
}

async function attemptAudioUnderstandingWithChat(params: {
  openai: OpenAI;
  model: string;
  fileName: string;
  prompt: string;
  instructions: string;
  body: Buffer;
  format: "wav" | "mp3";
}): Promise<AudioUnderstandingRouteAttempt> {
  try {
    const completion = await params.openai.chat.completions.create({
      model: params.model,
      temperature: 0.2,
      max_completion_tokens: 240,
      messages: [
        {
          role: "system",
          content: params.instructions,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: params.prompt,
            },
            {
              type: "input_audio",
              input_audio: {
                data: params.body.toString("base64"),
                format: params.format,
              },
            },
          ],
        },
      ],
    } as never);
    return parseAudioUnderstandingResult(normalizeSemanticText(extractChatCompletionText(completion)));
  } catch (error) {
    const baseFailureReason = classifyPrimaryMultimodalError(error, "audio");
    if (!shouldRetryAudioChatWithStreaming(error, baseFailureReason)) {
      return {
        analysisFailureReason: baseFailureReason,
      };
    }

    try {
      const completion = await params.openai.chat.completions.create({
        model: params.model,
        temperature: 0.2,
        max_completion_tokens: 240,
        modalities: ["text"],
        stream: true,
        messages: [
          {
            role: "system",
            content: params.instructions,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: params.prompt,
              },
              {
                type: "input_audio",
                input_audio: {
                  data: params.body.toString("base64"),
                  format: params.format,
                },
              },
            ],
          },
        ],
      } as never);
      let streamedText = "";
      for await (const chunk of completion as unknown as AsyncIterable<{
        choices?: Array<{ delta?: { content?: string | Array<{ type?: string; text?: string }> | null } }>;
      }>) {
        streamedText += extractChatCompletionDeltaText(chunk);
      }
      return parseAudioUnderstandingResult(normalizeSemanticText(streamedText));
    } catch (streamError) {
      return {
        analysisFailureReason: combineFailureReasons(
          baseFailureReason,
          classifyPrimaryMultimodalError(streamError, "audio"),
        ),
      };
    }
  }
}

function parseAudioUnderstandingResult(raw: string): AudioUnderstandingRouteAttempt {
  const parsed = safeParseJsonObject<{
    transcript?: string;
    summary?: string;
    transcriptConfidence?: string;
  }>(raw);
  const transcript = normalizeSemanticText(parsed?.transcript);
  const summary = normalizeSemanticText(parsed?.summary ?? raw);
  const transcriptConfidence = normalizeSemanticText(parsed?.transcriptConfidence).toLowerCase();
  const reliableTranscript =
    isUsableTranscriptText(transcript) && (transcriptConfidence === "high" || transcriptConfidence === "certain");
  if (reliableTranscript || isUsableAudioSemanticSummaryText(summary)) {
    return {
      transcript: reliableTranscript ? transcript : undefined,
      summary: isUsableAudioSemanticSummaryText(summary) ? summary : undefined,
    };
  }
  return {
    analysisFailureReason: summary ? "primary_multimodal_low_signal" : "primary_multimodal_empty",
  };
}

async function attemptImageSummary(params: {
  openai: OpenAI;
  model: string;
  fileName: string;
  imageUrl: string;
  prompts: string[];
  route: "primary" | "fallback";
}): Promise<{ text: string; analysisFailureReason?: string }> {
  let failureReason: string | undefined;
  for (const prompt of params.prompts) {
    try {
      const response = await params.openai.responses.create({
        model: params.model,
        max_output_tokens: 180,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `${prompt}\nFile name: ${params.fileName}`,
              },
              {
                type: "input_image",
                image_url: params.imageUrl,
                detail: "high",
              },
            ],
          },
        ],
      });
      const text = normalizeSemanticText(response.output_text);
      if (isUsableVisualSummaryText(text)) {
        return { text };
      }
      failureReason = combineFailureReasons(
        failureReason,
        text
          ? params.route === "primary"
            ? "primary_multimodal_low_signal"
            : "vision_summary_low_signal"
          : params.route === "primary"
            ? "primary_multimodal_empty"
            : "vision_summary_empty",
      );
    } catch (error) {
      failureReason = combineFailureReasons(
        failureReason,
        params.route === "primary" ? classifyPrimaryMultimodalError(error, "image") : classifyLegacyVisionError(error),
      );
    }

    try {
      const chat = await params.openai.chat.completions.create({
        model: params.model,
        max_tokens: 180,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${prompt}\nFile name: ${params.fileName}`,
              },
              {
                type: "image_url",
                image_url: {
                  url: params.imageUrl,
                  detail: "high",
                },
              },
            ],
          },
        ],
      });
      const text = normalizeSemanticText(extractChatCompletionText(chat));
      if (isUsableVisualSummaryText(text)) {
        return { text };
      }
      failureReason = combineFailureReasons(
        failureReason,
        text
          ? params.route === "primary"
            ? "primary_multimodal_low_signal"
            : "vision_summary_low_signal"
          : params.route === "primary"
            ? "primary_multimodal_empty"
            : "vision_summary_empty",
      );
    } catch (error) {
      failureReason = combineFailureReasons(
        failureReason,
        params.route === "primary" ? classifyPrimaryMultimodalError(error, "image") : classifyLegacyVisionError(error),
      );
    }
  }

  return {
    text: "",
    analysisFailureReason: failureReason,
  };
}

async function attemptVideoSummary(params: {
  openai: OpenAI;
  model: string;
  fileName: string;
  body: Buffer;
  prompts: string[];
  route: "primary" | "fallback";
}): Promise<{ text: string; analysisFailureReason?: string }> {
  let failureReason: string | undefined;
  for (const prompt of params.prompts) {
    try {
      const response = await params.openai.responses.create({
        model: params.model,
        max_output_tokens: 240,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `${prompt}\nFile name: ${params.fileName}`,
              },
              {
                type: "input_file",
                file_data: params.body.toString("base64"),
                filename: params.fileName,
              },
            ],
          },
        ],
      } as never);
      const text = normalizeSemanticText(response.output_text);
      if (isUsableVisualSummaryText(text)) {
        return { text };
      }
      failureReason = combineFailureReasons(
        failureReason,
        text
          ? params.route === "primary"
            ? "primary_multimodal_low_signal"
            : "video_summary_low_signal"
          : params.route === "primary"
            ? "primary_multimodal_empty"
            : "video_summary_empty",
      );
    } catch (error) {
      failureReason = combineFailureReasons(
        failureReason,
        params.route === "primary" ? classifyPrimaryMultimodalError(error, "video") : classifyLegacyVideoError(error),
      );
    }
  }
  return {
    text: "",
    analysisFailureReason: failureReason,
  };
}

function resolveAudioChatFormat(mime: string | undefined, fileName: string): "wav" | "mp3" | undefined {
  const normalized = mime?.trim().toLowerCase() ?? inferMimeFromName(fileName, "audio");
  if (normalized === "audio/wav" || normalized === "audio/x-wav") {
    return "wav";
  }
  if (normalized === "audio/mpeg") {
    return "mp3";
  }
  return undefined;
}

function combineFailureReasons(...reasons: Array<string | undefined>): string | undefined {
  const filtered = reasons.filter(Boolean);
  return filtered.length ? Array.from(new Set(filtered)).join("|") : undefined;
}

function classifyLegacyVisionError(error: unknown): string {
  const reason = classifyPrimaryMultimodalError(error, "image");
  switch (reason) {
    case "primary_multimodal_unavailable":
      return "vision_provider_unavailable";
    case "primary_multimodal_timeout":
      return "vision_summary_timeout";
    case "primary_multimodal_not_image_capable":
      return "vision_provider_not_image_capable";
    case "primary_multimodal_input_format_error":
      return "vision_input_format_error";
    case "primary_multimodal_low_signal":
      return "vision_summary_low_signal";
    case "primary_multimodal_empty":
      return "vision_summary_empty";
    default:
      return "vision_summary_error";
  }
}

function classifyLegacyVideoError(error: unknown): string {
  return classifyVideoError(error);
}
