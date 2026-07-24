# WhisperX smoke validation - 2026-07-02

## Goal

Validate whether the local WhisperX environment can run on an existing ClawSense wav file before asking the user to re-record fresh meeting audio.

## Environment

- Repo: `/Users/cedric/Documents/ClawSense`
- Python env: `.local/asr/whisperx-venv`
- Runner: `.local/asr/whisperx-runner.sh`
- Test audio: `.local/openclaw/state/plugins/clawsense/media/2026/05/14/2304fpn6dc/205439-audio-9dc272fb-2c14-48fa-a145-5f6a722a62ba.wav`
- Model used for smoke test: `.local/asr/models/faster-whisper-tiny`

## What happened

1. `2026-06-25` cannot be used for WhisperX re-diarization in the repo-local runtime because the state has transcripts but the original wav files are missing.
2. `2026-05-14` has three orphan wav files on disk, but most state events still point at already-deleted source paths. Therefore the normal `diarization-probe <date>` path cannot select those orphan files automatically.
3. Direct runner validation was used on the smallest remaining wav.

## Fixes made during validation

1. `scripts/local-asr/whisperx-local.py` now defaults to `vad_method="silero"` to avoid PyTorch 2.6+ `weights_only` failures in the default Pyannote VAD checkpoint path.
2. `scripts/local-asr/whisperx-local.py` now supports `CLAWSENSE_WHISPERX_ALIGN=0` so low-resource smoke tests can skip slow wav2vec2 alignment.
3. `scripts/local-asr/whisperx-local.py` now falls back to `soundfile + scipy` wav loading when system `ffmpeg` is not installed.
4. Current WhisperX version requires `DiarizationPipeline` from `whisperx.diarize`; the wrapper now imports it from there instead of expecting `whisperx.DiarizationPipeline`.

## Results

### ASR-only

Command shape:

```bash
export CLAWSENSE_ASR_MODEL=/Users/cedric/Documents/ClawSense/.local/asr/models/faster-whisper-tiny
export CLAWSENSE_ASR_LANGUAGE=zh
export CLAWSENSE_WHISPERX_DIARIZE=0
export CLAWSENSE_WHISPERX_ALIGN=0
.local/asr/whisperx-runner.sh <wav>
```

Result:

```json
{
  "language": "zh",
  "transcriptLen": 7,
  "transcriptPreview": "他还缺哪部分呢",
  "segments": 1,
  "speakerLabels": []
}
```

Conclusion: WhisperX ASR can run locally when the faster-whisper model is available as a local directory.

### Public web audio validation

The user had no fresh local meeting material available, so public audio was used to keep validation moving.

Sources:

- Pyannote tutorial sample: `https://files.pyannote.ai/marklex1min.wav`
- Pyannote tutorial page: `https://pyannote.github.io/pyannote-audio/tutorials/applying_a_pipeline.html`
- TorchAudio VOiCES sample: `https://pytorch-tutorial-assets.s3.amazonaws.com/VOiCES_devkit/source-16k/train/sp0307/Lab41-SRI-VOiCES-src-sp0307-ch127535-sg0042.wav`
- TorchAudio tutorial page: `https://docs.pytorch.org/audio/stable/tutorials/audio_io_tutorial.html`

Downloaded files:

```text
.local/asr/external/pyannote/marklex1min.wav
.local/asr/external/torchaudio/voices-speech.wav
```

#### WhisperX ASR on pyannote two-speaker sample

Command shape:

```bash
export HF_ENDPOINT=https://hf-mirror.com
export CLAWSENSE_ASR_MODEL=/Users/cedric/Documents/ClawSense/.local/asr/models/faster-whisper-tiny
export CLAWSENSE_ASR_LANGUAGE=en
export CLAWSENSE_WHISPERX_DIARIZE=0
export CLAWSENSE_WHISPERX_ALIGN=0
export CLAWSENSE_WHISPERX_BATCH_SIZE=8
.local/asr/whisperx-runner.sh .local/asr/external/pyannote/marklex1min.wav
```

Result:

```json
{
  "language": "en",
  "transcriptLen": 1032,
  "transcriptPreview": "Let me ask you about AI. It seems like this year for the entirety of the human civilization is an interesting year for the development of artificial intelligence...",
  "segments": 3,
  "speakerLabels": []
}
```

Conclusion: WhisperX ASR works on a public 79s two-speaker style sample. This validates the public-audio smoke path and the `soundfile + scipy` fallback when `ffmpeg` is absent.

#### WhisperX diarization on pyannote sample

Command shape:

```bash
source .local/asr/hf-token.env
export HF_ENDPOINT=https://hf-mirror.com
export CLAWSENSE_ASR_MODEL=/Users/cedric/Documents/ClawSense/.local/asr/models/faster-whisper-tiny
export CLAWSENSE_ASR_LANGUAGE=en
export CLAWSENSE_DIARIZATION_PROVIDER=whisperx
export CLAWSENSE_WHISPERX_ALIGN=0
export CLAWSENSE_WHISPERX_BATCH_SIZE=8
.local/asr/whisperx-runner.sh .local/asr/external/pyannote/marklex1min.wav
```

Result:

```json
{
  "language": "en",
  "transcriptLen": 1032,
  "segments": 3,
  "speakerLabels": []
}
```

Stderr signal:

