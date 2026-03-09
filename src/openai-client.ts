import OpenAI from "openai";
import type { ClawSenseConfig } from "./config.js";
import type { OpenClawConfig } from "./openclaw-types.js";

export function resolveOpenAiClient(
  cfg: ClawSenseConfig,
  runtimeConfig: OpenClawConfig,
): OpenAI | null {
  const explicitApiKey = cfg.openaiApiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  const providers = ((runtimeConfig as Record<string, unknown>).models ?? {}) as Record<string, unknown>;
  const providerMap = ((providers.providers ?? {}) as Record<string, unknown>).openai as
    | Record<string, unknown>
    | undefined;
  const inheritedApiKey = typeof providerMap?.apiKey === "string" ? providerMap.apiKey : undefined;
  const baseURL =
    cfg.openaiBaseUrl?.trim() ||
    (typeof providerMap?.baseUrl === "string" && providerMap.baseUrl.trim()
      ? providerMap.baseUrl.trim()
      : undefined);
  const apiKey = explicitApiKey || inheritedApiKey;
  return apiKey ? new OpenAI({ apiKey, baseURL }) : null;
}
