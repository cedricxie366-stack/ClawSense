import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ClawSenseSetupToken } from "./state-store.js";
import type { OpenClawConfig } from "./openclaw-types.js";

export type ResolvedArtifactMime = {
  mime: string;
  source: "detected" | "provided" | "extension" | "default";
  detectedMime?: string;
  mismatch: boolean;
};

export type ClawSenseAudioSessionHint = {
  session?: string;
  segment?: number;
  sessionStart?: number;
  boundary?: string;
  clipMs?: number;
  voicedMs?: number;
  peakRms?: number;
  continued?: boolean;
};

export function issueSetupToken(ttlSeconds: number): ClawSenseSetupToken {
  const token = randomBytes(24).toString("base64url");
  const createdAt = Date.now();
  return {
    token,
    tokenHash: hashSecret(token),
    createdAt,
    expiresAt: createdAt + ttlSeconds * 1000,
  };
}

export function createDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function createSetupCode(baseUrl: string, token: string): string {
  return Buffer.from(JSON.stringify({ url: stripTrailingSlash(baseUrl), token }), "utf8").toString(
    "base64url",
  );
}

export function inferPublicBaseUrl(params: {
  preferred?: string;
  config: OpenClawConfig;
  gatewayPort: number;
}): string {
  const preferred = params.preferred?.trim();
  if (preferred) {
    return stripTrailingSlash(withProtocol(preferred));
  }

  const config = params.config as Record<string, unknown>;
  const gateway = (config.gateway ?? {}) as Record<string, unknown>;
  const explicitUrl = typeof gateway.publicBaseUrl === "string" ? gateway.publicBaseUrl : undefined;
  if (explicitUrl?.trim()) {
    return stripTrailingSlash(withProtocol(explicitUrl));
  }

  const controlUi = (gateway.controlUi ?? {}) as Record<string, unknown>;
  const allowedOrigins = Array.isArray(controlUi.allowedOrigins) ? controlUi.allowedOrigins : [];
  const firstAllowedOrigin = allowedOrigins.find((origin): origin is string => {
    return typeof origin === "string" && /^https?:\/\//i.test(origin.trim());
  });
  if (firstAllowedOrigin?.trim()) {
    return stripTrailingSlash(firstAllowedOrigin.trim());
  }

  const bind = typeof gateway.bind === "string" ? gateway.bind.trim() : "";
  if (bind) {
    if (isWildcardOrAliasBind(bind)) {
      const host = process.env.CLAWSENSE_PUBLIC_HOST?.trim() || "127.0.0.1";
      return `http://${host}:${params.gatewayPort}`;
    }
    return stripTrailingSlash(withProtocol(bind));
  }

  const host = process.env.CLAWSENSE_PUBLIC_HOST?.trim() || "127.0.0.1";
  return `http://${host}:${params.gatewayPort}`;
}

export function withProtocol(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isWildcardOrAliasBind(bind: string): boolean {
  const normalized = bind.trim().toLowerCase();
  return ["lan", "all", "0.0.0.0", "::", "::0", "*"].includes(normalized);
}

export function timingSafeMatches(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function toSafeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function normalizeSemanticText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function inferMimeFromName(fileName: string, modality: "audio" | "image" | "video"): string {
  const extension = fileName.trim().toLowerCase().split(".").pop() ?? "";
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "webp") {
    return "image/webp";
  }
  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }
  if (extension === "gif") {
    return "image/gif";
  }
  if (extension === "mp3") {
    return "audio/mpeg";
  }
  if (extension === "m4a" || extension === "mp4") {
    return modality === "audio" ? "audio/mp4" : "video/mp4";
  }
  if (extension === "ogg" || extension === "oga") {
    return modality === "audio" ? "audio/ogg" : "video/ogg";
  }
  if (extension === "webm") {
    return modality === "audio" ? "audio/webm" : "video/webm";
  }
  if (extension === "mov") {
    return "video/quicktime";
  }
  if (extension === "m4v") {
    return "video/x-m4v";
  }
  if (extension === "mkv") {
    return "video/x-matroska";
  }
  return modality === "audio" ? "audio/wav" : modality === "video" ? "video/mp4" : "image/jpeg";
}

