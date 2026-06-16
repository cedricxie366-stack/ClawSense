import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClawSenseConfig, type ClawSenseConfig } from "../src/config.js";
import { ClawSenseMemoryStore } from "../src/memory-store.js";
import {
  analyzeImageWithPrimaryModel,
  analyzeVideoWithPrimaryModel,
  resolveOpenAiClient,
  resolveOpenAiClientForProvider,
  resolvePrimaryMultimodalModel,
  resolveReviewGenerationModel,
  transcribeAudioWithFallbackModel,
  understandAudioWithPrimaryModel,
} from "../src/openai-client.js";
import { ClawSenseReviewEngine } from "../src/review-engine.js";
import { ClawSenseStateStore, type ClawSenseCaptureEvent, toLocalDateKey } from "../src/state-store.js";

describe("ClawSenseMemoryStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-memory-test-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 10, 14, 0, 0));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function* createChatStream(chunks: Array<Record<string, unknown>>) {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  it("normalizes host model capability mode flags from config", () => {
    const normalized = resolveClawSenseConfig({
      hostModelAudioMode: "ASR-FIRST",
      hostModelImageMode: "METADATA-ONLY",
      hostModelVideoMode: "DIRECT",
    });
    const defaults = resolveClawSenseConfig({
      hostModelAudioMode: "custom-audio-mode",
      hostModelImageMode: "custom-image-mode",
      hostModelVideoMode: "custom-video-mode",
    });

    expect(normalized.hostModelAudioMode).toBe("asr-first");
    expect(normalized.hostModelImageMode).toBe("metadata-only");
    expect(normalized.hostModelVideoMode).toBe("direct");
    expect(defaults.hostModelAudioMode).toBe("balanced");
    expect(defaults.hostModelImageMode).toBe("multimodal");
    expect(defaults.hostModelVideoMode).toBe("none");
  });

  it("prefers the current OpenClaw primary multimodal model for images before falling back", async () => {
    const openai = {
      responses: {
        create: vi
          .fn()
          .mockRejectedValueOnce(new Error("input_image is not supported by this model"))
          .mockRejectedValueOnce(new Error("input_image is not supported by this model"))
          .mockResolvedValueOnce({
            output_text:
              "桌面上摊着演示提纲、便签和一台打开文档的电脑，看起来像是在准备一次产品演示。",
          }),
      },
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("input_image is not supported by this model")),
        },
      },
    } as any;

    const result = await analyzeImageWithPrimaryModel({
      cfg: resolveClawSenseConfig({
        visionProvider: "OpenAI",
        visionModel: "gpt-4.1-mini",
        reviewModel: "gpt-review-only",
      }),
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
            },
          },
        },
      },
      buffer: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      primaryOpenai: openai,
      fallbackOpenai: openai,
    });

    expect(result.text).toContain("产品演示");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary+openai-vision-fallback");
    expect(result.analysisFailureReason).toBe("primary_multimodal_not_image_capable");
    expect(openai.responses.create.mock.calls[0]?.[0]?.model).toBe("gpt-4.1");
    expect(openai.responses.create.mock.calls[1]?.[0]?.model).toBe("gpt-4.1");
    expect(openai.responses.create.mock.calls[2]?.[0]?.model).toBe("gpt-4.1-mini");
  });

  it("parses provider-qualified runtime primary model refs before calling multimodal clients", async () => {
    const openai = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: "桌面上摆着笔记本、电脑和咖啡，像是在协同整理当天的讨论重点。",
        }),
      },
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as any;

    const runtimeConfig = {
      models: {
        providers: {
          dashscope: {
            apiKey: "sk-test",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "dashscope/qwen3.5-plus",
          },
          models: {
            "dashscope/qwen3.5-plus": {
              alias: "qwen3.5-plus",
            },
          },
        },
      },
    };

    const resolution = resolvePrimaryMultimodalModel(
      resolveClawSenseConfig({
        visionProvider: "openai",
        visionModel: "qwen3-omni-flash",
      }),
      runtimeConfig,
    );

    expect(resolution.model).toBe("qwen3.5-plus");
    expect(resolution.providerId).toBe("dashscope");

    await analyzeImageWithPrimaryModel({
      cfg: resolveClawSenseConfig({
        openaiApiKey: "sk-test",
        openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        visionProvider: "openai",
        visionModel: "qwen3-omni-flash",
      }),
      runtimeConfig,
      buffer: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      primaryOpenai: openai,
      fallbackOpenai: openai,
    });

    expect(openai.responses.create.mock.calls[0]?.[0]?.model).toBe("qwen3.5-plus");
  });

  it("keeps provider id when reviewModel is provider-qualified even if runtime provider registry is sparse", () => {
    const resolved = resolveReviewGenerationModel(
      resolveClawSenseConfig({
        reviewModel: "openai/gpt-4.1-mini",
      }),
      {
        models: {
          providers: {
            qwen: {
              apiKey: "qwen-test-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            },
          },
        },
      },
    );

    expect(resolved.model).toBe("gpt-4.1-mini");
    expect(resolved.providerId).toBe("openai");
    expect(resolved.source).toBe("review-model");
  });

  it("uses the Responses API first for audio understanding when the primary model accepts file input", async () => {
    const openai = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            transcript: "",
            summary: "听起来像在讨论明天演示的顺序和截图，值得后续确认具体分工。",
            transcriptConfidence: "low",
          }),
        }),
      },
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    transcript: "",
                    summary: "听起来像在讨论明天演示的顺序和截图，值得后续确认具体分工。",
                    transcriptConfidence: "low",
                  }),
                },
              },
            ],
          }),
        },
      },
    } as any;

    const result = await understandAudioWithPrimaryModel({
      cfg: resolveClawSenseConfig({
        visionModel: "gpt-4.1-mini",
      }),
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
            },
          },
        },
      },
      body: createWaveBuffer(5_000),
      fileName: "clip.wav",
      mime: "audio/wav",
      primaryOpenai: openai,
    });

    expect(result.transcript).toBeUndefined();
    expect(result.summary).toContain("听起来像在讨论明天演示");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary");
    expect(openai.responses.create).toHaveBeenCalledTimes(1);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("falls back from Responses audio understanding to chat completions before giving up", async () => {
    const openai = {
      responses: {
        create: vi.fn().mockRejectedValue(new Error("input_file is not supported by this model")),
      },
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    transcript: "",
                    summary: "听起来像在讨论明天演示的顺序和截图，值得后续确认具体分工。",
                    transcriptConfidence: "low",
                  }),
                },
              },
            ],
          }),
        },
      },
    } as any;

    const result = await understandAudioWithPrimaryModel({
      cfg: resolveClawSenseConfig({
        visionModel: "gpt-4.1-mini",
        reviewModel: "gpt-review-only",
      }),
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
            },
          },
        },
      },
      body: createWaveBuffer(5_000),
      fileName: "clip.wav",
      mime: "audio/wav",
      primaryOpenai: openai,
    });

    expect(result.transcript).toBeUndefined();
    expect(result.summary).toContain("听起来像在讨论明天演示");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary");
    expect(openai.responses.create).toHaveBeenCalledTimes(1);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(openai.responses.create.mock.calls[0]?.[0]?.model).toBe("gpt-4.1");
    expect(openai.chat.completions.create.mock.calls[0]?.[0]?.model).toBe("gpt-4.1");
  });

  it("retries audio chat with streaming mode when the provider requires streamed audio output", async () => {
    const openai = {
      responses: {
        create: vi.fn().mockRejectedValue(new Error("input_file is not supported by this model")),
      },
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(new Error("streaming output is required for audio input"))
            .mockResolvedValueOnce(
              createChatStream([
                {
                  choices: [
                    {
                      delta: {
                        content:
                          '{"transcript":"","summary":"听起来像在确认今天的安排和下一步动作，建议后续核实细节。","transcriptConfidence":"low"}',
                      },
                    },
                  ],
                },
              ]),
            ),
        },
      },
    } as any;

    const result = await understandAudioWithPrimaryModel({
      cfg: resolveClawSenseConfig({
        visionModel: "qwen3-omni-flash",
      }),
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "dashscope/qwen3.5-plus",
            },
          },
        },
        models: {
          providers: {
            dashscope: {
              apiKey: "sk-test",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            },
          },
        },
      },
      body: createWaveBuffer(5_000),
      fileName: "clip.wav",
      mime: "audio/wav",
      primaryOpenai: openai,
    });

    expect(result.summary).toContain("确认今天的安排和下一步动作");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary");
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(openai.chat.completions.create.mock.calls[1]?.[0]?.stream).toBe(true);
    expect(openai.chat.completions.create.mock.calls[1]?.[0]?.modalities).toEqual(["text"]);
  });

  it("falls back to the configured multimodal model for audio when the runtime primary rejects audio input", async () => {
    const primaryOpenai = {
      responses: {
        create: vi.fn().mockRejectedValue(new Error("audio input is not supported by this model")),
      },
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("input_audio is not supported by this model")),
        },
      },
    } as any;
    const fallbackOpenai = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            transcript: "",
            summary: "听起来像在确认今天这段长对话的重点和后续行动，建议回顾同一会话窗口。",
            transcriptConfidence: "low",
          }),
        }),
      },
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    transcript: "",
                    summary: "听起来像在确认今天这段长对话的重点和后续行动，建议回顾同一会话窗口。",
                    transcriptConfidence: "low",
                  }),
                },
              },
            ],
          }),
        },
      },
    } as any;

    const result = await understandAudioWithPrimaryModel({
      cfg: resolveClawSenseConfig({
        visionProvider: "qwen",
        visionModel: "gpt-4.1-mini",
      }),
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
              provider: "openai",
            },
          },
        },
      },
      body: createWaveBuffer(5_000),
      fileName: "clip.wav",
      mime: "audio/wav",
      primaryOpenai,
      fallbackOpenai,
    });

    expect(result.summary).toContain("长对话的重点");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary+qwen-audio-fallback");
    expect(result.analysisFailureReason).toBe("primary_multimodal_not_audio_capable");
    expect(primaryOpenai.responses.create.mock.calls[0]?.[0]?.model).toBe("gpt-4.1");
    expect(fallbackOpenai.responses.create.mock.calls[0]?.[0]?.model).toBe("gpt-4.1-mini");
  });

  it("switches to the configured fallback client for image analysis when primary and vision providers differ", async () => {
    const primaryOpenai = {
      responses: {
        create: vi.fn().mockRejectedValue(new Error("input_image is not supported by this model")),
      },
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("input_image is not supported by this model")),
        },
      },
    } as any;
    const fallbackOpenai = {
      responses: {
        create: vi.fn().mockResolvedValue({
          output_text:
            "桌面上摊着演示提纲、便签和一台打开文档的电脑，看起来像是在准备一次产品演示。",
        }),
      },
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as any;

    const result = await analyzeImageWithPrimaryModel({
      cfg: resolveClawSenseConfig({
        visionProvider: "qwen",
        visionModel: "qwen-vl-max",
      }),
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
              provider: "openai",
            },
          },
        },
      },
      buffer: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      primaryOpenai,
      fallbackOpenai,
    });

    expect(result.text).toContain("产品演示");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary+qwen-vision-fallback");
    expect(result.analysisFailureReason).toBe("primary_multimodal_not_image_capable");
    expect(primaryOpenai.responses.create).toHaveBeenCalled();
    expect(fallbackOpenai.responses.create).toHaveBeenCalled();
  });

  it("resolves provider-specific clients instead of reusing explicit OpenAI credentials for another provider", async () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "openai-explicit-key",
      openaiBaseUrl: "https://api.openai.example/v1",
      visionProvider: "qwen",
      visionModel: "qwen-vl-max",
    });
    const runtimeConfig = {
      agents: {
        defaults: {
          model: {
            primary: "gpt-4.1",
            provider: "openai",
          },
        },
      },
      models: {
        providers: {
          qwen: {
            apiKey: "qwen-test-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
    };

    const qwenClient = resolveOpenAiClientForProvider(cfg, runtimeConfig, "qwen");
    const missingClient = resolveOpenAiClientForProvider(cfg, runtimeConfig, "anthropic");

    expect(qwenClient).not.toBeNull();
    expect(qwenClient?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(qwenClient?.apiKey).toBe("qwen-test-key");
    expect(qwenClient?.baseURL).not.toBe("https://api.openai.example/v1");
    expect(missingClient).toBeNull();
  });

  it("ignores provider placeholder api keys and falls back to explicit OpenAI-compatible credentials when baseUrl is present", () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "sk-explicit-fallback",
      openaiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      visionProvider: "dashscope",
      visionModel: "qwen3-omni-flash",
    });
    const runtimeConfig = {
      models: {
        providers: {
          dashscope: {
            apiKey: "$api-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "dashscope/qwen3.5-plus",
          },
          models: {
            "dashscope/qwen3.5-plus": {
              alias: "qwen3.5-plus",
            },
          },
        },
      },
    };

    const client = resolveOpenAiClientForProvider(cfg, runtimeConfig, "dashscope");

    expect(client).not.toBeNull();
    expect(client?.apiKey).toBe("sk-explicit-fallback");
    expect(client?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("does not route explicit OpenAI key to a non-openai provider when baseUrl is missing", () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "sk-openai-real",
      visionProvider: "dashscope",
      visionModel: "qwen3-omni-flash",
    });
    const runtimeConfig = {
      models: {
        providers: {
          dashscope: {
            apiKey: "$api-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "dashscope/qwen3.5-plus",
          },
          models: {
            "dashscope/qwen3.5-plus": {
              alias: "qwen3.5-plus",
            },
          },
        },
      },
    };

    const dashscopeClient = resolveOpenAiClientForProvider(cfg, runtimeConfig, "dashscope");
    const openaiClient = resolveOpenAiClientForProvider(cfg, runtimeConfig, "openai");

    expect(dashscopeClient).toBeNull();
    expect(openaiClient).not.toBeNull();
    expect(openaiClient?.apiKey).toBe("sk-openai-real");
  });

  it("uses different resolved clients and base URLs when image fallback crosses providers", async () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "openai-explicit-key",
      openaiBaseUrl: "https://api.openai.example/v1",
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
    });
    const runtimeConfig = {
      agents: {
        defaults: {
          model: {
            primary: "qwen-vl-max",
            provider: "qwen",
          },
        },
      },
      models: {
        providers: {
          qwen: {
            apiKey: "qwen-test-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
    };
    const primaryOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "qwen");
    const fallbackOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "openai");

    expect(primaryOpenai).not.toBeNull();
    expect(fallbackOpenai).not.toBeNull();
    expect(primaryOpenai?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(fallbackOpenai?.baseURL).toBe("https://api.openai.example/v1");

    const primaryResponses = vi
      .spyOn(primaryOpenai!.responses, "create")
      .mockRejectedValue(new Error("input_image is not supported by this model"));
    const primaryChat = vi
      .spyOn(primaryOpenai!.chat.completions, "create")
      .mockRejectedValue(new Error("input_image is not supported by this model"));
    const fallbackResponses = vi.spyOn(fallbackOpenai!.responses, "create").mockResolvedValue({
      output_text:
        "桌面上摊着演示提纲、便签和一台打开文档的电脑，看起来像是在准备一次产品演示。",
    } as never);
    const fallbackChat = vi
      .spyOn(fallbackOpenai!.chat.completions, "create")
      .mockRejectedValue(new Error("should not be called"));

    const result = await analyzeImageWithPrimaryModel({
      cfg,
      runtimeConfig,
      buffer: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      primaryOpenai,
      fallbackOpenai,
    });

    expect(result.text).toContain("产品演示");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary+openai-vision-fallback");
    expect(primaryResponses.mock.calls[0]?.[0]?.model).toBe("qwen-vl-max");
    expect(fallbackResponses.mock.calls[0]?.[0]?.model).toBe("gpt-4.1-mini");
    expect(primaryChat).toHaveBeenCalled();
    expect(fallbackChat).not.toHaveBeenCalled();
  });

  it("still triggers image fallback when model id is the same but provider differs", async () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "openai-explicit-key",
      openaiBaseUrl: "https://api.openai.example/v1",
      visionProvider: "openai",
      visionModel: "shared-mm-model",
    });
    const runtimeConfig = {
      agents: {
        defaults: {
          model: {
            primary: "shared-mm-model",
            provider: "qwen",
          },
        },
      },
      models: {
        providers: {
          qwen: {
            apiKey: "qwen-test-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
    };
    const primaryOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "qwen");
    const fallbackOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "openai");

    const primaryResponses = vi
      .spyOn(primaryOpenai!.responses, "create")
      .mockRejectedValue(new Error("input_image is not supported by this provider"));
    const primaryChat = vi
      .spyOn(primaryOpenai!.chat.completions, "create")
      .mockRejectedValue(new Error("input_image is not supported by this provider"));
    const fallbackResponses = vi.spyOn(fallbackOpenai!.responses, "create").mockResolvedValue({
      output_text: "会议室白板上写着任务清单和负责人，看起来正在做排期讨论。",
    } as never);

    const result = await analyzeImageWithPrimaryModel({
      cfg,
      runtimeConfig,
      buffer: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      primaryOpenai,
      fallbackOpenai,
    });

    expect(result.text).toContain("任务清单");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary+openai-vision-fallback");
    expect(primaryResponses.mock.calls[0]?.[0]?.model).toBe("shared-mm-model");
    expect(primaryChat).toHaveBeenCalled();
    expect(fallbackResponses.mock.calls[0]?.[0]?.model).toBe("shared-mm-model");
  });

  it("uses different resolved clients and base URLs when video fallback crosses providers", async () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "openai-explicit-key",
      openaiBaseUrl: "https://api.openai.example/v1",
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
    });
    const runtimeConfig = {
      agents: {
        defaults: {
          model: {
            primary: "qwen-omni-turbo",
            provider: "qwen",
          },
        },
      },
      models: {
        providers: {
          qwen: {
            apiKey: "qwen-test-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
    };
    const primaryOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "qwen");
    const fallbackOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "openai");

    expect(primaryOpenai).not.toBeNull();
    expect(fallbackOpenai).not.toBeNull();
    expect(primaryOpenai?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(fallbackOpenai?.baseURL).toBe("https://api.openai.example/v1");

    const primaryResponses = vi
      .spyOn(primaryOpenai!.responses, "create")
      .mockRejectedValue(new Error("input_video is not supported by this model"));
    const fallbackResponses = vi.spyOn(fallbackOpenai!.responses, "create").mockResolvedValue({
      output_text: "画面里是会议室白板和两位同事，正在对照任务清单做进度同步。",
    } as never);

    const result = await analyzeVideoWithPrimaryModel({
      cfg,
      runtimeConfig,
      buffer: Buffer.from("fake-video"),
      fileName: "clip.mp4",
      mime: "video/mp4",
      primaryOpenai,
      fallbackOpenai,
    });

    expect(result.text).toContain("会议室白板");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary+openai-video-fallback");
    expect(primaryResponses.mock.calls[0]?.[0]?.model).toBe("qwen-omni-turbo");
    expect(fallbackResponses.mock.calls[0]?.[0]?.model).toBe("gpt-4.1-mini");
  });

  it("uses different resolved clients and base URLs when audio fallback crosses providers", async () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "openai-explicit-key",
      openaiBaseUrl: "https://api.openai.example/v1",
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
    });
    const runtimeConfig = {
      agents: {
        defaults: {
          model: {
            primary: "qwen-omni-turbo",
            provider: "qwen",
          },
        },
      },
      models: {
        providers: {
          qwen: {
            apiKey: "qwen-test-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
    };
    const primaryOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "qwen");
    const fallbackOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "openai");

    expect(primaryOpenai).not.toBeNull();
    expect(fallbackOpenai).not.toBeNull();
    expect(primaryOpenai?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(fallbackOpenai?.baseURL).toBe("https://api.openai.example/v1");

    const primaryResponses = vi
      .spyOn(primaryOpenai!.responses, "create")
      .mockRejectedValue(new Error("audio input is not supported by this model"));
    const primaryChat = vi
      .spyOn(primaryOpenai!.chat.completions, "create")
      .mockRejectedValue(new Error("input_audio is not supported by this model"));
    const fallbackResponses = vi.spyOn(fallbackOpenai!.responses, "create").mockResolvedValue({
      output_text: JSON.stringify({
        transcript: "",
        summary: "听起来像在讨论明天演示的顺序和截图，建议回看同一会话窗口确认细节。",
        transcriptConfidence: "low",
      }),
    } as never);
    const fallbackChat = vi
      .spyOn(fallbackOpenai!.chat.completions, "create")
      .mockRejectedValue(new Error("should not be called"));

    const result = await understandAudioWithPrimaryModel({
      cfg,
      runtimeConfig,
      body: createWaveBuffer(5_000),
      fileName: "clip.wav",
      mime: "audio/wav",
      primaryOpenai,
      fallbackOpenai,
    });

    expect(result.summary).toContain("讨论明天演示的顺序和截图");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary+openai-audio-fallback");
    expect(result.analysisFailureReason).toBe("primary_multimodal_not_audio_capable");
    expect(primaryResponses.mock.calls[0]?.[0]?.model).toBe("qwen-omni-turbo");
    expect(fallbackResponses.mock.calls[0]?.[0]?.model).toBe("gpt-4.1-mini");
    expect(primaryChat).toHaveBeenCalled();
    expect(fallbackChat).not.toHaveBeenCalled();
  });

  it("still triggers audio fallback when model id is the same but provider differs", async () => {
    const cfg = resolveClawSenseConfig({
      openaiApiKey: "openai-explicit-key",
      openaiBaseUrl: "https://api.openai.example/v1",
      visionProvider: "openai",
      visionModel: "shared-mm-model",
    });
    const runtimeConfig = {
      agents: {
        defaults: {
          model: {
            primary: "shared-mm-model",
            provider: "qwen",
          },
        },
      },
      models: {
        providers: {
          qwen: {
            apiKey: "qwen-test-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
        },
      },
    };
    const primaryOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "qwen");
    const fallbackOpenai = resolveOpenAiClientForProvider(cfg, runtimeConfig, "openai");

    const primaryResponses = vi
      .spyOn(primaryOpenai!.responses, "create")
      .mockRejectedValue(new Error("audio input is not supported by this provider"));
    const primaryChat = vi
      .spyOn(primaryOpenai!.chat.completions, "create")
      .mockRejectedValue(new Error("input_audio is not supported by this provider"));
    const fallbackResponses = vi.spyOn(fallbackOpenai!.responses, "create").mockResolvedValue({
      output_text: JSON.stringify({
        transcript: "",
        summary: "听起来像在确认下周评审安排，建议后续补人物标注。",
        transcriptConfidence: "low",
      }),
    } as never);

    const result = await understandAudioWithPrimaryModel({
      cfg,
      runtimeConfig,
      body: createWaveBuffer(5_000),
      fileName: "clip.wav",
      mime: "audio/wav",
      primaryOpenai,
      fallbackOpenai,
    });

    expect(result.summary).toContain("下周评审安排");
    expect(result.analysisProvider).toBe("primary-multimodal:runtime-primary+openai-audio-fallback");
    expect(result.analysisFailureReason).toBe("primary_multimodal_not_audio_capable");
    expect(primaryResponses.mock.calls[0]?.[0]?.model).toBe("shared-mm-model");
    expect(primaryChat).toHaveBeenCalled();
    expect(fallbackResponses.mock.calls[0]?.[0]?.model).toBe("shared-mm-model");
  });

  it("uses the provider-specific OpenAI fallback client through the real memory-store ingest path", async () => {
    const runtimeConfig = {
      agents: {
        defaults: {
          model: {
            primary: "qwen-omni-turbo",
            provider: "qwen",
          },
        },
      },
      models: {
        providers: {
          qwen: {
            apiKey: "qwen-test-key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          },
          openai: {
            apiKey: "openai-test-key",
            baseUrl: "https://api.openai.example/v1",
          },
        },
      },
    };
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-provider-ingest-media"),
      visionProvider: "openai",
      visionModel: "gpt-4.1-mini",
      runtimeConfig,
    });

    (harness.memoryStore as unknown as { journalOnlyMode: boolean }).journalOnlyMode = true;
    const defaultClient = (harness.memoryStore as unknown as {
      openai: { baseURL?: string } | null;
    }).openai;
    const resolveMultimodalClient = (
      harness.memoryStore as unknown as {
        resolveMultimodalClient: (providerId?: string) => any;
      }
    ).resolveMultimodalClient.bind(harness.memoryStore);
    const qwenClient = resolveMultimodalClient("qwen");
    const openAiClient = resolveMultimodalClient("openai");

    expect(defaultClient?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(qwenClient?.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(openAiClient?.baseURL).toBe("https://api.openai.example/v1");
    expect(openAiClient).not.toBe(defaultClient);

    const qwenResponses = vi
      .spyOn(qwenClient.responses, "create")
      .mockRejectedValue(new Error("audio input is not supported by this model"));
    const qwenChat = vi
      .spyOn(qwenClient.chat.completions, "create")
      .mockRejectedValue(new Error("input_audio is not supported by this model"));
    const openAiResponses = vi.spyOn(openAiClient.responses, "create").mockResolvedValue({
      output_text: JSON.stringify({
        transcript: "",
        summary: "听起来像在讨论明天演示的顺序和截图，建议回看同一会话窗口确认细节。",
        transcriptConfidence: "low",
      }),
    } as never);
    const openAiChat = vi
      .spyOn(openAiClient.chat.completions, "create")
      .mockRejectedValue(new Error("should not be called"));
    const openAiStt = vi
      .spyOn(openAiClient.audio.transcriptions, "create")
      .mockResolvedValue({ text: "" } as never);

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(5_000),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.summary).toContain("讨论明天演示的顺序和截图");
    expect(event.analysisProvider).toBe("runtime+primary-multimodal:runtime-primary+openai-audio-fallback");
    expect(event.analysisStatus).toBe("succeeded");
    expect(event.analysisFailureReason).toBe("runtime_stt_empty");
    expect(qwenResponses.mock.calls[0]?.[0]?.model).toBe("qwen-omni-turbo");
    expect(openAiResponses.mock.calls[0]?.[0]?.model).toBe("gpt-4.1-mini");
    expect(qwenChat).toHaveBeenCalled();
    expect(openAiChat).not.toHaveBeenCalled();
    expect(openAiStt).not.toHaveBeenCalled();
  });

  it("resolves an OpenAI-compatible client from the runtime primary provider when no explicit OpenAI key is set", async () => {
    const client = resolveOpenAiClient(
      resolveClawSenseConfig({
        visionProvider: "qwen",
        visionModel: "qwen-vl-max",
      }),
      {
        agents: {
          defaults: {
            model: {
              primary: "qwen-vl-max",
              provider: "qwen",
            },
          },
        },
        models: {
          providers: {
            qwen: {
              apiKey: "qwen-test-key",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            },
          },
        },
      },
    );

    expect(client).not.toBeNull();
  });

  it("uses provider-native compatible chat ASR when the fallback model is qwen3-asr-flash", async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: "老板说明天先补会议纪要，再确认演示顺序。",
                },
              },
            ],
          }),
        },
      },
      audio: {
        transcriptions: {
          create: vi.fn(),
        },
      },
    } as any;

    const result = await transcribeAudioWithFallbackModel({
      cfg: resolveClawSenseConfig({
        sttFallbackModel: "qwen3-asr-flash",
        visionProvider: "openai",
        visionModel: "qwen3-omni-flash",
      }),
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "dashscope/qwen3.5-plus",
            },
          },
        },
        models: {
          providers: {
            dashscope: {
              apiKey: "sk-test",
              baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            },
          },
        },
      },
      body: createWaveBuffer(5_000),
      fileName: "meeting.wav",
      mime: "audio/wav",
      openai,
    });

    expect(result.transcript).toContain("老板说明天先补会议纪要");
    expect(result.analysisProvider).toBe("dashscope-stt:qwen3-asr-flash");
    expect(openai.chat.completions.create).toHaveBeenCalled();
    expect(openai.audio.transcriptions.create).not.toHaveBeenCalled();
    expect(openai.chat.completions.create.mock.calls[0]?.[0]?.model).toBe("qwen3-asr-flash");
    expect(
      openai.chat.completions.create.mock.calls[0]?.[0]?.messages?.[0]?.content?.[0]?.input_audio?.data,
    ).toMatch(/^data:audio\/wav;base64,/);
  });

  it("stores a successful image summary with explicit provider metadata", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "image-success-media"),
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
            },
          },
        },
      },
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "image",
      body: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      capturedAt: Date.now(),
      describeImage: async () => ({
        text: "Alice is standing in a kitchen holding a grocery list while a tablet shows a recipe.",
        analysisProvider: "primary-multimodal:runtime-primary",
      }),
      transcribeAudio: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.summary).toContain("Alice is standing in a kitchen");
    expect(event.analysisMode).toBe("multimodal-preview");
    expect(event.analysisProvider).toBe("primary-multimodal:runtime-primary");
    expect(event.analysisStatus).toBe("succeeded");
    expect(event.analysisFailureReason).toBeUndefined();
  });

  it("degrades image summaries into readable text when visual analysis fails", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "image-failure-media"),
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "image",
      body: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      capturedAt: Date.now(),
      note: "baseline kitchen snapshot",
      describeImage: async () => {
        throw new Error("vision api timeout");
      },
      transcribeAudio: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.summary).toContain("Image captured, but visual analysis timed out.");
    expect(event.summary).toContain("baseline kitchen snapshot");
    expect(event.summary).not.toContain("Image captured but visual summary was unavailable.");
    expect(event.analysisMode).toBe("metadata-only");
    expect(event.analysisProvider).toBe("openai");
    expect(event.analysisStatus).toBe("degraded");
    expect(event.analysisFailureReason).toBe("vision_summary_timeout");
  });

  it("skips image multimodal analysis when hostModelImageMode is metadata-only", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "image-metadata-only-media"),
      hostModelImageMode: "metadata-only",
    });
    const describeImage = vi.fn(async () => ({
      text: "should not run",
      analysisProvider: "primary-multimodal:runtime-primary",
    }));

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "image",
      body: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      capturedAt: Date.now(),
      note: "active-window",
      describeImage,
      transcribeAudio: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(describeImage).not.toHaveBeenCalled();
    expect(event.analysisMode).toBe("metadata-only");
    expect(event.analysisProvider).toBe("metadata-only");
    expect(event.analysisStatus).toBe("degraded");
    expect(event.analysisFailureReason).toBe("image_analysis_disabled_by_mode");
    expect(event.summary).toContain("Image captured");
    expect(event.summary).toContain("active-window");
  });

  it("stores video events as metadata-only while preserving raw artifact trace", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "video-metadata-only-media"),
      hostModelVideoMode: "keyframes",
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "video",
      body: Buffer.from("fake-video-bytes"),
      fileName: "clip.mp4",
      mime: "video/mp4",
      capturedAt: Date.now(),
      note: "meeting hallway clip",
      describeImage: async () => ({ text: "unused" }),
      transcribeAudio: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);
    const artifact = await harness.stateStore.getArtifact(event.artifactId);

    expect(event.modality).toBe("video");
    expect(event.analysisMode).toBe("metadata-only");
    expect(event.analysisProvider).toBe("video-metadata-only");
    expect(event.analysisStatus).toBe("degraded");
    expect(event.analysisFailureReason).toContain("video_analysis_disabled_by_mode");
    expect(event.summary).toContain("Video captured");
    expect(event.summary).toContain("meeting hallway clip");
    expect(artifact?.mime).toBe("video/mp4");
    expect(artifact?.fileName.endsWith(".mp4")).toBe(true);
  });

  it("runs direct video analysis when hostModelVideoMode=direct and stores multimodal summary", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "video-direct-mode-media"),
      hostModelVideoMode: "direct",
    });
    const describeVideo = vi.fn(async () => ({
      text: "画面里两位同学在教室前排对着投影讨论作业分工，白板上写着截止时间。",
      analysisProvider: "primary-multimodal:runtime-primary",
    }));

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "video",
      body: Buffer.from("fake-video-bytes"),
      fileName: "classroom.mp4",
      mime: "video/mp4",
      capturedAt: Date.now(),
      note: "classroom clip",
      describeImage: async () => ({ text: "unused" }),
      describeVideo,
      transcribeAudio: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(describeVideo).toHaveBeenCalled();
    expect(event.analysisMode).toBe("multimodal-preview");
    expect(event.analysisStatus).toBe("succeeded");
    expect(event.analysisProvider).toBe("primary-multimodal:runtime-primary");
    expect(event.summary).toContain("讨论作业分工");
  });

  it("surfaces generic image provider failures with a clearer degraded summary", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "image-provider-failure-media"),
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "image",
      body: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      capturedAt: Date.now(),
      describeImage: async () => {
        throw new Error("fetch failed");
      },
      transcribeAudio: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.summary).toContain("vision provider was unavailable");
    expect(event.analysisFailureReason).toBe("vision_provider_unavailable");
  });

  it("keeps runtime STT transcripts and drops raw sensor metrics from successful audio summaries", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-success-media"),
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: Buffer.from("RIFFaudio-success"),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      note: "rms=0.012 voicedMs=400",
      transcribeAudio: async () => ({ text: "We need to reorder the batteries tomorrow." }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.transcript).toBe("We need to reorder the batteries tomorrow.");
    expect(event.summary).toBe("We need to reorder the batteries tomorrow.");
    expect(event.analysisMode).toBe("runtime-stt");
    expect(event.analysisProvider).toBe("runtime");
    expect(event.analysisStatus).toBe("succeeded");
    expect(event.sttProvider).toBe("runtime");
  });

  it("stores captures immediately as pending and backfills analysis asynchronously", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-pending-media"),
    });
    const capturedAt = Date.now();

    const receipt = await harness.memoryStore.ingestPending({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(5_000),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt,
      note: "csAudio:v2 session=conv-pending segment=1",
    });

    let event = await latestEvent(harness.stateStore);
    expect(receipt.artifactId).toBeTruthy();
    expect(event.artifactId).toBe(receipt.artifactId);
    expect(event.analysisMode).toBe("metadata-only");
    expect(event.analysisProvider).toBe("analysis-queue");
    expect(event.analysisStatus).toBe("degraded");
    expect(event.analysisFailureReason).toBe("analysis_pending");
    expect(event.summary).toContain("analysis is pending");
    await expect(fs.stat(receipt.storedAt)).resolves.toMatchObject({ size: expect.any(Number) });

    const update = await harness.memoryStore.analyzeCaptureArtifact({
      artifactId: receipt.artifactId!,
      transcribeAudio: async () => ({ text: "刚才讨论了发布节奏和客户跟进事项。" }),
      describeImage: async () => ({ text: "unused" }),
    });

    expect(update.updated).toBe(true);
    event = await latestEvent(harness.stateStore);
    expect(event.transcript).toBe("刚才讨论了发布节奏和客户跟进事项。");
    expect(event.summary).toContain("发布节奏");
    expect(event.analysisMode).toBe("runtime-stt");
    expect(event.analysisProvider).toBe("runtime");
    expect(event.analysisStatus).toBe("succeeded");
    expect(event.analysisFailureReason).toBeUndefined();
  });

  it("degrades empty runtime STT output into readable summaries instead of raw rms placeholders", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-failure-media"),
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: Buffer.from("RIFFaudio-failure"),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      note: "rms=0.004 voicedMs=200",
      transcribeAudio: async () => ({ text: "" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.summary).toContain("primary multimodal model was unavailable");
    expect(event.summary).toContain("Sensor note: rms=0.004 voicedMs=200.");
    expect(event.summary).not.toBe("rms=0.004 voicedMs=200");
    expect(event.analysisMode).toBe("runtime-stt-fallback");
    expect(event.analysisProvider).toBe("runtime+primary-multimodal:vision-model+openai-stt:whisper-1");
    expect(event.analysisStatus).toBe("degraded");
    expect(event.analysisFailureReason).toContain("runtime_stt_empty");
    expect(event.analysisFailureReason).toContain("primary_multimodal_unavailable");
  });

  it("surfaces generic primary multimodal audio failures instead of collapsing to unavailable", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-generic-failure-media"),
      openaiApiKey: "test-key",
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
            },
          },
        },
      },
    });
    stubOpenAiClient(harness.memoryStore, harness.cfg, {
      responsesError: new Error("internal server error"),
      chatError: new Error("internal server error"),
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(5_000),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.analysisFailureReason).toContain("primary_multimodal_error");
    expect(event.summary).toContain("primary multimodal audio analysis failed");
  });

  it("records OpenAI fallback success when runtime STT returns low-signal output", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-fallback-media"),
      openaiApiKey: "test-key",
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
            },
          },
        },
      },
    });
    stubOpenAiClient(harness.memoryStore, harness.cfg, {
      audioSummaryJson: {
        transcript: "",
        summary: "听起来像在讨论下班后顺路买燕麦奶和鸡蛋，建议后续确认具体清单。",
        transcriptConfidence: "low",
      },
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: Buffer.from("RIFFaudio-fallback"),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "rms=0.005 voicedMs=150" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.transcript).toBeUndefined();
    expect(event.summary).toContain("听起来像在讨论下班后顺路买燕麦奶和鸡蛋");
    expect(event.analysisMode).toBe("runtime-stt-fallback");
    expect(event.analysisProvider).toBe("runtime+primary-multimodal:runtime-primary");
    expect(event.analysisStatus).toBe("succeeded");
    expect(event.analysisFailureReason).toBe("runtime_stt_low_signal");
    expect(event.sttProvider).toBeUndefined();
  });

  it("falls back to OpenAI STT when primary multimodal audio understanding still fails", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-openai-fallback-media"),
      openaiApiKey: "test-key",
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
            },
          },
        },
      },
    });
    stubOpenAiClient(harness.memoryStore, harness.cfg, {
      chatError: new Error("input_audio is not supported by this model"),
      transcript: "Please pick up oat milk and eggs after work.",
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(5_000),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "rms=0.005 voicedMs=150" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.transcript).toBe("Please pick up oat milk and eggs after work.");
    expect(event.summary).toBe("Please pick up oat milk and eggs after work.");
    expect(event.analysisMode).toBe("openai-stt-fallback");
    expect(event.analysisProvider).toBe(
      "runtime+primary-multimodal:runtime-primary+openai-audio-fallback+openai-stt:whisper-1",
    );
    expect(event.analysisStatus).toBe("succeeded");
    expect(event.analysisFailureReason).toContain("runtime_stt_low_signal");
    expect(event.analysisFailureReason).toContain("primary_multimodal_not_audio_capable");
    expect(event.sttProvider).toBe("openai-fallback");
  });

  it("runs ASR fallback before multimodal analysis when hostModelAudioMode is asr-first", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-asr-first-media"),
      hostModelAudioMode: "asr-first",
      openaiApiKey: "test-key",
      runtimeConfig: {
        agents: {
          defaults: {
            model: {
              primary: "gpt-4.1",
            },
          },
        },
      },
    });
    stubOpenAiClient(harness.memoryStore, harness.cfg, {
      transcript: "老板说今天先补会议纪要，明天再看报价细节。",
    });
    const openaiClient = (harness.memoryStore as unknown as { openai: any }).openai;

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(5_000),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(openaiClient.audio.transcriptions.create).toHaveBeenCalledTimes(1);
    expect(openaiClient.responses.create).not.toHaveBeenCalled();
    expect(openaiClient.chat.completions.create).not.toHaveBeenCalled();
    expect(event.transcript).toBe("老板说今天先补会议纪要，明天再看报价细节。");
    expect(event.summary).toBe("老板说今天先补会议纪要，明天再看报价细节。");
    expect(event.analysisMode).toBe("openai-stt-fallback");
    expect(event.analysisProvider).toBe("runtime+openai-stt:whisper-1");
    expect(event.analysisStatus).toBe("succeeded");
    expect(event.analysisFailureReason).toBe("runtime_stt_empty");
    expect(event.sttProvider).toBe("openai-fallback");
  });

  it("classifies clips shorter than one second before calling STT providers", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "audio-short-media"),
    });
    const transcribeAudio = vi.fn(async () => ({ text: "should not run" }));

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(800),
      fileName: "short.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      note: "rms=0.003 voicedMs=80",
      transcribeAudio,
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(event.analysisMode).toBe("metadata-only");
    expect(event.analysisProvider).toBe("metadata-only");
    expect(event.analysisFailureReason).toBe("audio_clip_too_short");
    expect(event.summary).toContain("clip was too short");
  });

  it("classifies vision models that reject image input instead of collapsing into unavailable", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "image-capability-media"),
    });

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "image",
      body: Buffer.from("fake-image"),
      fileName: "snapshot.jpg",
      mime: "image/jpeg",
      capturedAt: Date.now(),
      describeImage: async () => {
        throw new Error("input_image is not supported by this model");
      },
      transcribeAudio: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(event.analysisMode).toBe("metadata-only");
    expect(event.analysisProvider).toBe("openai");
    expect(event.analysisFailureReason).toBe("vision_provider_not_image_capable");
    expect(event.summary).toContain("could not accept image input");
  });

  it("prunes expired artifacts without breaking the event index or cached review", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "custom-media-root"),
      artifactRetentionDays: 1,
    });
    const capturedAt = Date.now();
    const date = toLocalDateKey(capturedAt);

    const receipt = await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: Buffer.from("RIFFclawsense"),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt,
      transcribeAudio: async () => ({ text: "project sync about launch checklist" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const review = await harness.reviewEngine.getOrGenerateDailyReview(date);
    const artifact = await harness.stateStore.getArtifact(receipt.artifactId ?? "");

    expect(receipt.storedAt.startsWith(harness.mediaRoot)).toBe(true);
    expect(artifact).not.toBeNull();
    expect(artifact?.storageRelPath).toMatch(/^\d{4}\/\d{2}\/\d{2}\//);
    expect(path.resolve(harness.mediaRoot, artifact?.storageRelPath ?? "")).toBe(receipt.storedAt);

    await harness.memoryStore.pruneExpiredArtifacts(capturedAt + 2 * 24 * 60 * 60 * 1000);

    await expect(fs.access(receipt.storedAt)).rejects.toMatchObject({ code: "ENOENT" });
    const prunedArtifact = await harness.stateStore.getArtifact(receipt.artifactId ?? "");
    const events = await harness.stateStore.listEventsByDate(date);
    const cachedReview = await harness.stateStore.getDailyReview(date);
    const library = await harness.reviewEngine.buildLibrary({
      date,
      artifactUrlBase: "/api/clawsense/artifacts",
    });

    expect(prunedArtifact?.deletedAt).toBeDefined();
    expect(events).toHaveLength(1);
    expect(cachedReview?.reviewId).toBe(review.reviewId);
    expect(library.events[0]?.artifact?.available).toBe(false);
  });

  it("keeps raw artifacts indefinitely when artifactRetentionDays is disabled", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "no-expire-media-root"),
      artifactRetentionDays: 0,
      maxArtifactBytes: 0,
    });
    const capturedAt = Date.now();

    const receipt = await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: Buffer.from("RIFFclawsense"),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt,
      transcribeAudio: async () => ({ text: "project sync about launch checklist" }),
      describeImage: async () => ({ text: "unused" }),
    });

    await harness.memoryStore.pruneExpiredArtifacts(capturedAt + 30 * 24 * 60 * 60 * 1000);

    await expect(fs.access(receipt.storedAt)).resolves.toBeUndefined();
    const artifact = await harness.stateStore.getArtifact(receipt.artifactId ?? "");
    expect(artifact?.deletedAt).toBeUndefined();
    expect(artifact?.retentionExpiresAt).toBeGreaterThan(capturedAt + 10 * 365 * 24 * 60 * 60 * 1000);
  });

  it("prunes the oldest raw artifacts when the media budget is exceeded", async () => {
    const harness = await createHarness(rootDir, {
      mediaRoot: path.join(rootDir, "budgeted-media-root"),
      maxArtifactBytes: 20,
    });

    const first = await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: Buffer.from("123456789012"),
      fileName: "first.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "first event" }),
      describeImage: async () => ({ text: "unused" }),
    });
    const second = await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: Buffer.from("ABCDEFGHIJKL"),
      fileName: "second.wav",
      mime: "audio/wav",
      capturedAt: Date.now() + 1000,
      transcribeAudio: async () => ({ text: "second event" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const firstArtifact = await harness.stateStore.getArtifact(first.artifactId ?? "");
    const secondArtifact = await harness.stateStore.getArtifact(second.artifactId ?? "");

    expect(firstArtifact?.deletedAt).toBeDefined();
    expect(secondArtifact?.deletedAt).toBeUndefined();
    await expect(fs.access(first.storedAt)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(second.storedAt)).resolves.toBeUndefined();
  });

  it("returns semantic memory hits filtered by time range, device and modality", async () => {
    const harness = await createHarness(rootDir);
    const memoryStoreAny = harness.memoryStore as unknown as {
      table: unknown;
      embed: (input: string) => Promise<number[]>;
    };
    memoryStoreAny.table = {
      search: vi.fn(() => ({
        limit: () => ({
          toArray: async () => [
            {
              id: "memory-hit-1",
              namespace: harness.cfg.memoryNamespace,
              deviceId: harness.device.deviceId,
              modality: "audio",
              summary: "会议里确认报价区间和演示顺序",
              transcript: "先确认报价区间，再演示关键截图。",
              note: "",
              createdAt: 5000,
              _distance: 0.2,
            },
            {
              id: "memory-hit-2",
              namespace: harness.cfg.memoryNamespace,
              deviceId: "other-device",
              modality: "audio",
              summary: "来自其他设备，不应返回",
              transcript: "",
              note: "",
              createdAt: 5000,
              _distance: 0.1,
            },
            {
              id: "memory-hit-3",
              namespace: harness.cfg.memoryNamespace,
              deviceId: harness.device.deviceId,
              modality: "image",
              summary: "同设备图片命中，不应返回到 audio-only 查询",
              transcript: "",
              note: "",
              createdAt: 5000,
              _distance: 0.05,
            },
          ],
        }),
      })),
    };
    memoryStoreAny.embed = vi.fn(async () => [0.1, 0.2, 0.3]);

    const hits = await harness.memoryStore.searchRelevantMemories({
      question: "今天关于报价区间和演示顺序的讨论是什么？",
      startAt: 1000,
      endAt: 8000,
      deviceId: harness.device.deviceId,
      modality: "audio",
      limit: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.eventId).toBe("memory-hit-1");
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.modality).toBe("audio");
  });

  it("includes video keyframe image rows in video-scoped semantic memory search", async () => {
    const harness = await createHarness(rootDir);
    const memoryStoreAny = harness.memoryStore as unknown as {
      table: unknown;
      embed: (input: string) => Promise<number[]>;
    };
    memoryStoreAny.table = {
      search: vi.fn(() => ({
        limit: () => ({
          toArray: async () => [
            {
              id: "video-parent",
              namespace: harness.cfg.memoryNamespace,
              deviceId: harness.device.deviceId,
              modality: "video",
              summary: "视频片段元数据",
              transcript: "",
              note: "videoRequestId=req-video-1",
              createdAt: 5000,
              _distance: 0.3,
            },
            {
              id: "video-keyframe",
              namespace: harness.cfg.memoryNamespace,
              deviceId: harness.device.deviceId,
              modality: "image",
              summary: "关键帧 OCR 显示 Scaling Law 与收购动态",
              transcript: "",
              note: "active-window videoRequestId=req-video-1 videoKeyframe=1 keyframe=1",
              createdAt: 5100,
              _distance: 0.1,
            },
            {
              id: "plain-image",
              namespace: harness.cfg.memoryNamespace,
              deviceId: harness.device.deviceId,
              modality: "image",
              summary: "普通图片不应进入 video-only 语义召回",
              transcript: "",
              note: "active-window",
              createdAt: 5200,
              _distance: 0.05,
            },
          ],
        }),
      })),
    };
    memoryStoreAny.embed = vi.fn(async () => [0.1, 0.2, 0.3]);

    const hits = await harness.memoryStore.searchRelevantMemories({
      question: "视频里关于 Scaling Law 和收购动态说了什么？",
      deviceId: harness.device.deviceId,
      modality: "video",
      limit: 5,
    });

    expect(hits.map((hit) => hit.eventId)).toEqual(["video-keyframe", "video-parent"]);
    expect(hits[0]?.modality).toBe("image");
    expect(hits[0]?.note).toContain("videoKeyframe=1");
  });

  it("skips vector indexing and semantic search when retrievalEmbeddingBackend is none", async () => {
    const harness = await createHarness(rootDir, {
      retrievalEmbeddingBackend: "none",
    });
    stubOpenAiClient(harness.memoryStore, harness.cfg, {
      transcript: "今天讨论了演示顺序和报价区间。",
    });
    const openaiClient = (harness.memoryStore as unknown as { openai: any }).openai;

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(5_000),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "今天讨论了演示顺序和报价区间。" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);
    const hits = await harness.memoryStore.searchRelevantMemories({
      question: "演示顺序和报价区间",
      limit: 5,
    });

    expect(openaiClient.embeddings.create).not.toHaveBeenCalled();
    expect(event.embeddingModel).toBeUndefined();
    expect(hits).toEqual([]);
  });

  it("keeps semantic indexing enabled when retrievalEmbeddingBackend is multimodal", async () => {
    const harness = await createHarness(rootDir, {
      retrievalEmbeddingBackend: "multimodal",
    });
    stubOpenAiClient(harness.memoryStore, harness.cfg, {
      transcript: "今天讨论了演示顺序和报价区间。",
    });
    const openaiClient = (harness.memoryStore as unknown as { openai: any }).openai;

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(5_000),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "今天讨论了演示顺序和报价区间。" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);

    expect(openaiClient.embeddings.create).toHaveBeenCalled();
    expect(event.embeddingModel).toBe(harness.cfg.embeddingModel);
  });

  it("falls back to deterministic vectors when the embedding request fails", async () => {
    const harness = await createHarness(rootDir);
    stubOpenAiClient(harness.memoryStore, harness.cfg, {
      transcript: "今天讨论了遥控器成本、价格和功能可行性。",
      embeddingError: new Error("404 model_not_found"),
    });
    const openaiClient = (harness.memoryStore as unknown as { openai: any }).openai;

    await harness.memoryStore.ingest({
      device: harness.device,
      modality: "audio",
      body: createWaveBuffer(5_000),
      fileName: "capture.wav",
      mime: "audio/wav",
      capturedAt: Date.now(),
      transcribeAudio: async () => ({ text: "今天讨论了遥控器成本、价格和功能可行性。" }),
      describeImage: async () => ({ text: "unused" }),
    });

    const event = await latestEvent(harness.stateStore);
    const hits = await harness.memoryStore.searchRelevantMemories({
      question: "遥控器成本和价格",
      limit: 5,
    });

    expect(openaiClient.embeddings.create).toHaveBeenCalled();
    expect(event.embeddingModel).toBe(harness.cfg.embeddingModel);
    expect(hits.map((hit) => hit.eventId)).toContain(event.eventId);
  });
});

