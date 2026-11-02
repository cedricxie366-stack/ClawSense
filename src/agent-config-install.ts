import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentId, AgentInstallPlan } from "./agent-install.js";

export interface ApplyAgentInstallOptions { homeDir: string; replace?: boolean }
export interface ApplyAgentInstallResult {
  agent: AgentId;
  applied: boolean;
  configPath?: string;
  backupPath?: string;
  instructions: string[];
  reason?: string;
}

const LOCATIONS: Partial<Record<AgentId, string[]>> = {
  pi: [".pi", "agent", "mcp.json"], codex: [".codex", "config.toml"],
  "claude-code": [".claude.json"], opencode: [".config", "opencode", "opencode.json"],
};

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex"); }

async function readRegular(filePath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile() || (await fs.lstat(filePath)).isSymbolicLink()) throw new Error(`Refusing non-regular config file: ${filePath}`);
    return await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

async function ensureDirectory(home: string, parts: string[]): Promise<void> {
  let current = home;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing symlink or non-directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode: 0o700 });
    }
  }
}

/** Parse TOML keys only. Complex multiline TOML is deliberately left for a native/manual import. */
function tomlKeys(input: string): string[] {
  const keys: string[] = [];
  let remaining = input.trim();
  while (remaining) {
    let key: string;
    if (remaining[0] === '"') {
      const match = remaining.match(/^"(?:[^"\\]|\\.)*"/u);
      if (!match) throw new Error("Cannot safely inspect quoted TOML key; import manually");
      try { key = JSON.parse(match[0]) as string; } catch { throw new Error("Cannot safely inspect escaped TOML key; import manually"); }
      remaining = remaining.slice(match[0].length).trim();
    } else if (remaining[0] === "'") {
      const end = remaining.indexOf("'", 1);
      if (end < 0) throw new Error("Cannot safely inspect literal TOML key; import manually");
      key = remaining.slice(1, end); remaining = remaining.slice(end + 1).trim();
    } else {
      const match = remaining.match(/^[A-Za-z0-9_-]+/u);
      if (!match) throw new Error("Cannot safely inspect TOML key; import manually");
      key = match[0]; remaining = remaining.slice(key.length).trim();
    }
    keys.push(key);
    if (!remaining) break;
    if (!remaining.startsWith(".")) throw new Error("Cannot safely inspect dotted TOML key; import manually");
    remaining = remaining.slice(1).trim();
    if (!remaining) throw new Error("Invalid dotted TOML key; import manually");
  }
  return keys;
}

function uncommentToml(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote === '"' && char === "\\") { index++; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index).trim();
  }
  return line.trim();
}

function assertTomlAppendable(source: string): void {
  if (source.includes('"""') || source.includes("'''")) throw new Error("Multiline TOML requires native/manual import; existing config was not changed");
  let section: string[] = [];
  for (const raw of source.split(/\r?\n/u)) {
    const line = uncommentToml(raw);
    if (!line) continue;
    if (line.startsWith("[")) {
      const array = line.startsWith("[[");
      const ending = array ? "]]" : "]";
      if (!line.endsWith(ending)) throw new Error("Cannot safely inspect TOML section; import manually");
      section = tomlKeys(line.slice(array ? 2 : 1, -ending.length));
      if (section[0] === "mcp_servers" && section[1] === "clawsense") throw new Error("Codex already contains a clawsense table; replace is not supported for TOML. Import manually");
      continue;
    }
    // Continuation lines of arrays/inline tables do not start independent TOML keys.
    const equal = line.indexOf("=");
    if (equal < 0) continue;
    let keys: string[];
    try { keys = tomlKeys(line.slice(0, equal)); } catch {
      // Ambiguous keys are never ignored, because they might hide the target table.
      throw new Error("Cannot safely inspect TOML assignment; import manually");
    }
    const full = [...section, ...keys];
    if (full[0] === "mcp_servers" && (full.length === 1 || full[1] === "clawsense")) {
      throw new Error("Codex contains an inline or existing clawsense MCP configuration; import manually");
    }
  }
}

