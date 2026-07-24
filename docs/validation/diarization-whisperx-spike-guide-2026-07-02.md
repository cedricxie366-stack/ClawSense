# WhisperX 本地 diarization spike 验证指南

目标：验证本地 WhisperX 是否能在 ClawSense 真实音频上产出 `transcriptSegments[].speakerLabel`，从而推进“我的任务 vs 别人的任务”“Amy 刚才说了什么”等能力。

## 前提

- 不影响默认路径：当前 ClawSense 仍默认关闭 ASR worker，默认不启用 WhisperX。
- WhisperX diarization 需要 Hugging Face token，并且通常需要接受 pyannote 模型条款。
- 没有 `HF_TOKEN` 时，`scripts/local-asr/whisperx-local.py` 仍可跑 ASR，但不会产出 speaker label。
- WhisperX diarization 必须能读到原始音频文件；如果 `state.json` 只有 transcript、但 `sourcePath` 指向的 wav 已被清理，探针会返回 `no-audio-candidates`。

## 建议验证步骤

```bash
cd /Users/cedric/Documents/ClawSense

python3 -m venv .local/asr/whisperx-venv
. .local/asr/whisperx-venv/bin/activate
python -m pip install -U pip
python -m pip install whisperx

cat > .local/asr/whisperx-runner.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cd /Users/cedric/Documents/ClawSense
exec .local/asr/whisperx-venv/bin/python scripts/local-asr/whisperx-local.py "$@"
SH
chmod +x .local/asr/whisperx-runner.sh
```

如果直连 Hugging Face 下载慢或超时，可先用镜像下载 faster-whisper tiny 模型做 smoke test：

```bash
mkdir -p .local/asr/models/faster-whisper-tiny
for f in config.json model.bin tokenizer.json vocabulary.txt; do
  curl -L --fail "https://hf-mirror.com/Systran/faster-whisper-tiny/resolve/main/$f" \
    -o ".local/asr/models/faster-whisper-tiny/$f"
done
```

如需 speaker diarization：

```bash
scripts/local-asr/save-hf-token.sh
source .local/asr/hf-token.env
```

临时切换 repo-local OpenClaw 配置：

```bash
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrBackend '"whisper"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrWhisperCommand '"/Users/cedric/Documents/ClawSense/.local/asr/whisperx-runner.sh"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrWhisperModel '"small"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrLanguage '"zh"' --strict-json
scripts/local-openclaw.sh setup
```

只读探针：

```bash
scripts/local-openclaw.sh openclaw clawsense diarization-probe 2026-06-25 --provider whisperx --max 1
```

低资源 / smoke test 可用的环境变量：

```bash
export CLAWSENSE_ASR_MODEL=/Users/cedric/Documents/ClawSense/.local/asr/models/faster-whisper-tiny
export CLAWSENSE_WHISPERX_VAD_METHOD=silero
export CLAWSENSE_WHISPERX_ALIGN=0
```

说明：

- `CLAWSENSE_WHISPERX_VAD_METHOD=silero` 避免默认 Pyannote VAD 在 PyTorch 2.6+ 上触发 checkpoint `weights_only` 兼容问题。
- `CLAWSENSE_WHISPERX_ALIGN=0` 跳过慢速 wav2vec2 alignment，适合 smoke test；正式需要细粒度词级时间戳时再打开。
- 如果系统未安装 `ffmpeg`，`whisperx-local.py` 会对 wav 文件自动使用 `soundfile + scipy` fallback。

## 可选：WhisperX + FunASR/CAM++ 混合只读探针

如果 pyannote 权限或下载链路不可用，可以先验证混合路线：

- WhisperX / Whisper 负责高质量转写。
- FunASR + CAM++ 负责本地 speaker 时间段。
- `scripts/local-asr/hybrid-whisper-funasr.py` 按时间重叠把 speaker label 合并回主转写段。

先确保两个 runner 都存在：

```bash
test -x .local/asr/whisperx-runner.sh
test -x .local/asr/funasr-runner.sh
chmod +x scripts/local-asr/hybrid-whisper-funasr.py
```

直接用公开样本 smoke test：

