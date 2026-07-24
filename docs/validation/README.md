# ClawSense validation guide

本目录收集 ClawSense 当前阶段的验证说明、公开素材 replay 记录和专项 smoke 文档。

## 首选入口

没有 Android 真机或真人语音条件时，先跑非真机产品质量门禁：

```bash
cd /Users/cedric/Documents/ClawSense
npm run check:non-device-product-gate
```

该门禁覆盖：

- Evidence v2 synthetic 音频诊断正向契约
- 公开 AMI 会议 replay 与长历史问题路由
- 2026-06-25 真实历史素材的 transcript / digest / retention 边界
- cached ASR / diarization positive sample
- active raw audio artifact 诊断
- speaker slots 与标注复用
- 自动录视频触发 fixture
- 可选中文 AliMeeting replay

每次运行会写入：

```bash
.local/non-device-product-gate-reports/latest.json
```

只复查最近一次结果时，不要重跑完整门禁：

```bash
npm run report:non-device-product-gate
```

摘要中的 `freshness.isStale` 为 `true` 时，说明最近一次完整门禁已经超过默认 24 小时；验收签核前需要重跑 `npm run check:non-device-product-gate`。

## 常用专项检查

| 目标 | 命令 | 文档 |
| --- | --- | --- |
| Evidence v2 音频诊断正向契约 | `npm run check:evidence-v2` | [evidence-v2-smoke-validation.md](./evidence-v2-smoke-validation.md) |
| 长历史问题路由 / 公开 AMI 对话包 | `npm run check:conversation-routing` | [conversation-evidence-routing-validation.md](./conversation-evidence-routing-validation.md) |
| repo-local OpenClaw 真实历史素材 | `npm run check:evidence-local` | [local-openclaw-evidence-cli-validation.md](./local-openclaw-evidence-cli-validation.md) |
| 公开 AMI WAV + cached ASR | `npm run check:public-wav` | [public-wav-sample-validation.md](./public-wav-sample-validation.md) |
| 公开 AMI replay 到 ClawSense state | `npm run check:public-replay` | [public-ami-replay-cli-validation.md](./public-ami-replay-cli-validation.md) |
| 中文 AliMeeting 样例 | `npm run check:public-zh-meeting` / `npm run check:public-zh-replay` | [public-zh-meeting-sample-validation.md](./public-zh-meeting-sample-validation.md) |

## 真机不可替代项

非真机门禁不能证明：

- Android 麦克风、TTS、停止朗读和真人听感已经通过
- 真实旧手机在弱网 / 跨网络 / 心跳恢复下稳定
- 环境音没有被误当成显式 assistant query
- 自动视频在真实手机上完成录制、上传和 evidence 回链

这些必须继续走 `docs/agents/final-stage-live-validation-agent-prompt.md` 和 Android live / stage-final 门禁。
