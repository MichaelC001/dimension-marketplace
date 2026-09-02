#!/usr/bin/env python3
"""Transcript acquisition: caption parsing first, speech-to-text as fallback.

Order of preference, cheapest and most private first:

1. Native captions from the source (yt-dlp), or a `.vtt`/`.srt` sidecar next
   to a local file. Free, instant, no audio leaves the machine.
2. A local Whisper CLI (`whisper` or `faster-whisper`) if one is installed.
   Never installed automatically -- only used when already present.
3. A cloud Whisper API (Groq or OpenAI). Requires BOTH a key and an explicit
   `--allow-remote-transcription`. A key on its own transmits nothing, because
   uploading someone's audio should be a deliberate act, not a side effect of
   having configured an unrelated key.

YouTube's auto-captions arrive as a rolling window: each spoken line is
re-rendered two or three times as the caption box scrolls. Naive prefix
matching misses the transition cue that repeats the tail of the previous one,
so every line ends up duplicated. `_collapse_rolling` compares whole lines
against the last line kept and collapses only exact matches -- a genuine
repetition split across two different cues survives.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

import safety
from pathlib import Path

# The hours field is OPTIONAL. openai-whisper's own VTT writer sets
# `always_include_hours = False`, so a sub-hour transcription emits
# `MM:SS.mmm --> MM:SS.mmm`. Requiring HH made the entire local-STT rung
# return zero segments while reporting success.
_STAMP = r"(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}"
_CUE = re.compile(rf"({_STAMP})\s*-->\s*({_STAMP})")
_TAG = re.compile(r"<[^>]+>")

# 25 MB is the documented upload ceiling for both Groq and OpenAI audio
# endpoints; stay under it with headroom for multipart overhead.
_UPLOAD_LIMIT = 24 * 1024 * 1024

_ENDPOINTS = {
    "groq": ("https://api.groq.com/openai/v1/audio/transcriptions",
             "whisper-large-v3", "GROQ_API_KEY"),
    "openai": ("https://api.openai.com/v1/audio/transcriptions",
               "whisper-1", "OPENAI_API_KEY"),
}


def _stamp(value: str) -> float:
    """Parse `HH:MM:SS.mmm` or `MM:SS.mmm` (either separator) into seconds."""
    head, _, frac = value.replace(",", ".").rpartition(".")
    parts = [float(p) for p in head.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    hours, minutes, seconds = parts[-3:]
    return hours * 3600 + minutes * 60 + seconds + int(frac.ljust(3, "0")) / 1000


def _collapse_rolling(cues: list[dict]) -> list[dict]:
    """Drop lines the caption renderer repeated, keep lines a speaker repeated."""
    out: list[dict] = []
    last_line: str | None = None
    for cue in cues:
        kept: list[str] = []
        for line in cue["text"].split("\n"):
            line = line.strip()
            if not line or line == last_line:
                continue
            kept.append(line)
            last_line = line
        if kept:
            out.append({**cue, "text": " ".join(kept)})
    return out


def parse_captions(path: str | Path) -> list[dict]:
    """Parse a VTT or SRT file into de-duplicated timestamped segments."""
    raw = Path(path).read_text(encoding="utf-8", errors="replace")
    cues: list[dict] = []
    current: dict | None = None
    for line in raw.splitlines():
        if match := _CUE.search(line):
            if current and current["text"].strip():
                cues.append(current)
            current = {
                "start": _stamp(match.group(1)),
                "end": _stamp(match.group(2)),
                "text": "",
            }
            continue
        if current is None:
            continue
        text = _TAG.sub("", line).strip()
        if text and not text.isdigit():
            current["text"] += (text + "\n")
    if current and current["text"].strip():
        cues.append(current)
    return _collapse_rolling(cues)


def filter_range(segments: list[dict], start: float | None,
                 end: float | None) -> list[dict]:
    lo = start if start is not None else float("-inf")
    hi = end if end is not None else float("inf")
    return [s for s in segments if s["end"] >= lo and s["start"] <= hi]


def format_transcript(segments: list[dict]) -> str:
    lines = []
    for seg in segments:
        total = int(seg["start"])
        h, rem = divmod(total, 3600)
        m, s = divmod(rem, 60)
        stamp = f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
        lines.append(f"[{stamp}] {seg['text']}")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Audio + speech-to-text
# --------------------------------------------------------------------------

def extract_audio(video: str, dest: Path) -> Path:
    """Mono 16 kHz 64 kbps mp3 -- roughly 0.5 MB per minute."""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(Path(video).resolve()), "-vn", "-ac", "1", "-ar", "16000",
         "-b:a", "64k", str(dest)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0 or not dest.exists():
        raise SystemExit("audio extraction failed: "
                         + safety.labeled_diagnostic(result.stderr))
    return dest


def local_backend() -> str | None:
    """Name an already-installed local Whisper CLI, or None. Never installs."""
    for candidate in ("faster-whisper", "whisper"):
        if shutil.which(candidate):
            return candidate
    return None


def transcribe_local(audio: Path, tool: str, work: Path) -> list[dict]:
    result = subprocess.run(
        [tool, str(audio), "--model", "base", "--output_format", "vtt",
         "--output_dir", str(work)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    produced = work / (audio.stem + ".vtt")
    if result.returncode != 0 or not produced.exists():
        raise SystemExit(f"{tool} failed: " + safety.labeled_diagnostic(result.stderr))
    return parse_captions(produced)


def _multipart(audio: Path, model: str) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    sep = f"--{boundary}".encode()
    body = b"\r\n".join([
        sep,
        b'Content-Disposition: form-data; name="model"', b"", model.encode(),
        sep,
        f'Content-Disposition: form-data; name="file"; filename="{audio.name}"'.encode(),
        b"Content-Type: audio/mpeg", b"", audio.read_bytes(),
        sep,
        b'Content-Disposition: form-data; name="response_format"', b"", b"verbose_json",
        f"--{boundary}--".encode(), b"",
    ])
    return body, f"multipart/form-data; boundary={boundary}"


def transcribe_remote(audio: Path, backend: str, api_key: str) -> list[dict]:
    url, model, _ = _ENDPOINTS[backend]
    if audio.stat().st_size > _UPLOAD_LIMIT:
        raise SystemExit(
            f"audio is {audio.stat().st_size // 1_048_576} MB, over the "
            f"{_UPLOAD_LIMIT // 1_048_576} MB API limit. Re-run with "
            "--start/--end to transcribe a section."
        )
    body, content_type = _multipart(audio, model)
    request = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"{backend} transcription failed ({exc.code}): "
                         + safety.labeled_diagnostic(detail))
    except urllib.error.URLError as exc:
        raise SystemExit(f"{backend} unreachable: {exc.reason}")

    segments = payload.get("segments") or []
    if segments:
        return [
            {"start": float(s.get("start", 0)), "end": float(s.get("end", 0)),
             "text": (s.get("text") or "").strip()}
            for s in segments if (s.get("text") or "").strip()
        ]
    text = (payload.get("text") or "").strip()
    return [{"start": 0.0, "end": 0.0, "text": text}] if text else []


def resolve_remote(preference: str | None) -> tuple[str | None, str | None]:
    order = [preference] if preference in _ENDPOINTS else ["groq", "openai"]
    for backend in order:
        key = os.environ.get(_ENDPOINTS[backend][2])
        if key:
            return backend, key
    return None, None


def obtain(
    video: str, work: Path, stt: str, allow_remote: bool,
) -> tuple[list[dict], str]:
    """Run the STT ladder. Returns (segments, source-label)."""
    if stt == "none":
        return [], "disabled"

    # Resolve WHO will transcribe before extracting anything. Writing audio.mp3
    # and then reporting "audio stays local" put the file on disk in every
    # configuration except --stt none, including the two the report promised
    # had extracted nothing.
    if stt in ("auto", "local"):
        if tool := local_backend():
            audio = extract_audio(video, work / "audio.mp3")
            print(f"[watch] transcribing locally with {tool}...", file=sys.stderr)
            return transcribe_local(audio, tool, work), f"local ({tool})"
        if stt == "local":
            raise SystemExit(
                "no local Whisper CLI found (looked for faster-whisper, whisper). "
                "Install one, or pass --stt groq/openai with "
                "--allow-remote-transcription."
            )

    backend, key = resolve_remote(None if stt == "auto" else stt)
    if not backend:
        return [], "unavailable (no captions, no local STT, no API key)"
    if not allow_remote:
        return [], (f"blocked ({backend} key present, but --allow-remote-"
                    "transcription was not passed -- audio stays local)")

    print(f"[watch] uploading audio to {backend}...", file=sys.stderr)
    return transcribe_remote(audio, backend, key), f"remote ({backend})"
