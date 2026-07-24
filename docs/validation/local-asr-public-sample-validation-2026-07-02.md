# Local ASR public sample validation - 2026-07-02

## Goal

Use public audio samples to validate the current local ASR / diarization direction without waiting for fresh private meeting recordings.

The target product question is:

- Can ClawSense run a free/local transcript path?
- Can it attach stable `speaker_N` labels without requiring paid cloud ASR?
- Which sample types are valid evidence, and which ones should not be over-interpreted?

## Sources

- Pyannote tutorial two-speaker style sample: `https://files.pyannote.ai/marklex1min.wav`
- Pyannote tutorial page: `https://pyannote.github.io/pyannote-audio/tutorials/applying_a_pipeline.html`
- Open Speech Repository Mandarin samples: `https://www.voiptroubleshooter.com/open_speech/chinese.html`
- AISHELL-3 demo samples: `https://sos1sos2sixteen.github.io/aishell3/`
- RingCentral sample file page checked for future samples: `https://developers.ringcentral.com/guide/ai/sample-files`
- AMI corpus full meeting mirror: `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2004a.Mix-Headset.wav`
- AliMeeting derived public sample: `https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test`

Downloaded local files:

```text
.local/asr/external/pyannote/marklex1min.wav
.local/asr/external/osr-chinese/OSR_cn_000_0072_8k.wav
.local/asr/external/osr-chinese/OSR_cn_000_0073_8k.wav
.local/asr/external/osr-chinese/OSR_cn_000_0074_8k.wav
.local/asr/external/osr-chinese/OSR_cn_000_0075_8k.wav
.local/asr/external/aishell3/raw/raw1.wav
.local/asr/external/aishell3/raw/raw2.wav
.local/asr/external/aishell3/raw/raw3.wav
.local/asr/external/combined-zh-osr-aishell.wav
.local/asr/external/ami-full/ES2004a.Mix-Headset.wav
.local/asr/external/ami-full/ES2004a.Mix-Headset.60-360s.wav
.local/asr/external/alimeeting/R8002_M8002.near.rttm
.local/asr/external/alimeeting/R8002_M8002_MS802.far-mono.120s.wav
```

`combined-zh-osr-aishell.wav` is a local synthetic validation file built from OSR Mandarin and AISHELL-3 demo clips with short silences inserted. It is useful for transcript and wrapper checks, but it is not a strong proof of real multi-speaker diarization.

## Results

### Hybrid WhisperX + FunASR/CAM++ on pyannote sample

Command shape:

```bash
export HF_ENDPOINT=https://hf-mirror.com
export CLAWSENSE_ASR_MODEL="$PWD/.local/asr/models/faster-whisper-tiny"
export CLAWSENSE_ASR_LANGUAGE=en
export CLAWSENSE_WHISPERX_ALIGN=0
export CLAWSENSE_WHISPERX_DIARIZE=0
export CLAWSENSE_HYBRID_ASR_COMMAND="$PWD/.local/asr/whisperx-runner.sh"
export CLAWSENSE_HYBRID_SPEAKER_COMMAND="$PWD/.local/asr/funasr-runner.sh"
export CLAWSENSE_HYBRID_FUNASR_MODEL=iic/SenseVoiceSmall
export CLAWSENSE_HYBRID_SPEAKER_LANGUAGE=en
export CLAWSENSE_HYBRID_SPEAKER_MODEL=cam++
scripts/local-asr/hybrid-whisper-funasr.py .local/asr/external/pyannote/marklex1min.wav
```

Summary:

```json
{
  "language": "en",
  "transcriptLen": 1032,
  "segments": 3,
  "speakerLabels": ["speaker_1", "speaker_2"],
  "assignedSpeakerSegmentCount": 3
}
```

Conclusion:

- This is the strongest current free/local route when pyannote access is blocked.
- WhisperX keeps the better English transcript.
- FunASR/CAM++ contributes local speaker timeline evidence.
- Speaker labels are normalized to `speaker_1`, `speaker_2`, etc., so user annotations can attach consistently.

