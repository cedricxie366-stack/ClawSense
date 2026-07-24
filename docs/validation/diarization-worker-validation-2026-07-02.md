# Diarization Worker Validation - 2026-07-02

## Scope

- Validation target: current ASR worker status, `diarization-probe` CLI reachability, and WhisperX local wrapper readiness.
- Working directory: `/Users/cedric/Documents/ClawSense`.
- Guardrails followed:
  - Read `AGENTS.md` and `.codex/skills/local-openclaw-dev/SKILL.md`.
  - Used repo-scoped `scripts/local-openclaw.sh` for OpenClaw checks.
  - Did not install dependencies.
  - Did not enable or start the background ASR worker.
  - Did not run commands expected to bulk-write runtime state.

## Command Results

| Check | Command | Result |
| --- | --- | --- |
| WhisperX wrapper syntax | `python3 -m py_compile scripts/local-asr/whisperx-local.py` | Passed. Exit code `0`; no compiler output. |
| Local ASR status | `scripts/local-openclaw.sh openclaw clawsense asr-status` | Passed. `ok=true`; backend `funasr`; provider `local-asr:funasr:zh`; language `zh`; `ready=true`; no issues; command resolves to `.local/asr/funasr-runner.sh`; command exists and is executable. |
| ASR worker status | `scripts/local-openclaw.sh openclaw clawsense asr-worker status` | Passed. `ok=true`; worker `enabled=false`; queue count `0`; pending/running/failed jobs all `0`; active queue `null`. Recent dry-run queues for `2026-06-25` show succeeded local ASR jobs, but no worker was started in this validation. |
| Diarization probe help | `scripts/local-openclaw.sh openclaw clawsense diarization-probe --help` | Passed. CLI is reachable. It accepts optional `[date]`, `--max`, `--provider`, and `--speaker-model`. Provider choices shown: `funasr`, `whisperx`, `pyannote`, `local-asr`; default provider is `funasr`; default speaker model is `cam++`. |
| WhisperX import check | `python3 - <<'PY' ...` | Blocked. `whisperx_spec_found=False`; current `python3` environment cannot import `whisperx`. |

## WhisperX Dry-Run Decision

No WhisperX ASR-only dry-run or diarization probe was executed.

Reason: the current `python3` environment does not have an importable `whisperx` module. Per validation constraints, no dependency installation was attempted.

## Current Runnability Assessment

- ASR worker control/status path is runnable enough for status inspection. It reports a disabled, idle worker with no active queue.
- Local ASR provider readiness is good for the currently configured FunASR path.
- `diarization-probe` command registration and help output are healthy.
- `scripts/local-asr/whisperx-local.py` is syntactically valid.
- WhisperX runtime execution is not validated because `whisperx` is not installed in the checked Python environment.

## Blockers And External Conditions

- Install or select a Python environment where `import whisperx` succeeds before validating WhisperX ASR-only execution.
- For pyannote-backed diarization through WhisperX or pyannote directly, expect to need a valid `HF_TOKEN` and accepted pyannote model terms on Hugging Face.
- After dependencies and tokens are available, the next safe validation should use a single `2026-06-25` audio artifact with a dry-run/probe-style command and should avoid enabling the background worker until the single-artifact path succeeds.
