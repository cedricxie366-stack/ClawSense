# FunASR 本地后端验证报告（2026-07-01）

## 结论

- `FunASR` 已在 repo-local 隔离环境中安装完成，并成功接入 ClawSense 本地 ASR 后端。
- `openclaw clawsense asr-status` 已能诊断当前本地 ASR 配置，当前显示 `local-asr:funasr:zh` ready。
- 使用 2026-06-25 真实音频素材执行 dry-run，小批量 `10 / 10` 成功。
- 已执行首批非 dry-run 写回，`10 / 10` 成功写入 `transcriptSegments`，并保留原有较高质量 `transcript` 文本。
- 已补充 batch 协议：FunASR wrapper 可一次加载模型处理多条音频，真实素材 `3 / 3` batch dry-run 成功。
- 当前验证只证明 `ASR 转写链路` 成立；`speaker diarization / 多说话人区分` 尚未成立。

## 环境

- Repo: `/Users/cedric/Documents/ClawSense`
- Local OpenClaw runtime: `.local/openclaw`
- FunASR venv: `.local/asr/funasr-venv`
- Runner: `.local/asr/funasr-runner.sh`
- Wrapper: `scripts/local-asr/funasr-local.py`
- Batch protocol: `--batch-json <manifest.json>`，manifest 格式为 `{ "items": [{ "id": "...", "path": "..." }] }`
- Backend config:
  - `localAsrBackend = "funasr"`
  - `localAsrFunAsrCommand = "/Users/cedric/Documents/ClawSense/.local/asr/funasr-runner.sh"`
  - `localAsrFunAsrModel = "iic/SenseVoiceSmall"`
  - `localAsrTimeoutMs = 600000`

## 安装结果

```bash
.local/asr/funasr-venv/bin/python - <<'PY'
import torch
import torchaudio
import funasr
import modelscope
print('torch', torch.__version__)
print('torchaudio', torchaudio.__version__)
print('funasr', getattr(funasr, '__version__', 'unknown'))
print('modelscope', getattr(modelscope, '__version__', 'unknown'))
PY
```

结果：

- `torch 2.8.0`
- `torchaudio 2.8.0`
- `funasr 1.3.14`
- `modelscope 1.37.1`
- venv size: about `845M`

备注：

- Python import 时会出现 `urllib3 / LibreSSL` warning。
- FunASR 会提示未安装 `ffmpeg`，但会回退到 `torchaudio` 加载音频；本轮不作为阻塞。

## 配置诊断

```bash
scripts/local-openclaw.sh openclaw clawsense asr-status
```

结果摘要：

```json
{
  "backend": "funasr",
  "enabled": true,
  "provider": "local-asr:funasr:zh",
  "language": "zh",
  "timeoutMs": 600000,
  "ready": true,
  "issues": [],
  "command": "/Users/cedric/Documents/ClawSense/.local/asr/funasr-runner.sh",
  "model": "iic/SenseVoiceSmall",
  "commandExists": true,
  "commandExecutable": true
}
```

## 真实素材 dry-run

命令：

```bash
scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --dry-run --max 3
```

结果：

```json
{
  "attempted": 3,
  "succeeded": 3,
  "failed": 0,
  "skipped": 0,
  "dryRun": true,
  "provider": "local-asr"
}
```

扩大到 10 条后继续成功：

```bash
scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --dry-run --max 10
```

结果摘要：

```json
{
  "attempted": 10,
  "succeeded": 10,
  "failed": 0,
  "skipped": 0,
  "dryRun": true,
  "provider": "local-asr"
}
```

成功样本：

- `104642-audio-b0d26bb8-0f0a-4832-9257-6e6b14d5a153.wav`
  - preview: `就是但是跟我们在这个产品，就是想象的那个空间上还是有影差的，，就这俩都不说话了。。`
  - `transcriptSegmentCount = 1`
