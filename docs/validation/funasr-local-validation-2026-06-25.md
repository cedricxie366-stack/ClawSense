# ClawSense 本地 FunASR 验证报告

## 结论

- 日期：2026-07-01
- 验证目标素材：2026-06-25 真实办公/会议素材。
- 结论：**部分成功，真实 FunASR 模型运行被本机 Python 依赖阻塞。**
- 已确认：
  - repo-local OpenClaw runtime 中存在 2026-06-25 真实音频素材。
  - 当天共有 457 个事件、132 个音频文件。
  - 现有状态里 118 条音频已有 transcript，但 0 条有 `transcriptSegments`。
  - `scripts/local-asr/funasr-local.py` 存在且可执行。
  - ClawSense 新本地 ASR command backend 可以消费 FunASR / SenseVoice 风格 JSON，并把 `sentence_info` 转成 `transcriptSegments` + `speakerLabel`。
- 阻塞：
  - 当前 Mac Python 环境缺少 `funasr`、`modelscope`、`torch`，无法真实加载 `iic/SenseVoiceSmall` 跑模型。
  - 因此本轮没有对真实 6 月 25 日音频产生真实 FunASR transcript。

## 验证边界

- 只使用 repo-local OpenClaw：`.local/openclaw`。
- 没有修改主线代码。
- 没有修改 `.local/openclaw/state/openclaw.json`。
- 没有安装 Python 包或下载模型。
- 只新增本报告。

## 环境检查

```bash
scripts/local-openclaw.sh env
```

输出摘要：

```text
PROJECT_ROOT=/Users/cedric/Documents/ClawSense
LOCAL_RUNTIME_ROOT=/Users/cedric/Documents/ClawSense/.local/openclaw
OPENCLAW_HOME=/Users/cedric/Documents/ClawSense/.local/openclaw/home
OPENCLAW_STATE_DIR=/Users/cedric/Documents/ClawSense/.local/openclaw/state
OPENCLAW_CONFIG_PATH=/Users/cedric/Documents/ClawSense/.local/openclaw/state/openclaw.json
```

Python / 依赖检查：

```bash
python3 --version
python3 - <<'PY'
mods=['funasr','modelscope','torch','numpy']
for m in mods:
    try:
        mod=__import__(m)
        print(f'{m}: OK {getattr(mod, "__version__", "unknown")}')
    except Exception as e:
        print(f'{m}: MISSING {type(e).__name__}: {e}')
PY
```

输出摘要：

```text
Python 3.9.6
funasr: MISSING ModuleNotFoundError: No module named 'funasr'
modelscope: MISSING ModuleNotFoundError: No module named 'modelscope'
torch: MISSING ModuleNotFoundError: No module named 'torch'
numpy: OK 2.0.2
```

Wrapper 检查：

```bash
ls -l scripts/local-asr/funasr-local.py scripts/local-asr/whisper-faster.py
```

输出摘要：

```text
scripts/local-asr/funasr-local.py
scripts/local-asr/whisper-faster.py
```

当前 ClawSense ASR 配置：

```bash
scripts/local-openclaw.sh openclaw config get plugins.entries.clawsense.config --json
```

关键摘要：

```json
{
  "localAsrBackend": "sherpa-onnx-sensevoice",
  "localAsrModelDir": "/Users/cedric/Documents/ClawSense/.local/openclaw/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
  "localAsrLanguage": "zh",
  "localAsrNumThreads": 2,
  "sttFallbackModel": "qwen3-asr-flash"
}
```

## 真实素材盘点

读取 2026-06-25 媒体索引：

```bash
scripts/local-openclaw.sh openclaw clawsense media 2026-06-25
```

摘要：

```json
{
  "date": "2026-06-25",
  "counts": {
    "events": 457,
    "artifacts": 457,
    "devices": 1
  }
}
```

磁盘音频文件：

```bash
find .local/openclaw/state/plugins/clawsense/media/2026/06/25 -type f -name '*.wav' | wc -l
```

输出：

```text
132
```

样例路径：

