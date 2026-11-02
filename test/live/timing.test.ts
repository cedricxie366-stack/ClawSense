import { expect, it } from "vitest";
import { LiveTurnTiming } from "../../src/live/timing.js";

it("keeps model measurements numeric, bounded and independent from user content", () => {
  const timing = new LiveTurnTiming("text");
  timing.provider("llm", { promptTokens: 120, cachedTokens: 60, firstTokenMs: 45, modelLoadMs: 0, residencyMs: 8, text: "private source", cacheBytes: Infinity, totalMs: -1 } as any);
  const result = timing.snapshot();
  expect(result.providers).toEqual([{ stage: "llm", values: { promptTokens: 120, cachedTokens: 60, firstTokenMs: 45, modelLoadMs: 0, residencyMs: 8 } }]);
  expect(JSON.stringify(result)).not.toContain("private source");
  for (let i = 0; i < 100; i++) timing.provider("tts", { firstAudioMs: 20 });
  expect(timing.snapshot().providers).toHaveLength(64);
});