export function resolveArtifactMime(params: {
  body: Buffer;
  fileName: string;
  mime?: string;
  modality: "audio" | "image" | "video";
}): ResolvedArtifactMime {
  const provided = params.mime?.trim().toLowerCase();
  const detected = detectMimeFromBody(params.body, params.modality);
  const fallback = inferMimeFromName(params.fileName, params.modality);
  if (detected) {
    return {
      mime: detected,
      source: "detected",
      detectedMime: detected,
      mismatch: Boolean(provided && provided !== detected),
    };
  }
  if (provided) {
    return {
      mime: provided,
      source: "provided",
      mismatch: false,
    };
  }
  if (fallback) {
    return {
      mime: fallback,
      source: "extension",
      mismatch: false,
    };
  }
  return {
    mime: params.modality === "audio" ? "audio/wav" : params.modality === "video" ? "video/mp4" : "image/jpeg",
    source: "default",
    mismatch: false,
  };
}

export function isSupportedAudioMime(mime: string | undefined): boolean {
  const normalized = mime?.trim().toLowerCase();
  return Boolean(
    normalized &&
      [
        "audio/wav",
        "audio/x-wav",
        "audio/mpeg",
        "audio/mp4",
        "audio/ogg",
        "audio/webm",
      ].includes(normalized),
  );
}

export function isSupportedImageMime(mime: string | undefined): boolean {
  const normalized = mime?.trim().toLowerCase();
  return Boolean(
    normalized &&
      [
        "image/jpeg",
        "image/png",
        "image/webp",
      ].includes(normalized),
  );
}

export function isSupportedVideoMime(mime: string | undefined): boolean {
  const normalized = mime?.trim().toLowerCase();
  return Boolean(
    normalized &&
      [
        "video/mp4",
        "video/webm",
        "video/quicktime",
        "video/ogg",
        "video/x-m4v",
        "video/x-matroska",
      ].includes(normalized),
  );
}

export function estimateAudioDurationMs(body: Buffer, mime?: string): number | undefined {
  const normalized = mime?.trim().toLowerCase();
  if (normalized === "audio/wav" || normalized === "audio/x-wav" || looksLikeWave(body)) {
    return parseWaveDurationMs(body);
  }
  return undefined;
}

export function isLikelySensorMetricNote(value: string | undefined): boolean {
  const text = normalizeSemanticText(value).toLowerCase();
  if (!text) {
    return false;
  }
  return /(^|[\s,;])rms=\d/.test(text) || /(^|[\s,;])voicedms=\d/.test(text);
}

export function isUsableTranscriptText(value: string | undefined): boolean {
  const text = normalizeSemanticText(value);
  return hasSemanticSignal(text, 4) && !isLowSignalSemanticText(text);
}

export function isUsableVisualSummaryText(value: string | undefined): boolean {
  const text = normalizeSemanticText(value);
  return hasSemanticSignal(text, 8) && !isLowSignalSemanticText(text);
}

export function isUsableAudioSemanticSummaryText(value: string | undefined): boolean {
  const text = normalizeSemanticText(value);
  return hasSemanticSignal(text, 6) && !isLowSignalSemanticText(text);
}

export function safeParseJsonObject<T>(raw: string | undefined): T | null {
  const trimmed = normalizeSemanticText(raw);
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

export function parseClawSenseAudioSessionHint(note: string | undefined): ClawSenseAudioSessionHint | null {
  const text = normalizeSemanticText(note);
  if (!text.toLowerCase().startsWith("csaudio:v2")) {
    return null;
  }
  const hint: ClawSenseAudioSessionHint = {};
  const tokens = text.split(/\s+/).slice(1);
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    switch (key) {
      case "session":
        hint.session = value.trim() || undefined;
        break;
      case "segment":
        hint.segment = parseOptionalInteger(value);
        break;
      case "sessionStart":
        hint.sessionStart = parseOptionalInteger(value);
        break;
      case "boundary":
        hint.boundary = value.trim() || undefined;
        break;
      case "clipMs":
        hint.clipMs = parseOptionalInteger(value);
        break;
      case "voicedMs":
        hint.voicedMs = parseOptionalInteger(value);
        break;
      case "peakRms":
        hint.peakRms = parseOptionalNumber(value);
        break;
      case "continued":
        hint.continued = value === "1" || value.toLowerCase() === "true";
        break;
      default:
        break;
    }
  }
  return hint.session ? hint : null;
}