### FunASR + CAM++ on Chinese public sample

Command shape:

```bash
export CLAWSENSE_ASR_LANGUAGE=zh
export CLAWSENSE_FUNASR_SPK_MODEL=cam++
export CLAWSENSE_FUNASR_PUNC_MODEL=none
.local/asr/funasr-runner.sh .local/asr/external/combined-zh-osr-aishell.wav
```

Summary:

```json
{
  "transcriptLen": 192,
  "segments": 1,
  "speakerLabels": ["speaker_1"]
}
```

Conclusion:

- Chinese local ASR runs and produces a clean transcript after SenseVoice tag cleanup.
- The sample is treated as one speaker by CAM++ in this setup.
- Therefore this sample validates Chinese transcript plumbing and wrapper cleanliness, but it does not validate Chinese multi-speaker diarization.

### AMI short meeting clip

Local file:

```text
.local/asr/external/ami/ES2004a.Mix-Headset.wav
```

Summary:

```json
{
  "durationSec": 22.91,
  "transcriptLen": 92,
  "segments": 1,
  "speakerLabels": []
}
```

Conclusion:

- This 23-second AMI clip is too short / sparse for the current CAM++ route to produce useful speaker labels.
- It should not be used as the main diarization acceptance sample.

### AMI 5-minute meeting clip

Local file:

```text
.local/asr/external/ami-full/ES2004a.Mix-Headset.60-360s.wav
```

Source:

```text
https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/HeadsetAudio/ES2004a.Mix-Headset.wav
```

Clip shape:

```json
{
  "durationSec": 300,
  "samplerate": 16000,
  "channels": 1
}
```

Initial hybrid result:

```json
{
  "transcriptLen": 2136,
  "segments": 8,
  "speakerLabels": [],
  "speakerSegmentCount": 0
}
```

Failure signal:

```text
WARNING:root:length mismatch between punc and timestamp
[clawsense-funasr] speaker diarization failed because timestamps are incomplete; retrying ASR without speaker labels
```

Direct FunASR retry with `CLAWSENSE_FUNASR_PUNC_MODEL=none`:

```json
{
  "transcriptLen": 2178,
  "segments": 19,
  "speakerLabels": ["speaker_1", "speaker_2", "speaker_3"]
}
```

Final hybrid result after automatic no-punc speaker retry:

```json
{
  "language": "en",
  "transcriptLen": 2136,
  "segments": 8,
  "speakerLabels": ["speaker_2", "speaker_3"],
  "assignedSpeakerSegmentCount": 8,
  "primarySegmentCount": 8,
  "speakerSegmentCount": 19
}
```

Evidence v2 rerun after preserving speaker timeline as first-class output:

```json
{
  "file": ".local/asr/results/evidence-v2-ami-hybrid-20260703-033013.json",
  "transcriptLen": 2118,
  "segmentCount": 56,
  "speakerTimelineSegmentCount": 19,
  "speakerTimelineLabels": ["speaker_1", "speaker_2", "speaker_3"],
  "mergedSpeakerLabels": ["speaker_2", "speaker_1", "speaker_3"],
  "hybrid": {
    "primary": "whisper",
    "speaker": "funasr:cam++",
    "primarySegmentCount": 56,
    "speakerSegmentCount": 19,
    "assignedSpeakerSegmentCount": 56,
    "speakerLabels": ["speaker_1", "speaker_2", "speaker_3"],
    "speakerTimelineLabels": ["speaker_1", "speaker_2", "speaker_3"]
  }
}
```

Conclusion:

- The 5-minute AMI meeting sample validates that the hybrid route can handle a longer public meeting clip.
- WhisperX/faster-whisper produced a usable meeting transcript.
- FunASR/CAM++ produced a local speaker timeline after disabling punc in the speaker-only retry path.
- Current Evidence v2 preserves both merged primary transcript segments and the raw speaker timeline. This keeps global transcript readability while giving review/query code access to finer speaker evidence.