async function createHarness(
  rootDir: string,
  overrides: Partial<ClawSenseConfig> & { runtimeConfig?: Record<string, unknown> } = {},
) {
  const { runtimeConfig, ...cfgOverrides } = overrides;
  const mediaRoot = cfgOverrides.mediaRoot ?? path.join(rootDir, "media-root");
  const cfg = resolveClawSenseConfig({
    ...cfgOverrides,
    mediaRoot,
    artifactRetentionDays: cfgOverrides.artifactRetentionDays ?? 7,
    maxArtifactBytes: cfgOverrides.maxArtifactBytes ?? 2 * 1024 * 1024 * 1024,
    memoryDbPath: path.join(rootDir, `memory-db-${Math.random().toString(36).slice(2, 8)}`),
  });
  const stateStore = new ClawSenseStateStore({
    resolveStateDir: () => rootDir,
    logger: testLogger,
  });
  const memoryStore = new ClawSenseMemoryStore({
    cfg,
    runtimeConfig: runtimeConfig ?? {},
    logger: testLogger,
    stateStore,
    resolveStateDir: () => rootDir,
  });
  const reviewEngine = new ClawSenseReviewEngine({
    cfg,
    runtimeConfig: runtimeConfig ?? {},
    logger: testLogger,
    stateStore,
  });
  const device = await stateStore.registerDevice({
    name: "Pixel 7 Pro",
    platform: "android",
  });

  return {
    cfg,
    mediaRoot,
    stateStore,
    memoryStore,
    reviewEngine,
    device,
  };
}

