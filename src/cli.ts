#!/usr/bin/env node
import { startLiveRuntime } from "./live/launch.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createStandaloneRuntime } from "./standalone-runtime.js";
import { createRemoteBackend, readCredentialFile, runMcpStdio, validateCompanionUrl } from "./mcp-server.js";
import { AGENT_IDS, agentGrantIdentity, buildAgentInstallPlan, normalizeAgentId, writeAgentInstallPlan } from "./agent-install.js";
import { applyAgentInstallPlan } from "./agent-config-install.js";
import { prepareLocalAsr } from "./local-asr-setup.js";
import { planContextMigration, applyContextMigration, activateContextMigration, rollbackContextMigration, recoverContextWriter, type ContextMigrationPlan } from "./context-migration.js";
import { normalizeContextScopes, normalizeContextCapabilities } from "./context-access.js";

const HELP = `ClawSense early cross-agent companion

  clawsense serve [--lan] [--port 18790] [--state-dir PATH] [--config FILE]
  clawsense start [--lan] [--local-asr] [--port 18790] [--state-dir PATH] [--config FILE]
  clawsense live-serve --state-dir NEW_ISOLATED_STATE --config LIVE_CONFIG [--port 19495] [--host HOST]
  clawsense prepare-asr [--model-dir PATH] [--state-dir PATH]
  clawsense stop [--state-dir PATH]
  clawsense pair [--role sensor|primary] [--state-dir PATH]
  clawsense open [--state-dir PATH]
  clawsense connect <agent|all> [--apply] [--out NEW_DIRECTORY]
  clawsense mcp --url URL --token-file PATH [--agent LABEL]
  clawsense doctor
  clawsense grants
  clawsense revoke <grant-id>
  clawsense call <tool-name> --args '{"sessionId":"..."}'
  clawsense export-work <work-id> --out FILE
  clawsense import --file FILE --project PROJECT [--title TITLE] [--source-url URL]
  clawsense context-plan --state-dir PATH --out PLAN.json
  clawsense context-migrate --state-dir PATH --plan PLAN.json --target-dir NEW_PATH
  clawsense context-activate --state-dir PATH --plan PLAN.json --target-dir PATH
  clawsense context-rollback --state-dir ORIGINAL_PATH --target-dir CURRENT_PATH
  clawsense context-recover --state-dir PATH

Agents: ${AGENT_IDS.join(", ")}
All commands accept --state-dir. Client commands accept --url and --token-file.
Default state: ~/.clawsense; no OpenClaw installation is required.
--local-asr prepares a verified ~240 MB free local speech model on first use.
start runs in the background; serve stays in the foreground. --lan selects a private LAN address for Android.
connect writes a fresh install bundle and a separate revocable credential.
--apply installs supported local host configurations without replacing unrelated settings.
Market publication, platform approval and live host testing are separate steps.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "state-dir": { type: "string" }, host: { type: "string" }, port: { type: "string" },
    "public-url": { type: "string" }, config: { type: "string" }, url: { type: "string" },
    "token-file": { type: "string" }, agent: { type: "string" }, out: { type: "string" },
    args: { type: "string" }, apply: { type: "boolean" }, replace: { type: "boolean" },
    "local-asr": { type: "boolean" }, "model-dir": { type: "string" },
    "config-home": { type: "string" }, lan: { type: "boolean" }, help: { type: "boolean", short: "h" },
    role: { type: "string" }, "digital-project": { type: "string", multiple: true }, "digital-raw": { type: "boolean" },
    plan: { type: "string" }, "target-dir": { type: "string" },
    "context-project": { type: "string", multiple: true }, "context-source": { type: "string", multiple: true },
    "context-operation": { type: "string", multiple: true }, "context-capability": { type: "string", multiple: true }, "context-processing": { type: "string" },
    file: { type: "string" }, project: { type: "string" }, title: { type: "string" }, "source-url": { type: "string" }, "person-id": { type: "string" }, "session-id": { type: "string" },
  } });
  const [command = "help", target] = positionals;
  if (values.help || command === "help") { process.stdout.write(HELP); return; }
  if (values["model-dir"] && command !== "prepare-asr" && !values["local-asr"]) throw new Error("model_dir_requires_prepare_asr_or_local_asr");
  if (values["local-asr"] && values.config) throw new Error("local_asr_and_config_are_alternative_processing_presets");
  if (["start", "serve"].includes(command) && (values.url || values["token-file"])) throw new Error("server_commands_use_state_dir_not_client_connection_options");
  const stateDir = path.resolve(values["state-dir"] ?? path.join(os.homedir(), ".clawsense"));
  const connectionFile = path.join(stateDir, "connection.json");
  const localAsrPreset = path.join(stateDir, "prepared-local-asr.json");
  if (command === "context-plan") {
    if (!values.out) throw new Error("migration_plan_output_required");
    const plan = await planContextMigration(stateDir); const out = path.resolve(values.out); await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 }); await fs.writeFile(out, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true, planFile: out, workspaceId: plan.workspaceId, counts: plan.counts, sourceUnchanged: true }) + "\n"); return;
  }
  if (["context-migrate", "context-activate"].includes(command)) {
    if (!values.plan || !values["target-dir"]) throw new Error("migration_plan_and_target_required");
    const plan = JSON.parse(await fs.readFile(path.resolve(values.plan), "utf8")) as ContextMigrationPlan;
    const result = command === "context-migrate" ? await applyContextMigration(stateDir, path.resolve(values["target-dir"]), plan) : await activateContextMigration(stateDir, path.resolve(values["target-dir"]), plan);
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n"); return;
  }
  if (command === "context-rollback") { if (!values["target-dir"]) throw new Error("migration_target_required"); process.stdout.write(JSON.stringify({ ok: true, ...(await rollbackContextMigration(stateDir, path.resolve(values["target-dir"]))) }) + "\n"); return; }
  if (command === "context-recover") { process.stdout.write(JSON.stringify({ ok: true, ...(await recoverContextWriter(stateDir)) }) + "\n"); return; }
  const prepareSpeech = async () => {
    let lastPhase = "";
    let lastPercent = -1;
    const result = await prepareLocalAsr({ stateDir, modelDir: values["model-dir"], onProgress(event) {
      const percent = event.totalBytes && event.bytes !== undefined ? Math.floor(event.bytes * 10 / event.totalBytes) * 10 : undefined;
      if (event.phase !== lastPhase || (percent !== undefined && percent !== lastPercent)) {
        process.stderr.write(`[local-asr] ${event.phase}${event.file ? ` ${event.file}` : ""}${percent !== undefined ? ` ${percent}%` : ""}\n`);
        lastPhase = event.phase; lastPercent = percent ?? -1;
      }
    } });
    const config = { ...result.config, hostModelImageMode: "metadata-only", hostModelVideoMode: "keyframes", retrievalEmbeddingBackend: "none", asrWorkerEnabled: false };
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${localAsrPreset}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ generatedBy: "clawsense", config }, null, 2), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, localAsrPreset);
    } finally { await fs.rm(temporary, { force: true }); }
    return { ...result, config, configFile: localAsrPreset };
  };
  if (command === "live-serve") {
    if(!values["state-dir"]||!values.config)throw new Error("live_serve_requires_explicit_isolated_state_and_config");
    const config=JSON.parse(await fs.readFile(path.resolve(values.config),"utf8"));
    const service=await startLiveRuntime({stateDir,host:values.host??"127.0.0.1",port:Number(values.port??"19495"),config});
    process.stdout.write(JSON.stringify({ok:true,url:service.address.baseUrl,stateDir,live:true})+"\n");
    let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await service.stop();};
    process.once("SIGINT",()=>void stop());process.once("SIGTERM",()=>void stop());return;
  }
  if (command === "prepare-asr") {
    process.stdout.write(JSON.stringify({ ok: true, ...(await prepareSpeech()) }, null, 2) + "\n"); return;
  }
  const connection = async (): Promise<{ url: string; tokenFile: string }> => {
    let saved: { url?: string; tokenFile?: string } = {};
    if (!values.url || !values["token-file"]) {
      try { saved = JSON.parse(await fs.readFile(connectionFile, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid_connection_file"); }
    }
    return {
      url: validateCompanionUrl(values.url ?? saved.url ?? "http://127.0.0.1:18790"),
      tokenFile: path.resolve(values["token-file"] ?? saved.tokenFile ?? path.join(stateDir, "standalone-admin-token")),
    };
  };
  const adminRequest = async (route: string, method = "GET", body?: unknown): Promise<Record<string, any>> => {
    const config = await connection();
    const token = await readCredentialFile(config.tokenFile);
    const response = await fetch(`${config.url}${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`companion_request_failed_${response.status}`);
    return await response.json() as Record<string, any>;
  };
  if (command === "start") {
    // An authenticated response, rather than a PID file, establishes an already-running companion.
    try {
      await adminRequest("/api/clawsense/agent/tools");
      process.stdout.write(JSON.stringify({ ok: true, alreadyRunning: true, url: (await connection()).url,
        ...(values["local-asr"] || values.config ? { note: "The running service was not reconfigured. Stop it before starting with a new processing preset." } : {}) }) + "\n"); return;
    } catch { /* Prepare a new managed process. */ }
    if (values["local-asr"]) await prepareSpeech();
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(stateDir, "companion.log");
    const log = await fs.open(logFile, "a", 0o600);
    let child;
    try {
      const childArgs = [fileURLToPath(import.meta.url), "serve", "--state-dir", stateDir];
      for (const key of ["host", "port", "public-url", "config"] as const) {
        if (values[key] !== undefined) childArgs.push(`--${key}`, key === "config" ? path.resolve(values[key]!) : values[key]!);
      }
      if (values.lan) childArgs.push("--lan");
      // The parent has already prepared the local model; the child reads the saved preset.
      child = spawn(process.execPath, childArgs, {
        detached: true, stdio: ["ignore", log.fd, log.fd], shell: false,
      });
      await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", () => reject(new Error("companion_launch_failed"))); });
      child.unref();
    } finally { await log.close(); }
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await adminRequest("/api/clawsense/agent/tools");
        process.stdout.write(JSON.stringify({ ok: true, pid: child!.pid, url: (await connection()).url, logFile }) + "\n"); return;
      } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    throw new Error(`companion_start_not_confirmed_check_log:${logFile}`);
  }
  if (command === "stop") {
    process.stdout.write(JSON.stringify(await adminRequest("/api/clawsense/shutdown", "POST", {})) + "\n"); return;
  }
  if (command === "serve") {
    const port = Number(values.port ?? "18790");
    if (!Number.isInteger(port) || port < 0 || port > 65535 || (port === 0 && values.lan)) throw new Error("invalid_port");
    const host = values.host ?? (values.lan ? "0.0.0.0" : "127.0.0.1");
    const publicBaseUrl = values["public-url"] ?? (values.lan ? `http://${privateLanAddress()}:${port}` : undefined);
    if (values["local-asr"]) await prepareSpeech();
    let prepared: { generatedBy?: string; config?: Record<string, unknown> } = {};
    if (!values.config) {
      try {
        prepared = JSON.parse(await fs.readFile(localAsrPreset, "utf8"));
        if (!prepared || prepared.generatedBy !== "clawsense" || !prepared.config || typeof prepared.config !== "object" || Array.isArray(prepared.config) ||
          prepared.config.localAsrBackend !== "sherpa-onnx-sensevoice" || typeof prepared.config.localAsrModelDir !== "string" ||
          prepared.config.hostModelImageMode !== "metadata-only" || prepared.config.retrievalEmbeddingBackend !== "none" ||
          Object.keys(prepared.config).some((key) => /apiKey|baseUrl|Command/i.test(key))) throw new Error("invalid_local_asr_preset");
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid_local_asr_preset"); }
    }
    const config = values.config ? JSON.parse(await fs.readFile(path.resolve(values.config), "utf8")) : prepared.config ?? {};
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config_must_be_an_object");
    if (prepared.config && !values.config) {
      // The generated local preset must not silently fall back to inherited cloud credentials.
      // This affects this companion process only; it does not edit the user's environment or files.
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
    const runtime = createStandaloneRuntime({ stateDir, host, port,
      pluginConfig: { ...config, ...(publicBaseUrl ? { publicBaseUrl } : {}) } });
    const address = await runtime.start();
    const localUrl = ["0.0.0.0", "::"].includes(host) ? `http://127.0.0.1:${address.port}` : address.baseUrl;
    await fs.writeFile(connectionFile, JSON.stringify({ url: localUrl, tokenFile: path.join(stateDir, "standalone-admin-token") }, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ok: true, url: localUrl, stateDir, phoneUrl: publicBaseUrl ?? null,
      next: ["clawsense pair", "clawsense connect codex --apply"],
      note: "Model/ASR availability depends on the configured backend. This command does not provision model credentials." }, null, 2) + "\n");
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      try { await runtime.stop(); process.exitCode = 0; }
      catch { process.stderr.write("Companion shutdown failed. Inspect service state before restarting.\n"); process.exitCode = 1; }
    };
    const onSignal = () => {
      if (stopping) {
        process.stderr.write("Forced exit; the state lock is retained. Confirm the old process has stopped before recovery.\n");
        process.exit(130);
      }
      void stop();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return;
  }
  if (command === "mcp") { await runMcpStdio(await connection()); return; }
  if (command === "open") {
    const config = await connection();
    const result = await adminRequest("/api/clawsense/browser-login", "POST", {});
    const url = `${config.url}/app#code=${encodeURIComponent(result.code)}`;
    const launcher = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launcher, args, { stdio: "ignore", shell: false });
      child.once("error", () => reject(new Error("browser_launch_failed")));
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("browser_launch_failed")));
    });
    process.stdout.write("Opened the local ClawSense console.\n"); return;
  }
  if (command === "pair") {
    if (values.role && !["sensor", "primary"].includes(values.role)) throw new Error("invalid_device_role");
    const result = await adminRequest("/api/clawsense/setup", "POST", { deviceRole: values.role ?? "sensor" });
    qrcode.generate(result.setupCode, { small: true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "connect") {
    if (!target) throw new Error("agent_required");
    const agents = target === "all" ? [...AGENT_IDS] : [normalizeAgentId(target)];
    const config = await connection();
    const results: unknown[] = [];
    for (const agent of agents) {
      const outputDir = path.resolve(values.out ? (agents.length > 1 ? path.join(values.out, agent) : values.out) : path.join(stateDir, "agent-installs", agent));
      let issued: Record<string, any> | undefined;
      let tokenFile: string | undefined;
      let bundleWritten = false;
      try {
      try { await fs.lstat(outputDir); throw new Error(`install_directory_exists:${outputDir}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const tokenDir = path.join(stateDir, "agent-tokens");
      await fs.mkdir(tokenDir, { recursive: true, mode: 0o700 });
      tokenFile = path.join(tokenDir, `${agent}-${randomUUID()}.token`);
      const plan = buildAgentInstallPlan({ agent, executable: process.execPath, executableArgs: [fileURLToPath(import.meta.url)], serverUrl: config.url, tokenFile, outputDir });
      const digitalScopes = (values["digital-project"] ?? []).map((projectId) => ({ projectId, allowRaw: values["digital-raw"] ?? false }));
      if (values["digital-raw"] && !digitalScopes.length) throw new Error("digital_raw_requires_digital_project");
      const contextScopes = values["context-project"] ? normalizeContextScopes(values["context-project"].map((projectId) => ({ projectId, sourceKinds: values["context-source"], operations: values["context-operation"] ?? ["read-metadata", "read-analysis", "read-result"] }))) : undefined;
      if (!contextScopes && [values["context-source"], values["context-operation"], values["context-capability"]].some(Boolean)) throw new Error("context_options_require_project");
      const contextCapabilities = normalizeContextCapabilities(values["context-capability"]);
      issued = await adminRequest("/api/clawsense/agent/grants", "POST", { agentId: agentGrantIdentity(agent), digitalScopes, contextScopes, contextCapabilities, contextProcessingLocation: values["context-processing"] });
        await fs.writeFile(tokenFile, `${issued.token}\n`, { mode: 0o600, flag: "wx" });
        const files = await writeAgentInstallPlan(plan, outputDir);
        bundleWritten = true;
        const install = values.apply ? await applyAgentInstallPlan(plan, { homeDir: path.resolve(values["config-home"] ?? os.homedir()), replace: values.replace }) : undefined;
        results.push({ ok: true, agent, grantId: issued.grant.id, authorizationMode: contextScopes === undefined ? "legacy-physical-library" : "explicit-context-scopes", contextScopes, contextCapabilities, outputDir, files, install,
          status: plan.status, instructions: plan.instructions, warnings: plan.warnings, ...(plan.deepLink ? { deepLink: plan.deepLink } : {}) });
      } catch (error) {
        if (issued) await adminRequest(`/api/clawsense/agent/grants?id=${encodeURIComponent(issued.grant.id)}`, "DELETE").catch(() => {});
        if (tokenFile) await fs.rm(tokenFile, { force: true });
        if (bundleWritten) await fs.rm(outputDir, { recursive: true, force: true });
        results.push({ ok: false, agent, error: error instanceof Error ? error.message : "agent_install_failed" });
      }
    }
    const failed = results.some((result) => (result as { ok: boolean }).ok === false);
    process.stdout.write(JSON.stringify({ ok: !failed, partial: failed && results.some((result) => (result as { ok: boolean }).ok), results }, null, 2) + "\n");
    if (failed) process.exitCode = 1;
    return;
  }
  if (command === "grants") { process.stdout.write(JSON.stringify(await adminRequest("/api/clawsense/agent/grants"), null, 2) + "\n"); return; }
  if (command === "revoke") {
    if (!target) throw new Error("grant_id_required");
    process.stdout.write(JSON.stringify(await adminRequest(`/api/clawsense/agent/grants?id=${encodeURIComponent(target)}`, "DELETE")) + "\n"); return;
  }
  const backend = createRemoteBackend(await connection());
  if (command === "doctor") {
    const tools = await backend.listTools();
    const status = await backend.callTool("clawsense_status", {});
    process.stdout.write(JSON.stringify({ ok: true, toolCount: tools.length, status: status.details,
      validation: "Connection check only; live capture, model quality and native host acceptance are separate." }, null, 2) + "\n"); return;
  }
  if (command === "call") {
    if (!target) throw new Error("tool_name_required");
    const args = JSON.parse(values.args ?? "{}");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args_must_be_object");
    const result = await backend.callTool(target, args);
    process.stdout.write(JSON.stringify(result.details ?? result, null, 2) + "\n");
    if ((result.details as { ok?: boolean } | undefined)?.ok === false) process.exitCode = 1;
    return;
  }
  if (command === "export-work") {
    if (!target || !values.out) throw new Error("work_id_and_output_file_required");
    const result = await backend.callTool("clawsense_work_get", { workItemId: target });
    const details = result.details as { ok?: boolean; work?: { resultText?: string; stale?: boolean } };
    if (!details.ok || typeof details.work?.resultText !== "string") throw new Error("completed_work_result_required");
    const output = path.resolve(values.out);
    await fs.writeFile(output, details.work.resultText, { mode: 0o600, flag: "wx" });
    process.stdout.write(JSON.stringify({ ok: true, path: output, stale: details.work.stale }) + "\n"); return;
  }
  if (command === "import") {
    if (!values.file || !values.project) throw new Error("import_file_and_project_required");
    const file = path.resolve(values.file), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("invalid_import_file");
    const ext = path.extname(file).toLowerCase();
    const mime = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" } as Record<string,string>)[ext];
    if (!mime && ![".txt", ".md", ".csv", ".json"].includes(ext)) throw new Error("unsupported_import_file");
    const bytes = await fs.readFile(file), text = mime ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 64000) throw new Error("import_text_too_large");
    const clientEventId = createHash("sha256").update(JSON.stringify([values.project, values["person-id"], values["session-id"], values.title, values["source-url"], info.mtimeMs])).update(bytes).digest("hex");
    const result = await backend.callTool("clawsense_desktop_import", { clientEventId, projectId: values.project, title: values.title ?? path.basename(file), text, capturedAt: info.mtimeMs, ...(mime ? { mime, imageBase64: bytes.toString("base64") } : {}), ...(values["person-id"] ? { personId: values["person-id"] } : {}), ...(values["session-id"] ? { sessionId: values["session-id"] } : {}), ...(values["source-url"] ? { sourceUrl: values["source-url"] } : {}) });
    const details = result.details as any;
    if (!details.ok) throw new Error(details.error ?? "desktop_import_failed");
    process.stdout.write(JSON.stringify({ ok: true, stored: details.stored, eventId: details.event?.eventId, revision: details.event?.revision, meaning: "已保存来源，尚未确认业务事实" }) + "\n"); return;
  }
  throw new Error(`unknown_command:${command}`);
}

function privateLanAddress(): string {
  const candidates = Object.values(os.networkInterfaces()).flat().filter((item) => item && !item.internal && item.family === "IPv4")
    .map((item) => item!.address).filter((address) => /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(address));
  if (!candidates.length) throw new Error("no_private_lan_address_found_use_public_url");
  return candidates[0]!;
}

main().catch((error: unknown) => {
  process.stderr.write(`ClawSense: ${error instanceof Error ? error.message : "operation_failed"}\n`);
  process.exitCode = 1;
});