- `103244-audio-24365132-1f38-4592-ada9-db6dba9dfa6c.wav`
  - preview: `啊，这个是客服个人说报告的这个查看，就是作为管理视角和陪练师训练师那个视角，，我们怎么从那个后台获取一次性的综合报告？。`
  - `transcriptSegmentCount = 1`
- `103457-audio-1f85cf76-d0cf-4cb6-bbcc-0474b113d464.wav`
  - preview: `就是希望在那个对话的那个地方，不要展示标签，，而是展示考。。对对对，对，，展展示的详细一点，，就这句话到底是因为他他好还是不好，好在哪里？，不好在哪里啊，。。。`
  - `transcriptSegmentCount = 1`

## 首批真实写回

写回前先备份 repo-local ClawSense state：

```bash
cp .local/openclaw/state/plugins/clawsense/state.json \
  .local/openclaw/state-backups/clawsense-state-before-funasr-writeback-20260701-205335.json
```

写回命令：

```bash
scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --max 10
```

结果摘要：

```json
{
  "attempted": 10,
  "succeeded": 10,
  "failed": 0,
  "skipped": 0,
  "dryRun": false,
  "provider": "local-asr"
}
```

写回后 2026-06-25 音频状态抽样：

```json
{
  "audio": 132,
  "withArtifact": 132,
  "withTranscript": 118,
  "withSegments": 10,
  "noSegmentsWithTranscript": 108,
  "degraded": 14,
  "localAsr": 10
}
```

注意：

- 写回策略会保留已有 `event.transcript`，只补充本地 ASR 产生的 `transcriptSegments` / `sttProvider` / `analysisMode` 等结构化字段。
- 当前 FunASR 输出的段数仍通常为 `1`，所以这一步是“本地 ASR 证据链写回成立”，还不是“句级时间戳 / speaker diarization 成立”。
- 后续若要批量回填剩余 `108` 条已转写但无 segment 的音频，建议先做批处理/常驻 worker，否则每条都启动 Python + 加载模型会很慢。

## Batch dry-run 验证

命令：

```bash
time scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --dry-run --max 3
```

结果摘要：

```json
{
  "attempted": 3,
  "succeeded": 3,
  "failed": 0,
  "skipped": 0,
  "dryRun": true,
  "provider": "local-asr"
}
```

耗时：

- `1:28.66 total`
- `66.50s user`
- `18.03s system`

结论：

- Node 侧 strict `provider=local-asr` 回填在多候选时会优先调用 batch。
- FunASR wrapper 已支持一次加载模型循环处理多条音频，避免每条音频重新启动 Python + 加载模型。
- CPU 推理本身仍然慢；batch 是必要优化，但还不是最终生产形态。后续若要全天回填，仍建议做常驻 worker / 作业队列和进度可观测。

## CAM++ speaker diarization 探针

命令：

```bash
CLAWSENSE_FUNASR_SPK_MODEL='cam++' .local/asr/funasr-runner.sh <2026-06-25-audio.wav>
```

观察结果：

- 首次运行会下载 `iic/speech_campplus_sv_zh-cn_16k-common`。
- 在 2026-06-25 真实中文片段上，`SenseVoiceSmall + CAM++` 会遇到 timestamp 不完整问题：
  - 原始 FunASR 可能抛 `TypeError: '>' not supported between instances of 'float' and 'NoneType'`
  - wrapper 已降级为“不输出 speaker，保住普通 ASR”
- 降级后仍能得到 transcript，但 `segments=[]`，无法形成可用 speaker label。

结论：

- 当前不能把 CAM++ 直接视为已成立的 speaker diarization 方案。
- 本轮只完成“speaker 失败不拖垮 ASR”的鲁棒性保护。
- 真正要让“speaker_1 是我 / Amy 刚才说了什么 / 哪些任务分配给我”准确起来，还需要换 diarization 路线或更换 FunASR 模型组合继续验证。

## 修复过的问题

首次 dry-run 时，FunASR / torchaudio 的提示文本写入 stdout，导致 ClawSense 把 warning 当成 transcript。

修复：

