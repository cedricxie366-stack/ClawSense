#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createStandaloneRuntime } from "../dist/src/standalone-runtime.js";

// These fixtures never call a model or use an existing private library.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-stdio-")));
const configHome = path.join(directory, "test-config-home");
await fs.mkdir(configHome);
const runtime = createStandaloneRuntime({ stateDir: directory, port: 0, pluginConfig: {
  hostModelImageMode: "metadata-only", retrievalEmbeddingBackend: "none", localAsrBackend: "none", asrWorkerEnabled: false,
} });
const clients = [];
let assertions = 0;
let daemonPid;
let daemonDirectory;
try {
  const { baseUrl } = await runtime.start();
  const common = ["--state-dir", directory, "--url", baseUrl, "--token-file", runtime.adminTokenFile];
  const runCli = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args, ...common], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  const codexInstall = await runCli("connect", "codex", "--apply", "--config-home", configHome);
  const claudeInstall = await runCli("connect", "claude-code", "--apply", "--config-home", configHome);
  assert.equal(codexInstall.ok, true); assert.equal(claudeInstall.ok, true); assertions += 2;
  assert.match(await fs.readFile(path.join(configHome, ".codex/config.toml"), "utf8"), /mcp_servers/);
  const claudeConfig = JSON.parse(await fs.readFile(path.join(configHome, ".claude.json"), "utf8"));
  assert.ok(claudeConfig.mcpServers.clawsense); assertions += 2;
  for (const agent of ["codex", "claude-code"]) {
    const files = await fs.readdir(path.join(directory, "agent-tokens"));
    const tokenFile = path.join(directory, "agent-tokens", files.find((file) => file.startsWith(`${agent}-`)));
    const client = new Client({ name: `fixture-${agent}`, version: "1.0.0" }, { capabilities: {} });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--url", baseUrl, "--token-file", tokenFile, "--agent", "spoofed-label"], stderr: "pipe" }));
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === "clawsense_session_evidence")); assertions++;
  }
  const call = async (client, name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response)); assertions++;
    return response.structuredContent;
  };
  const [a, b] = clients;
  assert.equal((await call(a, "clawsense_status", {})).actor, "codex"); assertions++;
  assert.equal((await call(b, "clawsense_status", {})).actor, "claude-code"); assertions++;
  const session = (await call(a, "clawsense_session_create", { title: "Protocol fixture", participants: [{ personId: "bob", displayName: "Bob" }] })).session;
  await call(a, "clawsense_memory_correct", { sessionId: session.sessionId, kind: "commitment", text: "Bob will send the proposal on Friday.", assigneeId: "bob", expectedRevision: 1 });
  const secondRead = await call(b, "clawsense_session_get", { sessionId: session.sessionId });
  assert.equal(secondRead.session.revision, 2); assert.equal(secondRead.session.facts[0].assigneeId, "bob"); assertions += 2;
  const work = (await call(a, "clawsense_work_create", { sessionId: session.sessionId, title: "Proposal outline", instructions: "Prepare a user-requested outline.", assignedAgent: "claude-code", inputRevision: 2 })).work;
  await call(b, "clawsense_work_complete", { workItemId: work.workItemId, expectedRevision: 1, resultTitle: "Proposal", resultText: "# Proposal\nOwner: Bob. Delivery: Friday.\n" });
  const output = path.join(directory, "proposal.md");
  const exported = await runCli("export-work", work.workItemId, "--out", output);
  assert.equal(exported.ok, true); assert.match(await fs.readFile(output, "utf8"), /Owner: Bob/); assertions += 2;
  const doctor = await runCli("doctor"); assert.equal(doctor.ok, true); assertions++;
  daemonDirectory = path.join(directory, "daemon");
  const daemonConfig = path.join(directory, "offline-config.json");
  await fs.writeFile(daemonConfig, JSON.stringify({ hostModelImageMode: "metadata-only", retrievalEmbeddingBackend: "none", localAsrBackend: "none", asrWorkerEnabled: false }));
  const background = JSON.parse((await execute(process.execPath, [cli, "--state-dir", daemonDirectory, "start", "--port", "0", "--config", daemonConfig], { timeout: 30_000 })).stdout);
  daemonPid = background.pid;
  assert.equal(background.ok, true); assertions++;
  const stopped = JSON.parse((await execute(process.execPath, [cli, "stop", "--state-dir", daemonDirectory], { timeout: 15_000 })).stdout);
  assert.equal(stopped.stopping, true); assertions++;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.stat(path.join(daemonDirectory, ".standalone.lock")); }
    catch (error) { if (error.code === "ENOENT") { daemonPid = undefined; break; } throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(daemonPid, undefined, "background service should release its lock after stop"); assertions++;
  process.stdout.write(JSON.stringify({ ok: true, assertions, transports: ["stdio"], clients: 2,
    verified: ["CLI install into isolated host configs", "real MCP processes", "authenticated identity", "shared corrections", "work handoff and export", "managed background start and stop"],
    liveModelCalls: 0, nativeHostAcceptance: false, physicalAndroidAcceptance: false }, null, 2) + "\n");
} finally {
  if (daemonPid) { try { process.kill(daemonPid, "SIGTERM"); } catch { /* already exited */ } }
  await Promise.allSettled(clients.map((client) => client.close()));
  await runtime.stop();
  await fs.rm(directory, { recursive: true, force: true });
}
