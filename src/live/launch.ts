import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStandaloneRuntime } from "../standalone-runtime.js";
import type { LiveConfig } from "./types.js";
/** Boot an isolated companion and attach its own MCP grant to the selected DSH SDK profile. */
export async function startLiveRuntime(options: {
  stateDir: string;
  host?: string;
  port: number;
  config: Record<string, any>;
}) {
  const stateDir = path.resolve(options.stateDir),
    cfg = options.config.live as LiveConfig;
  if (!cfg?.enabled) throw new Error("live_must_be_explicitly_enabled");
  const runtime = createStandaloneRuntime({
    stateDir,
    host: options.host,
    port: options.port,
    pluginConfig: options.config,
    runtimeConfig: { clawsenseLiveLocalOnly: true },
  });
  const address = await runtime.start();
  const projectId = cfg.projectId ?? "live";
  await runtime.invokeTool("clawsense_device_context_policy", { deviceId: "*", policy: { projectIds: [projectId], audience: "private", processingLocation: cfg.dsh || cfg.codex ? "selected-external" : "owned-devices", allowedRecipients: [...(cfg.dsh ? ["agent:live-dsh"] : []), ...(cfg.codex ? ["agent:live-codex"] : [])] } });
  const localUrl = `http://127.0.0.1:${address.port}`;
  const token = (await fs.readFile(runtime.adminTokenFile, "utf8")).trim();
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  let grantId: string | undefined;
  try {
    await fs.writeFile(
      path.join(stateDir, "connection.json"),
      JSON.stringify({ url: localUrl, tokenFile: runtime.adminTokenFile }),
      { mode: 0o600 },
    );
    if (cfg.dsh) {
      const grantFile = path.join(stateDir, "live-dsh-grant.json");
      try {
        const previous = JSON.parse(await fs.readFile(grantFile, "utf8"));
        if (typeof previous.id === "string")
          await fetch(
            localUrl +
              "/api/clawsense/agent/grants?id=" +
              encodeURIComponent(previous.id),
            { method: "DELETE", headers },
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const response = await fetch(localUrl + "/api/clawsense/agent/grants", {
        method: "POST",
        headers,
        body: JSON.stringify({ agentId: "live-dsh", contextScopes: [{ projectId, operations: ["read-metadata", "read-analysis", "read-result"] }], contextCapabilities: ["complete-work"] }),
      });
      if (!response.ok) throw new Error("live_harness_grant_failed");
      const data = (await response.json()) as any;
      grantId = data.grant.id;
      const tokenFile = path.join(stateDir, "live-dsh-token");
      await fs.writeFile(tokenFile, data.token, { mode: 0o600 });
      await fs.writeFile(grantFile, JSON.stringify({ id: grantId }), {
        mode: 0o600,
      });
      const overlay = path.join(stateDir, "live-dsh-mcp.patch.yml"),
        cli = fileURLToPath(new URL("../cli.js", import.meta.url));
      await fs.writeFile(
        overlay,
        JSON.stringify([
          {
            insert: [
              {
                id: "clawsense-live-mcp",
                name: "@deepseek-ai/dsh-mcp-client",
                config: {
                  serverName: "clawsense",
                  transport: "stdio",
                  command: process.execPath,
                  args: [
                    cli,
                    "mcp",
                    "--url",
                    localUrl,
                    "--token-file",
                    tokenFile,
                    "--agent",
                    "live-dsh",
                  ],
                  failOnStartupError: true,
                  toolCallTimeoutMs: 120000,
                },
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );
      cfg.dsh.args = [...cfg.dsh.args, "--patch", overlay];
    }
  } catch (error) {
    await runtime.stop();
    throw error;
  }
  return {
    runtime,
    address,
    async stop() {
      if (grantId)
        await fetch(
          localUrl +
            "/api/clawsense/agent/grants?id=" +
            encodeURIComponent(grantId),
          { method: "DELETE", headers },
        ).catch(() => {});
      await runtime.stop();
    },
  };
}