- `scripts/local-asr/funasr-local.py` 在 import / model generate 阶段把 stdout 重定向到 stderr，只保留最终 JSON 输出。
- `src/local-asr.ts` 增强 parser：当 stdout 混有日志时，会优先解析最后一行 JSON。
- `src/local-asr.ts` 清洗 SenseVoice 控制标签，如 `<|zh|>`、`<|NEUTRAL|>`、`<|Speech|>` 和带空格的变体。
- `scripts/local-asr/funasr-local.py` 尝试 `sentence_timestamp=True` 时，`SenseVoiceSmall` 在当前依赖组合下会抛 `KeyError: "timestamp"`；wrapper 已自动降级重试，避免整条 ASR 失败。
- `scripts/local-asr/funasr-local.py` 在 `CLAWSENSE_FUNASR_SPK_MODEL=cam++` 且 speaker 分配因 timestamp 不完整失败时，会自动关闭 speaker 重试，保住 transcript。
- `src/review-engine.ts` 修复 `--max` 被维护安全上限强制压到 `6` 的问题：dry-run 显式 `--max` 现在可用于较大批量验证，非 dry-run 仍保留较小安全上限。
- `src/local-asr.ts` / `src/review-engine.ts` 新增 strict local-ASR batch 路径：`provider=local-asr` 且候选超过 1 条时优先走 batch；不支持 batch 的自定义命令会自动回退逐条模式。

## 已验证命令

```bash
npx vitest run --config vitest.config.ts test/local-asr.test.ts
npm run build
scripts/local-openclaw.sh setup
scripts/local-openclaw.sh openclaw clawsense asr-status
scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --dry-run --max 1
scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --dry-run --max 3
scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --dry-run --max 10
scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --max 10
time scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --provider local-asr --include-transcribed --dry-run --max 3
```

## 2026-07-01 追加：队列、diarization probe 与任务归因验证

新增命令面：

```bash
scripts/local-openclaw.sh openclaw clawsense asr-queue plan 2026-06-25 --max 3 --provider local-asr --include-transcribed --dry-run
scripts/local-openclaw.sh openclaw clawsense asr-queue status
scripts/local-openclaw.sh openclaw clawsense asr-queue run <queueId> --batch 2 --dry-run
scripts/local-openclaw.sh openclaw clawsense diarization-probe 2026-06-25 --max 1 --speaker-model 'cam++'
```

预期：

- `asr-queue plan` 会生成可恢复队列，返回 `queueId`、`stats.pending` 和候选音频信息。
- `asr-queue run` 会按 batch 执行 pending/failed job；`--dry-run` 不写回事件 transcript，只更新队列 job 状态。
- `diarization-probe` 是只读探针，不写回 state；如果 CAM++ 仍然无法产出 speaker segments，应返回 `speakerReady=false`，但普通 transcript 不应被 speaker 失败拖垮。

代码级验证：

```bash
npm run build
npx vitest run --config vitest.config.ts test/local-asr.test.ts test/review-engine.test.ts test/assistant-tool.test.ts
```

结果：

- `test/local-asr.test.ts`、`test/review-engine.test.ts`、`test/assistant-tool.test.ts` 共 `102` 条测试通过。
- 新增 speaker-aware 任务归因覆盖：当 `transcriptSegments[].speakerLabel=speaker_2` 且 `speaker_2` 已标注为 `Amy` 时，`我负责同步培训安排` 会被判定为 `assigned-to-known-speaker`，不会默认归为用户本人任务。

本地命令级验证结果：

```json
{
  "asrStatus": {
    "ready": true,
    "provider": "local-asr:funasr:zh",
    "commandExists": true,
    "commandExecutable": true
  },
  "queuePlan": {
    "pending": 3,
    "total": 3,
    "provider": "local-asr",
    "dryRun": true
  },
  "queueRun": {
    "attempted": 2,
    "succeeded": 2,
    "failed": 0,
    "remaining": 1
  },
  "diarizationProbe": {
    "attempted": 1,
    "succeeded": 1,
    "speakerReady": false,
    "speakerModel": "cam++",
    "provider": "local-asr:funasr:zh"
  }
}
```

