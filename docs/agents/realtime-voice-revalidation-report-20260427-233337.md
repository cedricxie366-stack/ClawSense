# Realtime Voice Revalidation Report

- GeneratedAt: Mon Apr 27 23:33:37 CST 2026
- Device:
- APK:
- Runtime: repo-local OpenClaw

## Precheck

### ADB
List of devices attached


### APK And Permissions

### TTS Engines
default=

### Local Gateway
{
  "service": {
    "label": "LaunchAgent",
    "loaded": true,
    "loadedText": "loaded",
    "notLoadedText": "not loaded",
    "command": {
      "programArguments": [
        "/usr/local/bin/node",
        "/Users/cedric/Documents/ClawSense/.local/openclaw/home/node_modules/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789"
      ],
      "environment": {
        "OPENCLAW_STATE_DIR": "/Users/cedric/Documents/ClawSense/.local/openclaw/state",
        "OPENCLAW_CONFIG_PATH": "/Users/cedric/Documents/ClawSense/.local/openclaw/state/openclaw.json",
        "OPENCLAW_GATEWAY_PORT": "18789"
      },
      "sourcePath": "/Users/cedric/Library/LaunchAgents/ai.openclaw.gateway.plist"
    },
    "runtime": {
      "status": "running",
      "state": "running",
      "pid": 67649,
      "cachedLabel": false
    },
    "configAudit": {
      "ok": true,
      "issues": []
    }
  },
  "config": {
    "cli": {
      "path": "/Users/cedric/Documents/ClawSense/.local/openclaw/state/openclaw.json",
      "exists": true,
      "valid": true,
      "controlUi": {
        "allowedOrigins": [
          "http://localhost:18789",
          "http://127.0.0.1:18789"
        ]
      }
    },
    "daemon": {
      "path": "/Users/cedric/Documents/ClawSense/.local/openclaw/state/openclaw.json",
      "exists": true,
      "valid": true,
      "controlUi": {
        "allowedOrigins": [
          "http://localhost:18789",
          "http://127.0.0.1:18789"
        ]
      }
    }
  },
  "gateway": {
    "bindMode": "lan",
    "bindHost": "0.0.0.0",
    "port": 18789,
    "portSource": "service args",
    "probeUrl": "ws://127.0.0.1:18789",
    "probeNote": "bind=lan listens on 0.0.0.0 (all interfaces); probing via 127.0.0.1."
  },
  "port": {
    "port": 18789,
    "status": "busy",
    "listeners": [
      {
        "pid": 67649,
        "command": "node",
        "address": "*:18789",
        "commandLine": "openclaw-gateway",
        "user": "cedric",
        "ppid": 1
      }
    ],
    "hints": [
      "Gateway already running locally. Stop it (openclaw gateway stop) or use a different port."
    ]
  },
  "rpc": {
    "ok": true,
    "url": "ws://127.0.0.1:18789"
  },
  "extraServices": []
}

### ClawSense Local Config
{
  "publicBaseUrl": "http://192.168.18.240:18789",
  "hasOpenaiApiKey": false,
  "openaiBaseUrl": null,
  "visionProvider": null,
  "visionModel": null,
  "sttFallbackModel": null
}

### Devices
{
  "ok": true,
  "count": 2,
  "devices": [
    {
      "deviceId": "7fbbc4a4-3baf-4aaa-aa50-1166d9c7cca4",
      "name": "PDEM10",
      "platform": "android",
      "appVersion": "0.1.1-ui-textfix1-debug",
      "createdAt": 1776271751805,
      "lastSeenAt": 1776421916187,
      "lastHeartbeatAt": 1776421916187
    },
    {
      "deviceId": "394e680a-bc49-41a9-884a-b46cf70a366c",
      "name": "2304FPN6DC",
      "platform": "android",
      "appVersion": "0.1.1-ui-textfix1-debug",
      "createdAt": 1777293808297,
      "lastSeenAt": 1777304021431,
      "lastHeartbeatAt": 1777304016674
    }
  ]
}

## Host Route Checks

### /assistant/query GET should be 405
HTTP/1.1 405 Method Not Allowed
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
allow: POST
content-type: application/json; charset=utf-8
cache-control: no-store
Date: Mon, 27 Apr 2026 15:33:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 58

{"ok":false,"error":"method_not_allowed","allow":["POST"]}
### /recent-context
{
  "ok": true,
  "sceneSummary": "Image captured, but the primary multimodal model was unavailable. Device note: baseline-snapshot.",
  "counts": {
    "windows": 1,
    "events": 1,
    "transcriptSpans": 0
  },
  "keys": [
    "ok",
    "windowHint",
    "modeUsed",
    "timeRange",
    "sceneSummary",
    "recentTranscriptSpans",
    "peopleHints",
    "attentionHints",
    "taskHints",
    "topEvidence",
    "counts"
  ]
}

### /followups
{
  "ok": true,
  "evidenceFollowUpTargets": 3,
  "topPrompts": [
    "你可以继续问：“请复核 22:11-22:26 这段音频，尽量提取任务、人物和结论。”",
    "你可以继续问：“请复核 22:28-22:37 这段音频，尽量提取任务、人物和结论。”",
    "你可以继续问：“请复核 21:56-22:09 这段音频，尽量提取任务、人物和结论。”"
  ]
}

### ADB Recheck After Server Restart
List of devices attached
c8e666a9               device usb:1-1.1 product:ishtar model:2304FPN6DC device:ishtar transport_id:1


### APK And Permissions Recheck
    versionName=0.1.1-ui-textfix1-debug
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
        android.permission.CAMERA: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
        android.permission.RECORD_AUDIO: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]

## Validation A: Empty Query Timeout

### UI After Timeout
服务状态
音频 VAD、定格拍照和心跳都在运行。
最近变更：23:27:34
拍照可用
音频可用
通知可用
当前是完整模式：音频 VAD、定格拍照、心跳都在运行。
最近活动
最近音频上传
暂无
最近图片上传
23:34:39
最近错误
暂无错误
启动感知服务
停止服务
实时助手
现在可以手动触发一轮语音提问。
就绪中
首版先走“手动触发单轮提问”，主机返回文本，手机本地 TTS 朗读。后面再把常开唤醒词接进来。
自动
会议
工位
问实时助手
权限检查
ClawSense

### Logs

