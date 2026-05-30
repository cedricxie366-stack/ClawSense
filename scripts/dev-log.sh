#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$ROOT_DIR/docs/dev/开发日志.md"

TITLE="${1:-}"
CHANGES="${2:-}"
VERIFY="${3:-}"
NEXT="${4:-}"

if [[ -z "$TITLE" ]]; then
  echo "Usage: scripts/dev-log.sh \"标题\" \"改动\" [\"验证\"] [\"下一步\"]"
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"
if [[ ! -f "$LOG_FILE" ]]; then
  cat > "$LOG_FILE" <<'EOF'
# ClawSense 开发日志

## 记录规则
- 每次完成一个可验收节点就追加一条
- 每条至少包含：背景、改动、验证、下一步
EOF
fi

TS="$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')"
BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
SHORT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo 'uncommitted')"

{
  echo ""
  echo "## ${TS} (Asia/Shanghai) - ${TITLE}"
  echo "- 分支：\`${BRANCH}\`"
  echo "- 基线提交：\`${SHORT_SHA}\`"
  echo "- 背景："
  echo "- 改动：${CHANGES:-待补充}"
  echo "- 验证：${VERIFY:-待补充}"
  echo "- 下一步：${NEXT:-待补充}"
} >> "$LOG_FILE"

echo "Appended development log: $LOG_FILE"
