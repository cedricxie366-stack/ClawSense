# Public WAV sample validation

## 目标

当暂时没有真人新素材时，用公开可下载的 WAV 验证 ClawSense 本地 ASR / diarization / speaker timeline 路线。

默认样例：

- AMI Meeting Corpus `ES2004a.Mix-Headset.wav`
- 来源：`https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2004a.Mix-Headset.wav`
- 本地切片：`60s-360s`，5 分钟真实多人会议片段

## 快速验证

```bash
npm run check:public-wav
```

默认模式会：

- 确认 AMI WAV 可下载，若本地缺失则下载。
- 生成或复用 5 分钟切片。
- 读取最近一次 AMI hybrid ASR 结果，断言 transcript、segment、speaker timeline 和 speaker labels 都存在。

## 强制重新跑 ASR

```bash
CLAWSENSE_PUBLIC_WAV_RUN_ASR=1 npm run check:public-wav
```

这会调用：

- `.local/asr/whisperx-runner.sh` 作为主转写
- `.local/asr/funasr-runner.sh` + CAM++ 作为 speaker timeline
- `scripts/local-asr/hybrid-whisper-funasr.py` 做合并

该命令会比普通 smoke 慢很多，适合模型或 wrapper 改动后跑。

## 中文公开会议素材建议

中文多人会议优先选 AISHELL-4：

- OpenSLR: `https://www.openslr.org/111/`
- 说明：真实会议场景，211 个 session，4-8 个说话人，约 120 小时，包含转写和 speaker voice activity。
- 注意：数据包体积较大，不适合作为日常 smoke；适合后续专门做中文会议深测。

## 中文会议深测入口

当前仓库提供一个默认轻量、显式重型的 AliMeeting 深测入口：

```bash
npm run check:public-zh-meeting
```

默认只检查：

- AliMeeting RTTM 是否可下载。
- RTTM 是否包含多说话人、多轮次。
- far-field / near-field WAV 是否可达，以及体积是否符合真实会议录音。

它不会默认下载 500MB 级 far-field WAV，也不会默认跑本地 ASR。

如需准备 120 秒远场单声道切片：

```bash
CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting
```

如需进一步跑本地 ASR + speaker 深测：

```bash
CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting
```

如需把最新中文 ASR 结果回放进 ClawSense 证据包并验证 context / followups / speaker 标注：

```bash
npm run check:public-zh-replay
```

该深测会：

- 从 AliMeeting far-field WAV 用 HTTP range 下载开头片段。
- 把 8 通道远场音频 downmix 成 16kHz / mono / PCM16 WAV。
- 调用 `scripts/local-asr/hybrid-whisper-funasr.py`，中文默认用 FunASR / SenseVoice 负责主转写，用 FunASR / CAM++ 负责 speaker timeline。

边界：

- 这是中文多人会议路线的 optional deep check，不进入默认 release / phase gate。
- AliMeeting 单场音频很大，网络慢时不建议在主开发线程反复跑。
- speaker label 仍是概率证据，需要后续用真实用户会议继续校验。
- replay 检查会污染 repo-local ClawSense fixture 日期 `2026-01-16` 的测试 state；脚本会在下次运行前清理同一 fixture。

详细记录见：

- [public-zh-meeting-sample-validation.md](./public-zh-meeting-sample-validation.md)
