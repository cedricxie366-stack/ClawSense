#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LOCAL_RUNTIME_ROOT="${LOCAL_RUNTIME_ROOT:-$PROJECT_ROOT/.local/openclaw}"
LOCAL_RUNTIME_PARENT="$(dirname "$LOCAL_RUNTIME_ROOT")"
OPENCLAW_HOME="${OPENCLAW_HOME:-$LOCAL_RUNTIME_ROOT/home}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$LOCAL_RUNTIME_ROOT/state}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
CLAWSENSE_PLUGIN_ID="${CLAWSENSE_PLUGIN_ID:-clawsense}"
CLAWSENSE_PLUGIN_DIR="${CLAWSENSE_PLUGIN_DIR:-$OPENCLAW_HOME/plugin-sources/$CLAWSENSE_PLUGIN_ID}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.3.2}"

export OPENCLAW_HOME
export OPENCLAW_STATE_DIR
export OPENCLAW_CONFIG_PATH

log() {
  printf '[local-openclaw] %s\n' "$*"
}

print_env() {
  cat <<EOF
PROJECT_ROOT=$PROJECT_ROOT
LOCAL_RUNTIME_ROOT=$LOCAL_RUNTIME_ROOT
LOCAL_RUNTIME_PARENT=$LOCAL_RUNTIME_PARENT
OPENCLAW_HOME=$OPENCLAW_HOME
OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR
OPENCLAW_CONFIG_PATH=$OPENCLAW_CONFIG_PATH
CLAWSENSE_PLUGIN_ID=$CLAWSENSE_PLUGIN_ID
CLAWSENSE_PLUGIN_DIR=$CLAWSENSE_PLUGIN_DIR
EOF
}

ensure_layout() {
  install -d -m 700 "$LOCAL_RUNTIME_PARENT" "$LOCAL_RUNTIME_ROOT" "$OPENCLAW_HOME" "$OPENCLAW_STATE_DIR" "$LOCAL_RUNTIME_ROOT/logs"
}

harden_permissions() {
  chmod 700 "$LOCAL_RUNTIME_PARENT" "$LOCAL_RUNTIME_ROOT" "$OPENCLAW_HOME" "$OPENCLAW_STATE_DIR" "$LOCAL_RUNTIME_ROOT/logs"
  chmod -R go-rwx "$LOCAL_RUNTIME_ROOT"
  if [ -d "$CLAWSENSE_PLUGIN_DIR" ]; then
    chmod 700 "$CLAWSENSE_PLUGIN_DIR"
  fi
  if [ -f "$OPENCLAW_CONFIG_PATH" ]; then
    chmod 600 "$OPENCLAW_CONFIG_PATH"
  fi
}

openclaw_bin() {
  local bin
  bin="$OPENCLAW_HOME/node_modules/.bin/openclaw"
  if [ -x "$bin" ]; then
    printf '%s' "$bin"
    return 0
  fi
  return 1
}

require_openclaw_bin() {
  if ! OPENCLAW_BIN="$(openclaw_bin)"; then
    printf 'Local OpenClaw is not installed. Run: %s setup\n' "$0" >&2
    exit 1
  fi
  export OPENCLAW_BIN
}

run_setup() {
  ensure_layout
  umask 077
  OPENCLAW_HOME="$OPENCLAW_HOME" \
  OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
  OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
  CLAWSENSE_PLUGIN_ID="$CLAWSENSE_PLUGIN_ID" \
  CLAWSENSE_PLUGIN_DIR="$CLAWSENSE_PLUGIN_DIR" \
  OPENCLAW_VERSION="$OPENCLAW_VERSION" \
  bash "$PROJECT_ROOT/install.sh"
  harden_permissions
  log "Local OpenClaw + ClawSense setup finished."
}

run_passthrough() {
  require_openclaw_bin
  "$OPENCLAW_BIN" "$@"
}

