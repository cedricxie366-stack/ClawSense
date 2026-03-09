# ClawSense

[![npm version](https://img.shields.io/npm/v/clawsense-openclaw-plugin)](https://www.npmjs.com/package/clawsense-openclaw-plugin)
[![license](https://img.shields.io/github/license/cedricxie366-stack/ClawSense)](./LICENSE)
[![release](https://img.shields.io/github/v/tag/cedricxie366-stack/ClawSense?label=release)](https://github.com/cedricxie366-stack/ClawSense/releases)

Turn an old Android phone into an always-on sensory node for OpenClaw.

ClawSense is an OpenClaw plugin plus an Android client. It pairs once, keeps a long-lived `deviceSecret`, and continuously sends:

- VAD-triggered audio clips
- periodic image snapshots
- heartbeat / liveness signals
- memory-ready ingest events for OpenClaw

## What Works Today

The following paths have been verified on a real server plus a real Android phone:

- OpenClaw server plugin loading
- QR pairing
- persistent `deviceSecret`
- Android foreground service start / stop
- clear runtime states in the app UI
- audio upload
- image upload
- heartbeat reporting
- server-side ClawSense journal persistence

## Quick Links

- [小白部署与使用指南](./docs/小白部署与使用指南.md)
- [Android 客户端说明](./android/README.md)
- [GitHub 与 npm 发布清单](./docs/GitHub与npm发布清单.md)
- [npm package: clawsense-openclaw-plugin](https://www.npmjs.com/package/clawsense-openclaw-plugin)
- [GitHub Releases](https://github.com/cedricxie366-stack/ClawSense/releases)

## Fastest Install

If OpenClaw is already available on the target machine, the most direct installation path is:

```bash
CLAWSENSE_NPM_SPEC="clawsense-openclaw-plugin@latest" bash install.sh
```

If you prefer source-based installation from this repo:

```bash
bash install.sh
```

If you want the server to download a source archive:

```bash
CLAWSENSE_SOURCE_URL="https://your-host.example/clawsense-plugin.tar.gz" bash install.sh
```

After installation, generate a pairing QR code:

```bash
openclaw clawsense pair
```

## Current Limits

This is a real, working MVP, but not yet a fully polished public release.

- `install.sh` works well on normal Linux environments, but `2GB` servers may still OOM during OpenClaw installation
- when STT / embedding / vision backends are unavailable, ClawSense falls back to degraded summaries instead of hard failing
- there is no full device management UI yet
- low-memory deployment still needs a maintainer-style prebuilt path in some cases

## Android Runtime States

The Android client now exposes explicit runtime states instead of vague button feedback:

- `未配对`
- `启动中`
- `运行中 · 完整模式`
- `运行中 · 仅音频`
- `运行中 · 仅图片`
- `已停止`
- `异常`

That means users can tell whether the service actually started, whether it is degraded, and whether it has stopped cleanly.

## Repository Layout

- `src/`
  OpenClaw plugin logic, pairing, ingest routes, memory flow
- `android/`
  Android client, foreground service, CameraX, audio capture, QR pairing
- `docs/`
  deployment notes, release checklist, beginner guide
- `install.sh`
  install / enable / restart helper for OpenClaw environments

## Local Development

```bash
npm install
npm run check
npm test
```

## Status

Validated baseline:

- OpenClaw `2026.3.2`
- Android 13
- real-device pairing and upload loop

If you are touching this project for the first time, start with:

- [小白部署与使用指南](./docs/小白部署与使用指南.md)
