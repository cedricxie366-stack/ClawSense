import { describe, expect, it } from "vitest";
import { resolveClawSenseConfig } from "../src/config.js";
import {
  resolveOpenAiClient,
  resolveOpenAiClientForProvider,
  resolvePrimaryMultimodalModel,
} from "../src/openai-client.js";

function createRuntimeConfig(overrides: Record<string, unknown> = {}) {
  return {
    models: {
      providers: {
        dashscope: {
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "sk-dashscope-123",
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-runtime-openai-123",
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "dashscope/qwen3-max-2026-01-23",
        },
      },
    },
    ...overrides,
  };
}

describe("openai-client provider routing", () => {
  it("resolves provider-scoped client credentials for dashscope when explicit openai key exists", () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "sk-explicit-openai-123",
      openaiBaseUrl: "https://api.openai.com/v1",
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
    });
    const runtimeConfig = createRuntimeConfig();

    const client = resolveOpenAiClientForProvider(cfg, runtimeConfig as any, "dashscope");
    expect(client).not.toBeNull();
    expect((client as any).apiKey).toBe("sk-dashscope-123");
    expect((client as any).baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("keeps default non-scoped client on explicit openai credentials", () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "sk-explicit-openai-123",
      openaiBaseUrl: "https://api.openai.com/v1",
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
    });
    const runtimeConfig = createRuntimeConfig();

    const client = resolveOpenAiClient(cfg, runtimeConfig as any);
    expect(client).not.toBeNull();
    expect((client as any).apiKey).toBe("sk-explicit-openai-123");
    expect((client as any).baseURL).toBe("https://api.openai.com/v1");
  });

  it("allows known non-openai provider to reuse explicit compatible credentials when provider map has no api key", () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "sk-compatible-provider-123",
      openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      visionProvider: "dashscope",
      visionModel: "qwen3-omni-flash",
    });
    const runtimeConfig = createRuntimeConfig({
      models: {
        providers: {
          dashscope: {
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
    });

    const client = resolveOpenAiClientForProvider(cfg, runtimeConfig as any, "dashscope");
    expect(client).not.toBeNull();
    expect((client as any).apiKey).toBe("sk-compatible-provider-123");
    expect((client as any).baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("does not route explicit openai key into unknown non-openai provider", () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "sk-explicit-openai-123",
      openaiBaseUrl: "https://api.openai.com/v1",
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
    });
    const runtimeConfig = createRuntimeConfig();

    const client = resolveOpenAiClientForProvider(cfg, runtimeConfig as any, "unknown-provider");
    expect(client).toBeNull();
  });

  it("keeps runtime primary provider id for cross-provider fallback planning", () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "sk-explicit-openai-123",
      openaiBaseUrl: "https://api.openai.com/v1",
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
    });
    const runtimeConfig = createRuntimeConfig();

    const primary = resolvePrimaryMultimodalModel(cfg, runtimeConfig as any);
    expect(primary.providerId).toBe("dashscope");
    expect(primary.model).toBe("qwen3-max-2026-01-23");
  });

  it("prefers OpenClaw imageModel primary for image and video analysis only", () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "sk-explicit-openai-123",
      openaiBaseUrl: "https://api.openai.com/v1",
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
    });
    const runtimeConfig = createRuntimeConfig({
      agents: {
        defaults: {
          model: {
            primary: "dashscope/qwen3-max-2026-01-23",
          },
          imageModel: {
            primary: "dashscope/qwen3.6-plus",
          },
          models: {
            "dashscope/qwen3-max-2026-01-23": {
              alias: "qwen3-max-2026-01-23",
            },
            "dashscope/qwen3.6-plus": {
              alias: "qwen3.6-plus",
            },
          },
        },
      },
    });

    const defaultPrimary = resolvePrimaryMultimodalModel(cfg, runtimeConfig as any);
    const imagePrimary = resolvePrimaryMultimodalModel(cfg, runtimeConfig as any, "image");
    const videoPrimary = resolvePrimaryMultimodalModel(cfg, runtimeConfig as any, "video");

    expect(defaultPrimary.source).toBe("runtime-primary");
    expect(defaultPrimary.model).toBe("qwen3-max-2026-01-23");
    expect(imagePrimary.source).toBe("runtime-image");
    expect(imagePrimary.model).toBe("qwen3.6-plus");
    expect(imagePrimary.providerId).toBe("dashscope");
    expect(videoPrimary.source).toBe("runtime-image");
    expect(videoPrimary.model).toBe("qwen3.6-plus");
    expect(videoPrimary.providerId).toBe("dashscope");
  });
});
