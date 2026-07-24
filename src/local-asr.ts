import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import type { ClawSenseConfig } from "./config.js";
import type {
  AudioSpeakerTimelineSegment,
  AudioTranscriptSegment,
  AudioTranscriptionAttempt,
} from "./openai-client.js";
import { normalizeSemanticText } from "./utils.js";

type SherpaWaveform = {
  samples: Float32Array;
  sampleRate: number;
};

type SherpaOfflineStream = {
  acceptWaveform(obj: SherpaWaveform): void;
};

type SherpaOfflineRecognizer = {
  createStream(): SherpaOfflineStream;
  decodeAsync(stream: SherpaOfflineStream): Promise<unknown>;
  getResult(stream: SherpaOfflineStream): { text?: string };
};

type SherpaOnnxNode = {
  OfflineRecognizer: {
    createAsync(config: unknown): Promise<SherpaOfflineRecognizer>;
  };
  readWave(filePath: string): SherpaWaveform;
};

type LocalAsrCommandOutput = {
  transcript?: string;
  text?: string;
  language?: string;
  segments?: unknown;
  sentences?: unknown;
  sentence_info?: unknown;
  speakerTimelineSegments?: unknown;
  speaker_timeline_segments?: unknown;
  speakerTimeline?: unknown;
  speaker_timeline?: unknown;
};

type LocalAsrBatchCommandOutput = {
  results?: unknown;
  items?: unknown;
};

type LoggerLike = {
  warn(message: string): void;
};

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const recognizerCache = new Map<string, Promise<SherpaOfflineRecognizer>>();
const COMMAND_OUTPUT_MAX_BUFFER = 8 * 1024 * 1024;

export type LocalAsrInspection = {
  backend: ClawSenseConfig["localAsrBackend"];
  enabled: boolean;
  provider: string;
  language: string;
  timeoutMs: number;
  command?: string;
  resolvedCommand?: string;
  commandExists?: boolean;
  commandExecutable?: boolean;
  model?: string;
  modelDir?: string;
  resolvedModelDir?: string;
  resolvedModelFile?: string;
  resolvedTokensFile?: string;
  ready: boolean;
  issues: string[];
  nextActions: string[];
};

