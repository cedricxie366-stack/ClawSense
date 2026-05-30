# ClawSense Repo Guide

## Scope

- This repository has two different instruction surfaces:
  - Root `skills/` is the runtime OpenClaw plugin skill surface exposed by [openclaw.plugin.json](/Users/cedric/Documents/ClawSense/openclaw.plugin.json).
  - Repo-local Codex development guidance must stay in `AGENTS.md` and `.codex/`.
- Do not put development-only Codex skills into root `skills/`.
- Do not add repo-local developer rules to `openclaw.plugin.json`.

## Current Priorities

- Treat ClawSense as an active, dirty worktree. Read changes carefully and do not revert unrelated edits.
- The project is in a multimodal OpenClaw + Android pairing and ingest stage. Favor fixes that preserve the current working data plane.
- Keep local development workflows local-first. Prefer the repo-scoped OpenClaw runtime under `.local/openclaw` over user-global state when verifying ClawSense behavior.

## Local OpenClaw Workflow

- Use [scripts/local-openclaw.sh](/Users/cedric/Documents/ClawSense/scripts/local-openclaw.sh) for local host-side work.
- Important commands:
  - `scripts/local-openclaw.sh pair`
  - `scripts/local-openclaw.sh devices`
  - `scripts/local-openclaw.sh media-today`
  - `scripts/local-openclaw.sh review-today`
  - `scripts/local-openclaw.sh gateway-restart`
  - `scripts/local-openclaw.sh openclaw ...`
- Local runtime paths:
  - `.local/openclaw/home`
  - `.local/openclaw/state`
  - `.local/openclaw/state/openclaw.json`
- Keep permissions tight for `.local/openclaw`. Do not loosen them unless the task explicitly requires it.

## Pairing And Network Guardrails

- When Android pairing fails, separate the problem into:
  - bad setup code / host generation
  - gateway bind / reachability
  - Android client normalization or permission behavior
- For LAN pairing, the local gateway should currently be treated as:
  - `gateway.mode = "local"`
  - `gateway.bind = "lan"`
  - ClawSense plugin `publicBaseUrl` pointing at the Mac's LAN IP and port `18789`
- Verify reachability before changing Android code:
  - check the gateway listener
  - check local config
  - check `curl http://<lan-ip>:18789/api/clawsense/pair`

## Android Touchpoints

- Most pairing and foreground-service behavior lives in:
  - [MainActivity.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/MainActivity.kt)
  - [MainViewModel.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/MainViewModel.kt)
  - [DeviceSessionRepository.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/DeviceSessionRepository.kt)
  - [OkHttpClawSenseApi.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/OkHttpClawSenseApi.kt)
  - [SetupCodeParser.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/SetupCodeParser.kt)
  - [SensorForegroundService.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt)
- Before editing Android networking or pairing code, confirm whether the host-side gateway is already wrong. Do not fix host issues in the client first.

## Verification Expectations

- Prefer targeted verification over broad rebuilds.
- For host-side changes, start with the local OpenClaw script workflow.
- For pairing bugs, verify:
  - setup code payload
  - gateway listener state
  - `devices` output after a successful pair
- For Android-only fixes, report what was verified and what still needs a real device check.

## Documentation Discipline

- Keep developer-harness guidance in `AGENTS.md` and `.codex/skills`.
- Keep user-facing product behavior in:
  - [README.md](/Users/cedric/Documents/ClawSense/README.md)
  - [android/README.md](/Users/cedric/Documents/ClawSense/android/README.md)
  - [docs/小白部署与使用指南.md](/Users/cedric/Documents/ClawSense/docs/小白部署与使用指南.md)
