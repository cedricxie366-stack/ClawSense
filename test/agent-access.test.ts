import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAccessStore } from "../src/agent-access.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("agent grants", () => {
  it("persists only hashes, binds actor, and revokes immediately across instances", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-grants-")); roots.push(stateDir);
    const store = new AgentAccessStore({ stateDir });
    const [a, b] = await Promise.all([store.issue("codex"), store.issue("claude-code")]);
    const second = new AgentAccessStore({ stateDir });
    expect((await second.authenticate(a.token))?.agentId).toBe("codex");
    expect(await second.authenticate("wrong")).toBeNull();
    expect(await fs.readFile(path.join(stateDir, "agent-grants.json"), "utf8")).not.toContain(a.token);
    await second.revoke(a.grant.id);
    expect(await store.authenticate(a.token)).toBeNull();
    expect((await store.authenticate(b.token))?.agentId).toBe("claude-code");
    expect(await store.list()).toHaveLength(2);
  });

  it("does not replace a corrupt store with an empty one", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsense-grants-")); roots.push(stateDir);
    await fs.writeFile(path.join(stateDir, "agent-grants.json"), "broken");
    await expect(new AgentAccessStore({ stateDir }).issue("codex")).rejects.toThrow("agent_grant_store_unreadable");
    expect(await fs.readFile(path.join(stateDir, "agent-grants.json"), "utf8")).toBe("broken");
  });
});
