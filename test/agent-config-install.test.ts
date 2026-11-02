import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentInstallPlan, type AgentId } from "../src/agent-install.js";
import { applyAgentInstallPlan } from "../src/agent-config-install.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
async function home() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-apply-")); roots.push(directory); return directory; }
function plan(agent: AgentId, suffix = "") { return buildAgentInstallPlan({ agent, executable: "clawsense", serverUrl: "http://127.0.0.1:18790", tokenFile: "/private/tokens/" + agent + suffix }); }
async function seed(root: string, relative: string, source: string) {
  const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, source); return file;
}

describe("apply agent configuration", () => {
  it.each([
    ["pi", ".pi/agent/mcp.json", "mcpServers"], ["claude-code", ".claude.json", "mcpServers"],
    ["opencode", ".config/opencode/opencode.json", "mcp"],
  ] as const)("merges %s without losing settings or other servers and backs up exact bytes", async (agent, relative, key) => {
    const homeDir = await home();
    const original = JSON.stringify({ theme: "original", [key]: { other: { command: "keep" } }, projects: { demo: { trusted: true } } });
    const file = await seed(homeDir, relative, original);
    const result = await applyAgentInstallPlan(plan(agent), { homeDir });
    expect(result.applied).toBe(true);
    expect(result.configPath).toBe(file);
    expect(await fs.readFile(result.backupPath!, "utf8")).toBe(original);
    const updated = JSON.parse(await fs.readFile(file, "utf8"));
    expect(updated.theme).toBe("original");
    expect(updated.projects.demo.trusted).toBe(true);
    expect(updated[key].other.command).toBe("keep");
    expect(updated[key].clawsense).toBeDefined();
    expect(updated[key].clawsense._clawsenseManaged).toBeUndefined();
    const repeat = await applyAgentInstallPlan(plan(agent), { homeDir });
    expect(repeat.applied).toBe(true); expect(repeat.backupPath).toBeUndefined();
    const changed = await applyAgentInstallPlan(plan(agent, "-rotated"), { homeDir });
    expect(changed.applied).toBe(true); expect(changed.backupPath).toBeDefined();
  });

  it("requires explicit replacement for an unmanaged or externally changed server", async () => {
    const homeDir = await home(); const original = JSON.stringify({ mcpServers: { clawsense: { command: "someone-else" } } });
    const file = await seed(homeDir, ".claude.json", original);
    await expect(applyAgentInstallPlan(plan("claude-code"), { homeDir })).rejects.toThrow("unmanaged");
    expect(await fs.readFile(file, "utf8")).toBe(original);
    const result = await applyAgentInstallPlan(plan("claude-code"), { homeDir, replace: true });
    expect(await fs.readFile(result.backupPath!, "utf8")).toBe(original);
    const edited = JSON.parse(await fs.readFile(file, "utf8")); edited.mcpServers.clawsense.command = "user-customized"; await fs.writeFile(file, JSON.stringify(edited));
    await expect(applyAgentInstallPlan(plan("claude-code"), { homeDir })).rejects.toThrow("unmanaged");
  });

  it("appends Codex's distinct TOML table and preserves original bytes", async () => {
    const homeDir = await home(); const original = 'model = "selected"\n[mcp_servers.other]\ncommand = "keep"\n[mcp_servers.other.env]\nMODE = "local"\n';
    const file = await seed(homeDir, ".codex/config.toml", original);
    const result = await applyAgentInstallPlan(plan("codex"), { homeDir });
    expect(await fs.readFile(result.backupPath!, "utf8")).toBe(original);
    expect((await fs.readFile(file, "utf8")).startsWith(original)).toBe(true);
    expect(await fs.readFile(file, "utf8")).toContain("[mcp_servers.clawsense]");
    await expect(applyAgentInstallPlan(plan("codex"), { homeDir, replace: true })).rejects.toThrow("replace is not supported");
  });

  it.each([
    '[mcp_servers."clawsense"]\ncommand = "other"',
    "['mcp_servers'.'clawsense'.env]\nMODE='old'",
    '["mcp_servers"."claw\\u0073ense"]\ncommand="other"',
    'mcp_servers = { other = {command="other"} }',
    '[mcp_servers]\nclawsense = {command="other"}',
    'mcp_servers.clawsense.command = "other"',
  ])("does not create conflicting Codex tables for %s", async (original) => {
    const homeDir = await home(); const file = await seed(homeDir, ".codex/config.toml", original);
    await expect(applyAgentInstallPlan(plan("codex"), { homeDir })).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("does not bypass an OpenCode JSONC configuration", async () => {
    const homeDir = await home(); const original = '{ // keep comments\n "model": "chosen"\n}';
    const jsonc = await seed(homeDir, ".config/opencode/opencode.jsonc", original);
    await expect(applyAgentInstallPlan(plan("opencode"), { homeDir })).rejects.toThrow("jsonc");
    expect(await fs.readFile(jsonc, "utf8")).toBe(original);
    await expect(fs.stat(path.join(homeDir, ".config/opencode/opencode.json"))).rejects.toThrow();
  });

  it("rejects malformed JSON, non-object maps, and symlink configs without replacing them", async () => {
    const homeDir = await home(); const file = await seed(homeDir, ".claude.json", "{not json}");
    await expect(applyAgentInstallPlan(plan("claude-code"), { homeDir })).rejects.toThrow("strict JSON");
    await fs.writeFile(file, '{"mcpServers":[]}');
    await expect(applyAgentInstallPlan(plan("claude-code"), { homeDir })).rejects.toThrow("JSON object");
    await fs.rm(file); const outside = path.join(homeDir, "untouched"); await fs.writeFile(outside, "{}"); await fs.symlink(outside, file);
    await expect(applyAgentInstallPlan(plan("claude-code"), { homeDir })).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("{}");
  });

  it("rejects directory and ownership-marker symlinks", async () => {
    const homeDir = await home(); const external = await home();
    await fs.symlink(external, path.join(homeDir, ".pi"), "dir");
    await expect(applyAgentInstallPlan(plan("pi"), { homeDir })).rejects.toThrow("symlink");
    expect(await fs.readdir(external)).toEqual([]);
    const markerTarget = await seed(homeDir, "marker-data", "{}"); await fs.symlink(markerTarget, path.join(homeDir, ".claude.json.clawsense-managed.json"));
    await expect(applyAgentInstallPlan(plan("claude-code"), { homeDir })).rejects.toThrow();
    await expect(fs.stat(path.join(homeDir, ".claude.json"))).rejects.toThrow();
  });

  it.each(["workbuddy", "trae", "doubao-work", "qwenwork"] as const)("returns native instructions for %s without guessing config paths", async (agent) => {
    const homeDir = await home(); const result = await applyAgentInstallPlan(plan(agent), { homeDir });
    expect(result.applied).toBe(false); expect(result.reason).toContain("native import"); expect(await fs.readdir(homeDir)).toEqual([]);
  });
});
