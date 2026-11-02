import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
export const SENSEVOICE_REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07";
export const SENSEVOICE_BASE_URL = `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/${SENSEVOICE_REVISION}`;
type Asset = { name: string; url: string; bytes: number; sha256: string };
export const SENSEVOICE_ASSETS: readonly Asset[] = [
  { name: "model.int8.onnx", url: `${SENSEVOICE_BASE_URL}/model.int8.onnx?download=true`, bytes: 239233841, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
  { name: "tokens.txt", url: `${SENSEVOICE_BASE_URL}/tokens.txt?download=true`, bytes: 315894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" },
];
const MAX_BYTES = 256 * 1024 * 1024;
const ARCHIVE_PREFIX = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
export const SENSEVOICE_RELEASE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ARCHIVE_PREFIX}.tar.bz2`;
const ALLOWED_HOSTS = new Set(["huggingface.co", "hf.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co", "eu.aws.cdn.hf.co", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
export type LocalAsrProgress = { phase: string; file?: string; bytes?: number; totalBytes?: number };
export type LocalAsrSetupOptions = { stateDir: string; modelDir?: string; onProgress?: (event: LocalAsrProgress) => void };
type SetupDependencies = { assets: readonly Asset[]; fetch: typeof fetch; validateModel: (directory: string) => Promise<void>; allowArchiveFallback: boolean };

/** Dependencies are injectable for offline integrity/failure tests; the CLI always uses the pinned manifest. */
export function createLocalAsrPreparer(overrides: Partial<SetupDependencies> = {}) {
  const assets = overrides.assets ?? SENSEVOICE_ASSETS;
  const fetcher = overrides.fetch ?? globalThis.fetch;
  const validate = overrides.validateModel ?? validateNativeModel;
  const allowArchiveFallback = overrides.allowArchiveFallback ?? overrides.assets === undefined;
  return async (options: LocalAsrSetupOptions) => {
    if (!options.stateDir?.trim()) throw new Error("state_directory_required");
    if (!overrides.validateModel) {
      try { require.resolve("sherpa-onnx-node"); }
      catch { throw new Error("local_asr_runtime_missing_install_optional_sherpa_onnx_node_dependency"); }
    }
    const progress = options.onProgress ?? (() => {});
    if (options.modelDir !== undefined) {
      if (!options.modelDir.trim()) throw new Error("model_directory_required");
      const directory = path.resolve(options.modelDir);
      await checkDirectory(directory);
      for (const name of ["model.int8.onnx", "tokens.txt"]) await checkFile(path.join(directory, name));
      progress({ phase: "validating-local-model" });
      await validate(directory);
      return result(directory, false, "local-load" as const);
    }
    const models = path.join(path.resolve(options.stateDir), "models");
    await fs.mkdir(models, { recursive: true, mode: 0o700 });
    await checkDirectory(models);
    const directory = path.join(models, "sherpa-onnx-sensevoice-2024-07-17-int8");
    if (await exists(directory)) {
      progress({ phase: "checking-cached-model" });
      await verify(directory, assets);
      await validate(directory);
      return result(directory, false, "pinned-sha256" as const);
    }
    const lock = `${directory}.lock`;
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("local_asr_preparation_already_running");
      throw error;
    }
    const temporary = path.join(models, `.sensevoice-${randomUUID()}`);
    try {
      if (await exists(directory)) {
        await verify(directory, assets); await validate(directory);
        return result(directory, false, "pinned-sha256" as const);
      }
      await fs.mkdir(temporary, { mode: 0o700 });
      for (const asset of assets) {
        if (!/^[a-z0-9.-]+$/i.test(asset.name) || asset.name.includes("..") || asset.bytes <= 0 || asset.bytes > MAX_BYTES) throw new Error("invalid_local_asr_asset_manifest");
      }
      let source = "huggingface-pinned-revision";
      try {
        for (const asset of assets) {
          await download(asset, path.join(temporary, asset.name), fetcher, progress);
        }
      } catch (error) {
        if (!allowArchiveFallback) throw error;
        progress({ phase: "primary-unavailable-using-official-release" });
        await fs.rm(temporary, { recursive: true, force: true });
        await fs.mkdir(temporary, { mode: 0o700 });
        const archive = path.join(temporary, "sensevoice.tar.bz2");
        await download({ name: "sensevoice.tar.bz2", url: SENSEVOICE_RELEASE_URL, bytes: MAX_BYTES, sha256: "" }, archive, fetcher, progress, false);
        for (const asset of assets) await extractVerifiedMember(archive, asset, path.join(temporary, asset.name));
        await fs.rm(archive);
        source = "official-github-release";
      }
      progress({ phase: "validating-native-runtime" });
      await validate(temporary);
      await fs.writeFile(path.join(temporary, "source.json"), JSON.stringify({ revision: SENSEVOICE_REVISION, source, assets }, null, 2), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, directory);
      progress({ phase: "ready" });
      return result(directory, true, "pinned-sha256" as const);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
      await fs.rmdir(lock);
    }
  };
}

export const prepareLocalAsr = createLocalAsrPreparer();

function result(modelDir: string, downloaded: boolean, verification: "local-load" | "pinned-sha256") {
  return { modelDir, downloaded, verification,
    ...(verification === "pinned-sha256" ? { bytes: SENSEVOICE_ASSETS.reduce((total, asset) => total + asset.bytes, 0), sha256: SENSEVOICE_ASSETS[0]!.sha256, revision: SENSEVOICE_REVISION } : {}),
    config: {
      localAsrBackend: "sherpa-onnx-sensevoice", localAsrModelDir: modelDir,
      localAsrModelFile: "model.int8.onnx", localAsrTokensFile: "tokens.txt",
      localAsrLanguage: "auto", localAsrNumThreads: 2, hostModelAudioMode: "asr-first",
    },
  };
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function checkDirectory(directory: string): Promise<void> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("model_directory_must_be_regular");
}
async function checkFile(file: string): Promise<void> {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_BYTES) throw new Error("model_file_invalid");
}
async function verify(directory: string, assets: readonly Asset[]): Promise<void> {
  await checkDirectory(directory);
  for (const asset of assets) {
    const file = path.join(directory, asset.name);
    await checkFile(file);
    const hash = createHash("sha256");
    const handle = await fs.open(file, "r");
    let bytes = 0;
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk); }
    } finally { await handle.close(); }
    if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error(`local_asr_integrity_failed:${asset.name}`);
  }
}

async function download(asset: Asset, destination: string, fetcher: typeof fetch, progress: (event: LocalAsrProgress) => void, verifyExact = true): Promise<void> {
  let url = asset.url;
  let response: Response | undefined;
  const signal = AbortSignal.timeout(10 * 60_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || !ALLOWED_HOSTS.has(target.hostname)) throw new Error("untrusted_model_download_origin");
    response = await fetcher(url, { redirect: "manual", signal, headers: { "Cache-Control": "no-cache" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("model_download_redirect_failed");
    url = new URL(location, target).toString();
  }
  if (!response?.ok || !response.body) throw new Error(`model_download_http_${response?.status ?? "failed"}`);
  const declaredBytes = Number(response.headers.get("content-length") ?? "0");
  if (declaredBytes > asset.bytes) { await response.body.cancel(); throw new Error("model_download_exceeds_budget"); }
  const file = await fs.open(destination, "wx", 0o600);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let total = 0;
  progress({ phase: "downloading", file: asset.name, bytes: 0, totalBytes: asset.bytes });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > asset.bytes || total > MAX_BYTES) throw new Error("model_download_exceeds_budget");
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const written = await file.write(value, offset, value.byteLength - offset);
        if (!written.bytesWritten) throw new Error("model_download_write_failed");
        offset += written.bytesWritten;
      }
      progress({ phase: "downloading", file: asset.name, bytes: total, totalBytes: asset.bytes });
    }
    const digest = hash.digest("hex");
    if (verifyExact && (total !== asset.bytes || digest !== asset.sha256)) throw new Error(`local_asr_integrity_failed:${asset.name}`);
    await file.sync();
    progress({ phase: "downloaded", file: asset.name, bytes: total, totalBytes: total });
  } finally { await reader.cancel().catch(() => {}); await file.close(); }
}

async function extractVerifiedMember(archive: string, asset: Asset, destination: string): Promise<void> {
  // Open before starting tar: a fast child can exit while an async open is pending,
  // causing Node to drain unread stdout before the consumer attaches.
  const file = await fs.open(destination, "wx", 0o600);
  // tar only writes stdout. No archive paths, links or permissions are ever extracted to disk.
  const child = spawn("tar", ["-xOf", archive, `${ARCHIVE_PREFIX}/${asset.name}`], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let spawnError: Error | undefined;
  const finished = new Promise<{ code: number | null }>((resolve) => {
    child.once("error", (error) => { spawnError = error; resolve({ code: -1 }); });
    child.once("close", (code) => resolve({ code }));
  });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const hash = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of child.stdout) {
      total += chunk.length;
      if (total > asset.bytes) throw new Error("model_archive_member_exceeds_budget");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    const outcome = await finished;
    if (spawnError || outcome.code !== 0) throw new Error("model_archive_reader_failed_check_tar_installation");
    if (total !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error(`local_asr_integrity_failed:${asset.name}`);
    await file.sync();
  } finally {
    clearTimeout(timer); child.kill("SIGKILL"); await finished; await file.close();
  }
}

async function validateNativeModel(directory: string): Promise<void> {
  const entry = require.resolve("sherpa-onnx-node");
  // A short-lived process isolates native aborts from invalid ONNX files and releases validation memory.
  const program = `const s=require(process.argv[1]);s.OfflineRecognizer.createAsync({featConfig:{sampleRate:16000,featureDim:80},modelConfig:{senseVoice:{model:process.argv[2],language:'auto',useInverseTextNormalization:1},tokens:process.argv[3],numThreads:2,debug:0,provider:'cpu'}}).then(()=>process.exit(0)).catch(()=>process.exit(1));`;
  try {
    await execute(process.execPath, ["-e", program, entry, path.join(directory, "model.int8.onnx"), path.join(directory, "tokens.txt")], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error("local_asr_native_validation_failed_check_platform_and_model"); }
}
