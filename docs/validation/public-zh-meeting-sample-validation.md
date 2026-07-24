# Public Chinese meeting sample validation

## 目标

用公开中文多人会议素材验证 ClawSense 的本地免费 ASR / speaker 路线，不依赖用户临时提供真人会议录音。

当前样例使用 AliMeeting 派生公开数据集：

- Dataset: `ggfox00000/dia-alimeeting-test`
- Source: `https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test`
- Session: `R8002_M8002`
- RTTM: `rttm/near/R8002_M8002.rttm`
- Far-field WAV: `audio/far/R8002_M8002_MS802.wav`

## 快速 metadata 检查

```bash
npm run check:public-zh-meeting
```

默认只做轻量检查：

- 下载 / 复用 RTTM。
- 验证 RTTM 至少包含 4 个 speaker 和大量轮次。
- HEAD 检查 1 个 far-field WAV 和 1 个 near-field WAV 是否可达。
- 不默认下载完整大音频，不默认跑 ASR。

最新结果：

```json
{
  "mode": "metadata-only",
  "rttm": {
    "lineCount": 866,
    "speakerCount": 4,
    "speakers": ["N_SPK8005", "N_SPK8006", "N_SPK8007", "N_SPK8008"]
  },
  "audio": {
    "farContentLength": 529029200,
    "nearContentLength": 65991600
  }
}
```

## 准备 120 秒远场切片

```bash
CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting
```

脚本会使用 HTTP range 只下载开头所需字节，并把 8 通道远场音频 downmix 成单声道：

```json
{
  "clipPath": ".local/asr/external/alimeeting/R8002_M8002_MS802.far-mono.120s.wav",
  "channels": 1,
  "sampleRate": 16000,
  "durationSec": 120
}
```

## 本地 ASR + speaker 深测

```bash
CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting
```

当前中文默认路线是：

- primary transcript: FunASR / SenseVoice
- speaker timeline: FunASR / CAM++
- merge wrapper: `scripts/local-asr/hybrid-whisper-funasr.py`

最新结果：

```json
{
  "mode": "fresh-asr",
  "asr": {
    "primary": "funasr",
    "transcriptLength": 651,
    "segmentCount": 7,
    "speakerTimelineSegmentCount": 7,
    "speakerLabels": [
      "speaker_1",
      "speaker_2",
      "speaker_3",
      "speaker_4",
      "speaker_5"
    ],
    "assignedSpeakerSegmentCount": 7
  }
}
```

## 回放到 ClawSense 证据链

```bash
npm run check:public-zh-replay
```

该检查会把最新的 AliMeeting ASR 结果回放到 repo-local OpenClaw / ClawSense state，并通过真实 CLI 验证：

- `clawsense context` 能把中文会议转写作为主要证据，而不是只看图片或降级摘要。
- `responseHints.evidenceFollowUpTargets` 能继续产出追问目标。
- `clawsense annotate-speaker` 标注后，二次 context 能暴露中文实名 / 角色。
- `clawsense followups` 对同一天仍有可用追问入口。

最新结果：

```json
{
  "ok": true,
  "fixtureDate": "2026-01-16",
  "segmentCount": 7,
  "transcriptSpanCount": 7,
  "topicSegmentCount": 1,
  "evidenceFollowUpTargetCount": 2,
  "annotatedSpeaker": "同事A",
  "taskAttributionStatus": "needs-speaker-labels"
}
```

## 本轮发现

- 中文会议不应默认用 Whisper tiny 作为 primary transcript；同一 120 秒远场切片上，FunASR primary 的转写明显更自然。
- `hybrid-whisper-funasr.py` 已修复 FunASR primary 的两个问题：
  - 当 primary command 是 FunASR 时，自动启用 `CLAWSENSE_FUNASR_SENTENCE_TIMESTAMP=1` 和 `CLAWSENSE_FUNASR_SPK_MODEL=cam++`。
  - 当 FunASR 输出 `segments=[]` 但 `sentence_info` 非空时，会选择非空 `sentence_info` 作为主段落，不再丢失 transcript segments。
- 这个样例证明中文多人会议本地链路可跑，但还不能代表所有真实办公室远场、嘈杂、距离远场景。
- 中文会议 replay 已证明本地 ASR 结果可以进入 ClawSense context / followups / speaker 标注链路，用于回归“刚才讨论重点是什么”“某个同事说了什么”这类聊天页问题。

## 边界

- AliMeeting 单场 far-field WAV 约 500MB；默认 smoke 不下载完整音频。
- ASR 深测是 optional，不进入默认 release / phase gate。
- speaker label 是概率证据，需要继续通过真实用户会议验证“任务归属”和“人物标注后重问”。
