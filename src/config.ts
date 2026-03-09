import { Type } from "@sinclair/typebox";

export const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const DEFAULT_GATEWAY_PORT = 3000;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
const DEFAULT_MEMORY_NAMESPACE = "clawsense";
const DEFAULT_VISION_PROVIDER = "openai";
const DEFAULT_VISION_MODEL = "gpt-4.1-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_MAX_PENDING_TOKENS = 10;

export const clawsenseConfigSchema = Type.Object(
  {
    publicBaseUrl: Type.Optional(Type.String()),
    gatewayPort: Type.Optional(Type.Number()),
    openaiApiKey: Type.Optional(Type.String()),
    openaiBaseUrl: Type.Optional(Type.String()),
    visionProvider: Type.Optional(Type.String()),
    visionModel: Type.Optional(Type.String()),
    embeddingModel: Type.Optional(Type.String()),
    embeddingDimensions: Type.Optional(Type.Number()),
    memoryDbPath: Type.Optional(Type.String()),
    memoryNamespace: Type.Optional(Type.String()),
    pairingTtlSeconds: Type.Optional(Type.Number()),
    maxPendingTokens: Type.Optional(Type.Number()),
    heartbeatIntervalSeconds: Type.Optional(Type.Number()),
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
  memoryDbPath?: string;
  memoryNamespace: string;
  pairingTtlSeconds: number;
  maxPendingTokens: number;
  heartbeatIntervalSeconds: number;
};

export function resolveClawSenseConfig(raw: Record<string, unknown> | undefined): ClawSenseConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  return {
    publicBaseUrl: readOptionalString(cfg.publicBaseUrl),
    gatewayPort: readOptionalNumber(cfg.gatewayPort) ?? DEFAULT_GATEWAY_PORT,
    openaiApiKey: readOptionalString(cfg.openaiApiKey),
    openaiBaseUrl: readOptionalString(cfg.openaiBaseUrl),
    visionProvider: readOptionalString(cfg.visionProvider) ?? DEFAULT_VISION_PROVIDER,
    visionModel: readOptionalString(cfg.visionModel) ?? DEFAULT_VISION_MODEL,
    embeddingModel: readOptionalString(cfg.embeddingModel) ?? DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: readOptionalNumber(cfg.embeddingDimensions) ?? DEFAULT_EMBEDDING_DIMENSIONS,
    memoryDbPath: readOptionalString(cfg.memoryDbPath),
    memoryNamespace: readOptionalString(cfg.memoryNamespace) ?? DEFAULT_MEMORY_NAMESPACE,
    pairingTtlSeconds: readOptionalNumber(cfg.pairingTtlSeconds) ?? DEFAULT_PAIRING_TTL_SECONDS,
    maxPendingTokens: readOptionalNumber(cfg.maxPendingTokens) ?? DEFAULT_MAX_PENDING_TOKENS,
    heartbeatIntervalSeconds:
      readOptionalNumber(cfg.heartbeatIntervalSeconds) ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
