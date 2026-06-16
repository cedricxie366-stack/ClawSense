# Evidence of Existing Prototype

This page summarizes current ClawSense implementation evidence that can support the grant application's feasibility section.

## Repository

- GitHub: `https://github.com/cedricxie366-stack/ClawSense`
- Package target: `clawsense`
- Current architecture: OpenClaw plugin plus Android client

## Implemented Capabilities

### Android Sensory Node

- QR/setup-code pairing
- persistent `deviceSecret`
- foreground sensing service
- VAD-triggered audio upload
- periodic image upload
- manual six-second video clip upload with start/end keyframes
- explicit voice question submission
- local TTS playback
- `read full answer` / `stop speaking` interaction controls
- echo-drain logic to reduce TTS self-recording
- background heartbeat

### Host / OpenClaw Data Plane

- pairing endpoint
- audio/image/video ingest endpoints
- fast artifact persistence with asynchronous analysis
- media/event indexing
- same-origin lightweight media library
- evidence bundle export
- custom-range evidence API
- daily review and consolidation paths
- structured follow-up targets
- person/speaker annotation suggestions
- queue status and retry controls

### Real-Time Assistant Layer

- `/api/clawsense/assistant/query`
- evidence-first answer construction
- model answer plus deterministic fallback
- time-range routing for last seconds/minutes/hours/day
- previous-turn follow-up support
- draft document generation for meeting notes/action items
- assistant query diagnostics
- audio recheck diagnostics

### Safety and Validation

- no-arm ambient validation flow
- TTS echo-drain validation
- Android live validation scripts
- stage-final gate
- scripted fixture replay for meeting and classroom scenarios
- auto-video trigger guardrails
- backpressure-aware capture throttling

## Existing Validation Commands

Common checks:

```bash
npm run check
npm test
npm run check:release
npm run check:phase
npm run check:stage-final:doctor
```

Android build:

```bash
cd android
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew assembleDebug
```

Repo-local OpenClaw checks:

```bash
scripts/local-openclaw.sh openclaw clawsense status
scripts/local-openclaw.sh openclaw clawsense acceptance 7
scripts/local-openclaw.sh evidence-video
```

## Public Demo Readiness

The public demo should use scripted, consented scenes only. Do not include private personal traces or local `.local/openclaw` state.