```bash
mkdir -p .local/asr/external/pyannote
curl -L --fail https://files.pyannote.ai/marklex1min.wav \
  -o .local/asr/external/pyannote/marklex1min.wav

export HF_ENDPOINT=https://hf-mirror.com
export CLAWSENSE_ASR_MODEL=/Users/cedric/Documents/ClawSense/.local/asr/models/faster-whisper-tiny
export CLAWSENSE_ASR_LANGUAGE=en
export CLAWSENSE_WHISPERX_ALIGN=0
export CLAWSENSE_WHISPERX_DIARIZE=0
export CLAWSENSE_WHISPERX_BATCH_SIZE=8
export CLAWSENSE_HYBRID_ASR_COMMAND=/Users/cedric/Documents/ClawSense/.local/asr/whisperx-runner.sh
export CLAWSENSE_HYBRID_SPEAKER_COMMAND=/Users/cedric/Documents/ClawSense/.local/asr/funasr-runner.sh
export CLAWSENSE_HYBRID_FUNASR_MODEL=iic/SenseVoiceSmall
export CLAWSENSE_HYBRID_SPEAKER_LANGUAGE=en
export CLAWSENSE_HYBRID_SPEAKER_MODEL=cam++

scripts/local-asr/hybrid-whisper-funasr.py .local/asr/external/pyannote/marklex1min.wav
```

如果要让 OpenClaw 只读 probe 使用混合 wrapper：

```bash
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrBackend '"whisper"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrWhisperCommand '"/Users/cedric/Documents/ClawSense/scripts/local-asr/hybrid-whisper-funasr.py"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrWhisperModel '"/Users/cedric/Documents/ClawSense/.local/asr/models/faster-whisper-tiny"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrLanguage '"zh"' --strict-json
scripts/local-openclaw.sh setup

CLAWSENSE_HYBRID_ASR_COMMAND=/Users/cedric/Documents/ClawSense/.local/asr/whisperx-runner.sh \
CLAWSENSE_HYBRID_SPEAKER_COMMAND=/Users/cedric/Documents/ClawSense/.local/asr/funasr-runner.sh \
CLAWSENSE_HYBRID_FUNASR_MODEL=iic/SenseVoiceSmall \
scripts/local-openclaw.sh openclaw clawsense diarization-probe 2026-06-25 --provider hybrid --max 1
```

注意：`hybrid` 是过渡路线，优点是不依赖 pyannote gated 权限；缺点是 speaker label 来自另一个模型的时间段，长段落可能只有主导 speaker，而不是词级归属。

判断标准：

- `speakerReady=true`：WhisperX 路线进入下一轮真实写回评估。
- `diagnosis=asr-ok-speaker-missing`：ASR 成功但 speaker label 缺失，检查 `HF_TOKEN` / pyannote 条款 / 音频质量。
- `diagnosis=asr-failed`：先看 `items[].analysisFailureReason`，通常是依赖、模型下载、超时或 token 问题。

如果只读探针已经出现 `speakerReady=true`，再做小批量 dry-run：

```bash
scripts/local-openclaw.sh openclaw clawsense asr-worker run-once 2026-06-25 \
  --provider local-asr \
  --diarization-provider whisperx \
  --dry-run \
  --max 1 \
  --batch 1
```

只有当 dry-run 里的 `recentJobs[].transcriptSegmentCount` 和 speaker labels 都合理时，才做真实写回：

```bash
scripts/local-openclaw.sh openclaw clawsense asr-worker run-once 2026-06-25 \
  --provider local-asr \
  --diarization-provider whisperx \
  --max 1 \
  --batch 1
```

真实写回后，用普通聊天或 ClawSense context 检查“谁说了什么 / 哪些任务落到谁身上”的回答是否引用 speaker evidence。

## 回滚到 FunASR

```bash
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrBackend '"funasr"' --strict-json
scripts/local-openclaw.sh openclaw config set plugins.entries.clawsense.config.localAsrFunAsrCommand '"/Users/cedric/Documents/ClawSense/.local/asr/funasr-runner.sh"' --strict-json
scripts/local-openclaw.sh setup
```

## 记录结论

验证完成后，请把以下信息写入验证报告：

- 模型与设备：`localAsrWhisperModel`、CPU/GPU、是否设置 `HF_TOKEN`。
- 耗时：单条音频 clip 时长与总耗时。
- 输出：`speakerReady`、`diagnosis`、`transcriptSegmentCount`、`speakerSegmentCount`、`speakerLabels`。
- 产品判断：是否足以支撑“人物任务归属”进入内测默认路径。
