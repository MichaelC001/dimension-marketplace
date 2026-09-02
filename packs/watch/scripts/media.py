#!/usr/bin/env python3
"""Media acquisition and frame extraction: yt-dlp + ffmpeg, defensively.

Every subprocess call here decodes as UTF-8 with `errors="replace"`. That is
not cosmetic: ffmpeg emits the source's own metadata on stderr, and on a
Windows console Python otherwise decodes it as cp1252 and raises
UnicodeDecodeError on the first non-ASCII video title.

Two capability probes run once per process and are cached:

- `-fps_mode vfr` vs `-vsync vfr`. ffmpeg 9 removed `-vsync` outright, which
  breaks every frame-extraction path in tools that still pass it. `-fps_mode`
  arrived in 5.1, so we probe and pick rather than assuming either.
- `ffprobe` executability. An Application Control policy (WDAC / Smart App
  Control) can block `ffprobe.exe` while allowing `ffmpeg.exe` from the same
  install directory. `shutil.which()` answers "does the file exist", not "may
  I run it", so we probe and fall back to parsing the `ffmpeg -i` banner.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import safety
from urllib.parse import urlparse

MAX_FPS = 2.0
SCENE_THRESHOLD = 0.20
KEYFRAME_MIN = 4
MAX_READ_DIMENSION = 1998
DEDUP_THUMB = 16
DEDUP_THRESHOLD = 2.0
# Disk/time guard on candidate DETECTION, deliberately far above any frame cap
# so it never acts as a sampler. Hitting it means the video has more than 5000
# scene cuts, which is reported as truncation rather than passed off as full
# coverage. This is NOT the frame budget -- select_frames() applies that.
CANDIDATE_CEILING = 5000

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv", ".wmv", ".ts"}

_SHOWINFO_TS = re.compile(r"pts_time:([0-9.]+)")
_BANNER_DURATION = re.compile(r"Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)")
_BANNER_VIDEO = re.compile(r"Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)")
_BANNER_AUDIO = re.compile(r"Stream #\d+:\d+.*?: Audio:")

_caps: dict[str, bool] = {}


def _run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """subprocess.run with encoding pinned. See module docstring."""
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw
    )


def require(binary: str) -> None:
    if shutil.which(binary) is None:
        raise SystemExit(
            f"{binary} is not on PATH.\n"
            f"  macOS:   brew install {'ffmpeg' if binary.startswith('ff') else binary}\n"
            f"  Windows: winget install {'Gyan.FFmpeg' if binary.startswith('ff') else 'yt-dlp.yt-dlp'}\n"
            f"  Linux:   apt install {'ffmpeg' if binary.startswith('ff') else binary}"
        )


def vfr_flag() -> list[str]:
    """Return the variable-frame-rate flag this ffmpeg actually accepts."""
    if "fps_mode" not in _caps:
        probe = _run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
             "-i", "nullsrc=s=16x16:d=0.1", "-fps_mode", "vfr", "-frames:v", "1",
             "-f", "null", "-"]
        )
        _caps["fps_mode"] = probe.returncode == 0
    return ["-fps_mode", "vfr"] if _caps["fps_mode"] else ["-vsync", "vfr"]


def passthrough_flag() -> list[str]:
    """Emit every input frame, dropping none.

    The concat demuxer hands identical presentation timestamps to a sequence of
    stills, and ffmpeg's default CFR sync silently DROPS the duplicates -- so a
    12-frame dedup pass only ever saw 4 thumbnails and collapsed nothing.
    """
    _ = vfr_flag()  # populate the shared capability probe
    return ["-fps_mode", "passthrough"] if _caps["fps_mode"] else ["-vsync", "0"]


def _ffprobe_usable() -> bool:
    if "ffprobe" not in _caps:
        if shutil.which("ffprobe") is None:
            _caps["ffprobe"] = False
        else:
            try:
                _caps["ffprobe"] = _run(["ffprobe", "-version"]).returncode == 0
            except OSError:
                # WinError 4551 = blocked by Application Control policy.
                _caps["ffprobe"] = False
    return _caps["ffprobe"]


def is_url(source: str) -> bool:
    if source.startswith("-"):
        return False
    parsed = urlparse(source)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def parse_time(value: str | float | int | None) -> float | None:
    """Parse SS, MM:SS, or HH:MM:SS (optional .ms) into seconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    parts = s.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        pass
    raise SystemExit(f"Cannot parse time {value!r} (expected SS, MM:SS, or HH:MM:SS)")


