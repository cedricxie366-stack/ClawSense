#!/usr/bin/env node
import { randomUUID } from "node:crypto";
/** Copy only provider definitions (no secret values) into an isolated SDK profile. */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const [stateArg, installedArg, profileArg] = process.argv.slice(2);
if (!stateArg || !installedArg || !profileArg)
  throw new Error(
    "Usage: dsh-prepare.mjs NEW_LIVE_DIR DSH_INSTALL_DIR EXISTING_PROFILE_PATCH",
  );
const root = path.resolve(stateArg),
  installed = path.resolve(installedArg),
  source = path.resolve(profileArg);
const require = createRequire(
  path.join(installed, "node_modules/@deepseek-ai/dsh/package.json"),
);
const yaml = require("js-yaml");
const rows = yaml.load(await fs.readFile(source, "utf8"));
if (!Array.isArray(rows)) throw new Error("Expected a profile patch list");
const providerRows = rows.filter(
  (row) => row.id === "llm-pi-ai" || row.id === "agent-default-model",
);
if (providerRows.length !== 2)
  throw new Error("Selected profile must define a model route and providers");
for (const row of providerRows)
  for (const cfg of Object.values(row.config?.providers ?? {})) {
    if (cfg.apiKey || cfg.token || cfg.secret)
      throw new Error(
        "Inline credentials are not copied. Use an existing env/credential-file reference.",
      );
  }
const dshHome = path.join(root, "dsh-home");
await fs.mkdir(dshHome, { recursive: true, mode: 0o700 });
const overlay = path.join(root, "dsh-provider-" + randomUUID() + ".patch.yml");
await fs.writeFile(overlay, yaml.dump(providerRows), {
  mode: 0o600,
  flag: "wx",
});
const defaultRoute = providerRows.find(
  (r) => r.id === "agent-default-model",
).config;
const configFile = path.join(root, "config.json"),
  config = JSON.parse(await fs.readFile(configFile, "utf8"));
config.live.dsh = {
  command: process.execPath,
  args: [
    path.join(installed, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
    "--profile",
    "sdk",
    "--patch",
    overlay,
  ],
  cwd: path.join(root, "dsh-workspace"),
  home: dshHome,
  routes: [
    {
      id: "default",
      provider: defaultRoute.provider,
      model: defaultRoute.model,
    },
  ],
  timeoutMs: 120000,
};
// Optional installed-harness reference; metadata contains a path and field, never a key.
try {
  const metadata = JSON.parse(
    await fs.readFile(path.join(installed, "credential-source.json"), "utf8"),
  );
  const provider = providerRows.find((r) => r.id === "llm-pi-ai").config
    .providers[defaultRoute.provider];
  if (metadata.credentialSource && provider.apiKeyEnv)
    config.live.dsh.credential = {
      file: metadata.credentialSource,
      env: provider.apiKeyEnv,
      format: metadata.format === "raw-token" ? "raw-token" : "env",
      field: metadata.credentialField,
    };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await fs.mkdir(config.live.dsh.cwd, { recursive: true, mode: 0o700 });
await fs.writeFile(configFile, JSON.stringify(config, null, 2), {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    ready: true,
    home: dshHome,
    profile: "sdk",
    provider: defaultRoute.provider,
    model: defaultRoute.model,
    credentialsCopied: false,
    restartRequired: true,
  }),
);
