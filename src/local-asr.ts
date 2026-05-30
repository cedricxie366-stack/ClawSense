import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ClawSenseConfig } from "./config.js";
import type { AudioTranscriptionAttempt } from "./openai-client.js";
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

type LoggerLike = {
  warn(message: string): void;
};

const require = createRequire(import.meta.url);
const recognizerCache = new Map<string, Promise<SherpaOfflineRecognizer>>();

export async function transcribeAudioWithLocalAsr(params: {
  cfg: ClawSenseConfig;
  filePath: string;
  resolveStateDir: () => string;
  logger?: LoggerLike;
}): Promise<AudioTranscriptionAttempt> {
  const provider = localAsrProviderLabel(params.cfg);
  if (params.cfg.localAsrBackend === "none") {
    return {
      analysisProvider: provider,
      analysisFailureReason: "query_time_local_asr_disabled",
    };
  }

  if (params.cfg.localAsrBackend !== "sherpa-onnx-sensevoice") {
    return {
      analysisProvider: provider,
      analysisFailureReason: "query_time_local_asr_unavailable",
    };
  }

  try {
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
        analysisProvider: provider,
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
        analysisProvider: provider,
      };
    }
    return {
      analysisProvider: provider,
      analysisFailureReason: "query_time_local_asr_empty",
    };
  } catch (error) {
    params.logger?.warn(`[clawsense] local ASR failed: ${String(error)}`);
    return {
      analysisProvider: provider,
      analysisFailureReason: classifyLocalAsrError(error),
    };
  }
}

export function localAsrProviderLabel(cfg: ClawSenseConfig): string {
  if (cfg.localAsrBackend === "sherpa-onnx-sensevoice") {
    return `local-asr:sherpa-onnx-sensevoice:${cfg.localAsrLanguage}`;
  }
  return "local-asr:none";
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

function classifyLocalAsrError(error: unknown): string {
  const text = String(error).toLowerCase();
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