def format_time(seconds: float) -> str:
    total = int(round(max(0.0, seconds)))
    hours, rem = divmod(total, 3600)
    minutes, sec = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{sec:02d}" if hours else f"{minutes:02d}:{sec:02d}"


# --------------------------------------------------------------------------
# Metadata
# --------------------------------------------------------------------------

def _metadata_via_banner(video_path: str) -> dict:
    """Recover duration/resolution from `ffmpeg -i` when ffprobe is unusable."""
    result = _run(["ffmpeg", "-hide_banner", "-i", str(Path(video_path).resolve())])
    err = result.stderr or ""
    duration = 0.0
    if m := _BANNER_DURATION.search(err):
        duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    width = height = codec = None
    if m := _BANNER_VIDEO.search(err):
        codec, width, height = m.group(1), int(m.group(2)), int(m.group(3))
    return {
        "duration_seconds": duration,
        "width": width,
        "height": height,
        "codec": codec,
        "has_audio": bool(_BANNER_AUDIO.search(err)),
        "probe": "ffmpeg-banner",
    }


def get_metadata(video_path: str) -> dict:
    if not _ffprobe_usable():
        return _metadata_via_banner(video_path)
    try:
        result = _run([
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", str(Path(video_path).resolve()),
        ])
    except OSError:
        _caps["ffprobe"] = False
        return _metadata_via_banner(video_path)
    if result.returncode != 0:
        return _metadata_via_banner(video_path)

    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    return {
        "duration_seconds": float(fmt.get("duration") or video.get("duration") or 0),
        "width": video.get("width"),
        "height": video.get("height"),
        "codec": video.get("codec_name"),
        "has_audio": audio is not None,
        "probe": "ffprobe",
    }


# --------------------------------------------------------------------------
# Acquisition
# --------------------------------------------------------------------------

def _pick(out_dir: Path, exts: tuple[str, ...]) -> Path | None:
    for ext in exts:
        for candidate in sorted(out_dir.glob(f"video*{ext}")):
            return candidate
    return None


def _pick_subtitle(out_dir: Path) -> Path | None:
    candidates = sorted(out_dir.glob("video*.vtt"))
    if not candidates:
        return None
    preferred = [
        c for c in candidates
        if any(m in c.name for m in (".en.", ".en-US.", ".en-GB.", ".en-orig."))
    ]
    return preferred[0] if preferred else candidates[0]


def _read_info(out_dir: Path, url: str) -> dict:
    path = out_dir / "video.info.json"
    if not path.exists():
        return {"url": url}
    try:
        raw = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        print(f"[watch] info.json unreadable: {exc}", file=sys.stderr)
        return {"url": url}
    return {
        "title": raw.get("title"),
        "uploader": raw.get("uploader") or raw.get("channel"),
        "duration": raw.get("duration"),
        "url": raw.get("webpage_url") or url,
    }


_SUB_ARGS = [
    "--write-subs", "--write-auto-subs", "--sub-langs", "en.*",
    "--sub-format", "vtt", "--convert-subs", "vtt",
]


def fetch_captions(url: str, out_dir: Path) -> dict:
    """Metadata + captions with no media download."""
    require("yt-dlp")
    out_dir.mkdir(parents=True, exist_ok=True)
    _run([
        "yt-dlp", "--skip-download", "--write-info-json", *_SUB_ARGS,
        "--no-playlist", "--ignore-errors",
        "-P", f"home:{out_dir}", "-o", "video.%(ext)s", "--", url,
    ])
    sub = _pick_subtitle(out_dir)
    return {
        "video_path": None,
        "subtitle_path": str(sub) if sub else None,
        "info": _read_info(out_dir, url),
    }


