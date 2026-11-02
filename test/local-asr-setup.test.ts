import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAsrPreparer } from "../src/local-asr-setup.js";

let directory: string;
beforeEach(async () => { directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-model-setup-"))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
const payloads = [Buffer.from("fixture-model"), Buffer.from("fixture-tokens")];
const assets = ["model.int8.onnx", "tokens.txt"].map((name, index) => ({ name,
  url: `https://huggingface.co/fixture/${name}`, bytes: payloads[index]!.length,
  sha256: createHash("sha256").update(payloads[index]!).digest("hex"),
}));
function setup(extra: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async (url: string) => new Response(payloads[assets.findIndex((asset) => asset.url === url)]!));
  const validateModel = vi.fn(async () => {});
  return { prepare: createLocalAsrPreparer({ assets, fetch: fetcher as any, validateModel, ...extra }), fetcher, validateModel };
}

describe("local ASR first-run preparation", () => {
  it("downloads verified files atomically and reuses the cache without a network call", async () => {
    const { prepare, fetcher, validateModel } = setup();
    const first = await prepare({ stateDir: directory });
    expect(first.downloaded).toBe(true);
    expect(first.config.localAsrBackend).toBe("sherpa-onnx-sensevoice");
    expect((await fs.stat(path.join(first.modelDir, "model.int8.onnx"))).mode & 0o777).toBe(0o600);
    const second = await prepare({ stateDir: directory });
    expect(second.downloaded).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(validateModel).toHaveBeenCalledTimes(2);
  });
  it("rejects modified cached files without replacing them", async () => {
    const { prepare, fetcher } = setup();
    const result = await prepare({ stateDir: directory });
    await fs.writeFile(path.join(result.modelDir, "tokens.txt"), "corrupt");
    await expect(prepare({ stateDir: directory })).rejects.toThrow("local_asr_integrity_failed");
    expect(await fs.readFile(path.join(result.modelDir, "tokens.txt"), "utf8")).toBe("corrupt");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("cleans partial downloads after a checksum failure", async () => {
    const { prepare } = setup({ fetch: async () => new Response("bad") });
    await expect(prepare({ stateDir: directory })).rejects.toThrow("local_asr_integrity_failed");
    expect(await fs.readdir(path.join(directory, "models"))).toEqual([]);
  });
  it("refuses untrusted redirects without sending the second request", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/model" } }));
    const { prepare } = setup({ fetch: fetcher });
    await expect(prepare({ stateDir: directory })).rejects.toThrow("untrusted_model_download_origin");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("enforces the byte budget while streaming", async () => {
    const { prepare } = setup({ fetch: async () => new Response("x".repeat(100)) });
    await expect(prepare({ stateDir: directory })).rejects.toThrow("model_download_exceeds_budget");
    expect(await fs.readdir(path.join(directory, "models"))).toEqual([]);
  });
  it("does not publish downloaded models that the native runtime cannot load", async () => {
    const { prepare } = setup({ validateModel: async () => { throw new Error("native failure"); } });
    await expect(prepare({ stateDir: directory })).rejects.toThrow("native failure");
    expect(await fs.readdir(path.join(directory, "models"))).toEqual([]);
  });
  it("validates a user-specified model without downloading or creating a state directory", async () => {
    const modelDir = path.join(directory, "provided"); await fs.mkdir(modelDir);
    await Promise.all(assets.map((asset, index) => fs.writeFile(path.join(modelDir, asset.name), payloads[index]!)));
    const { prepare, fetcher } = setup();
    const result = await prepare({ stateDir: path.join(directory, "unused"), modelDir });
    expect(result.verification).toBe("local-load"); expect(fetcher).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(directory, "unused"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a symlink in the provided model files", async () => {
    const modelDir = path.join(directory, "provided"); await fs.mkdir(modelDir);
    await fs.writeFile(path.join(directory, "target"), "model");
    await fs.symlink(path.join(directory, "target"), path.join(modelDir, "model.int8.onnx"));
    await expect(setup().prepare({ stateDir: directory, modelDir })).rejects.toThrow("model_file_invalid");
  });
  it("falls back to the official archive and verifies extracted bytes without extracting archive paths", async () => {
    const fixtureRoot = path.join(directory, "source");
    const prefix = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
    await fs.mkdir(path.join(fixtureRoot, prefix), { recursive: true });
    await Promise.all(assets.map((asset, index) => fs.writeFile(path.join(fixtureRoot, prefix, asset.name), payloads[index]!)));
    const archive = path.join(directory, "test.tar.bz2");
    await promisify(execFile)("tar", ["-cjf", archive, "-C", fixtureRoot, prefix]);
    const bytes = await fs.readFile(archive);
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith("https://huggingface.co/")) throw new Error("unreachable");
      return new Response(bytes);
    });
    const { prepare } = setup({ fetch: fetcher, allowArchiveFallback: true });
    // Slow storage must not make a short-lived tar process lose its stdout.
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("model.int8.onnx")) await new Promise((resolve) => setTimeout(resolve, 40));
      return originalOpen(...args);
    });
    const result = await prepare({ stateDir: path.join(directory, "cache") });
    expect(result.downloaded).toBe(true);
    expect(await fs.readFile(path.join(result.modelDir, "model.int8.onnx"))).toEqual(payloads[0]);
    expect(JSON.parse(await fs.readFile(path.join(result.modelDir, "source.json"), "utf8")).source).toBe("official-github-release");
    expect(await fs.readdir(result.modelDir)).toEqual(["model.int8.onnx", "source.json", "tokens.txt"]);
  });
});