### AliMeeting 120-second Chinese far-field meeting clip

Metadata command:

```bash
npm run check:public-zh-meeting
```

Prepared clip / ASR commands:

```bash
CLAWSENSE_PUBLIC_ZH_MEETING_PREPARE_CLIP=1 npm run check:public-zh-meeting
CLAWSENSE_PUBLIC_ZH_MEETING_RUN_ASR=1 npm run check:public-zh-meeting
```

Sample shape:

```json
{
  "rttmLineCount": 866,
  "rttmSpeakerCount": 4,
  "farWavBytes": 529029200,
  "preparedClip": {
    "durationSec": 120,
    "sampleRate": 16000,
    "channels": 1
  }
}
```

FunASR-primary hybrid result:

```json
{
  "primary": "funasr",
  "transcriptLength": 651,
  "segmentCount": 7,
  "speakerTimelineSegmentCount": 7,
  "speakerLabels": ["speaker_1", "speaker_2", "speaker_3", "speaker_4", "speaker_5"],
  "assignedSpeakerSegmentCount": 7
}
```

Conclusion:

- Chinese meeting clips should not default to Whisper tiny primary transcript; FunASR / SenseVoice produced a more natural Chinese transcript on this far-field sample.
- The hybrid wrapper now supports FunASR as primary while still preserving CAM++ speaker timeline.
- This is an optional deep check, not a default release gate, because the source meeting WAV is large.

## Fixes made

- `scripts/local-asr/funasr-local.py`
  - Preserves `spk: 0` instead of dropping it as a falsy value.
  - Normalizes numeric speakers into `speaker_N`.
  - Supports both zero-based (`0/1`) and one-based (`1/2`) speaker ids.
  - Cleans SenseVoice control tags in raw runner JSON.
- `scripts/local-asr/hybrid-whisper-funasr.py`
  - Normalizes child speaker ids into `speaker_N`.
  - Preserves zero-based speaker labels.
  - Retries the speaker timeline pass with `CLAWSENSE_FUNASR_PUNC_MODEL=none` when the first FunASR/CAM++ speaker pass returns no labels.
  - Exposes `speakerTimelineSegments` and `hybrid.speakerTimelineLabels` for diagnostics and downstream evidence consumption.
  - Supports FunASR as primary ASR for Chinese meeting deep checks by enabling sentence timestamps and CAM++ when the primary command is a FunASR runner.
  - Ignores empty `segments=[]` when `sentence_info` is non-empty, so FunASR primary output keeps transcript segments.
- `src/local-asr.ts`
  - Normalizes local ASR speaker labels before writing transcript segments into ClawSense attempts.
  - Parses `speakerTimelineSegments` / `speaker_timeline_segments` / `speakerTimeline` / `speaker_timeline`.

## Current recommendation

For near-term open-source local ASR:

1. Global / English-first users: use Whisper or WhisperX for transcript.
2. Chinese-first users: use FunASR / SenseVoice for transcript.
3. If pyannote gated access is unavailable: use `hybrid` for transcript + local speaker labels; for Chinese, prefer FunASR-primary hybrid rather than Whisper-tiny-primary hybrid.
4. Treat speaker labels as helpful but probabilistic until validated on real user recordings.

## Next validation target

Use a real or public 5-15 minute meeting/conversation sample with:

- at least two speakers,
- clear turn-taking,
- source wav retained on disk,
- expected high-level topic known by the tester.

Acceptance should check:

- transcript completeness,
- speaker label stability,
- whether "what tasks were assigned to me?" improves after user marks `speaker_1` / `speaker_2`.

The next implementation target is to preserve the speaker timeline in ClawSense state/review evidence, instead of only exposing it in wrapper diagnostics or collapsing it into dominant-speaker labels on long Whisper segments.