def download(source: str, out_dir: Path, audio_only: bool = False) -> dict:
    if not is_url(source):
        path = Path(source).expanduser().resolve()
        if not path.exists():
            raise SystemExit(f"File not found: {path}")
        if path.suffix.lower() not in VIDEO_EXTS:
            print(f"[watch] warning: {path.suffix} is not a known video "
                  "extension, proceeding anyway", file=sys.stderr)
        # A sidecar transcript beside the file beats paying for Whisper.
        sidecar = next(
            (p for ext in (".vtt", ".srt") if (p := path.with_suffix(ext)).exists()),
            None,
        )
        return {
            "video_path": str(path),
            "subtitle_path": str(sidecar) if sidecar else None,
            "info": {"title": path.name, "url": str(path)},
        }

    require("yt-dlp")
    out_dir.mkdir(parents=True, exist_ok=True)
    fmt = "ba/bestaudio" if audio_only else "bv*[height<=720]+ba/b[height<=720]/bv+ba/b"
    result = _run([
        "yt-dlp", "-N", "8", "-f", fmt, "--merge-output-format", "mp4",
        "--write-info-json", *_SUB_ARGS, "--no-playlist", "--ignore-errors",
        "-P", f"home:{out_dir}", "-o", "video.%(ext)s", "--", source,
    ])
    media = _pick(out_dir, (".mp4", ".mkv", ".webm", ".mov", ".m4a", ".mp3", ".opus"))
    if media is None:
        raise SystemExit(
            f"yt-dlp produced no media file (exit {result.returncode}). "
            + safety.labeled_diagnostic(result.stderr)
        )
    sub = _pick_subtitle(out_dir)
    return {
        "video_path": str(media),
        "subtitle_path": str(sub) if sub else None,
        "info": _read_info(out_dir, source),
    }


# --------------------------------------------------------------------------
# Frame budgeting
# --------------------------------------------------------------------------

def auto_fps(duration: float, max_frames: int, focused: bool) -> tuple[float, int]:
    """Pick an fps that targets a frame budget. Token cost scales with frames,
    so long videos get capped rather than sampled at a fixed rate."""
    if duration <= 0:
        return 1.0, 1
    if focused:
        # A named range means the user is zooming in; spend more per second.
        if duration <= 5:
            target = max(10, int(round(duration * 6)))
        elif duration <= 15:
            target = max(30, int(round(duration * 4)))
        elif duration <= 30:
            target = 60
        elif duration <= 60:
            target = 80
        else:
            target = max_frames
    else:
        if duration <= 30:
            target = max(12, int(round(duration)))
        elif duration <= 60:
            target = 40
        elif duration <= 180:
            target = 60
        elif duration <= 600:
            target = 80
        else:
            target = max_frames
    target = min(max_frames, target)
    fps = min(MAX_FPS, target / duration)
    return fps, min(max_frames, max(1, int(round(fps * duration))))


def _even_indices(count: int, n: int) -> list[int]:
    """Indices of n evenly spaced items, always keeping first and last."""
    if n >= count:
        return list(range(count))
    if n <= 1:
        return [0]
    return [round(i * (count - 1) / (n - 1)) for i in range(n)]


def _scale(resolution: int) -> str:
    return (
        f"scale=w='min({resolution},iw)':h='min({MAX_READ_DIMENSION},ih)':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    )


def _clear(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("frame_*.jpg"):
        stale.unlink()


def _range_args(start: float | None, end: float | None) -> list[str]:
    args: list[str] = []
    if start is not None:
        args += ["-ss", f"{start:.3f}"]
    if end is not None:
        args += ["-to", f"{end:.3f}"]
    return args


# --------------------------------------------------------------------------
# Deduplication
# --------------------------------------------------------------------------

def dedup(frames: list[dict]) -> tuple[list[dict], int]:
    """Drop frames visually near-identical to the last frame we KEPT.

    Comparing against the last kept frame (rather than the immediately
    previous one) is what catches a slow fade: each step is under threshold,
    but the cumulative drift is not.

    One ffmpeg call renders every frame to a 16x16 gray thumbnail on stdout;
    the comparison itself is pure stdlib, so there is no image dependency.
    """
    if len(frames) < 2:
        return frames, 0

    # ffmpeg's concat demuxer takes a single-quoted path; an apostrophe in the
    # path (a user's --out-dir) would otherwise terminate the quote and silently
    # disable dedup via the short-blob guard.
    listing = "\n".join(
        "file '{}'".format(Path(f["path"]).as_posix().replace("'", "'\\''"))
        for f in frames
    )
    concat = Path(frames[0]["path"]).parent / "dedup.txt"
    concat.write_text(listing, encoding="utf-8")

    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "concat",
         "-safe", "0", "-i", str(concat), "-vf",
         f"scale={DEDUP_THUMB}:{DEDUP_THUMB},format=gray",
         *passthrough_flag(), "-f", "rawvideo", "-"],
        capture_output=True,
    )
    concat.unlink(missing_ok=True)

    size = DEDUP_THUMB * DEDUP_THUMB
    blob = proc.stdout or b""
    if proc.returncode != 0 or len(blob) < size * len(frames):
        # Keeping every frame is the safe direction -- but say so. A silent
        # return here once hid a real bug for a full test cycle: the pass
        # reported "0 dropped" on twelve identical frames and looked correct.
        print(
            f"[watch] dedup skipped: expected {len(frames)} thumbnails, got "
            f"{len(blob) // size} (ffmpeg exit {proc.returncode})",
            file=sys.stderr,
        )
        return frames, 0

    kept: list[dict] = [frames[0]]
    reference = blob[0:size]
    dropped = 0
    for i in range(1, len(frames)):
        thumb = blob[i * size:(i + 1) * size]
        delta = sum(abs(a - b) for a, b in zip(thumb, reference)) / size
        if delta <= DEDUP_THRESHOLD:
            Path(frames[i]["path"]).unlink(missing_ok=True)
            dropped += 1
            continue
        kept.append(frames[i])
        reference = thumb
    return kept, dropped


