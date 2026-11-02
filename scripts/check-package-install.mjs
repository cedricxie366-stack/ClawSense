#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
const run = promisify(execFile);
const { values } = parseArgs({ options: { package: { type: "string" } } });
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-package-")));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  const packed = values.package ? { filename: path.basename(values.package) } : JSON.parse((await run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { maxBuffer: 4 * 1024 * 1024 })).stdout)[0];
  const packagePath = values.package ? path.resolve(values.package) : path.join(directory, packed.filename);
  const sha256 = createHash("sha256").update(await fs.readFile(packagePath)).digest("hex");
  const prefix = path.join(directory, "install");
  await run(npm, ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", packagePath], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  const pkgDir = path.join(prefix, "node_modules", "clawsense");
  const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(path.posix.normalize(pkg.bin.clawsense), "dist/src/cli.js");
  const output = await run(process.execPath, [path.join(pkgDir, pkg.bin.clawsense), "--help"], { timeout: 15_000 });
  assert.match(output.stdout, /connect <agent\|all>/);
  assert.match(output.stdout, /clawsense start/);
  assert.match(output.stdout, /Agents:.*dsh/);
  assert.match(output.stdout, /context-migrate/);
  assert.match(output.stdout, /context-recover/);
  assert.match(output.stdout, /live-serve/);
  for (const file of ["worker.py", "process_activity.py", "vision_policy.py", "prepare.py", "requirements.txt", "dsh-prepare.mjs"])
    await fs.access(path.join(pkgDir, "scripts/live", file));
  await fs.access(path.join(pkgDir, "docs/pilot/README.md"));
  await fs.access(path.join(pkgDir, "docs/contracts/live-runtime-v1.md"));
  const { LiveRequestStore } = await import(pathToFileURL(path.join(pkgDir, "dist/src/live/requests.js")).href);
  const receipts = new LiveRequestStore(path.join(directory, "installed-live"));
  assert.equal((await receipts.claim("fixture", "first", "controlled request")).fresh, true);
  assert.equal((await receipts.claim("fixture", "first", "controlled request")).fresh, false);
  await fs.access(path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "clawsense.cmd" : "clawsense"));
  const manifest = JSON.parse(await fs.readFile(path.join(pkgDir, "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.configSchema.properties.companionUrl.type, "string");
  const plugin = (await import(pathToFileURL(path.join(pkgDir, "dist/index.js")).href)).default;
  const tools = [];
  plugin.register({ pluginConfig: { companionUrl: "http://127.0.0.1:18790", companionTokenFile: path.join(directory, "private-token") }, registerTool: (tool) => tools.push(tool),
    get runtime() { throw new Error("packaged_client_opened_local_writer"); },
    registerService() { throw new Error("packaged_client_started_capture"); } });
  assert.deepEqual(tools.map((tool) => tool.name), ["clawsense_tools", "clawsense_call"]);
  const { buildAgentInstallPlan } = await import(pathToFileURL(path.join(pkgDir, "dist/src/agent-install.js")).href);
  const dsh = buildAgentInstallPlan({ agent: "dsh", executable: process.execPath, executableArgs: [path.join(pkgDir, pkg.bin.clawsense)], serverUrl: "http://127.0.0.1:18790", tokenFile: path.join(directory, "private-token"), outputDir: path.join(directory, "dsh-bundle") });
  assert.equal(dsh.agent, "dsh");
  assert.match(JSON.stringify(dsh), /@deepseek-ai\/dsh-mcp-client/);
  const skill = await fs.readFile(path.join(pkgDir, "agent-plugins/skills/clawsense/SKILL.md"), "utf8");
  assert.match(skill, /receiving a proposal on Thursday/);
  assert.match(skill, /clawsense_selected_results/);
  const { createStandaloneRuntime } = await import(pathToFileURL(path.join(pkgDir, "dist/src/standalone-runtime.js")).href);
  const installedRuntime = createStandaloneRuntime({ stateDir: path.join(directory, "installed-runtime"), port: 0, pluginConfig: { retrievalEmbeddingBackend: "none", hostModelImageMode: "metadata-only", hostModelVideoMode: "none" } });
  try {
    await installedRuntime.start();
    for (const name of ["clawsense_workspace", "clawsense_context_snapshot", "clawsense_result_review", "clawsense_selected_results", "clawsense_context_delete", "clawsense_context_export"]) assert(installedRuntime.tools.has(name), `packaged_context_tool_missing:${name}`);
    const workspace = await installedRuntime.invokeTool("clawsense_workspace", {});
    assert.equal(workspace.details.ok, true);
    assert.match(JSON.stringify(workspace.details), /workspace_/);
  } finally { await installedRuntime.stop(); }
  process.stdout.write(JSON.stringify({ ok: true, package: packed.filename, sha256, cleanPrefixInstall: true, cliLoads: true, dshInstallPlanLoads: true, runtimeSkillIncluded: true, openclawCompanionLoads: true, unifiedContextLoads: true, liveModelCalls: 0, published: false }, null, 2) + "\n");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