/** Apply only documented user-level config paths; preserve all other entries and back up before writing. */
export async function applyAgentInstallPlan(plan: AgentInstallPlan, options: ApplyAgentInstallOptions): Promise<ApplyAgentInstallResult> {
  const result: ApplyAgentInstallResult = { agent: plan.agent, applied: false, instructions: [...plan.instructions] };
  const location = LOCATIONS[plan.agent];
  if (!location) return { ...result, reason: "This host requires its native import, installation link, or credential UI; no host configuration was modified." };
  if (!path.isAbsolute(options.homeDir)) throw new Error("homeDir must be absolute");
  const home = path.resolve(options.homeDir);
  await ensureDirectory(home, location.slice(0, -1));
  const configPath = path.join(home, ...location);
  result.configPath = configPath;
  const markerPath = `${configPath}.clawsense-managed.json`;
  const lockPath = `${configPath}.clawsense-install.lock`;
  const lock = await fs.open(lockPath, "wx", 0o600);
  let temporary: string | undefined;
  try {
    if (plan.agent === "opencode" && await readRegular(path.join(path.dirname(configPath), "opencode.jsonc")) !== undefined) {
      throw new Error("OpenCode has opencode.jsonc; use manual import to preserve its configuration");
    }
    const original = await readRegular(configPath);
    const originalMarker = await readRegular(markerPath);
    const file = plan.files.find((candidate) => candidate.path === plan.primaryConfig);
    if (!file) throw new Error("Install plan has no primary configuration");
    let next: string;
    let marker: string | undefined;
    if (plan.agent === "codex") {
      assertTomlAppendable(original ?? "");
      // Only append a fully separate table; never remove ranges using a section-spanning regex.
      next = `${original ?? ""}${original?.endsWith("\n") || !original ? "" : "\n"}\n# ClawSense managed MCP connection\n${file.content}`;
    } else {
      let config: unknown;
      try { config = original ? JSON.parse(original) : {}; } catch { throw new Error("Existing configuration is not strict JSON; import manually without replacing it"); }
      if (!object(config)) throw new Error("Existing configuration must be a JSON object");
      const key = plan.agent === "opencode" ? "mcp" : "mcpServers";
      const servers = config[key] ?? {};
      if (!object(servers)) throw new Error(`Existing ${key} must be a JSON object`);
      const desired = JSON.parse(file.content)[key]?.clawsense as unknown;
      if (!object(desired)) throw new Error("Install plan has no clawsense server entry");
      const existing = servers.clawsense;
      let managed = false;
      if (originalMarker) {
        try {
          const prior = JSON.parse(originalMarker);
          managed = prior.version === 1 && prior.agent === plan.agent && prior.entryHash === hash(existing);
        } catch { /* An invalid ownership marker never grants overwrite permission. */ }
      }
      if (existing !== undefined && !managed && !options.replace) throw new Error("An unmanaged clawsense server already exists; use explicit replace or import manually");
      if (managed && hash(existing) === hash(desired)) return { ...result, applied: true };
      config[key] = { ...servers, clawsense: desired };
      next = `${JSON.stringify(config, null, 2)}\n`;
      marker = `${JSON.stringify({ version: 1, agent: plan.agent, entryHash: hash(desired) }, null, 2)}\n`;
    }
    if (original !== undefined) {
      result.backupPath = `${configPath}.clawsense-backup-${randomUUID()}`;
      await fs.writeFile(result.backupPath, original, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    temporary = `${configPath}.clawsense-tmp-${randomUUID()}`;
    await fs.writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (await readRegular(configPath) !== original) throw new Error("Host configuration changed during installation; refusing to overwrite it");
    await fs.rename(temporary, configPath); temporary = undefined;
    if (marker !== undefined) {
      // Never follow an existing sidecar symlink. The sidecar is bookkeeping, not host configuration.
      await readRegular(markerPath);
      const markerTemporary = `${markerPath}.${randomUUID()}`;
      await fs.writeFile(markerTemporary, marker, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(markerTemporary, markerPath);
    }
    return { ...result, applied: true };
  } finally {
    if (temporary) await fs.rm(temporary, { force: true });
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}
