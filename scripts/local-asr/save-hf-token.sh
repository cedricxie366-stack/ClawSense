#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
target="${1:-$repo_root/.local/asr/hf-token.env}"

mkdir -p "$(dirname -- "$target")"

printf 'HF token (input hidden): ' >&2
old_stty="$(stty -g 2>/dev/null || true)"
if [ -n "$old_stty" ]; then
  stty -echo
fi
IFS= read -r token
if [ -n "$old_stty" ]; then
  stty "$old_stty"
fi
printf '\n' >&2

case "$token" in
  hf_*) ;;
  *)
    printf 'Refusing to save: token should start with "hf_".\n' >&2
    exit 1
    ;;
esac

umask 077
tmp="$target.$$"
printf "export HF_TOKEN='%s'\n" "$(printf '%s' "$token" | sed "s/'/'\\\\''/g")" > "$tmp"
mv "$tmp" "$target"
chmod 600 "$target"

printf 'Saved HF token env file: %s\n' "$target" >&2
printf 'Load it with: source %s\n' "$target" >&2