export function buildAudioDegradedSummary(
  note?: string,
  analysisFailureReason?: string,
): string {
  const cleanedNote = normalizeSemanticText(note);
  const lead = resolveAudioFailureLead(analysisFailureReason);
  if (cleanedNote) {
    return isLikelySensorMetricNote(cleanedNote)
      ? `${lead} Sensor note: ${cleanedNote}.`
      : `${lead} Device note: ${cleanedNote}.`;
  }
  return lead;
}

export function buildImageDegradedSummary(
  note?: string,
  analysisFailureReason?: string,
): string {
  const cleanedNote = normalizeSemanticText(note);
  const lead = resolveImageFailureLead(analysisFailureReason);
  if (cleanedNote) {
    return `${lead} Device note: ${cleanedNote}.`;
  }
  return lead;
}

export function buildVideoDegradedSummary(
  note?: string,
  analysisFailureReason?: string,
): string {
  const cleanedNote = normalizeSemanticText(note);
  const lead = resolveVideoFailureLead(analysisFailureReason);
  if (cleanedNote) {
    return `${lead} Device note: ${cleanedNote}.`;
  }
  return lead;
}

export function classifyRuntimeSttError(error: unknown): string {
  const text = String(error).toLowerCase();
  if (isProviderUnavailableMessage(text)) {
    return "runtime_stt_provider_unavailable";
  }
  if (isFormatErrorMessage(text)) {
    return "runtime_stt_format_error";
  }
  if (isTimeoutMessage(text)) {
    return "runtime_stt_timeout";
  }
  return "runtime_stt_error";
}

export function classifyOpenAiSttError(error: unknown): string {
  const text = String(error).toLowerCase();
  if (isProviderUnavailableMessage(text)) {
    return "openai_stt_unavailable";
  }
  if (isFormatErrorMessage(text)) {
    return "openai_stt_format_error";
  }
  if (isTimeoutMessage(text)) {
    return "openai_stt_timeout";
  }
  return "openai_stt_error";
}

export function classifyVisionError(error: unknown): string {
  const text = String(error).toLowerCase();
  if (isProviderUnavailableMessage(text)) {
    return "vision_provider_unavailable";
  }
  if (isTimeoutMessage(text)) {
    return "vision_summary_timeout";
  }
  if (
    [
      "input_image",
      "image_url",
      "does not support image",
      "does not support images",
      "not multimodal",
      "image input",
    ].some((snippet) => text.includes(snippet))
  ) {
    return "vision_provider_not_image_capable";
  }
  if (isFormatErrorMessage(text)) {
    return "vision_input_format_error";
  }
  return "vision_summary_error";
}

export function classifyPrimaryMultimodalError(
  error: unknown,
  modality: "image" | "audio" | "video",
): string {
  const text = String(error).toLowerCase();
  if (isProviderUnavailableMessage(text)) {
    return "primary_multimodal_unavailable";
  }
  if (isTimeoutMessage(text)) {
    return "primary_multimodal_timeout";
  }
  if (modality === "image" && isImageCapabilityError(text)) {
    return "primary_multimodal_not_image_capable";
  }
  if (modality === "audio" && isAudioCapabilityError(text)) {
    return "primary_multimodal_not_audio_capable";
  }
  if (modality === "video" && isVideoCapabilityError(text)) {
    return "primary_multimodal_not_video_capable";
  }
  if (isFormatErrorMessage(text)) {
    return "primary_multimodal_input_format_error";
  }
  return "primary_multimodal_error";
}