async function latestEvent(stateStore: ClawSenseStateStore): Promise<ClawSenseCaptureEvent> {
  const events = await stateStore.listEvents();
  const event = events.at(-1);
  if (!event) {
    throw new Error("expected at least one event");
  }
  return event;
}

function stubOpenAiClient(
  memoryStore: ClawSenseMemoryStore,
  cfg: ClawSenseConfig,
  params: {
    transcript?: string;
    embeddingError?: Error;
    responsesError?: Error;
    chatError?: Error;
    audioSummaryJson?: Record<string, unknown>;
  },
): void {
  const dimensions = cfg.embeddingDimensions ?? 1536;
  const client = {
    embeddings: {
      create: params.embeddingError
        ? vi.fn().mockRejectedValue(params.embeddingError)
        : vi.fn().mockResolvedValue({
            data: [{ embedding: Array.from({ length: dimensions }, () => 0) }],
          }),
    },
    responses: {
      create: params.responsesError
        ? vi.fn().mockRejectedValue(params.responsesError)
        : vi.fn().mockResolvedValue({
            output_text: JSON.stringify(
              params.audioSummaryJson ?? {
                transcript: "",
                summary: "",
                transcriptConfidence: "low",
              },
            ),
          }),
    },
    chat: {
      completions: {
        create: params.chatError
          ? vi.fn().mockRejectedValue(params.chatError)
          : vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify(
                      params.audioSummaryJson ?? {
                        transcript: "",
                        summary: "",
                        transcriptConfidence: "low",
                      },
                    ),
                  },
                },
              ],
            }),
      },
    },
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({ text: params.transcript ?? "" }),
      },
    },
  };
  (memoryStore as unknown as { openai: unknown }).openai = client;
  const providerClients = (memoryStore as unknown as {
    providerOpenAiClients: Map<string, unknown>;
  }).providerOpenAiClients;
  providerClients.set("openai", client);
}

const testLogger = {
  info() {},
  warn() {},
  error() {},
};

function createWaveBuffer(durationMs: number): Buffer {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = Math.max(2, Math.round((byteRate * durationMs) / 1000));
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}
