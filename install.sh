#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.3.2}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$OPENCLAW_HOME}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
CLAWSENSE_PLUGIN_ID="${CLAWSENSE_PLUGIN_ID:-clawsense}"
CLAWSENSE_PLUGIN_DIR="${CLAWSENSE_PLUGIN_DIR:-$OPENCLAW_HOME/plugins/$CLAWSENSE_PLUGIN_ID}"
CLAWSENSE_NPM_SPEC="${CLAWSENSE_NPM_SPEC:-}"
CLAWSENSE_SOURCE_URL="${CLAWSENSE_SOURCE_URL:-}"
CLAWSENSE_PUBLIC_BASE_URL="${CLAWSENSE_PUBLIC_BASE_URL:-}"
CLAWSENSE_GATEWAY_PORT="${CLAWSENSE_GATEWAY_PORT:-3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() {
  printf '[clawsense-install] %s\n' "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd npm
need_cmd tar

mkdir -p "$OPENCLAW_HOME" "$OPENCLAW_STATE_DIR"
export OPENCLAW_STATE_DIR
export OPENCLAW_CONFIG_PATH

if command -v openclaw >/dev/null 2>&1; then
  OPENCLAW_BIN="openclaw"
elif [ -x "$OPENCLAW_HOME/node_modules/.bin/openclaw" ]; then
  OPENCLAW_BIN="$OPENCLAW_HOME/node_modules/.bin/openclaw"
else
  log "OpenClaw 未检测到，正在安装到 $OPENCLAW_HOME"
  npm install --prefix "$OPENCLAW_HOME" "openclaw@$OPENCLAW_VERSION"
  OPENCLAW_BIN="$OPENCLAW_HOME/node_modules/.bin/openclaw"
fi

merge_plugin_allowlist() {
  local current next
  current="$("$OPENCLAW_BIN" config get plugins.allow --json 2>/dev/null || printf 'null')"
  next="$(node -e '
const raw = process.argv[1];
const pluginId = process.argv[2];
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch {}
const list = Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
if (!list.includes(pluginId)) {
  list.push(pluginId);
}
process.stdout.write(JSON.stringify(list));
' "$current" "$CLAWSENSE_PLUGIN_ID")"
  "$OPENCLAW_BIN" config set plugins.allow "$next" --strict-json >/dev/null
}

prepare_local_source() {
  rm -rf "$CLAWSENSE_PLUGIN_DIR"
  mkdir -p "$CLAWSENSE_PLUGIN_DIR"
  cp "$SCRIPT_DIR/package.json" "$CLAWSENSE_PLUGIN_DIR/package.json"
  cp "$SCRIPT_DIR/package-lock.json" "$CLAWSENSE_PLUGIN_DIR/package-lock.json"
  cp "$SCRIPT_DIR/openclaw.plugin.json" "$CLAWSENSE_PLUGIN_DIR/openclaw.plugin.json"
  cp "$SCRIPT_DIR/index.ts" "$CLAWSENSE_PLUGIN_DIR/index.ts"
  cp "$SCRIPT_DIR/tsconfig.json" "$CLAWSENSE_PLUGIN_DIR/tsconfig.json"
  cp -R "$SCRIPT_DIR/src" "$CLAWSENSE_PLUGIN_DIR/src"
}

prepare_downloaded_source() {
  local archive
  archive="$(mktemp -t clawsense-plugin.XXXXXX.tar.gz)"
  curl -fsSL "$CLAWSENSE_SOURCE_URL" -o "$archive"
  rm -rf "$CLAWSENSE_PLUGIN_DIR"
  mkdir -p "$CLAWSENSE_PLUGIN_DIR"
  tar -xzf "$archive" -C "$CLAWSENSE_PLUGIN_DIR" --strip-components=1
  rm -f "$archive"
}

if [ -n "$CLAWSENSE_NPM_SPEC" ]; then
  log "使用 npm 规格安装插件：$CLAWSENSE_NPM_SPEC"
  "$OPENCLAW_BIN" plugins install "$CLAWSENSE_NPM_SPEC"
else
  if [ -n "$CLAWSENSE_SOURCE_URL" ]; then
    log "从远程归档下载插件源码：$CLAWSENSE_SOURCE_URL"
    prepare_downloaded_source
  else
    log "未提供远程地址，使用当前目录源码模拟下载步骤"
    prepare_local_source
  fi

  log "通过本地目录执行受管安装"
  "$OPENCLAW_BIN" plugins install "$CLAWSENSE_PLUGIN_DIR"
fi

log "启用插件并确认 allowlist"
"$OPENCLAW_BIN" plugins enable "$CLAWSENSE_PLUGIN_ID"
merge_plugin_allowlist

if [ -n "$CLAWSENSE_PUBLIC_BASE_URL" ]; then
  export CLAWSENSE_PUBLIC_BASE_URL
fi
export CLAWSENSE_GATEWAY_PORT

log "插件依赖将由 OpenClaw 安装流程自动处理"

restart_gateway() {
  if "$OPENCLAW_BIN" gateway restart --json >/dev/null 2>&1; then
    log "通过 OpenClaw CLI 重启 Gateway 服务"
    return
  fi

  if "$OPENCLAW_BIN" gateway start --json >/dev/null 2>&1; then
    log "通过 OpenClaw CLI 启动 Gateway 服务"
    return
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl --user status openclaw >/dev/null 2>&1; then
    log "通过 systemd --user 重启 OpenClaw"
    systemctl --user restart openclaw
    return
  fi

  if command -v pm2 >/dev/null 2>&1 && pm2 describe openclaw >/dev/null 2>&1; then
    log "通过 pm2 重启 OpenClaw"
    pm2 restart openclaw
    return
  fi

  log "未检测到托管进程，尝试优雅终止旧进程"
  pkill -f "openclaw.*gateway" >/dev/null 2>&1 || true
  nohup "$OPENCLAW_BIN" gateway run >/tmp/openclaw-gateway.log 2>&1 &
}

restart_gateway

log "等待 OpenClaw 重启"
sleep 3

log "生成新的配对二维码"
"$OPENCLAW_BIN" clawsense pair || {
  log "CLI 触发失败，请查看 OpenClaw 日志确认插件是否已加载"
  exit 1
}

log "安装完成"