# --------------------------------------------------------------------------
# Extraction engines
# --------------------------------------------------------------------------

def _collect(out_dir: Path, timestamps: list[float], offset: float, reason: str) -> list[dict]:
    frames = sorted(out_dir.glob("frame_*.jpg"))
    return [
        {
            "index": i,
            "timestamp_seconds": timestamps[i] if i < len(timestamps) else None,
            "path": str(p),
            "reason": "first-frame" if i == 0 and reason == "scene-change" else reason,
        }
        for i, p in enumerate(frames)
    ]


def extract_scene(
    video: str, out_dir: Path, resolution: int, cap: int | None,
    start: float | None, end: float | None,
) -> list[dict]:
    require("ffmpeg")
    _clear(out_dir)
    vf = (f"select='eq(n\\,0)+gt(scene\\,{SCENE_THRESHOLD})',"
          f"{_scale(resolution)},showinfo")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", "-y",
           *_range_args(start, end), "-i", str(Path(video).resolve()),
           "-vf", vf, *vfr_flag()]
    # NEVER pass the frame cap to ffmpeg as -frames:v. It makes ffmpeg stop
    # decoding at the first N scene changes, so a video with more cuts than the
    # cap is TRUNCATED, not sampled: a 5:49 montage capped at 100 returned its
    # last frame at 4:39 and silently reported "full range". Detect every
    # candidate here; select_frames() even-samples down to the cap afterwards,
    # which is what keeps the final frame at the end of the range.
    cmd += ["-frames:v", str(CANDIDATE_CEILING)]
    cmd += ["-q:v", "4", str(out_dir / "frame_%05d.jpg")]

    result = _run(cmd)
    if result.returncode != 0:
        raise SystemExit("scene extraction failed: "
                         + safety.labeled_diagnostic(result.stderr))
    offset = start or 0.0
    stamps = [round(offset + float(m.group(1)), 2)
              for m in _SHOWINFO_TS.finditer(result.stderr or "")]
    return _collect(out_dir, stamps, offset, "scene-change")


def extract_keyframes(
    video: str, out_dir: Path, resolution: int, cap: int | None,
    start: float | None, end: float | None,
) -> list[dict]:
    require("ffmpeg")
    _clear(out_dir)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", "-y",
           "-skip_frame", "nokey", *_range_args(start, end),
           "-i", str(Path(video).resolve()),
           "-vf", f"{_scale(resolution)},showinfo", *vfr_flag()]
    # See extract_scene: the cap is applied after detection, never by ffmpeg.
    cmd += ["-frames:v", str(CANDIDATE_CEILING)]
    cmd += ["-q:v", "4", str(out_dir / "frame_%05d.jpg")]

    result = _run(cmd)
    if result.returncode != 0:
        raise SystemExit("keyframe extraction failed: "
                         + safety.labeled_diagnostic(result.stderr))
    offset = start or 0.0
    stamps = [round(offset + float(m.group(1)), 2)
              for m in _SHOWINFO_TS.finditer(result.stderr or "")]
    return _collect(out_dir, stamps, offset, "keyframe")