usage() {
  cat <<'EOF'
Usage: scripts/local-openclaw.sh <command> [args]

Commands:
  setup              Install local OpenClaw and ClawSense in .local/openclaw
  env                Print local environment paths
  pair               Generate ClawSense pairing QR code
  devices            Show paired devices
  media-today        Show today's media summary
  video-config       Show ClawSense video ingest mode and enable commands
  library-url [date] Print media library URL(s) and token status (default: today)
  review-today       Show today's review summary
  evidence-video [d] Show recent video-focused evidence bundle (default: 7 days)
  followups          Show today's structured follow-up targets (audio/video/history)
  acceptance         Show 7-day phase acceptance snapshot
  acceptance-plan    Show 7-day actionable acceptance plan
  gateway-restart    Restart local gateway
  gateway-start      Start local gateway
  openclaw ...       Run raw local openclaw subcommands
EOF
}

print_library_url_fallback() {
  local raw_date="${1:-today}"
  local date_query
  if [[ "$raw_date" == "today" || -z "$raw_date" ]]; then
    date_query="$(date +%F)"
  else
    date_query="$raw_date"
  fi

  node - "$OPENCLAW_CONFIG_PATH" "$date_query" <<'NODE'
const fs = require("fs");

const configPath = process.argv[2];
const dateQuery = process.argv[3];
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const gatewayPort = Number((cfg.gateway || {}).port) || 18789;
const gatewayToken = String((((cfg.gateway || {}).auth || {}).token) || "").trim();
const publicBaseUrl = String(((((cfg.plugins || {}).entries || {}).clawsense || {}).config || {}).publicBaseUrl || "").trim();

const local = new URL("/plugins/clawsense/library", `http://127.0.0.1:${gatewayPort}`);
local.searchParams.set("date", dateQuery);
let publicUrl = "";
if (publicBaseUrl) {
  try {
    const parsed = new URL("/plugins/clawsense/library", publicBaseUrl);
    parsed.searchParams.set("date", dateQuery);
    publicUrl = parsed.toString();
  } catch {
    // noop
  }
}
const masked =
  gatewayToken.length >= 8
    ? `${gatewayToken.slice(0, 4)}...${gatewayToken.slice(-4)}`
    : gatewayToken.length > 0
      ? "***"
      : "<missing>";

console.log(JSON.stringify({
  ok: true,
  source: "fallback",
  date: dateQuery,
  gatewayPort,
  libraryLocalUrl: local.toString(),
  libraryPublicUrl: publicUrl || undefined,
  hasGatewayToken: Boolean(gatewayToken),
  gatewayTokenLength: gatewayToken.length,
  gatewayTokenMasked: masked,
  hints: [
    "Open libraryLocalUrl on host machine, or libraryPublicUrl on phone/laptop.",
    "Paste your current gateway token in the media library auth panel.",
  ],
}, null, 2));
NODE
}

cmd="${1:-}"
case "$cmd" in
  setup)
    run_setup
    ;;
  env)
    print_env
    ;;
  pair)
    run_passthrough clawsense pair
    ;;
  devices)
    run_passthrough clawsense devices
    ;;
  media-today)
    run_passthrough clawsense media today
    ;;
  video-config)
    run_passthrough clawsense video-config
    ;;
  library-url)
    shift
    output=""
    if output="$(run_passthrough clawsense library-url "${1:-today}" 2>&1)"; then
      printf '%s\n' "$output"
    else
      if [[ "$output" == *"unknown command 'library-url'"* ]]; then
        log "Current runtime does not support clawsense library-url yet; using local fallback parser."
        print_library_url_fallback "${1:-today}"
      else
        printf '%s\n' "$output" >&2
        exit 1
      fi
    fi
    ;;
  review-today)
    run_passthrough clawsense review today
    ;;
  evidence-video)
    shift || true
    evidence_video_lookback_days="${1:-7}"
    run_passthrough clawsense evidence --lookbackDays "$evidence_video_lookback_days" --modality video --focus what_happened
    ;;
  followups)
    run_passthrough clawsense followups today --focus what_happened
    ;;
  acceptance)
    run_passthrough clawsense acceptance 7
    ;;
  acceptance-plan)
    run_passthrough clawsense acceptance-plan 7
    ;;
  gateway-restart)
    run_passthrough gateway restart --json
    ;;
  gateway-start)
    run_passthrough gateway start --json
    ;;
  openclaw)
    shift
    run_passthrough "$@"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    run_passthrough "$@"
    ;;
esac
