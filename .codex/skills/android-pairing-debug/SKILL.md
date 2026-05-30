---
name: android-pairing-debug
description: Use when the Android app fails to pair, cannot reach the host, loses the saved session, or behaves incorrectly around permissions and foreground service startup.
---

# Android Pairing Debug

Use this skill when the Android app fails to pair, cannot reach the host, loses the saved session, or behaves incorrectly around permissions and foreground service startup.

## Main Files

- [MainActivity.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/MainActivity.kt)
- [MainViewModel.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/MainViewModel.kt)
- [DeviceSessionRepository.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/DeviceSessionRepository.kt)
- [OkHttpClawSenseApi.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/OkHttpClawSenseApi.kt)
- [SetupCodeParser.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/data/SetupCodeParser.kt)
- [SensorForegroundService.kt](/Users/cedric/Documents/ClawSense/android/app/src/main/java/ai/openclaw/clawsense/service/SensorForegroundService.kt)

## Diagnose In This Order

1. Host-side reachability
2. Setup code decoding and host normalization
3. Pair request / response handling
4. Session persistence
5. Runtime permissions and service behavior

Do not start by changing the Android client if the host is still unreachable from the phone.

## Common Failure Shapes

- `Unable to resolve host`
  - The setup code likely contains a bad hostname.
  - Verify `publicBaseUrl` generation on the host.
- `Failed to connect to http://<ip>:18789`
  - The gateway may still be loopback-only, not reachable on LAN, or blocked by the wrong bind mode.
- Pair succeeds but service does not run
  - Inspect saved session state, permission gating, and foreground service startup.

## Useful Host Checks

```bash
scripts/local-openclaw.sh pair
scripts/local-openclaw.sh devices
scripts/local-openclaw.sh openclaw gateway status --json
curl -sS -m 3 -o /dev/null -w '%{http_code}\n' http://<lan-ip>:18789/api/clawsense/pair
```

## Android Verification Notes

- If the issue is pairing only, verify setup code parsing and request execution before touching sensor code.
- If the issue is post-pair behavior, check whether `deviceSecret`, `host`, and `uploadBaseUrl` are persisted and reused.
- When reporting results, separate:
  - host-side verified locally
  - Android code inspected
  - real-device verification still required
