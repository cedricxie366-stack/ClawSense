#!/usr/bin/env python3
"""ClawSense local ASR + speaker diarization wrapper for WhisperX.

Install example:
  python3 -m pip install whisperx

Optional diarization needs a Hugging Face token accepted for pyannote models:
  export HF_TOKEN=hf_...

OpenClaw config example:
  localAsrBackend = "whisper"
  localAsrWhisperCommand = "/path/to/ClawSense/scripts/local-asr/whisperx-local.py"
  localAsrWhisperModel = "small"

The script prints JSON with transcript + segments. When diarization succeeds,
segments include speakerLabel values such as SPEAKER_00.
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import redirect_stdout
from typing import Any


def main() -> int:
    batch_manifest = read_batch_manifest_arg()
    audio_path = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else os.environ.get("CLAWSENSE_ASR_INPUT", "")
    if not audio_path and not batch_manifest:
        raise SystemExit("missing audio path")

    with redirect_stdout(sys.stderr):
        import whisperx  # type: ignore

    settings = read_settings()
    with redirect_stdout(sys.stderr):
        model = whisperx.load_model(
            settings["model_name"],
            settings["device"],
            compute_type=settings["compute_type"],
            language=settings["language"],
            vad_method=settings["vad_method"],
        )

    align_cache: dict[str, Any] = {}
    diarize_model = None
    if settings["diarize"]:
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("PYANNOTE_AUTH_TOKEN")
        if token:
            try:
                with redirect_stdout(sys.stderr):
                    from whisperx.diarize import DiarizationPipeline  # type: ignore

                    diarize_model = DiarizationPipeline(
                        use_auth_token=token,
                        device=settings["device"],
                    )
            except Exception as exc:  # noqa: BLE001 - wrapper should degrade to ASR-only.
                print(f"[clawsense-whisperx] diarization pipeline unavailable: {exc}", file=sys.stderr)
        else:
            print("[clawsense-whisperx] HF_TOKEN missing; running ASR without speaker labels", file=sys.stderr)

    if batch_manifest:
        payload = run_batch(
            whisperx,
            model,
            align_cache,
            diarize_model,
            batch_manifest,
            settings,
        )
    else:
        payload = transcribe_one(
            whisperx,
            model,
            align_cache,
            diarize_model,
            audio_path,
            settings,
        )
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def read_settings() -> dict[str, Any]:
    language = os.environ.get("CLAWSENSE_ASR_LANGUAGE") or None
    if language == "auto":
        language = None
    diarization_provider = (os.environ.get("CLAWSENSE_DIARIZATION_PROVIDER") or "").strip().lower()
    explicit_diarize = os.environ.get("CLAWSENSE_WHISPERX_DIARIZE")
    diarize = (
        explicit_diarize != "0"
        if explicit_diarize is not None
        else diarization_provider in {"whisperx", "pyannote"}
    )
    return {
        "model_name": (
            os.environ.get("CLAWSENSE_WHISPERX_MODEL")
            or os.environ.get("CLAWSENSE_WHISPER_MODEL")
            or os.environ.get("CLAWSENSE_ASR_MODEL")
            or "small"
        ),
        "language": language,
        "device": os.environ.get("CLAWSENSE_WHISPERX_DEVICE") or os.environ.get("CLAWSENSE_WHISPER_DEVICE") or "cpu",
        "compute_type": os.environ.get("CLAWSENSE_WHISPERX_COMPUTE_TYPE") or os.environ.get("CLAWSENSE_WHISPER_COMPUTE_TYPE") or "int8",
        "batch_size": int(os.environ.get("CLAWSENSE_WHISPERX_BATCH_SIZE") or "16"),
        "vad_method": os.environ.get("CLAWSENSE_WHISPERX_VAD_METHOD") or "silero",
        "align": (os.environ.get("CLAWSENSE_WHISPERX_ALIGN") or "1") != "0",
        "diarize": diarize,
    }


def read_batch_manifest_arg() -> str | None:
    for index, arg in enumerate(sys.argv[1:], start=1):
        if arg == "--batch-json":
            if index + 1 >= len(sys.argv):
                raise SystemExit("--batch-json requires a manifest path")
            return sys.argv[index + 1]
        if arg.startswith("--batch-json="):
            return arg.split("=", 1)[1]
    return os.environ.get("CLAWSENSE_ASR_BATCH_MANIFEST") or None


def run_batch(
    whisperx: Any,
    model: Any,
    align_cache: dict[str, Any],
    diarize_model: Any,
    manifest_path: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    raw_items = manifest.get("items") if isinstance(manifest, dict) else manifest
    if not isinstance(raw_items, list):
        raise SystemExit("batch manifest must contain an items array")
    results: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            continue
        item_id = str(raw.get("id") or raw.get("itemId") or index)
        item_path = str(raw.get("path") or raw.get("filePath") or raw.get("audioPath") or "")
        if not item_path:
            results.append({"id": item_id, "error": "query_time_local_asr_input_missing"})
            continue
        try:
            item_payload = transcribe_one(
                whisperx,
                model,
                align_cache,
                diarize_model,
                item_path,
                settings,
            )
            item_payload["id"] = item_id
            results.append(item_payload)
        except Exception as exc:  # noqa: BLE001 - isolate per-file failures.
            results.append({"id": item_id, "error": f"query_time_local_asr_error:{exc}"})
    return {"results": results}


def transcribe_one(
    whisperx: Any,
    model: Any,
    align_cache: dict[str, Any],
    diarize_model: Any,
    audio_path: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    with redirect_stdout(sys.stderr):
        audio = load_audio_for_whisperx(whisperx, audio_path)
        result = model.transcribe(audio, batch_size=settings["batch_size"], language=settings["language"])
    language = str(result.get("language") or settings["language"] or "")

    if language and settings["align"]:
        try:
            aligned = align_result(whisperx, result, audio, language, settings, align_cache)
            if aligned:
                result = aligned
        except Exception as exc:  # noqa: BLE001 - alignment is valuable but not mandatory.
            print(f"[clawsense-whisperx] alignment failed: {exc}", file=sys.stderr)

    if diarize_model is not None:
        try:
            with redirect_stdout(sys.stderr):
                diarize_segments = diarize_model(audio)
                result = whisperx.assign_word_speakers(diarize_segments, result)
        except Exception as exc:  # noqa: BLE001 - keep ASR output if diarization fails.
            print(f"[clawsense-whisperx] diarization failed: {exc}", file=sys.stderr)

    return normalize_whisperx_result(result, language)


def load_audio_for_whisperx(whisperx: Any, audio_path: str) -> Any:
    try:
        return whisperx.load_audio(audio_path)
    except FileNotFoundError as exc:
        if getattr(exc, "filename", "") != "ffmpeg":
            raise
        print("[clawsense-whisperx] ffmpeg missing; using soundfile wav fallback", file=sys.stderr)

    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore
    from scipy.signal import resample_poly  # type: ignore

    data, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    target_rate = 16000
    if sample_rate != target_rate:
        from math import gcd

        common = gcd(sample_rate, target_rate)
        mono = resample_poly(mono, target_rate // common, sample_rate // common).astype("float32")
    return np.asarray(mono, dtype="float32")


def align_result(
    whisperx: Any,
    result: dict[str, Any],
    audio: Any,
    language: str,
    settings: dict[str, Any],
    align_cache: dict[str, Any],
) -> dict[str, Any] | None:
    if language not in align_cache:
        with redirect_stdout(sys.stderr):
            align_cache[language] = whisperx.load_align_model(
                language_code=language,
                device=settings["device"],
            )
    model_a, metadata = align_cache[language]
    with redirect_stdout(sys.stderr):
        return whisperx.align(
            result.get("segments") or [],
            model_a,
            metadata,
            audio,
            settings["device"],
            return_char_alignments=False,
        )


def normalize_whisperx_result(result: dict[str, Any], language: str) -> dict[str, Any]:
    raw_segments = result.get("segments") or []
    segments: list[dict[str, Any]] = []
    if isinstance(raw_segments, list):
        for raw in raw_segments:
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("text") or "").strip()
            if not text:
                continue
            segment: dict[str, Any] = {"text": text}
            if raw.get("start") is not None:
                segment["startMs"] = round(float(raw["start"]) * 1000)
            if raw.get("end") is not None:
                segment["endMs"] = round(float(raw["end"]) * 1000)
            speaker = raw.get("speaker") or raw.get("speakerLabel")
            if speaker is not None:
                segment["speakerLabel"] = str(speaker)
            segments.append(segment)
    transcript = " ".join(segment["text"] for segment in segments).strip()
    return {
        "language": language or None,
        "transcript": transcript,
        "segments": segments,
    }


if __name__ == "__main__":
    raise SystemExit(main())