结论：

- 本地 ASR 队列已经具备“规划、批量执行、状态恢复”的基本闭环。
- `diarization-probe` 能稳定证明当前 CAM++ speaker 不可用但 ASR 可用，适合作为后续替换/对比 diarization 方案的验收入口。
- speaker-aware 任务归因现在已经能消费已有句级 speaker label；但真实素材里的 speaker label 覆盖率仍取决于 diarization / turn-level attribution 后续进展。

## 2026-07-01 追加：transcript-only batch 句段兜底

问题：

- FunASR batch 在部分真实音频上只返回 `transcript`，没有 `segments/sentence_info`。
- 修复前这类结果会显示 `transcriptSegmentCount=0`，虽然 transcript 可用，但结构化证据层无法判断句段覆盖。

修复：

- Node 侧 parser 在 `transcript` 存在但 segment 数组为空时，按 `。！？!?；;` 合成轻量 `transcriptSegments`。
- 单条命令和 batch 命令共用该兜底。

验证命令：

```bash
npx vitest run --config vitest.config.ts test/local-asr.test.ts
npx vitest run --config vitest.config.ts test/review-engine.test.ts
npm run build
scripts/local-openclaw.sh setup
scripts/local-openclaw.sh openclaw clawsense asr-queue plan 2026-06-25 --max 2 --provider local-asr --include-transcribed --dry-run
scripts/local-openclaw.sh openclaw clawsense asr-queue run asr-2026-07-01T15-01-13-590Z-review_9 --batch 2 --dry-run
```

真实输出摘要：

```json
{
  "attempted": 2,
  "succeeded": 2,
  "failed": 0,
  "remaining": 0,
  "items": [
    {
      "eventId": "9d12e1b6-d62c-43e7-abbd-02e00966d204",
      "transcriptSegmentCount": 2
    },
    {
      "eventId": "3f8afdaf-3eec-4507-b52b-16627d1c00ec",
      "transcriptSegmentCount": 5
    }
  ]
}
```

结论：

- transcript-only 的 batch 结果现在不再表现为 `0` 个 segment。
- 这是“句段兜底”，不是 speaker diarization；它提升长音频结构化质量，但不能区分不同说话人。

## 2026-07-01 追加：队列状态 recentJobs 可观测性

命令：

```bash
scripts/local-openclaw.sh openclaw clawsense asr-queue status asr-2026-07-01T15-01-13-590Z-review_9
```

输出新增：

```json
{
  "stats": {
    "succeeded": 2,
    "remaining": 0
  },
  "recentJobs": [
    {
      "status": "succeeded",
      "attempts": 1,
      "fileName": "102022-audio-e128bbca-b8b3-4be6-ad54-88d9f600f4b2.wav",
      "provider": "local-asr:funasr:zh",
      "transcriptPreview": "然后可以选择对话的策略...",
      "transcriptSegmentCount": 2
    },
    {
      "status": "succeeded",
      "attempts": 1,
      "fileName": "104653-audio-4222b4fd-4463-47e2-bc65-14bc6937eff5.wav",
      "provider": "local-asr:funasr:zh",
      "transcriptPreview": "他这个练只能一点点的情绪安抚...",
      "transcriptSegmentCount": 5
    }
  ]
}
```

结论：

- `asr-queue status` 现在不仅能看汇总数字，还能直接定位剩余、失败或最近完成的 job。
- 后续验证 agent 可以用 `recentJobs[].analysisFailureReason` 判断队列失败原因，用 `recentJobs[].transcriptSegmentCount` 判断句段覆盖是否有效。

## 2026-07-01 追加：diarization probe 诊断字段

命令：

```bash
scripts/local-openclaw.sh openclaw clawsense diarization-probe 2026-06-25 --max 1 --speaker-model 'cam++'
```

真实输出摘要：

