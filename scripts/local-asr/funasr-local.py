#!/usr/bin/env python3
"""ClawSense local ASR wrapper for FunASR / SenseVoice.

Install example:
  python3 -m pip install funasr modelscope

OpenClaw config example:
  localAsrBackend = "funasr"
  localAsrFunAsrCommand = "/path/to/ClawSense/scripts/local-asr/funasr-local.py"
  localAsrFunAsrModel = "iic/SenseVoiceSmall"

Optional speaker diarization:
  export CLAWSENSE_FUNASR_SPK_MODEL=cam++

The script prints JSON with transcript + sentence_info-like segments.
"""

from __future__ import annotations

import json
import os
import re
import sys
from contextlib import redirect_stdout
from typing import Any


def main() -> int:
    batch_manifest = read_batch_manifest_arg()
    audio_path = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else os.environ.get("CLAWSENSE_ASR_INPUT", "")
    if not audio_path and not batch_manifest:
        raise SystemExit("missing audio path")

    with redirect_stdout(sys.stderr):
        from funasr import AutoModel  # type: ignore

    model_name = (
        os.environ.get("CLAWSENSE_FUNASR_MODEL")
        or os.environ.get("CLAWSENSE_ASR_MODEL")
        or "iic/SenseVoiceSmall"
    )
    language = os.environ.get("CLAWSENSE_ASR_LANGUAGE") or "auto"
    device = os.environ.get("CLAWSENSE_FUNASR_DEVICE", "cpu")
    vad_model = optional_model_env("CLAWSENSE_FUNASR_VAD_MODEL", "fsmn-vad")
    punc_model = optional_model_env("CLAWSENSE_FUNASR_PUNC_MODEL", "ct-punc")
    spk_model = os.environ.get("CLAWSENSE_FUNASR_SPK_MODEL") or None
    sentence_timestamp = os.environ.get("CLAWSENSE_FUNASR_SENTENCE_TIMESTAMP", "1") != "0"

    model_kwargs: dict[str, Any] = {
        "model": model_name,
        "device": device,
        "disable_update": True,
    }
    if vad_model:
        model_kwargs["vad_model"] = vad_model
    if punc_model:
        model_kwargs["punc_model"] = punc_model
    if spk_model:
        model_kwargs["spk_model"] = spk_model

    with redirect_stdout(sys.stderr):
        model = AutoModel(**model_kwargs)

    if batch_manifest:
        payload = run_batch(
            model,
            batch_manifest,
            language=language,
            sentence_timestamp=sentence_timestamp,
            return_spk_res=bool(spk_model),
        )
    else:
        payload = transcribe_one(
            model,
            audio_path,
            language=language,
            sentence_timestamp=sentence_timestamp,
            return_spk_res=bool(spk_model),
        )
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def optional_model_env(name: str, default: str | None) -> str | None:
    raw = os.environ.get(name)
    value = default if raw is None else raw.strip()
    if not value or value.lower() in {"0", "false", "off", "none", "null", "disabled"}:
        return None
    return value


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
    model: Any,
    manifest_path: str,
    *,
    language: str,
    sentence_timestamp: bool,
    return_spk_res: bool,
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
                model,
                item_path,
                language=language,
                sentence_timestamp=sentence_timestamp,
                return_spk_res=return_spk_res,
            )
            item_payload["id"] = item_id
            results.append(item_payload)
        except Exception as exc:  # noqa: BLE001 - wrapper must isolate per-file failures.
            results.append({"id": item_id, "error": f"query_time_local_asr_error:{exc}"})
    return {"results": results}


def transcribe_one(
    model: Any,
    audio_path: str,
    *,
    language: str,
    sentence_timestamp: bool,
    return_spk_res: bool,
) -> dict[str, Any]:
    with redirect_stdout(sys.stderr):
        result = generate_with_retries(
            model,
            audio_path,
            language=language,
            sentence_timestamp=sentence_timestamp,
            return_spk_res=return_spk_res,
        )
    return normalize_funasr_result(result)