```text
[clawsense-whisperx] diarization pipeline unavailable: An error happened while trying to locate the file on the Hub and we cannot find the requested files in the local cache.
```

Additional gated-model check:

```text
pyannote/speaker-diarization-3.1 config via hf-mirror: HTTP 403
```

Conclusion: WhisperX degrades correctly to ASR-only when pyannote diarization cannot load. The remaining blocker is pyannote model access/download, not ClawSense JSON parsing.

#### FunASR + CAM++ on pyannote sample

Command shape:

```bash
CLAWSENSE_ASR_LANGUAGE=en CLAWSENSE_FUNASR_SPK_MODEL=cam++ \
  .local/asr/funasr-runner.sh .local/asr/external/pyannote/marklex1min.wav
```

Result:

```json
{
  "transcriptLen": 1346,
  "segments": 19,
  "speakerLabels": ["1", "2"]
}
```

Conclusion: FunASR/CAM++ can produce local speaker labels without pyannote gated access. However, English transcript quality was poor in this run, so this is evidence for a local speaker-label outlet, not evidence that FunASR should be the global default for English ASR.

#### Hybrid WhisperX + FunASR/CAM++ on pyannote sample

Command shape:

```bash
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

Result:

```json
{
  "language": "en",
  "transcriptLen": 1032,
  "segments": 3,
  "speakerLabels": ["1", "2"],
  "assignedSpeakerSegmentCount": 3,
  "hybrid": {
    "primary": "whisper",
    "speaker": "funasr:cam++",
    "primarySegmentCount": 3,
    "speakerSegmentCount": 19,
    "assignedSpeakerSegmentCount": 3,
    "speakerLabels": ["1", "2"]
  }
}
```

Conclusion: the hybrid route keeps the better WhisperX transcript while adding local FunASR/CAM++ speaker labels. This is the current best open-source default candidate when pyannote access is unavailable.

Follow-up fix:

- Numeric speaker ids are now normalized into `speaker_N`.
- Both zero-based labels (`0/1`) and one-based labels (`1/2`) are supported.
- Re-run result: `speakerLabels=["speaker_1","speaker_2"]`, `assignedSpeakerSegmentCount=3`.

Detailed public-sample validation is tracked in `docs/validation/local-asr-public-sample-validation-2026-07-02.md`.

#### Chinese public sample check

Sources:

- Open Speech Repository Mandarin: `https://www.voiptroubleshooter.com/open_speech/chinese.html`
- AISHELL-3 demo: `https://sos1sos2sixteen.github.io/aishell3/`

Result on `.local/asr/external/combined-zh-osr-aishell.wav`:

```json
{
  "transcriptLen": 192,
  "segments": 1,
  "speakerLabels": ["speaker_1"]
}
```

Conclusion: FunASR/SenseVoice can produce a clean Chinese transcript locally. This synthetic public sample is not a valid multi-speaker diarization proof because CAM++ treated it as a single speaker.

#### WhisperX ASR on TorchAudio VOiCES sample

Command shape:

```bash
export HF_ENDPOINT=https://hf-mirror.com
export CLAWSENSE_ASR_MODEL=/Users/cedric/Documents/ClawSense/.local/asr/models/faster-whisper-tiny
export CLAWSENSE_ASR_LANGUAGE=en
export CLAWSENSE_WHISPERX_DIARIZE=0
export CLAWSENSE_WHISPERX_ALIGN=0
.local/asr/whisperx-runner.sh .local/asr/external/torchaudio/voices-speech.wav
```

Result:

```json
{
  "language": "en",
  "transcriptLen": 46,
  "transcriptPreview": "I had that curiosity beside me at this moment.",
  "segments": 1,
  "speakerLabels": []
}
```

Conclusion: WhisperX ASR also works on a small public single-speaker baseline sample.

### Diarization

Command shape:

```bash
export HF_ENDPOINT=https://hf-mirror.com
export CLAWSENSE_ASR_MODEL=/Users/cedric/Documents/ClawSense/.local/asr/models/faster-whisper-tiny
export CLAWSENSE_ASR_LANGUAGE=zh
export CLAWSENSE_DIARIZATION_PROVIDER=whisperx
export CLAWSENSE_WHISPERX_ALIGN=0
.local/asr/whisperx-runner.sh <wav>
```

Result:

- ASR still succeeded.
- Speaker labels were not produced.
- `pyannote/speaker-diarization-3.1` config download returned `403` with: `not in the authorized list`.

Conclusion: the current token/account has not been authorized for the gated pyannote speaker diarization model. The user must accept the model terms, then retry.

## Restored state

After the smoke test, repo-local ClawSense ASR config was restored to:

- `localAsrBackend=funasr`
- `localAsrFunAsrCommand=/Users/cedric/Documents/ClawSense/.local/asr/funasr-runner.sh`
- `localAsrFunAsrModel=iic/SenseVoiceSmall`

`scripts/local-openclaw.sh openclaw clawsense asr-status` reports `local-asr:funasr:zh` ready.

## Next

1. User should accept access for `pyannote/speaker-diarization-3.1` on Hugging Face, and likely revoke the previously pasted token.
2. Re-run WhisperX diarization on a fresh short audio clip that is still present on disk.
3. If speaker labels appear, run `asr-worker run-once <date> --provider local-asr --diarization-provider whisperx --dry-run --max 1 --batch 1`.