export function classifyVideoError(error: unknown): string {
  const reason = classifyPrimaryMultimodalError(error, "video");
  switch (reason) {
    case "primary_multimodal_unavailable":
      return "video_provider_unavailable";
    case "primary_multimodal_timeout":
      return "video_summary_timeout";
    case "primary_multimodal_not_video_capable":
      return "video_provider_not_video_capable";
    case "primary_multimodal_input_format_error":
      return "video_input_format_error";
    case "primary_multimodal_low_signal":
      return "video_summary_low_signal";
    case "primary_multimodal_empty":
      return "video_summary_empty";
    default:
      return "video_summary_error";
  }
}

function hasSemanticSignal(text: string, minimumMeaningfulCharacters: number): boolean {
  const meaningful = text.match(/[\p{L}\p{N}]/gu) ?? [];
  return meaningful.length >= minimumMeaningfulCharacters;
}

export function isLowSignalSemanticText(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    /^rms=\d/,
    /^voicedms=\d/,
    /^audio captured but transcription was empty\.?$/,
    /^audio captured, but speech transcription was unavailable\.?$/,
    /^image captured but visual summary was unavailable\.?$/,
    /^image captured, but the visual summary model was unavailable\.?$/,
    /^transcription unavailable\.?$/,
    /^visual summary unavailable\.?$/,
    /^n\/a\.?$/,
    /^音频(?:内容)?不清(?:楚|晰)[。.]?$/,
    /^无法(?:从)?音频中(?:判断|辨认).*[。.]?$/,
    /^无法清楚辨认.*[。.]?$/,
    /^听不清(?:楚)?[。.]?$/,
    /^图像(?:内容)?不清(?:楚|晰)[。.]?$/,
  ].some((pattern) => pattern.test(normalized));
}

