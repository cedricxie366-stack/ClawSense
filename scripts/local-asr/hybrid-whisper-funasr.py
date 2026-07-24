#!/usr/bin/env python3
"""Hybrid ClawSense ASR wrapper: Whisper/WhisperX transcript + FunASR/CAM++ speaker labels.

This wrapper is intentionally a thin local command. It can be configured as a
ClawSense local ASR command while keeping speaker diarization optional:

  localAsrBackend = "whisper"
  localAsrWhisperCommand = "/path/to/ClawSense/scripts/local-asr/hybrid-whisper-funasr.py"

Default child commands:

  scripts/local-asr/whisperx-local.py   # transcript source
  scripts/local-asr/funasr-local.py     # speaker timeline source

The output keeps the primary transcript text and assigns speakerLabel to each
primary segment by maximum time overlap with the speaker timeline.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


def main() -> int:
    batch_manifest = read_batch_manifest_arg()
    audio_path = (
        sys.argv[1]
        if len(sys.argv) > 1 and not sys.argv[1].startswith("--")
        else os.environ.get("CLAWSENSE_ASR_INPUT", "")
    )
    if not audio_path and not batch_manifest:
        raise SystemExit("missing audio path")

    if batch_manifest:
        payload = run_batch(batch_manifest)
    else:
        payload = transcribe_one(audio_path)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def read_batch_manifest_arg() -> str | None:
    for index, arg in enumerate(sys.argv[1:], start=1):
        if arg == "--batch-json":
            if index + 1 >= len(sys.argv):
                raise SystemExit("--batch-json requires a manifest path")
            return sys.argv[index + 1]
        if arg.startswith("--batch-json="):
            return arg.split("=", 1)[1]
    return os.environ.get("CLAWSENSE_ASR_BATCH_MANIFEST") or None


def run_batch(manifest_path: str) -> dict[str, Any]:
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
            item_payload = transcribe_one(item_path)
            item_payload["id"] = item_id
            results.append(item_payload)
        except Exception as exc:  # noqa: BLE001 - isolate per-file failures.
            results.append({"id": item_id, "error": f"query_time_local_asr_error:{exc}"})
    return {"results": results}


def transcribe_one(audio_path: str) -> dict[str, Any]:
    primary = run_primary_asr(audio_path)
    speaker = run_speaker_timeline(audio_path)
    return merge_primary_and_speaker(primary, speaker)


def run_primary_asr(audio_path: str) -> dict[str, Any]:
    env = dict(os.environ)
    env["CLAWSENSE_ASR_INPUT"] = audio_path
    env["CLAWSENSE_WHISPERX_DIARIZE"] = "0"
    env["CLAWSENSE_DIARIZATION_PROVIDER"] = ""
    command = resolve_command(
        "CLAWSENSE_HYBRID_ASR_COMMAND",
        "CLAWSENSE_HYBRID_WHISPER_COMMAND",
        default_script="whisperx-local.py",
    )
    if "funasr" in Path(command).name.lower():
        env["CLAWSENSE_FUNASR_SENTENCE_TIMESTAMP"] = env.get("CLAWSENSE_FUNASR_SENTENCE_TIMESTAMP") or "1"
        env["CLAWSENSE_FUNASR_SPK_MODEL"] = env.get("CLAWSENSE_FUNASR_SPK_MODEL") or env.get("CLAWSENSE_HYBRID_SPEAKER_MODEL") or "cam++"
        env["CLAWSENSE_FUNASR_MODEL"] = resolve_funasr_model(env)
        env["CLAWSENSE_ASR_MODEL"] = env["CLAWSENSE_FUNASR_MODEL"]
    payload = run_json_command(command, [audio_path], env, role="primary-asr")
    payload["_hybridPrimaryLabel"] = resolve_primary_label(command)
    return payload


def run_speaker_timeline(audio_path: str) -> dict[str, Any]:
    env = dict(os.environ)
    env["CLAWSENSE_ASR_INPUT"] = audio_path
    env["CLAWSENSE_FUNASR_SPK_MODEL"] = env.get("CLAWSENSE_HYBRID_SPEAKER_MODEL") or env.get("CLAWSENSE_FUNASR_SPK_MODEL") or "cam++"
    env["CLAWSENSE_FUNASR_SENTENCE_TIMESTAMP"] = env.get("CLAWSENSE_FUNASR_SENTENCE_TIMESTAMP") or "1"
    env["CLAWSENSE_FUNASR_MODEL"] = resolve_funasr_model(env)
    # Avoid passing a Whisper model directory as CLAWSENSE_ASR_MODEL into FunASR.
    env["CLAWSENSE_ASR_MODEL"] = env["CLAWSENSE_FUNASR_MODEL"]
    if env.get("CLAWSENSE_HYBRID_SPEAKER_LANGUAGE"):
        env["CLAWSENSE_ASR_LANGUAGE"] = env["CLAWSENSE_HYBRID_SPEAKER_LANGUAGE"]

    command = resolve_command(
        "CLAWSENSE_HYBRID_SPEAKER_COMMAND",
        "CLAWSENSE_HYBRID_FUNASR_COMMAND",
        default_script="funasr-local.py",
    )
    try:
        payload = run_json_command(command, [audio_path], env, role="speaker-timeline")
        if has_speaker_segments(payload) or env.get("CLAWSENSE_FUNASR_PUNC_MODEL"):
            return payload

        retry_env = dict(env)
        retry_env["CLAWSENSE_FUNASR_PUNC_MODEL"] = "none"
        print(
            "[clawsense-hybrid-asr] speaker timeline had no labels; retrying FunASR speaker pass without punc model",
            file=sys.stderr,
        )
        retry_payload = run_json_command(command, [audio_path], retry_env, role="speaker-timeline-nopunc")
        if has_speaker_segments(retry_payload):
            return retry_payload
        return payload
    except Exception as exc:  # noqa: BLE001 - speaker labels should not destroy ASR output.
        print(f"[clawsense-hybrid-asr] speaker timeline failed: {exc}", file=sys.stderr)
        return {"transcript": "", "segments": [], "hybridError": str(exc)}


def resolve_funasr_model(env: dict[str, str]) -> str:
    explicit = env.get("CLAWSENSE_HYBRID_FUNASR_MODEL")
    if explicit:
        return explicit
    inherited_funasr = env.get("CLAWSENSE_FUNASR_MODEL") or ""
    primary_model = env.get("CLAWSENSE_ASR_MODEL") or env.get("CLAWSENSE_WHISPER_MODEL") or ""
    # ClawSense command backends populate CLAWSENSE_FUNASR_MODEL even when the
    # active backend is Whisper. In that case the inherited value can be a
    # faster-whisper path, not a FunASR model.
    if inherited_funasr and inherited_funasr != primary_model:
        return inherited_funasr
    return "iic/SenseVoiceSmall"


def resolve_command(*env_names: str, default_script: str) -> str:
    for name in env_names:
        value = os.environ.get(name)
        if value:
            return value
    script_dir = Path(__file__).resolve().parent
    default_path = script_dir / default_script
    if default_path.resolve() == Path(__file__).resolve():
        raise RuntimeError("hybrid command resolved to itself")
    return str(default_path)


def run_json_command(command: str, args: list[str], env: dict[str, str], *, role: str) -> dict[str, Any]:
    resolved = Path(command).expanduser()
    cmd = [str(resolved), *args]
    proc = subprocess.run(
        cmd,
        env=env,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        raise RuntimeError(f"{role} command exited {proc.returncode}: {proc.stderr.strip()[:400]}")
    parsed = parse_json_output(proc.stdout)
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{role} command did not emit a JSON object")
    return parsed


def parse_json_output(stdout: str) -> Any:
    trimmed = stdout.strip()
    if not trimmed:
        return {}
    try:
        return json.loads(trimmed)
    except json.JSONDecodeError:
        pass
    for line in reversed([line.strip() for line in trimmed.splitlines() if line.strip()]):
        if (line.startswith("{") and line.endswith("}")) or (line.startswith("[") and line.endswith("]")):
            return json.loads(line)
    raise RuntimeError("no JSON object found in command stdout")


def has_speaker_segments(payload: dict[str, Any]) -> bool:
    return any(segment.get("speakerLabel") for segment in normalize_segments(payload))


def merge_primary_and_speaker(primary: dict[str, Any], speaker: dict[str, Any]) -> dict[str, Any]:
    primary_segments = normalize_segments(primary)
    speaker_segments = [segment for segment in normalize_segments(speaker) if segment.get("speakerLabel")]
    merged_segments = [assign_speaker_label(segment, speaker_segments) for segment in primary_segments]
    transcript = str(primary.get("transcript") or primary.get("text") or "").strip()
    if not transcript:
        transcript = " ".join(str(segment.get("text") or "").strip() for segment in merged_segments).strip()

    speaker_labels = sorted({
        str(segment.get("speakerLabel"))
        for segment in merged_segments
        if segment.get("speakerLabel")
    })
    speaker_timeline_labels = sorted({
        str(segment.get("speakerLabel"))
        for segment in speaker_segments
        if segment.get("speakerLabel")
    })
    return {
        "language": primary.get("language"),
        "transcript": transcript,
        "segments": merged_segments,
        "speakerTimelineSegments": speaker_segments,
        "hybrid": {
            "primary": str(primary.get("_hybridPrimaryLabel") or "primary-asr"),
            "speaker": "funasr:cam++",
            "primarySegmentCount": len(primary_segments),
            "speakerSegmentCount": len(speaker_segments),
            "assignedSpeakerSegmentCount": sum(1 for segment in merged_segments if segment.get("speakerLabel")),
            "speakerLabels": speaker_labels,
            "speakerTimelineLabels": speaker_timeline_labels,
        },
    }


def resolve_primary_label(command: str) -> str:
    name = Path(command).name.lower()
    if "funasr" in name:
        return "funasr"
    if "whisperx" in name:
        return "whisperx"
    if "whisper" in name:
        return "whisper"
    return name or "primary-asr"


def normalize_segments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = []
    source_key = "segments"
    for candidate_key in ("segments", "sentence_info", "sentences"):
        candidate = payload.get(candidate_key)
        if isinstance(candidate, list) and len(candidate) > 0:
            raw = candidate
            source_key = candidate_key
            break
    if not isinstance(raw, list):
        return synthesize_segments(str(payload.get("transcript") or payload.get("text") or "").strip())
    segments: list[dict[str, Any]] = []
    zero_based_speakers = has_zero_based_speaker_labels(raw)
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or item.get("transcript") or item.get("sentence") or "").strip()
        if not text:
            continue
        segment: dict[str, Any] = {"text": text}
        start_ms = read_time_ms(item, "start", source_key)
        end_ms = read_time_ms(item, "end", source_key)
        if start_ms is not None:
            segment["startMs"] = start_ms
        if end_ms is not None:
            segment["endMs"] = end_ms
        speaker = first_present(item, "speakerLabel", "speaker", "spk", "speaker_id")
        if speaker is not None:
            segment["speakerLabel"] = normalize_speaker_label(speaker, zero_based=zero_based_speakers)
        confidence = item.get("confidence")
        if isinstance(confidence, (int, float)):
            segment["confidence"] = confidence
        segments.append(segment)
    return segments


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


def synthesize_segments(transcript: str) -> list[dict[str, Any]]:
    return [{"text": transcript}] if transcript else []


def read_time_ms(item: dict[str, Any], side: str, source_key: str) -> int | None:
    for key in (f"{side}Ms", f"{side}_ms"):
        value = item.get(key)
        if isinstance(value, (int, float)):
            return max(0, round(value))
    for key in (f"{side}Sec", f"{side}_sec"):
        value = item.get(key)
        if isinstance(value, (int, float)):
            return max(0, round(value * 1000))
    value = item.get(side)
    if not isinstance(value, (int, float)):
        return None
    if source_key == "sentence_info":
        return max(0, round(value))
    return max(0, round(value * 1000))


def assign_speaker_label(segment: dict[str, Any], speaker_segments: list[dict[str, Any]]) -> dict[str, Any]:
    start = segment.get("startMs")
    end = segment.get("endMs")
    if not isinstance(start, int) or not isinstance(end, int) or end <= start:
        return segment

    overlaps: dict[str, int] = {}
    for speaker_segment in speaker_segments:
        speaker = speaker_segment.get("speakerLabel")
        speaker_start = speaker_segment.get("startMs")
        speaker_end = speaker_segment.get("endMs")
        if not isinstance(speaker, str) or not isinstance(speaker_start, int) or not isinstance(speaker_end, int):
            continue
        overlap = min(end, speaker_end) - max(start, speaker_start)
        if overlap > 0:
            overlaps[speaker] = overlaps.get(speaker, 0) + overlap

    if not overlaps:
        midpoint = (start + end) // 2
        for speaker_segment in speaker_segments:
            speaker = speaker_segment.get("speakerLabel")
            speaker_start = speaker_segment.get("startMs")
            speaker_end = speaker_segment.get("endMs")
            if (
                isinstance(speaker, str)
                and isinstance(speaker_start, int)
                and isinstance(speaker_end, int)
                and speaker_start <= midpoint <= speaker_end
            ):
                overlaps[speaker] = 1
                break

    if not overlaps:
        return segment

    speaker, overlap_ms = sorted(overlaps.items(), key=lambda item: (-item[1], item[0]))[0]
    duration = max(1, end - start)
    merged = dict(segment)
    merged["speakerLabel"] = speaker
    merged.setdefault("confidence", round(min(1.0, overlap_ms / duration), 3))
    return merged


if __name__ == "__main__":
    raise SystemExit(main())
