#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_JSON="$(mktemp)"
trap 'rm -f "$PACK_JSON"' EXIT

cd "$ROOT_DIR"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$ROOT_DIR/.local/npm-cache}"
export npm_config_cache="$NPM_CONFIG_CACHE"
mkdir -p "$NPM_CONFIG_CACHE"

echo "[check:release] build"
npm run check

echo "[check:release] tests"
npm test

echo "[check:release] shell syntax"
bash -n install.sh
bash -n scripts/check-android-emulator-smoke.sh
bash -n scripts/check-android-live.sh
bash -n scripts/check-android-live-fixtures.sh
bash -n scripts/check-current-phase.sh
bash -n scripts/dev-log.sh
bash -n scripts/local-openclaw.sh
bash -n scripts/check-stage-final.sh
bash -n scripts/check-stage-final-fixtures.sh
bash -n scripts/run-final-live-validation.sh
node --check scripts/index-stage-final-reports.mjs
node --check scripts/check-stage-final-doctor.mjs
node --check scripts/check-phase9-fixtures.mjs
node --check scripts/check-evidence-v2-smoke.mjs
node --check scripts/check-local-openclaw-evidence-smoke.mjs
node --check scripts/check-conversation-evidence-routing-smoke.mjs
node --check scripts/check-public-wav-asr-smoke.mjs
node --check scripts/check-public-ami-replay-cli-smoke.mjs
node --check scripts/check-public-zh-meeting-sample.mjs
node --check scripts/check-public-zh-meeting-replay-cli-smoke.mjs
node --check scripts/check-non-device-product-gate.mjs
node --check scripts/summarize-android-live-report.mjs
node --check scripts/check-cross-agent-stdio.mjs

echo "[check:release] calibration and cross-agent stdio"
node --test calibration-fixtures/*.test.mjs
node scripts/check-cross-agent-stdio.mjs

echo "[check:release] evidence-v2 smoke"
npm run check:evidence-v2

echo "[check:release] phase9 fixture smoke"
npm run check:phase9

echo "[check:release] android-live fixture smoke"
bash scripts/check-android-live-fixtures.sh

echo "[check:release] stage-final fixture smoke"
bash scripts/check-stage-final-fixtures.sh

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
  "dist/src/cli.js",
  "dist/src/mcp-server.js",
  "dist/src/standalone-runtime.js",
  "dist/src/workflow-store.js",
  "agent-plugins/skills/clawsense/SKILL.md",
  "VISION.md",
  "scripts/live/worker.py",
  "scripts/live/process_activity.py",
  "scripts/live/upstream/runtime.py",
  "scripts/live/upstream/prepare.py",
  "scripts/live/upstream/requirements.txt",
  "scripts/live/vision_policy.py",
  "scripts/live/prepare.py",
  "scripts/live/requirements.txt",
  "scripts/live/dsh-prepare.mjs",
  "docs/contracts/live-runtime-v1.md",
  "docs/contracts/live-upstream-v1.md",
  "docs/validation/p1-upstream-2026-10-29.md",
  "docs/validation/p1-upstream-2026-10-29.json",
  "docs/pilot/README.md",
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
const runtimeDocuments = new Set([
  "docs/releases/v0.2.0-preview.12.md",
  "docs/validation/p1-upstream-device-2026-10-29.md",
  // npm also includes directory READMEs next to the selected validation files.
  "docs/validation/README.md",
  "docs/产品演进路线与执行计划.md",
  "docs/contracts/live-runtime-v1.md",
  "docs/contracts/live-upstream-v1.md",
  "docs/validation/p1-upstream-2026-10-29.md",
  "docs/validation/p1-upstream-2026-10-29.json",
  "docs/pilot/support-matrix.json",
  "docs/validation/p1-p2-integrated-2026-10-15.md",
  "docs/validation/p1-p2-human-acceptance-2026-10-15.md",
  "docs/validation/p1-p2-closeout-2026-10-16.md",
  "docs/validation/p1-p2-closeout-2026-10-16.json",
  "docs/validation/p1-autonomous-2026-10-16.md",
  "docs/validation/p1-autonomous-2026-10-16.json",
  "docs/validation/p1-autonomous-2026-10-19.md",
  "docs/validation/p1-autonomous-2026-10-19.json",
  "docs/validation/p1-human-2026-10-20.md",
  "docs/validation/p1-input-offline-2026-10-20.md",
  "docs/validation/p1-input-offline-2026-10-20.json",
  "docs/validation/p1-oppo-recovery-2026-10-20.md",
  "docs/validation/p1-ready-2026-10-21.md",
  "docs/validation/p1-ready-2026-10-21.json",
  "docs/validation/p1-latency-playback-2026-10-22.md",
  "docs/validation/p1-latency-playback-2026-10-22.json",
  "docs/validation/p1-normal-dialogue-2026-10-23.md",
  "docs/validation/p1-normal-dialogue-2026-10-23.json",
  "docs/research/live-voice-landscape-2026-10-29.json",
  "docs/research/android-vad-comparison-2026-10-16.md",
  "docs/research/android-vad-comparison-2026-10-16.json",
]);

const forbidden = [...files].filter((file) => {
  if (forbiddenExact.has(file) || file.endsWith("/.DS_Store")) return true;
  if (/^scripts\/local-asr\/[^/]+\.py$/.test(file)) return false;
  if (/^scripts\/live\/(?:worker\.py|process_activity\.py|vision_policy\.py|prepare\.py|requirements\.txt|dsh-prepare\.mjs)$/.test(file)) return false;
  if (/^scripts\/live\/upstream\/(?:runtime\.py|prepare\.py|requirements\.txt)$/.test(file)) return false;
  if (runtimeDocuments.has(file) || /^docs\/pilot\/[^/]+\.(?:md|csv)$/.test(file)) return false;
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
