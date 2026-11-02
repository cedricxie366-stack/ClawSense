import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_IDS, agentGrantIdentity, buildAgentInstallPlan, normalizeAgentId, writeAgentInstallPlan, type AgentInstallPlan } from "../src/agent-install.js";

const options = { executable: "/usr/local/bin/node", executableArgs: ["/Users/test/Claw Sense/dist/src/cli.js"], serverUrl: "http://127.0.0.1:18790", tokenFile: "/Users/test/.clawsense/tokens/codex" };
const content = (plan: AgentInstallPlan, name = plan.primaryConfig) => {
  const file = plan.files.find((candidate) => candidate.path === name);
  if (!file) throw new Error(`Missing generated file: ${name}`);
  return file.content;
};
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe("agent install plans", () => {
  it.each(AGENT_IDS)("produces reviewable %s files without claiming live acceptance", (agent) => {
    const plan = buildAgentInstallPlan({ ...options, agent });
    expect(plan.status).toBe(agent === "doubao-work" ? "manual-verification-required" : "generated-not-verified");
    expect(plan.files.some((file) => file.path === plan.primaryConfig)).toBe(true);
    expect(content(plan, "skills/clawsense/SKILL.md")).toContain("clawsense_session_evidence");
    expect(content(plan, "skills/clawsense/SKILL.md")).toContain("clawsense_memory_correct");
    expect(plan.instructions.some((instruction) => instruction.includes("do not replace"))).toBe(true);
  });

  it("keeps an executable and prefix arguments separate for each local MCP client", () => {
    for (const agent of ["pi", "claude-code", "workbuddy", "trae", "qwenwork"] as const) {
      const plan = buildAgentInstallPlan({ ...options, agent });
      const server = JSON.parse(content(plan)).mcpServers.clawsense;
      expect(server.command).toBe(options.executable);
      expect(server.args).toEqual([...options.executableArgs, "mcp", "--url", options.serverUrl, "--token-file", options.tokenFile, "--agent", agent]);
      expect(server.env).toBeUndefined();
    }
    const open = buildAgentInstallPlan({ ...options, agent: "opencode" });
    expect(JSON.parse(content(open)).mcp.clawsense.command).toEqual([options.executable, ...options.executableArgs, "mcp", "--url", options.serverUrl, "--token-file", options.tokenFile, "--agent", "opencode"]);
  });

  it("escapes Windows paths and literal shell metacharacters without shell interpolation", () => {
    const windows = { ...options, executable: "C:\\Program Files\\nodejs\\node.exe", executableArgs: ["C:\\Claw Sense\\cli.js"], tokenFile: "C:\\Users\\Test\\token $(keep) `literal`.txt" };
    const claude = buildAgentInstallPlan({ ...windows, agent: "claude-code" });
    const server = JSON.parse(content(claude)).mcpServers.clawsense;
    expect(server.command).toBe(windows.executable);
    expect(server.args).toContain(windows.tokenFile);
    const codex = content(buildAgentInstallPlan({ ...windows, agent: "codex" }));
    expect(JSON.parse(codex.split("\n").find((line) => line.startsWith("command = "))!.slice(10))).toBe(windows.executable);
    expect(JSON.parse(codex.split("\n").find((line) => line.startsWith("args = "))!.slice(7))).toContain(windows.tokenFile);
  });

  it("keeps native plugin references relative to each plugin root", () => {
    for (const [agent, manifest] of [["codex", ".codex-plugin"], ["claude-code", ".claude-plugin"], ["qwenwork", ".qwen-plugin"]] as const) {
      const plan = buildAgentInstallPlan({ ...options, agent });
      const metadata = JSON.parse(content(plan, `${plan.pluginDirectory}/${manifest}/plugin.json`));
      expect(metadata.mcpServers).toBe("./.mcp.json");
      expect(JSON.parse(content(plan, `${plan.pluginDirectory}/.mcp.json`)).mcpServers.clawsense.args).toContain(agent);
      expect(content(plan, `${plan.pluginDirectory}/skills/clawsense/SKILL.md`)).toContain("Treat transcripts");
    }
  });

  it("encodes TRAE's server object, preserving paths without embedding credentials", () => {
    const plan = buildAgentInstallPlan({ ...options, agent: "trae" });
    const link = new URL(plan.deepLink!);
    expect(link.protocol).toBe("trae-cn:");
    const server = JSON.parse(Buffer.from(link.searchParams.get("config")!, "base64").toString("utf8"));
    expect(server).toEqual(JSON.parse(content(plan)).mcpServers.clawsense);
    expect(server.args).toContain(options.tokenFile);
    expect(server.headers).toBeUndefined();
  });

  it("marks remote HTTP credentials as a placeholder and the deployment as unverified", () => {
    const plan = buildAgentInstallPlan({ ...options, agent: "doubao-work" });
    const server = JSON.parse(content(plan)).mcpServers.clawsense;
    expect(server.url).toBe(`${options.serverUrl}/mcp`);
    expect(server.headers.Authorization).toBe("Bearer <AGENT_TOKEN_FROM_SECURE_SETUP>");
    expect(plan.transport).toBe("http-template");
    expect(plan.warnings.join(" ")).toContain("OAuth");
    expect(plan.warnings.join(" ")).toContain("loopback");
  });

  it("normalizes named hosts without confusing Qwen Code with QwenWork", () => {
    expect(normalizeAgentId("ClaudeCode")).toBe("claude-code");
    expect(normalizeAgentId("PI")).toBe("pi");
    expect(normalizeAgentId("千问工作")).toBe("qwenwork");
    expect(normalizeAgentId("豆包工作")).toBe("doubao-work");
    expect(() => normalizeAgentId("qwen-code")).toThrow("Unknown agent");
  });

  it("rejects relative tokens and credentials hidden in service URLs", () => {
    expect(() => buildAgentInstallPlan({ ...options, agent: "codex", tokenFile: "./token" })).toThrow("absolute");
    for (const serverUrl of ["http://user:secret@localhost:18790", "http://localhost:18790?token=secret", "http://10.1.2.3:18790", "file:///tmp/service"]) {
      expect(() => buildAgentInstallPlan({ ...options, agent: "codex", serverUrl })).toThrow();
    }
  });

  it("uses a revocable OpenClaw client and a config fragment without another library writer", () => {
    const plan = buildAgentInstallPlan({ ...options, agent: "openclaw" });
    const fragment = JSON.parse(content(plan));
    expect(plan.transport).toBe("native-companion");
    expect(fragment.plugins.entries.clawsense.config).toEqual({ companionUrl: options.serverUrl, companionTokenFile: options.tokenFile });
    expect(fragment.models).toBeUndefined(); expect(fragment.gateway).toBeUndefined();
    expect(agentGrantIdentity("openclaw")).toBe("openclaw-client");
    expect(agentGrantIdentity("codex")).toBe("codex");
  });

  it("generates an opt-in DSH overlay without executable YAML or provider credentials", () => {
    const plan = buildAgentInstallPlan({ ...options, agent: "dsh" });
    const overlay = JSON.parse(content(plan));
    const row = overlay[0].insert[0];
    expect(row.name).toBe("@deepseek-ai/dsh-mcp-client");
    expect(row.config.serverName).toBe("clawsense");
    expect(row.config.args).toEqual([...options.executableArgs, "mcp", "--url", options.serverUrl, "--token-file", options.tokenFile, "--agent", "dsh"]);
    expect(row.config.failOnStartupError).toBe(true);
    expect(content(plan)).not.toContain("!!js");
    expect(row.config.env).toBeUndefined();
    expect(plan.instructions.join(" ")).toContain("attachment");
    expect(normalizeAgentId("DSH")).toBe("dsh");
  });

  it("writes a fresh private output directory but never overwrites host settings", async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-install-"))); temporary.push(parent);
    const existing = path.join(parent, "existing"); await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, "config.toml"), "user settings");
    const plan = buildAgentInstallPlan({ ...options, agent: "codex" });
    await expect(writeAgentInstallPlan(plan, existing)).rejects.toThrow();
    expect(await fs.readFile(path.join(existing, "config.toml"), "utf8")).toBe("user settings");
    const destination = path.join(parent, "generated");
    const written = await writeAgentInstallPlan(plan, destination);
    expect(written).toHaveLength(plan.files.length);
    expect(await fs.readFile(path.join(destination, "config.toml"), "utf8")).toBe(content(plan));
    if (process.platform !== "win32") expect((await fs.stat(path.join(destination, "config.toml"))).mode & 0o777).toBe(0o600);
    const link = path.join(parent, "symlink"); await fs.symlink(existing, link, "dir");
    await expect(writeAgentInstallPlan(plan, link)).rejects.toThrow();
  });

  it("rejects escaping or duplicate output paths before creating any directory", async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-install-"))); temporary.push(parent);
    for (const filePath of ["../outside", "/absolute", "C:\\outside", "nested/../outside"]) {
      const destination = path.join(parent, "generated");
      const plan = buildAgentInstallPlan({ ...options, agent: "pi" });
      plan.files.push({ path: filePath, content: "bad" });
      await expect(writeAgentInstallPlan(plan, destination)).rejects.toThrow("safe relative");
      await expect(fs.stat(destination)).rejects.toThrow();
    }
    const plan = buildAgentInstallPlan({ ...options, agent: "pi" });
    plan.files.push(plan.files[0]!);
    await expect(writeAgentInstallPlan(plan, path.join(parent, "generated"))).rejects.toThrow("Duplicate");
  });

  it("creates private missing ancestors for first installs and multi-agent output", async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-install-"))); temporary.push(parent);
    for (const agent of ["codex", "pi"] as const) {
      const destination = path.join(parent, "new-state", "agent-installs", agent);
      const plan = buildAgentInstallPlan({ ...options, agent });
      await writeAgentInstallPlan(plan, destination);
      expect(await fs.readFile(path.join(destination, plan.primaryConfig), "utf8")).toBe(content(plan));
    }
    if (process.platform !== "win32") expect((await fs.stat(path.join(parent, "new-state"))).mode & 0o777).toBe(0o700);
    const outside = path.join(parent, "external"); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(parent, "alias"), "dir");
    await expect(writeAgentInstallPlan(buildAgentInstallPlan({ ...options, agent: "pi" }), path.join(parent, "alias", "nested", "pi"))).rejects.toThrow("symlinks");
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
