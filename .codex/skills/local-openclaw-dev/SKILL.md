---
name: local-openclaw-dev
description: Use when the task touches the local ClawSense host runtime, pairing QR generation, gateway reachability, or repo-scoped OpenClaw verification.
---

# Local OpenClaw Dev

Use this skill when the task touches the local ClawSense host runtime, pairing QR generation, gateway reachability, or repo-scoped OpenClaw verification.

## Goals

- Keep local verification inside this repository's isolated OpenClaw runtime.
- Prefer deterministic host-side checks before changing Android client code.
- Avoid polluting the runtime plugin skill surface.

## Use These Paths

- Local runtime root: `/Users/cedric/Documents/ClawSense/.local/openclaw`
- Local config: `/Users/cedric/Documents/ClawSense/.local/openclaw/state/openclaw.json`
- Helper script: [scripts/local-openclaw.sh](/Users/cedric/Documents/ClawSense/scripts/local-openclaw.sh)

## Preferred Commands

```bash
scripts/local-openclaw.sh env
scripts/local-openclaw.sh pair
scripts/local-openclaw.sh devices
scripts/local-openclaw.sh media-today
scripts/local-openclaw.sh review-today
scripts/local-openclaw.sh openclaw gateway status --json
```

## Pairing Checklist

1. Confirm the gateway is listening on the expected port.
2. Confirm `publicBaseUrl` points to the current LAN-reachable host.
3. Regenerate a fresh setup token with `scripts/local-openclaw.sh pair`.
4. Only then debug the Android client.

## LAN Pairing Baseline

- Expected local gateway config for phone testing:
  - `gateway.mode = "local"`
  - `gateway.bind = "lan"`
- Expected ClawSense plugin config:
  - `plugins.entries.clawsense.config.publicBaseUrl = "http://<lan-ip>:18789"`
  - `plugins.entries.clawsense.config.gatewayPort = 18789`
- Useful listener checks:

```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
netstat -an | rg 18789
curl -sS -m 3 -o /dev/null -w '%{http_code}\n' http://<lan-ip>:18789/api/clawsense/pair
```

`405` on the pair endpoint is acceptable for a reachability check because the route is alive and rejecting the wrong HTTP method.

## Guardrails

- Do not store dev-only instructions in root `skills/`.
- Do not switch to user-global `~/.openclaw` unless the task explicitly requires comparing against a global install.
- Keep `.local/openclaw` permissions restricted.
