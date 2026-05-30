import { describe, expect, it } from "vitest";
import { resolveClawSenseConfig } from "../src/config.js";

describe("resolveClawSenseConfig", () => {
  it("ignores invalid negative numeric configuration values", () => {
    const cfg = resolveClawSenseConfig({
      gatewayPort: -1,
      embeddingDimensions: 0,
      pairingTtlSeconds: -30,
      maxPendingTokens: 0,
      heartbeatIntervalSeconds: -1,
      artifactRetentionDays: -1,
      maxArtifactBytes: -1,
      localAsrNumThreads: -2,
    });

    expect(cfg.gatewayPort).toBe(3000);
    expect(cfg.embeddingDimensions).toBe(1536);
    expect(cfg.pairingTtlSeconds).toBe(600);
    expect(cfg.maxPendingTokens).toBe(10);
    expect(cfg.heartbeatIntervalSeconds).toBe(60);
    expect(cfg.artifactRetentionDays).toBe(7);
    expect(cfg.maxArtifactBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(cfg.localAsrNumThreads).toBe(2);
  });

  it("keeps explicit zero values that intentionally disable retention caps", () => {
    const cfg = resolveClawSenseConfig({
      artifactRetentionDays: 0,
      maxArtifactBytes: 0,
    });

    expect(cfg.artifactRetentionDays).toBe(0);
    expect(cfg.maxArtifactBytes).toBe(0);
  });
});
