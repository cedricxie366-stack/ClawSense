import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClawSenseStateStore } from "../src/state-store.js";
import { issueSetupToken } from "../src/utils.js";

describe("ClawSenseStateStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-state-test-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("consumes setup token only once", async () => {
    const store = new ClawSenseStateStore({
      resolveStateDir: () => rootDir,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });
    const token = issueSetupToken(600);
    await store.upsertSetupToken(token);

    const first = await store.consumeSetupToken(token.token);
    const second = await store.consumeSetupToken(token.token);

    expect(first?.tokenHash).toBe(token.tokenHash);
    expect(second).toBeNull();
  });

  it("registers device without persisting plain secret", async () => {
    const store = new ClawSenseStateStore({
      resolveStateDir: () => rootDir,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });

    const created = await store.registerDevice({
      name: "Pixel",
      platform: "android",
    });
    const listed = await store.listDevices();

    expect(created.plainSecret).toBeTruthy();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.plainSecret).toBeUndefined();
    expect(listed[0]?.secretHash).toBeTruthy();
  });
});