```json
{
  "attempted": 1,
  "succeeded": 1,
  "failed": 0,
  "speakerReady": false,
  "speakerModel": "cam++",
  "provider": "local-asr:funasr:zh",
  "diagnosis": "asr-ok-speaker-missing",
  "nextActions": [
    "当前 cam++ 没有产出 speaker labels；继续评估 WhisperX / pyannote / FunASR 其他 speaker 模型组合。",
    "在 speaker 未解决前，任务归属继续保守表达，不要把“我/你/我们”自动归为用户本人。"
  ],
  "items": [
    {
      "status": "succeeded",
      "transcriptSegmentCount": 5,
      "speakerSegmentCount": 0,
      "speakerLabels": []
    }
  ]
}
```

结论：

- 本轮真实 probe 不是 ASR 失败；FunASR 已能产出文本和句段。
- 当前失败点是 speaker labels 缺失，因此不能把 `cam++` 作为已成立的发布级 speaker diarization 方案。
- 产品回答“哪些任务分给我”时仍应依赖已标注 speaker 或保守表达，不应根据 transcript 里的“我/你/我们”自动归因。

## 2026-07-01 追加：队列 job 暴露音频时长线索

命令：

```bash
scripts/local-openclaw.sh openclaw clawsense asr-queue plan 2026-06-25 --max 2 --provider local-asr --include-transcribed --dry-run
scripts/local-openclaw.sh openclaw clawsense asr-queue run asr-2026-07-01T15-22-15-601Z-review_e --batch 2 --dry-run
```

真实输出摘要：

```json
{
  "audio": {
    "totalClipMs": 36487,
    "remainingClipMs": 0,
    "totalVoicedMs": 22528,
    "remainingVoicedMs": 0
  },
  "recentJobs": [
    {
      "fileName": "102022-audio-e128bbca-b8b3-4be6-ad54-88d9f600f4b2.wav",
      "clipMs": 18433,
      "voicedMs": 11392,
      "status": "succeeded",
      "transcriptSegmentCount": 2
    },
    {
      "fileName": "104653-audio-4222b4fd-4463-47e2-bc65-14bc6937eff5.wav",
      "clipMs": 18054,
      "voicedMs": 11136,
      "status": "succeeded",
      "transcriptSegmentCount": 5
    }
  ]
}
```

结论：

- `asr-queue plan/run/status` 现在能直接展示候选音频长度和有效人声时长。
- queue-level `audio.totalClipMs/remainingClipMs` 能帮助验证 agent 判断剩余工作量；本轮 36.5 秒音频 dry-run 完成后 `remainingClipMs=0`。
- 这也暴露出 FunASR 冷启动/批处理仍偏慢，后续需要后台 worker、超时/取消、耗时预估和低优先级调度。

## 未完成 / 风险

- 当前 `SenseVoiceSmall` 输出为整段 transcript，`transcriptSegmentCount = 1`；还没有形成句级时间戳和 speaker diarization。
- `SenseVoiceSmall + CAM++` 在本轮真实素材上没有产出可用 speaker segments，只能作为失败探针记录，不能作为默认发布方案。
- 真实写回只执行了首批 `10` 条，剩余 2026-06-25 音频仍需要后续批量回填或按需回填。
- 若要让“我的任务 vs 别人任务”更准，下一步需要接入句级切分和 speaker diarization，而不是只接 ASR。
- FunASR 依赖体积较大，venv 当前约 `845M`，发布给普通用户时需要明确这是可选本地后端。
- 当前 batch 仍是单次命令模型加载，不是常驻 daemon；适合批量回填验证，但离全天后台稳定处理还需要 worker 化、进度记录和取消/重试策略。

## 建议下一步

1. 把 batch 进一步升级为常驻 worker / 作业队列，支持进度、取消、失败重试和后台低优先级运行。
2. 单独评估 `FunASR + CAM++` 或 `WhisperX / pyannote` 类 diarization 方案，不要把本轮 ASR 成功误判成 speaker 成功。
3. 在 speaker/句级切分没完成前，产品回答必须继续保守表达任务归属，不应把 speaker-dependent 任务直接认领给用户。