```text
.local/openclaw/state/plugins/clawsense/media/2026/06/25/2304fpn6dc/095944-audio-0a0fac40-4633-434b-84fc-1a0f73ebfd90.wav
.local/openclaw/state/plugins/clawsense/media/2026/06/25/2304fpn6dc/100025-audio-90eff0f2-b9e7-4ae7-b6cb-d2a2165da764.wav
.local/openclaw/state/plugins/clawsense/media/2026/06/25/2304fpn6dc/111556-audio-f122a885-d102-4520-9d6e-eced1ee803f5.wav
```

状态统计脚本：

```bash
node - <<'NODE'
const fs=require('fs');
const state=JSON.parse(fs.readFileSync('.local/openclaw/state/plugins/clawsense/state.json','utf8'));
const start=new Date('2026-06-25T00:00:00+08:00').getTime();
const end=new Date('2026-06-26T00:00:00+08:00').getTime();
const events=(state.events||[]).filter(e=>e.capturedAt>=start&&e.capturedAt<end);
const audio=events.filter(e=>e.modality==='audio');
const withTranscript=audio.filter(e=>e.transcript || (e.summary && !/^Audio captured/.test(e.summary)));
const withSegments=audio.filter(e=>Array.isArray(e.transcriptSegments)&&e.transcriptSegments.length);
const degraded=audio.filter(e=>String(e.analysisStatus||'').includes('degraded') || e.analysisFailureReason);
console.log(JSON.stringify({
  events: events.length,
  audio: audio.length,
  withTranscript: withTranscript.length,
  withTranscriptSegments: withSegments.length,
  degradedAudio: degraded.length
}, null, 2));
NODE
```

输出：

```json
{
  "events": 457,
  "audio": 132,
  "withTranscript": 118,
  "withTranscriptSegments": 0,
  "degradedAudio": 14
}
```

## 真实 FunASR wrapper 运行尝试

命令：

```bash
python3 scripts/local-asr/funasr-local.py \
  .local/openclaw/state/plugins/clawsense/media/2026/06/25/2304fpn6dc/095944-audio-0a0fac40-4633-434b-84fc-1a0f73ebfd90.wav
```

失败日志摘要：

```text
Traceback (most recent call last):
  File "/Users/cedric/Documents/ClawSense/scripts/local-asr/funasr-local.py", line 106, in <module>
    raise SystemExit(main())
  File "/Users/cedric/Documents/ClawSense/scripts/local-asr/funasr-local.py", line 31, in main
    from funasr import AutoModel
ModuleNotFoundError: No module named 'funasr'
```

判定：真实 FunASR 模型运行阻塞于 Python 依赖缺失，还未进入模型下载、模型加载或音频转写阶段。

## Command Backend 消费烟测

为了区分“FunASR 模型不可用”和“ClawSense 不会消费 FunASR 输出”，本轮用一个临时 mock command 输出 FunASR `sentence_info` 风格 JSON，并把真实 2026-06-25 wav 作为输入路径传给 `transcribeAudioWithLocalAsr`。

命令：

```bash
tmp_script="$(mktemp /tmp/clawsense-funasr-mock.XXXXXX)"
cat > "$tmp_script" <<'SH'
#!/bin/sh
cat <<'JSON'
{"transcript":"这是 FunASR 模拟输出，来自真实音频文件。","sentence_info":[{"start":0,"end":1280,"text":"这是第一段。","spk":"speaker_1"},{"start":1280,"end":2600,"text":"这是第二段。","spk":"speaker_2"}]}
JSON
SH
chmod +x "$tmp_script"
node - "$tmp_script" <<'NODE'
const command = process.argv[2];
const audio = '.local/openclaw/state/plugins/clawsense/media/2026/06/25/2304fpn6dc/095944-audio-0a0fac40-4633-434b-84fc-1a0f73ebfd90.wav';
const { transcribeAudioWithLocalAsr } = await import('./dist/src/local-asr.js');
const result = await transcribeAudioWithLocalAsr({
  cfg: {
    localAsrBackend: 'funasr',
    localAsrLanguage: 'zh',
    localAsrFunAsrCommand: command,
    localAsrFunAsrModel: 'iic/SenseVoiceSmall',
    localAsrTimeoutMs: 30000,
  },
  filePath: audio,
  resolveStateDir: () => process.cwd() + '/.local/openclaw/state',
});
console.log(JSON.stringify(result, null, 2));
NODE
rm -f "$tmp_script"
```

