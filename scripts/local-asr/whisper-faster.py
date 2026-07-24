#!/usr/bin/env python3
"""ClawSense local ASR wrapper for faster-whisper.

Install example:
  python3 -m pip install faster-whisper

OpenClaw config example:
  localAsrBackend = "whisper"
  localAsrWhisperCommand = "/path/to/ClawSense/scripts/local-asr/whisper-faster.py"
  localAsrWhisperModel = "small"

The script prints a compact JSON object that ClawSense can parse directly.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any


def main() -> int:
    audio_path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CLAWSENSE_ASR_INPUT", "")
    if not audio_path:
        raise SystemExit("missing audio path")

    from faster_whisper import WhisperModel  # type: ignore

    model_name = (
        os.environ.get("CLAWSENSE_WHISPER_MODEL")
        or os.environ.get("CLAWSENSE_ASR_MODEL")
        or "base"
    )
    language = os.environ.get("CLAWSENSE_ASR_LANGUAGE") or None
    if language == "auto":
        language = None
    device = os.environ.get("CLAWSENSE_WHISPER_DEVICE", "auto")
    compute_type = os.environ.get("CLAWSENSE_WHISPER_COMPUTE_TYPE", "int8")

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
    )

    segments: list[dict[str, Any]] = []
    for segment in segments_iter:
        text = (segment.text or "").strip()
        if not text:
            continue
        segments.append(
            {
                "startMs": round(float(segment.start) * 1000),
                "endMs": round(float(segment.end) * 1000),
                "text": text,
            }
        )

    transcript = " ".join(item["text"] for item in segments).strip()
    print(
        json.dumps(
            {
                "language": getattr(info, "language", None),
                "transcript": transcript,
                "segments": segments,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