function detectMimeFromBody(
  body: Buffer,
  modality: "audio" | "image" | "video",
): string | undefined {
  if (body.length >= 12 && looksLikeWave(body)) {
    return "audio/wav";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    body.length >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (body.length >= 4 && body.subarray(0, 4).toString("ascii") === "OggS") {
    if (modality === "audio") {
      return "audio/ogg";
    }
    if (modality === "video") {
      return "video/ogg";
    }
    return undefined;
  }
  if (body.length >= 3 && body.subarray(0, 3).toString("ascii") === "ID3") {
    return modality === "audio" ? "audio/mpeg" : undefined;
  }
  if (body.length >= 2 && body[0] === 0xff && (body[1] & 0xe0) === 0xe0) {
    return modality === "audio" ? "audio/mpeg" : undefined;
  }
  if (body.length >= 12 && body.subarray(4, 8).toString("ascii") === "ftyp") {
    return modality === "audio" ? "audio/mp4" : modality === "video" ? "video/mp4" : undefined;
  }
  if (
    body.length >= 4 &&
    body[0] === 0x1a &&
    body[1] === 0x45 &&
    body[2] === 0xdf &&
    body[3] === 0xa3
  ) {
    return modality === "audio" ? "audio/webm" : modality === "video" ? "video/webm" : undefined;
  }
  return undefined;
}

function looksLikeWave(body: Buffer): boolean {
  return (
    body.length >= 12 &&
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

function parseWaveDurationMs(body: Buffer): number | undefined {
  if (!looksLikeWave(body)) {
    return undefined;
  }
  let cursor = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;

  while (cursor + 8 <= body.length) {
    const chunkId = body.subarray(cursor, cursor + 4).toString("ascii");
    const chunkSize = body.readUInt32LE(cursor + 4);
    const chunkStart = cursor + 8;
    if (chunkStart + chunkSize > body.length) {
      break;
    }

    if (chunkId === "fmt " && chunkSize >= 12) {
      byteRate = body.readUInt32LE(chunkStart + 8);
    }
    if (chunkId === "data") {
      dataSize = chunkSize;
    }
    if (byteRate && dataSize !== undefined) {
      break;
    }
    cursor = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || !dataSize) {
    return undefined;
  }
  return Math.round((dataSize / byteRate) * 1000);
}

function resolveAudioFailureLead(analysisFailureReason: string | undefined): string {
  const primary = pickPrimaryFailureReason(analysisFailureReason, [
    "audio_clip_too_short",
    "audio_format_unsupported",
    "primary_multimodal_not_audio_capable",
    "primary_multimodal_unavailable",
    "primary_multimodal_timeout",
    "primary_multimodal_error",
    "primary_multimodal_low_signal",
    "primary_multimodal_empty",
    "runtime_stt_low_signal",
    "runtime_stt_empty",
    "runtime_stt_provider_unavailable",
    "runtime_stt_error",
    "runtime_stt_timeout",
    "openai_stt_error",
    "openai_stt_low_signal",
    "openai_stt_empty",
    "openai_stt_timeout",
  ]);
  switch (primary) {
    case "audio_clip_too_short":
      return "Audio captured, but the clip was too short for speech transcription.";
    case "audio_format_unsupported":
      return "Audio captured, but the clip format could not be transcribed.";
    case "runtime_stt_low_signal":
      return "Audio captured, but runtime STT only returned low-signal text.";
    case "runtime_stt_empty":
      return "Audio captured, but runtime STT returned an empty transcript.";
    case "primary_multimodal_not_audio_capable":
      return "Audio captured, but the primary multimodal model could not accept audio input.";
    case "primary_multimodal_unavailable":
      return "Audio captured, but the primary multimodal model was unavailable.";
    case "primary_multimodal_timeout":
      return "Audio captured, but primary multimodal audio analysis timed out.";
    case "primary_multimodal_error":
      return "Audio captured, but primary multimodal audio analysis failed.";
    case "primary_multimodal_low_signal":
    case "primary_multimodal_empty":
      return "Audio captured, but multimodal audio analysis did not return a reliable summary.";
    case "runtime_stt_provider_unavailable":
    case "openai_stt_unavailable":
      return "Audio captured, but a speech transcription provider was unavailable.";
    case "runtime_stt_error":
      return "Audio captured, but runtime STT failed before a reliable transcript was produced.";
    case "openai_stt_error":
      return "Audio captured, but OpenAI STT fallback failed before a reliable transcript was produced.";
    case "openai_stt_low_signal":
      return "Audio captured, but OpenAI STT fallback only returned low-signal text.";
    case "openai_stt_empty":
      return "Audio captured, but OpenAI STT fallback returned an empty transcript.";
    case "runtime_stt_timeout":
    case "openai_stt_timeout":
      return "Audio captured, but speech transcription timed out.";
    default:
      return "Audio captured, but speech transcription was unavailable.";
  }
}

function resolveImageFailureLead(analysisFailureReason: string | undefined): string {
  const primary = pickPrimaryFailureReason(analysisFailureReason, [
    "image_format_unsupported",
    "primary_multimodal_not_image_capable",
    "primary_multimodal_unavailable",
    "primary_multimodal_timeout",
    "primary_multimodal_error",
    "primary_multimodal_low_signal",
    "primary_multimodal_empty",
    "vision_provider_not_image_capable",
    "vision_provider_unavailable",
    "vision_input_format_error",
    "vision_summary_timeout",
    "vision_summary_error",
    "vision_summary_low_signal",
    "vision_summary_empty",
  ]);
  switch (primary) {
    case "image_format_unsupported":
      return "Image captured, but the file format could not be analyzed.";
    case "primary_multimodal_not_image_capable":
      return "Image captured, but the current primary multimodal model could not accept image input.";
    case "primary_multimodal_unavailable":
      return "Image captured, but the primary multimodal model was unavailable.";
    case "primary_multimodal_timeout":
      return "Image captured, but primary multimodal image analysis timed out.";
    case "primary_multimodal_error":
      return "Image captured, but primary multimodal image analysis failed.";
    case "primary_multimodal_low_signal":
    case "primary_multimodal_empty":
      return "Image captured, but the primary multimodal model did not return a reliable summary.";
    case "vision_provider_not_image_capable":
      return "Image captured, but the current vision model could not accept image input.";
    case "vision_provider_unavailable":
      return "Image captured, but the vision provider was unavailable.";
    case "vision_input_format_error":
      return "Image captured, but the image input format was rejected by the vision provider.";
    case "vision_summary_timeout":
      return "Image captured, but visual analysis timed out.";
    case "vision_summary_error":
      return "Image captured, but visual analysis failed.";
    case "vision_summary_low_signal":
    case "vision_summary_empty":
      return "Image captured, but visual analysis did not return a reliable summary.";
    default:
      return "Image captured, but the visual summary model was unavailable.";
  }
}

function resolveVideoFailureLead(analysisFailureReason: string | undefined): string {
  const primary = pickPrimaryFailureReason(analysisFailureReason, [
    "video_format_unsupported",
    "video_analysis_disabled_by_mode",
    "video_analysis_not_implemented",
    "video_mime_mismatch",
    "primary_multimodal_not_video_capable",
    "primary_multimodal_unavailable",
    "primary_multimodal_timeout",
    "primary_multimodal_error",
    "primary_multimodal_low_signal",
    "primary_multimodal_empty",
    "video_provider_not_video_capable",
    "video_provider_unavailable",
    "video_input_format_error",
    "video_summary_timeout",
    "video_summary_error",
    "video_summary_low_signal",
    "video_summary_empty",
  ]);
  switch (primary) {
    case "video_format_unsupported":
      return "Video captured, but the file format is not supported yet.";
    case "video_analysis_disabled_by_mode":
      return "Video captured, but direct video understanding is disabled in the current mode.";
    case "video_mime_mismatch":
      return "Video captured, but the provided MIME type did not match the payload.";
    case "primary_multimodal_not_video_capable":
    case "video_provider_not_video_capable":
      return "Video captured, but the current multimodal model could not accept video input.";
    case "primary_multimodal_unavailable":
    case "video_provider_unavailable":
      return "Video captured, but the video analysis provider was unavailable.";
    case "primary_multimodal_timeout":
    case "video_summary_timeout":
      return "Video captured, but video analysis timed out.";
    case "primary_multimodal_error":
    case "video_summary_error":
      return "Video captured, but video analysis failed.";
    case "primary_multimodal_low_signal":
    case "primary_multimodal_empty":
    case "video_summary_low_signal":
    case "video_summary_empty":
      return "Video captured, but analysis did not return a reliable summary.";
    case "video_analysis_not_implemented":
      return "Video captured; deep video understanding is not enabled in this build yet.";
    default:
      return "Video captured; analysis is pending in this build.";
  }
}

function pickPrimaryFailureReason(
  analysisFailureReason: string | undefined,
  priority: string[],
): string | undefined {
  const reasons = (analysisFailureReason ?? "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  return priority.find((item) => reasons.includes(item)) ?? reasons[0];
}

function isProviderUnavailableMessage(text: string): boolean {
  return [
    "api key",
    "not configured",
    "no provider",
    "provider unavailable",
    "missing provider",
    "unauthorized",
    "forbidden",
    "401",
    "429",
    "rate limit",
    "fetch failed",
    "network error",
    "service unavailable",
    "bad gateway",
    "connection refused",
    "socket hang up",
    "econnrefused",
    "enotfound",
    "502",
    "503",
    "504",
  ].some((snippet) => text.includes(snippet));
}

function isFormatErrorMessage(text: string): boolean {
  return [
    "unsupported",
    "format",
    "codec",
    "mime",
    "content-type",
    "container",
  ].some((snippet) => text.includes(snippet));
}

function isTimeoutMessage(text: string): boolean {
  return ["timeout", "timed out", "abort", "deadline exceeded"].some((snippet) =>
    text.includes(snippet),
  );
}

function isImageCapabilityError(text: string): boolean {
  return [
    "input_image",
    "image_url",
    "does not support image",
    "does not support images",
    "not multimodal",
    "image input",
  ].some((snippet) => text.includes(snippet));
}

function isAudioCapabilityError(text: string): boolean {
  return [
    "input_audio",
    "audio input",
    "audio is not supported",
    "does not support audio",
    "does not support input_audio",
    "unsupported audio",
  ].some((snippet) => text.includes(snippet));
}

function isVideoCapabilityError(text: string): boolean {
  return [
    "input_video",
    "video input",
    "video is not supported",
    "does not support video",
    "does not support input_video",
    "unsupported video",
  ].some((snippet) => text.includes(snippet));
}

function parseOptionalInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
