#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_JSON="$(mktemp)"
trap 'rm -f "$PACK_JSON"' EXIT

cd "$ROOT_DIR"

echo "[check:release] build"
npm run check

echo "[check:release] tests"
npm test

echo "[check:release] shell syntax"
bash -n install.sh
bash -n scripts/dev-log.sh
bash -n scripts/local-openclaw.sh

echo "[check:release] npm pack dry-run"
npm pack --json --dry-run --ignore-scripts > "$PACK_JSON"

PACK_JSON="$PACK_JSON" node - <<'NODE'
const fs = require("node:fs");

const raw = fs.readFileSync(process.env.PACK_JSON, "utf8");
const start = raw.indexOf("[");
const end = raw.lastIndexOf("]");
if (start === -1 || end === -1 || end < start) {
  throw new Error(`npm pack did not emit a JSON array:\n${raw}`);
}

const [pack] = JSON.parse(raw.slice(start, end + 1));
if (!pack || typeof pack !== "object") {
  throw new Error("npm pack output is empty");
}
if (pack.name !== "clawsense") {
  throw new Error(`expected package name "clawsense", got "${pack.name}"`);
}

const files = new Set((pack.files || []).map((file) => file.path));
const required = [
  "README.md",
  "LICENSE",
  "install.sh",
  "package.json",
  "openclaw.plugin.json",
  "dist/index.js",
  "skills/clawsense-context/SKILL.md",
  "skills/clawsense-daily-review/SKILL.md",
];

const missing = required.filter((file) => !files.has(file));
if (missing.length > 0) {
  throw new Error(`npm package is missing required files: ${missing.join(", ")}`);
}

const forbiddenPrefixes = [
  ".codex/",
  ".local/",
  "android/",
  "docs/",
  "scripts/",
  "test/",
  "node_modules/",
];
const forbiddenExact = new Set([
  ".DS_Store",
  ".gitignore",
  "AGENTS.md",
  "tsconfig.json",
  "vitest.config.ts",
]);

const forbidden = [...files].filter((file) => {
  if (forbiddenExact.has(file) || file.endsWith("/.DS_Store")) return true;
  return forbiddenPrefixes.some((prefix) => file.startsWith(prefix));
});

if (forbidden.length > 0) {
  throw new Error(`npm package includes development-only files: ${forbidden.join(", ")}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      name: pack.name,
      version: pack.version,
      files: pack.files?.length ?? 0,
      unpackedSize: pack.unpackedSize ?? null,
    },
    null,
    2,
  ),
);
NODE

if [[ "${CHECK_ANDROID:-0}" == "1" ]]; then
  echo "[check:release] android assembleDebug"
  if [[ -z "${JAVA_HOME:-}" && -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  fi
  (cd android && ./gradlew assembleDebug)
fi

echo "[check:release] ok"