def generate_with_retries(
    model: Any,
    audio_path: str,
    *,
    language: str,
    sentence_timestamp: bool,
    return_spk_res: bool,
) -> Any:
    try:
        return generate_with_model(
            model,
            audio_path,
            language=language,
            sentence_timestamp=sentence_timestamp,
            return_spk_res=return_spk_res,
        )
    except KeyError as exc:
        if not (sentence_timestamp and str(exc).strip("'\"") == "timestamp"):
            raise
        print(
            "[clawsense-funasr] sentence_timestamp unavailable for this model; retrying without it",
            file=sys.stderr,
        )
        return generate_with_retries(
            model,
            audio_path,
            language=language,
            sentence_timestamp=False,
            return_spk_res=return_spk_res,
        )
    except (TypeError, ValueError) as exc:
        if not (return_spk_res and looks_like_speaker_timestamp_error(exc)):
            raise
        print(
            "[clawsense-funasr] speaker diarization failed because timestamps are incomplete; retrying ASR without speaker labels",
            file=sys.stderr,
        )
        return generate_with_model(
            model,
            audio_path,
            language=language,
            sentence_timestamp=False,
            return_spk_res=False,
        )


def looks_like_speaker_timestamp_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "nonetype" in text or "timestamp" in text or "distribute_spk" in text


def generate_with_model(
    model: Any,
    audio_path: str,
    *,
    language: str,
    sentence_timestamp: bool,
    return_spk_res: bool,
) -> Any:
    return model.generate(
        input=audio_path,
        language=language,
        use_itn=True,
        batch_size_s=60,
        merge_vad=True,
        merge_length_s=15,
        sentence_timestamp=sentence_timestamp,
        return_spk_res=return_spk_res,
    )


def normalize_funasr_result(result: Any) -> dict[str, Any]:
    item: dict[str, Any]
    if isinstance(result, list) and result:
        item = result[0] if isinstance(result[0], dict) else {"text": str(result[0])}
    elif isinstance(result, dict):
        item = result
    else:
        item = {"text": str(result or "")}

    text = normalize_transcript_text(item.get("text") or item.get("transcript") or "")
    raw_sentences = item.get("sentence_info") or item.get("sentences") or item.get("segments") or []
    segments: list[dict[str, Any]] = []
    if isinstance(raw_sentences, list):
        zero_based_speakers = has_zero_based_speaker_labels(raw_sentences)
        for raw in raw_sentences:
            if not isinstance(raw, dict):
                continue
            segment_text = normalize_transcript_text(raw.get("text") or raw.get("sentence") or "")
            if not segment_text:
                continue
            segment: dict[str, Any] = {"text": segment_text}
            if "start" in raw:
                segment["startMs"] = raw.get("start")
            if "end" in raw:
                segment["endMs"] = raw.get("end")
            speaker = first_present(raw, "speakerLabel", "speaker", "spk", "speaker_id")
            if speaker is not None:
                segment["speakerLabel"] = normalize_speaker_label(speaker, zero_based=zero_based_speakers)
            segments.append(segment)

    if not text and segments:
        text = " ".join(segment["text"] for segment in segments).strip()
    return {
        "transcript": text,
        "segments": segments,
    }


def normalize_transcript_text(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"<\|[^|>]+\|>", "", text)
    text = re.sub(r"<\s*\|\s*[^|>]+\s*\|\s*>", "", text)
    return " ".join(text.split()).strip()


def first_present(obj: dict[str, Any], *keys: str) -> Any | None:
    for key in keys:
        if key in obj and obj.get(key) is not None:
            return obj.get(key)
    return None


def has_zero_based_speaker_labels(items: list[Any]) -> bool:
    for item in items:
        if not isinstance(item, dict):
            continue
        speaker = first_present(item, "speakerLabel", "speaker", "spk", "speaker_id")
        if speaker is not None and str(speaker).strip() == "0":
            return True
    return False


def normalize_speaker_label(value: Any, *, zero_based: bool) -> str:
    raw = str(value).strip()
    if raw.lower().startswith("speaker_"):
        return raw
    if raw.isdigit():
        speaker_index = int(raw) + 1 if zero_based else int(raw)
        return f"speaker_{max(1, speaker_index)}"
    return raw


if __name__ == "__main__":
    raise SystemExit(main())