def extract_uniform(
    video: str, out_dir: Path, fps: float, resolution: int, cap: int,
    start: float | None, end: float | None,
) -> list[dict]:
    require("ffmpeg")
    _clear(out_dir)
    result = _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        *_range_args(start, end), "-i", str(Path(video).resolve()),
        "-vf", f"fps={fps},{_scale(resolution)}",
        # Ceiling, not budget — see extract_scene. fps is already chosen to hit
        # the duration budget, so this only guards a pathological --fps.
        "-frames:v", str(CANDIDATE_CEILING), "-q:v", "4",
        str(out_dir / "frame_%05d.jpg"),
    ])
    if result.returncode != 0:
        raise SystemExit("uniform extraction failed: "
                         + safety.labeled_diagnostic(result.stderr))
    offset = start or 0.0
    frames = sorted(out_dir.glob("frame_*.jpg"))
    return [
        {
            "index": i,
            "timestamp_seconds": round(offset + (i / fps if fps > 0 else 0.0), 2),
            "path": str(p),
            "reason": "uniform",
        }
        for i, p in enumerate(frames)
    ]


def extract_at(
    video: str, out_dir: Path, stamps: list[float], resolution: int,
    start: float | None, end: float | None,
) -> tuple[list[dict], int]:
    """One frame per requested timestamp. Out-of-window cues are reported,
    not silently dropped."""
    require("ffmpeg")
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = [
        t for t in stamps
        if (start is None or t >= start) and (end is None or t <= end)
    ]
    dropped = len(stamps) - len(wanted)
    frames: list[dict] = []
    failed = 0
    for i, ts in enumerate(wanted):
        path = out_dir / f"cue_{i:04d}.jpg"
        result = _run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{ts:.3f}", "-i", str(Path(video).resolve()),
            "-vf", _scale(resolution), "-frames:v", "1", "-q:v", "4", str(path),
        ])
        if result.returncode == 0 and path.exists():
            frames.append({
                "index": i, "timestamp_seconds": round(ts, 2),
                "path": str(path), "reason": "transcript-cue",
            })
        else:
            failed += 1
    return frames, dropped + failed


def select_frames(
    video: str, out_dir: Path, detail: str, fps: float, target: int,
    resolution: int, cap: int | None, start: float | None, end: float | None,
    do_dedup: bool,
) -> tuple[list[dict], dict]:
    """Run the detail mode's engine, fall back when it under-produces, dedup,
    then even-sample down to the cap."""
    meta = {"engine": detail, "fallback": False, "deduped": 0}

    if detail == "efficient":
        frames = extract_keyframes(video, out_dir, resolution, cap, start, end)
        meta["engine"] = "keyframe"
        if len(frames) < KEYFRAME_MIN:
            frames = extract_uniform(video, out_dir, fps, resolution,
                                     cap or target, start, end)
            meta["engine"], meta["fallback"] = "uniform", True
    else:
        frames = extract_scene(video, out_dir, resolution, cap, start, end)
        meta["engine"] = "scene"
        # One candidate means the scene filter found no cuts at all -- a static
        # screen recording or talking head. Uniform sampling covers it better.
        if len(frames) < 2:
            frames = extract_uniform(video, out_dir, fps, resolution,
                                     cap or target, start, end)
            meta["engine"], meta["fallback"] = "uniform", True

    meta["candidates"] = len(frames)
    # Hitting the detection ceiling is real truncation -- surface it rather
    # than letting the report imply the whole range was covered.
    meta["truncated"] = len(frames) >= CANDIDATE_CEILING
    if meta["truncated"]:
        print(f"[watch] candidate ceiling ({CANDIDATE_CEILING}) reached — "
              "coverage stops early; narrow the range with --start/--end",
              file=sys.stderr)

    if do_dedup:
        frames, dropped = dedup(frames)
        meta["deduped"] = dropped

    # Cap AFTER dedup so the budget is spent on distinct frames. Even-sampling
    # keeps the first and last candidate, which is what makes the final frame
    # land at the END of the range instead of wherever the cap ran out.
    if cap is not None and len(frames) > cap:
        keep = set(_even_indices(len(frames), cap))
        for i, frame in enumerate(frames):
            if i not in keep:
                Path(frame["path"]).unlink(missing_ok=True)
        frames = [frame for i, frame in enumerate(frames) if i in keep]
    meta["selected"] = len(frames)
    return frames, meta
