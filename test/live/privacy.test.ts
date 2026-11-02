import { it, expect } from "vitest";
import { resolveClawSenseConfig } from "../../src/config.js";
import {
  resolveOpenAiClient,
  resolveOpenAiClientForProvider,
} from "../../src/openai-client.js";
it("the isolated Live runtime fails closed for inherited analysis credentials", () => {
  const cfg = resolveClawSenseConfig({ openaiApiKey: "fixture-unused-key" });
  const local = {
    clawsenseLiveLocalOnly: true,
    models: {
      providers: {
        example: {
          apiKey: "fixture-unused-key",
          baseUrl: "https://example.invalid/v1",
        },
      },
    },
  };
  expect(resolveOpenAiClient(cfg, local)).toBeNull();
  expect(resolveOpenAiClientForProvider(cfg, local, "example")).toBeNull();
  expect(resolveOpenAiClient(cfg, {})).not.toBeNull();
});