输出：

```json
{
  "transcript": "这是 FunASR 模拟输出，来自真实音频文件。",
  "transcriptSegments": [
    {
      "startMs": 0,
      "endMs": 1280,
      "text": "这是第一段。",
      "speakerLabel": "speaker_1"
    },
    {
      "startMs": 1280,
      "endMs": 2600,
      "text": "这是第二段。",
      "speakerLabel": "speaker_2"
    }
  ],
  "language": "zh",
  "analysisProvider": "local-asr:funasr:zh"
}
```

判定：

- `local-asr:funasr:zh` provider label 正常。
- FunASR `sentence_info.start/end` 被按毫秒解析为 `startMs/endMs`。
- `spk` 被归一成 `speakerLabel`。
- 本地 ASR 层已经具备消费 FunASR 输出并生成 `transcriptSegments` 的能力。

## Backfill 接入口检查

命令：

```bash
scripts/local-openclaw.sh openclaw clawsense backfill-audio --help
```

输出摘要：

```text
Usage: openclaw clawsense backfill-audio [options] [date]

对某一天的降级音频做一轮轻量 transcript backfill

Options:
  --max <count>  最多处理多少段音频 (default: "3")
```

说明：

- 回查 / backfill 命令存在。
- 由于真实 FunASR 依赖缺失，本轮没有把 repo-local 配置改成 `localAsrBackend=funasr` 后执行 `backfill-audio`，避免产生大量确定失败的状态写入。

## 最小下一步命令

如果要在当前 Mac 上继续真实 FunASR 验证，建议先使用隔离虚拟环境，避免污染系统 Python：

```bash
cd /Users/cedric/Documents/ClawSense
python3 -m venv .local/funasr-venv
. .local/funasr-venv/bin/activate
python -m pip install --upgrade pip
python -m pip install funasr modelscope torch
python scripts/local-asr/funasr-local.py \
  .local/openclaw/state/plugins/clawsense/media/2026/06/25/2304fpn6dc/095944-audio-0a0fac40-4633-434b-84fc-1a0f73ebfd90.wav
```

如果 wrapper 能输出 JSON，再临时切换 repo-local OpenClaw 配置：

```bash
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrBackend '"funasr"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrFunAsrCommand '"/Users/cedric/Documents/ClawSense/scripts/local-asr/funasr-local.py"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrFunAsrModel '"iic/SenseVoiceSmall"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrLanguage '"zh"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrTimeoutMs '120000' --strict-json
scripts/local-openclaw.sh gateway-restart
scripts/local-openclaw.sh openclaw clawsense backfill-audio 2026-06-25 --max 3
```

验证是否写入 segments：

```bash
node - <<'NODE'
const fs=require('fs');
const state=JSON.parse(fs.readFileSync('.local/openclaw/state/plugins/clawsense/state.json','utf8'));
const start=new Date('2026-06-25T00:00:00+08:00').getTime();
const end=new Date('2026-06-26T00:00:00+08:00').getTime();
const audio=(state.events||[]).filter(e=>e.capturedAt>=start&&e.capturedAt<end&&e.modality==='audio');
console.log(audio.filter(e=>Array.isArray(e.transcriptSegments)&&e.transcriptSegments.length).slice(0,5).map(e=>({
  eventId:e.eventId,
  sttProvider:e.sttProvider,
  analysisProvider:e.analysisProvider,
  segments:e.transcriptSegments.length,
  preview:e.transcriptSegments[0]?.text
})));
NODE
```

## 对主线开发的建议

1. 当前代码侧的 FunASR command backend 形态可继续保留；它已经能消费 FunASR `sentence_info`，这对后续 speaker/task attribution 很关键。
2. 下一次真实验证应先完成独立 venv 依赖安装，再只 backfill 少量降级音频，避免一次性改写 132 条历史事件。
3. 建议后续给 `backfill-audio` 增加 dry-run 或 `--provider local-asr` 诊断模式，方便验证本地 ASR 后端而不写状态。
4. 如果 FunASR 实测过慢，可优先让它处理短 clip / 降级事件；完整 10-15 分钟会议仍可继续由已有云 ASR transcript 兜底。