export async function transcribeAudioWithLocalAsr(params: {
  cfg: ClawSenseConfig;
  filePath: string;
  resolveStateDir: () => string;
  logger?: LoggerLike;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<AudioTranscriptionAttempt> {
  const provider = localAsrProviderLabel(params.cfg);
  if (params.cfg.localAsrBackend === "none") {
    return {
      analysisProvider: provider,
      analysisFailureReason: "query_time_local_asr_disabled",
    };
  }

  try {
    if (params.cfg.localAsrBackend === "sherpa-onnx-sensevoice") {
      return await transcribeWithSherpaSenseVoice({
        cfg: params.cfg,
        filePath: params.filePath,
        resolveStateDir: params.resolveStateDir,
        provider,
      });
    }
    return await transcribeWithCommandBackend({
      cfg: params.cfg,
      filePath: params.filePath,
      resolveStateDir: params.resolveStateDir,
      provider,
      extraEnv: params.extraEnv,
    });
  } catch (error) {
    params.logger?.warn(`[clawsense] local ASR failed: ${String(error)}`);
    return {
      analysisProvider: provider,
      analysisFailureReason: classifyLocalAsrError(error),
    };
  }
}

export async function transcribeAudioBatchWithLocalAsr(params: {
  cfg: ClawSenseConfig;
  items: Array<{ id: string; filePath: string }>;
  resolveStateDir: () => string;
  logger?: LoggerLike;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<Map<string, AudioTranscriptionAttempt>> {
  const provider = localAsrProviderLabel(params.cfg);
  const results = new Map<string, AudioTranscriptionAttempt>();
  if (params.items.length === 0) {
    return results;
  }
  if (params.cfg.localAsrBackend === "none") {
    for (const item of params.items) {
      results.set(item.id, {
        analysisProvider: provider,
        analysisFailureReason: "query_time_local_asr_disabled",
      });
    }
    return results;
  }
  if (params.items.length === 1) {
    const item = params.items[0];
    results.set(
      item.id,
      await transcribeAudioWithLocalAsr({
        cfg: params.cfg,
        filePath: item.filePath,
        resolveStateDir: params.resolveStateDir,
        logger: params.logger,
        extraEnv: params.extraEnv,
      }),
    );
    return results;
  }
  if (params.cfg.localAsrBackend === "whisper" || params.cfg.localAsrBackend === "funasr") {
    const commandBatch = await transcribeCommandBatchWithFallback({
      cfg: params.cfg,
      items: params.items,
      resolveStateDir: params.resolveStateDir,
      provider,
      logger: params.logger,
      extraEnv: params.extraEnv,
    });
    if (commandBatch) {
      return commandBatch;
    }
  }

  for (const item of params.items) {
    results.set(
      item.id,
      await transcribeAudioWithLocalAsr({
        cfg: params.cfg,
        filePath: item.filePath,
        resolveStateDir: params.resolveStateDir,
        logger: params.logger,
        extraEnv: params.extraEnv,
      }),
    );
  }
  return results;
}

export function localAsrProviderLabel(cfg: ClawSenseConfig): string {
  if (cfg.localAsrBackend === "whisper") {
    return `local-asr:whisper:${cfg.localAsrLanguage}`;
  }
  if (cfg.localAsrBackend === "funasr") {
    return `local-asr:funasr:${cfg.localAsrLanguage}`;
  }
  if (cfg.localAsrBackend === "sherpa-onnx-sensevoice") {
    return `local-asr:sherpa-onnx-sensevoice:${cfg.localAsrLanguage}`;
  }
  return "local-asr:none";
}

async function transcribeCommandBatchWithFallback(params: {
  cfg: ClawSenseConfig;
  items: Array<{ id: string; filePath: string }>;
  resolveStateDir: () => string;
  provider: string;
  logger?: LoggerLike;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<Map<string, AudioTranscriptionAttempt> | null> {
  const command = resolveLocalAsrCommand(params.cfg);
  if (!command) {
    return null;
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-asr-batch-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  try {
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        items: params.items.map((item) => ({ id: item.id, path: item.filePath })),
      }),
      "utf8",
    );
    const { stdout } = await execFileAsync(
      resolveConfiguredPath(command, params.resolveStateDir()),
      ["--batch-json", manifestPath],
      {
        env: {
          ...buildLocalAsrCommandEnv(
            params.cfg,
            params.items[0]?.filePath ?? "",
            params.resolveStateDir(),
            params.extraEnv,
          ),
          CLAWSENSE_ASR_BATCH: "1",
          CLAWSENSE_ASR_BATCH_MANIFEST: manifestPath,
        },
        maxBuffer: COMMAND_OUTPUT_MAX_BUFFER * Math.max(1, Math.min(params.items.length, 8)),
        timeout: Math.max(params.cfg.localAsrTimeoutMs, params.cfg.localAsrTimeoutMs * params.items.length),
      },
    );
    return parseLocalAsrBatchCommandOutput(stdout, params.provider, params.items);
  } catch (error) {
    params.logger?.warn(`[clawsense] local ASR batch failed, falling back to per-file mode: ${String(error)}`);
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function inspectLocalAsrConfig(params: {
  cfg: ClawSenseConfig;
  resolveStateDir: () => string;
}): Promise<LocalAsrInspection> {
  const stateDir = params.resolveStateDir();
  const provider = localAsrProviderLabel(params.cfg);
  const issues: string[] = [];
  const nextActions: string[] = [];
  const base: LocalAsrInspection = {
    backend: params.cfg.localAsrBackend,
    enabled: params.cfg.localAsrBackend !== "none",
    provider,
    language: params.cfg.localAsrLanguage,
    timeoutMs: params.cfg.localAsrTimeoutMs,
    ready: false,
    issues,
    nextActions,
  };

  if (params.cfg.localAsrBackend === "none") {
    issues.push("local_asr_disabled");
    nextActions.push(
      'Set plugins.entries.clawsense.config.localAsrBackend to "whisper" or "funasr".',
    );
    return base;
  }

  if (params.cfg.localAsrBackend === "whisper" || params.cfg.localAsrBackend === "funasr") {
    const command = resolveLocalAsrCommand(params.cfg);
    const model =
      params.cfg.localAsrBackend === "whisper"
        ? params.cfg.localAsrWhisperModel
        : params.cfg.localAsrFunAsrModel;
    base.command = command;
    base.model = model;
    if (!command) {
      issues.push("local_asr_command_missing");
      nextActions.push(
        params.cfg.localAsrBackend === "whisper"
          ? "Configure localAsrWhisperCommand or localAsrCommand to an executable wrapper."
          : "Configure localAsrFunAsrCommand or localAsrCommand to an executable wrapper.",
      );
      return base;
    }
    const resolvedCommand = resolveConfiguredPath(command, stateDir);
    base.resolvedCommand = resolvedCommand;
    const stat = await statFileIfExists(resolvedCommand);
    base.commandExists = Boolean(stat?.isFile());
    base.commandExecutable = Boolean(stat && (Number(stat.mode) & 0o111));
    if (!base.commandExists) {
      issues.push("local_asr_command_not_found");
      nextActions.push(`Create or configure the ASR command at ${resolvedCommand}.`);
      return base;
    }
    if (!base.commandExecutable) {
      issues.push("local_asr_command_not_executable");
      nextActions.push(`Run chmod +x ${resolvedCommand}.`);
      return base;
    }
    base.ready = true;
    return base;
  }

  base.modelDir = params.cfg.localAsrModelDir;
  if (!params.cfg.localAsrModelDir) {
    issues.push("local_asr_model_dir_missing");
    nextActions.push("Configure localAsrModelDir for sherpa-onnx-sensevoice.");
    return base;
  }
  base.resolvedModelDir = resolveConfiguredPath(params.cfg.localAsrModelDir, stateDir);
  try {
    const modelPaths = await resolveSenseVoiceModelPaths(params.cfg, stateDir);
    base.resolvedModelFile = modelPaths.modelPath;
    base.resolvedTokensFile = modelPaths.tokensPath;
    base.ready = true;
  } catch (error) {
    issues.push("local_asr_model_missing");
    nextActions.push(String(error));
  }
  return base;
}

async function transcribeWithSherpaSenseVoice(params: {
  cfg: ClawSenseConfig;
  filePath: string;
  resolveStateDir: () => string;
  provider: string;
}): Promise<AudioTranscriptionAttempt> {
  const modelPaths = await resolveSenseVoiceModelPaths(params.cfg, params.resolveStateDir());
  const sherpa = loadSherpaOnnxNode();
  const recognizer = await getSenseVoiceRecognizer({
    cfg: params.cfg,
    modelPath: modelPaths.modelPath,
    tokensPath: modelPaths.tokensPath,
    sherpa,
  });
  const wave = sherpa.readWave(params.filePath);
  if (!wave.samples.length) {
    return {
      analysisProvider: params.provider,
      analysisFailureReason: "query_time_local_asr_empty",
    };
  }
  const stream = recognizer.createStream();
  stream.acceptWaveform(wave);
  await recognizer.decodeAsync(stream);
  const result = recognizer.getResult(stream);
  const transcript = normalizeSemanticText(result.text ?? "");
  if (transcript) {
    return {
      transcript,
      transcriptSegments: [{ text: transcript }],
      language: params.cfg.localAsrLanguage,
      analysisProvider: params.provider,
    };
  }
  return {
    analysisProvider: params.provider,
    analysisFailureReason: "query_time_local_asr_empty",
  };
}

async function transcribeWithCommandBackend(params: {
  cfg: ClawSenseConfig;
  filePath: string;
  resolveStateDir: () => string;
  provider: string;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<AudioTranscriptionAttempt> {
  const command = resolveLocalAsrCommand(params.cfg);
  if (!command) {
    return {
      analysisProvider: params.provider,
      analysisFailureReason: "query_time_local_asr_command_missing",
    };
  }
  const { stdout } = await execFileAsync(resolveConfiguredPath(command, params.resolveStateDir()), [params.filePath], {
    env: buildLocalAsrCommandEnv(params.cfg, params.filePath, params.resolveStateDir(), params.extraEnv),
    maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
    timeout: params.cfg.localAsrTimeoutMs,
  });
  const parsed = parseLocalAsrCommandOutput(stdout);
  const transcript = normalizeSemanticText(
    parsed.transcript ?? parsed.transcriptSegments.map((segment) => segment.text).join(" "),
  );
  if (!transcript) {
    return {
      analysisProvider: params.provider,
      analysisFailureReason: "query_time_local_asr_empty",
    };
  }
  return {
    transcript,
    transcriptSegments: parsed.transcriptSegments.length > 0 ? parsed.transcriptSegments : [{ text: transcript }],
    ...(parsed.speakerTimelineSegments && parsed.speakerTimelineSegments.length > 0
      ? { speakerTimelineSegments: parsed.speakerTimelineSegments }
      : {}),
    language: parsed.language ?? params.cfg.localAsrLanguage,
    analysisProvider: params.provider,
  };
}

function resolveLocalAsrCommand(cfg: ClawSenseConfig): string | undefined {
  if (cfg.localAsrBackend === "whisper") {
    return cfg.localAsrWhisperCommand ?? cfg.localAsrCommand;
  }
  if (cfg.localAsrBackend === "funasr") {
    return cfg.localAsrFunAsrCommand ?? cfg.localAsrCommand;
  }
  return undefined;
}

function buildLocalAsrCommandEnv(
  cfg: ClawSenseConfig,
  filePath: string,
  stateDir: string,
  extraEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const model =
    cfg.localAsrBackend === "whisper"
      ? cfg.localAsrWhisperModel
      : cfg.localAsrBackend === "funasr"
        ? cfg.localAsrFunAsrModel
        : undefined;
  return {
    ...process.env,
    CLAWSENSE_ASR_BACKEND: cfg.localAsrBackend,
    CLAWSENSE_ASR_INPUT: filePath,
    CLAWSENSE_ASR_LANGUAGE: cfg.localAsrLanguage,
    CLAWSENSE_ASR_MODEL: model ?? "",
    CLAWSENSE_ASR_STATE_DIR: stateDir,
    CLAWSENSE_WHISPER_MODEL: cfg.localAsrWhisperModel ?? model ?? "",
    CLAWSENSE_FUNASR_MODEL: cfg.localAsrFunAsrModel ?? model ?? "",
    ...extraEnv,
  };
}

export function parseLocalAsrCommandOutput(stdout: string): {
  transcript?: string;
  transcriptSegments: AudioTranscriptSegment[];
  speakerTimelineSegments?: AudioSpeakerTimelineSegment[];
  language?: string;
} {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { transcriptSegments: [] };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parseLocalAsrJsonOutput(parsed);
  } catch {
    const jsonLine = extractLastJsonLine(trimmed);
    if (jsonLine) {
      try {
        return parseLocalAsrJsonOutput(JSON.parse(jsonLine) as unknown);
      } catch {
        // Fall through to treating stdout as plain text.
      }
    }
    const transcript = normalizeLocalAsrTranscriptText(trimmed);
    return {
      transcript,
      transcriptSegments: synthesizeTranscriptSegments(transcript),
    };
  }
}

export function parseLocalAsrBatchCommandOutput(
  stdout: string,
  provider: string,
  items: Array<{ id: string; filePath: string }>,
): Map<string, AudioTranscriptionAttempt> {
  const parsed = parseLocalAsrRawJson(stdout);
  const results = new Map<string, AudioTranscriptionAttempt>();
  if (!parsed) {
    return results;
  }
  const rawResults = readBatchResults(parsed);
  if (!rawResults.length) {
    return results;
  }
  for (let index = 0; index < rawResults.length; index += 1) {
    const rawResult = rawResults[index];
    const fallbackId = items[index]?.id;
    if (!isRecord(rawResult)) {
      if (!fallbackId) {
        continue;
      }
      const transcript = normalizeLocalAsrTranscriptText(String(rawResult ?? ""));
      results.set(fallbackId, {
        ...(transcript ? { transcript, transcriptSegments: synthesizeTranscriptSegments(transcript) } : {}),
        analysisProvider: provider,
        ...(transcript ? {} : { analysisFailureReason: "query_time_local_asr_empty" }),
      });
      continue;
    }
    const id = firstString(rawResult.id, rawResult.itemId, rawResult.eventId) ?? fallbackId;
    if (!id) {
      continue;
    }
    const error = firstString(rawResult.error, rawResult.analysisFailureReason);
    if (error) {
      results.set(id, {
        analysisProvider: provider,
        analysisFailureReason: error,
      });
      continue;
    }
    const single = parseLocalAsrJsonOutput(rawResult);
    const transcript = normalizeSemanticText(
      single.transcript ?? single.transcriptSegments.map((segment) => segment.text).join(" "),
    );
    const transcriptSegments =
      single.transcriptSegments.length > 0 ? single.transcriptSegments : synthesizeTranscriptSegments(transcript);
    results.set(id, {
      ...(transcript ? { transcript } : {}),
      ...(transcriptSegments.length > 0 ? { transcriptSegments } : {}),
      ...(single.speakerTimelineSegments && single.speakerTimelineSegments.length > 0
        ? { speakerTimelineSegments: single.speakerTimelineSegments }
        : {}),
      ...(single.language ? { language: single.language } : {}),
      analysisProvider: provider,
      ...(transcript ? {} : { analysisFailureReason: "query_time_local_asr_empty" }),
    });
  }
  return results;
}

function extractLastJsonLine(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      (line.startsWith("{") && line.endsWith("}")) ||
      (line.startsWith("[") && line.endsWith("]"))
    ) {
      return line;
    }
  }
  return undefined;
}

function parseLocalAsrRawJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const jsonLine = extractLastJsonLine(trimmed);
    if (!jsonLine) {
      return null;
    }
    try {
      return JSON.parse(jsonLine) as unknown;
    } catch {
      return null;
    }
  }
}

function readBatchResults(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const output = parsed as LocalAsrBatchCommandOutput;
  if (Array.isArray(output.results)) {
    return output.results;
  }
  if (Array.isArray(output.items)) {
    return output.items;
  }
  return [];
}

function parseLocalAsrJsonOutput(parsed: unknown): {
  transcript?: string;
  transcriptSegments: AudioTranscriptSegment[];
  speakerTimelineSegments?: AudioSpeakerTimelineSegment[];
  language?: string;
} {
  if (typeof parsed === "string") {
    const transcript = normalizeLocalAsrTranscriptText(parsed);
    return { transcript, transcriptSegments: synthesizeTranscriptSegments(transcript) };
  }
  if (Array.isArray(parsed)) {
    const transcriptSegments = normalizeAudioTranscriptSegments(parsed, "segments");
    return {
      transcript: normalizeSemanticText(transcriptSegments.map((segment) => segment.text).join(" ")),
      transcriptSegments,
    };
  }
  if (!isRecord(parsed)) {
    return { transcriptSegments: [] };
  }
  const output = parsed as LocalAsrCommandOutput;
  const directTranscript = cleanOptionalLocalAsrText(firstString(output.transcript, output.text));
  const segmentsSource =
    Array.isArray(output.segments)
      ? { key: "segments", value: output.segments }
      : Array.isArray(output.sentences)
        ? { key: "sentences", value: output.sentences }
        : Array.isArray(output.sentence_info)
          ? { key: "sentence_info", value: output.sentence_info }
          : null;
  const transcriptSegments = segmentsSource
    ? normalizeAudioTranscriptSegments(segmentsSource.value, segmentsSource.key)
    : [];
  const speakerTimelineSource =
    Array.isArray(output.speakerTimelineSegments)
      ? { key: "speakerTimelineSegments", value: output.speakerTimelineSegments }
      : Array.isArray(output.speaker_timeline_segments)
        ? { key: "speaker_timeline_segments", value: output.speaker_timeline_segments }
        : Array.isArray(output.speakerTimeline)
          ? { key: "speakerTimeline", value: output.speakerTimeline }
          : Array.isArray(output.speaker_timeline)
            ? { key: "speaker_timeline", value: output.speaker_timeline }
            : null;
  const speakerTimelineSegments = speakerTimelineSource
    ? normalizeAudioTranscriptSegments(speakerTimelineSource.value, speakerTimelineSource.key)
    : undefined;
  const transcript = normalizeSemanticText(
    directTranscript ?? transcriptSegments.map((segment) => segment.text).join(" "),
  );
  return {
    transcript,
    transcriptSegments: transcriptSegments.length > 0 ? transcriptSegments : synthesizeTranscriptSegments(transcript),
    ...(speakerTimelineSegments && speakerTimelineSegments.length > 0 ? { speakerTimelineSegments } : {}),
    language: firstString(output.language),
  };
}

function synthesizeTranscriptSegments(transcript: string | undefined): AudioTranscriptSegment[] {
  const normalized = normalizeLocalAsrTranscriptText(transcript ?? "");
  if (!normalized) {
    return [];
  }
  const sentenceLike = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [];
  const segments = sentenceLike
    .map((text) => normalizeLocalAsrTranscriptText(text))
    .filter((text) => text.length > 0)
    .slice(0, 64)
    .map((text) => ({ text }));
  return segments.length > 0 ? segments : [{ text: normalized }];
}

function normalizeAudioTranscriptSegments(rawSegments: unknown[], sourceKey: string): AudioTranscriptSegment[] {
  const zeroBasedSpeakers = hasZeroBasedSpeakerLabels(rawSegments);
  return rawSegments
    .map((segment) => normalizeAudioTranscriptSegment(segment, sourceKey, zeroBasedSpeakers))
    .filter((segment): segment is AudioTranscriptSegment => Boolean(segment));
}

function normalizeAudioTranscriptSegment(
  rawSegment: unknown,
  sourceKey: string,
  zeroBasedSpeakers: boolean,
): AudioTranscriptSegment | null {
  if (!isRecord(rawSegment)) {
    if (typeof rawSegment === "string") {
      const text = normalizeLocalAsrTranscriptText(rawSegment);
      return text ? { text } : null;
    }
    return null;
  }
  const text = normalizeLocalAsrTranscriptText(firstString(rawSegment.text, rawSegment.transcript, rawSegment.sentence) ?? "");
  if (!text) {
    return null;
  }
  const startMs = readSegmentTimeMs(rawSegment, "start", sourceKey);
  const endMs = readSegmentTimeMs(rawSegment, "end", sourceKey);
  const speakerLabel = firstString(
    rawSegment.speakerLabel,
    rawSegment.speaker,
    rawSegment.spk,
    rawSegment.speaker_id,
  );
  const confidence = readFiniteNumber(rawSegment.confidence);
  return {
    ...(typeof startMs === "number" ? { startMs } : {}),
    ...(typeof endMs === "number" ? { endMs } : {}),
    text,
    ...(speakerLabel ? { speakerLabel: normalizeLocalAsrSpeakerLabel(speakerLabel, zeroBasedSpeakers) } : {}),
    ...(typeof confidence === "number" ? { confidence } : {}),
  };
}

function hasZeroBasedSpeakerLabels(rawSegments: unknown[]): boolean {
  return rawSegments.some((segment) => {
    if (!isRecord(segment)) {
      return false;
    }
    const speakerLabel = firstString(segment.speakerLabel, segment.speaker, segment.spk, segment.speaker_id);
    return speakerLabel === "0";
  });
}

function normalizeLocalAsrSpeakerLabel(value: string, zeroBasedSpeakers: boolean): string {
  const raw = value.trim();
  if (/^speaker_/i.test(raw)) {
    return raw;
  }
  if (/^\d+$/.test(raw)) {
    const speakerIndex = zeroBasedSpeakers ? Number(raw) + 1 : Number(raw);
    return `speaker_${Math.max(1, speakerIndex)}`;
  }
  return raw;
}

function readSegmentTimeMs(
  rawSegment: Record<string, unknown>,
  side: "start" | "end",
  sourceKey: string,
): number | undefined {
  const explicitMs = readFiniteNumber(rawSegment[`${side}Ms`]);
  if (typeof explicitMs === "number") {
    return Math.max(0, Math.round(explicitMs));
  }
  const snakeMs = readFiniteNumber(rawSegment[`${side}_ms`]);
  if (typeof snakeMs === "number") {
    return Math.max(0, Math.round(snakeMs));
  }
  const seconds = readFiniteNumber(rawSegment[`${side}Sec`]) ?? readFiniteNumber(rawSegment[`${side}_sec`]);
  if (typeof seconds === "number") {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const generic = readFiniteNumber(rawSegment[side]);
  if (typeof generic !== "number") {
    return undefined;
  }
  // FunASR sentence_info uses millisecond start/end, while Whisper-like
  // segment arrays usually expose seconds. Wrapper scripts should prefer
  // startMs/endMs, but this keeps raw JSON from common tools usable.
  const value = sourceKey === "sentence_info" ? generic : generic * 1000;
  return Math.max(0, Math.round(value));
}

function cleanOptionalLocalAsrText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return normalizeLocalAsrTranscriptText(value);
}

function normalizeLocalAsrTranscriptText(value: string): string {
  return normalizeSemanticText(
    value
      // SenseVoice/FunASR can emit control tags such as <|zh|>,
      // <|NEUTRAL|>, or spaced variants like < | S pe ech | >.
      .replace(/<\s*\|?[^<>]{1,48}\|?\s*>/g, " ")
      .replace(/\s+([，。！？、；：,.!?;:])/g, "$1"),
  );
}

async function resolveSenseVoiceModelPaths(
  cfg: ClawSenseConfig,
  stateDir: string,
): Promise<{ modelPath: string; tokensPath: string }> {
  if (!cfg.localAsrModelDir) {
    throw new Error("localAsrModelDir is not configured");
  }
  const modelDir = resolveConfiguredPath(cfg.localAsrModelDir, stateDir);
  const modelPath = cfg.localAsrModelFile
    ? resolveConfiguredPath(cfg.localAsrModelFile, modelDir)
    : await firstExistingPath([
        path.join(modelDir, "model.int8.onnx"),
        path.join(modelDir, "model.onnx"),
      ]);
  const tokensPath = cfg.localAsrTokensFile
    ? resolveConfiguredPath(cfg.localAsrTokensFile, modelDir)
    : path.join(modelDir, "tokens.txt");
  await assertReadableFile(modelPath);
  await assertReadableFile(tokensPath);
  return { modelPath, tokensPath };
}

async function getSenseVoiceRecognizer(params: {
  cfg: ClawSenseConfig;
  modelPath: string;
  tokensPath: string;
  sherpa: SherpaOnnxNode;
}): Promise<SherpaOfflineRecognizer> {
  const cacheKey = [
    params.modelPath,
    params.tokensPath,
    params.cfg.localAsrLanguage,
    params.cfg.localAsrNumThreads,
  ].join("\n");
  const existing = recognizerCache.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created = params.sherpa.OfflineRecognizer.createAsync({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      senseVoice: {
        model: params.modelPath,
        language: params.cfg.localAsrLanguage,
        useInverseTextNormalization: 1,
      },
      tokens: params.tokensPath,
      numThreads: params.cfg.localAsrNumThreads,
      debug: 0,
      provider: "cpu",
    },
  });
  recognizerCache.set(cacheKey, created);
  return created;
}

function loadSherpaOnnxNode(): SherpaOnnxNode {
  return require("sherpa-onnx-node") as SherpaOnnxNode;
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  const expanded = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

async function firstExistingPath(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await assertReadableFile(candidate);
      return candidate;
    } catch {
      // Try the next conventional filename.
    }
  }
  throw new Error(`No local ASR model file found in candidates: ${candidates.join(", ")}`);
}

async function assertReadableFile(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }
}

async function statFileIfExists(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function classifyLocalAsrError(error: unknown): string {
  const text = String(error).toLowerCase();
  const code = isRecord(error) ? String(error.code ?? "").toLowerCase() : "";
  const signal = isRecord(error) ? String(error.signal ?? "").toLowerCase() : "";
  if (code === "enoent" || text.includes("enoent") || text.includes("command_missing")) {
    return "query_time_local_asr_command_missing";
  }
  if (signal === "sigterm" || text.includes("timeout") || text.includes("timed out")) {
    return "query_time_local_asr_timeout";
  }
  if (text.includes("cannot find module") || text.includes("could not find sherpa-onnx-node")) {
    return "query_time_local_asr_unavailable";
  }
  if (text.includes("localasrmodeldir") || text.includes("no local asr model")) {
    return "query_time_local_asr_model_missing";
  }
  if (text.includes("wave") || text.includes("format") || text.includes("read")) {
    return "query_time_local_asr_format_error";
  }
  return "query_time_local_asr_error";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
