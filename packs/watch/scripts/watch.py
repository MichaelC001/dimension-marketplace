#!/usr/bin/env python3
"""watch -- give the agent eyes and ears on a video.

Downloads (or opens) a video, samples frames as JPEGs, builds a timestamped
transcript, and prints a report the agent reads. Frame paths go to the agent's
image-capable Read tool; the transcript is quoted as explicitly untrusted data.

Run `python watch.py --help` for flags. Design notes worth knowing:

- **Working directories are managed here, not by the agent.** Runs land under
  a single `inso-watch/` root in the system temp dir and old runs are pruned
  automatically. Nothing instructs the agent to `rm -rf` anything, because an
  LLM holding a recursive delete pointed at a user-supplied path is a data-loss
  bug waiting for its first coincidence.
- **Media text is hostile until proven otherwise.** See safety.py.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))

import media  # noqa: E402
import safety  # noqa: E402
import transcript as tx  # noqa: E402

# Windows consoles default to a legacy code page (cp1252) that cannot encode
# the arrows and box characters in this report, so a finished run would die on
# its final print. Reconfigure before anything writes.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

WORK_ROOT = Path(tempfile.gettempdir()) / "inso-watch"
KEEP_RUNS = 5
# A run touched more recently than this may still be in flight in another
# process, so automatic pruning leaves it alone.
LIVE_WINDOW_SECONDS = 900

DETAIL_CAPS: dict[str, int | None] = {
    "transcript": 0,
    "efficient": 50,
    "balanced": 100,
    "full": None,
}


def prune_old_runs(keep: int = KEEP_RUNS) -> int:
    """Delete all but the newest `keep` run directories under WORK_ROOT.

    Scoped to directories this script created inside its own root -- it never
    touches a user-supplied --out-dir.
    """
    if not WORK_ROOT.exists():
        return 0
    runs = sorted(
        (p for p in WORK_ROOT.iterdir() if p.is_dir() and p.name.startswith("run-")),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    removed = 0
    cutoff = time.time() - LIVE_WINDOW_SECONDS
    for stale in runs[keep:]:
        # Another watch process may be mid-run in a sibling directory. Only an
        # explicit `--cleanup` (keep=0) may take a recently-touched run.
        if keep > 0 and stale.stat().st_mtime > cutoff:
            continue
        shutil.rmtree(stale, ignore_errors=True)
        removed += 1
    return removed


def new_work_dir(out_dir: str | None) -> tuple[Path, bool]:
    if out_dir:
        path = Path(out_dir).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path, False
    prune_old_runs()
    # 0700 + mkdtemp: downloaded media, extracted audio and every frame land
    # here. A predictable `run-<epoch-ms>` under a world-readable root lets a
    # local user read them, or pre-create the directory and swap frames before
    # the agent reads them -- an image-channel injection. mkdtemp is O_EXCL.
    WORK_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = Path(tempfile.mkdtemp(prefix="run-", dir=WORK_ROOT))
    return path, True


def parse_stamps(value: str | None) -> list[float]:
    if not value:
        return []
    seen = {media.parse_time(tok.strip()) for tok in value.split(",") if tok.strip()}
    return sorted(t for t in seen if t is not None)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="watch",
        description="Sample a video into frames + a transcript for an agent to read.",
    )
    p.add_argument("source", nargs="?", help="Video URL or local file path")
    p.add_argument("--detail", choices=list(DETAIL_CAPS), default="balanced",
                   help="transcript=no frames, efficient=keyframes (cap 50), "
                        "balanced=scene-aware (cap 100), full=scene, uncapped")
    p.add_argument("--start", help="Range start (SS, MM:SS, HH:MM:SS)")
    p.add_argument("--end", help="Range end (SS, MM:SS, HH:MM:SS)")
    p.add_argument("--timestamps", help="Comma-separated times to force a frame at")
    p.add_argument("--max-frames", type=int, help="Override the detail mode's cap")
    p.add_argument("--resolution", type=int, default=512,
                   help="Frame width in px (default 512; 1024 to read on-screen text)")
    p.add_argument("--fps", type=float, help="Override auto-fps (still capped at 2)")
    p.add_argument("--stt", default="auto",
                   choices=["auto", "local", "groq", "openai", "none"],
                   help="Speech-to-text ladder when captions are missing")
    p.add_argument("--allow-remote-transcription", action="store_true",
                   help="Permit uploading extracted audio to a cloud STT API")
    p.add_argument("--no-dedup", action="store_true",
                   help="Keep frames that are visually near-identical")
    p.add_argument("--out-dir", help="Working directory (default: managed temp dir)")
    p.add_argument("--cleanup", action="store_true",
                   help="Delete every managed run directory and exit")
    p.add_argument("--json", action="store_true",
                   help="Emit a JSON envelope (markdown report + structured "
                        "fields) instead of bare markdown. Used by the plugin "
                        "tool to populate its card.")
    return p


def main() -> int:
    args = build_parser().parse_args()

    if args.cleanup:
        removed = prune_old_runs(keep=0)
        print(f"Removed {removed} run director{'y' if removed == 1 else 'ies'} "
              f"under {WORK_ROOT}")
        return 0
    if not args.source:
        build_parser().error("source is required (a video URL or local path)")

    media.require("ffmpeg")

    cap = args.max_frames if args.max_frames is not None else DETAIL_CAPS[args.detail]
    if cap is not None and cap < 0:
        raise SystemExit("--max-frames must be zero or greater")
    cue_stamps = parse_stamps(args.timestamps)

    work, managed = new_work_dir(args.out_dir)
    print(f"[watch] work dir: {work}", file=sys.stderr)

    url_source = media.is_url(args.source)
    dl: dict = {"video_path": None, "subtitle_path": None, "info": {}}
    segments: list[dict] = []
    source_label = "none"

    # Captions first: on a captioned URL at transcript detail this is the whole
    # job, and no media is ever downloaded.
    if url_source:
        print("[watch] fetching metadata + captions...", file=sys.stderr)
        dl = media.fetch_captions(args.source, work / "download")
        if dl.get("subtitle_path"):
            try:
                segments = tx.parse_captions(dl["subtitle_path"])
                source_label = "captions"
            except Exception as exc:
                print(f"[watch] caption parse failed: {exc}", file=sys.stderr)

    needs_pixels = args.detail != "transcript" or bool(cue_stamps)
    video_path: str | None = None
    if needs_pixels or not segments:
        audio_only = not needs_pixels
        if url_source:
            print(f"[watch] downloading {'audio' if audio_only else 'video'}...",
                  file=sys.stderr)
            dl = media.download(args.source, work / "download", audio_only=audio_only)
        else:
            dl = media.download(args.source, work / "download")
            if dl.get("subtitle_path") and not segments:
                try:
                    segments = tx.parse_captions(dl["subtitle_path"])
                    source_label = "sidecar captions"
                except Exception as exc:
                    print(f"[watch] sidecar parse failed: {exc}", file=sys.stderr)
        video_path = dl["video_path"]

    info = dl.get("info") or {}
    if video_path:
        meta = media.get_metadata(video_path)
    else:
        meta = {"duration_seconds": float(info.get("duration") or 0), "width": None,
                "height": None, "codec": None, "has_audio": False, "probe": "info-json"}
    duration = meta["duration_seconds"]

    start = media.parse_time(args.start)
    end = media.parse_time(args.end)
    if start is not None and start < 0:
        raise SystemExit("--start must be non-negative")
    if start is not None and end is not None and end <= start:
        raise SystemExit("--end must be greater than --start")
    if duration > 0 and start is not None and start >= duration:
        raise SystemExit(f"--start {start:.1f}s is past the end ({duration:.1f}s)")

    focused = start is not None or end is not None
    span_start = start or 0.0
    span_end = end if end is not None else duration
    span = max(0.0, span_end - span_start)

    fps, target = media.auto_fps(span, cap if cap else 100, focused)
    if args.fps is not None:
        fps = min(args.fps, media.MAX_FPS)
        target = max(1, int(round(fps * span)))

    # Cue frames are pinned first and charged against the cap, so the sampler
    # can never evict a moment the caller explicitly asked for.
    frames: list[dict] = []
    cue_frames: list[dict] = []
    cues_dropped = 0
    if cue_stamps and video_path:
        cue_frames, cues_dropped = media.extract_at(
            video_path, work / "frames", cue_stamps, args.resolution, start, end)

    fmeta: dict = {"engine": "none", "candidates": 0, "selected": 0,
                   "fallback": False, "deduped": 0}
    budget = None if cap is None else max(0, cap - len(cue_frames))
    if args.detail != "transcript" and video_path and budget != 0:
        print(f"[watch] extracting frames over "
              f"{media.format_time(span_start)}-{media.format_time(span_end)}...",
              file=sys.stderr)
        frames, fmeta = media.select_frames(
            video_path, work / "frames", args.detail, fps, target,
            args.resolution, budget, start, end, not args.no_dedup)

    frames = sorted(frames + cue_frames,
                    key=lambda f: (f["timestamp_seconds"] is None,
                                   f["timestamp_seconds"] or 0.0))

    # Speech-to-text only if captions gave us nothing.
    if not segments and video_path and meta.get("has_audio"):
        try:
            segments, source_label = tx.obtain(
                video_path, work, args.stt, args.allow_remote_transcription)
        except SystemExit as exc:
            print(f"[watch] transcription failed: {exc}", file=sys.stderr)
            source_label = "failed"
    elif not segments and video_path:
        source_label = "no audio track"

    if segments and focused:
        segments = tx.filter_range(segments, start, end)

    # The markdown report is the model-facing surface and is already verified,
    # so --json wraps it rather than growing a second renderer that could drift.
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        emit_report(args, info, meta, duration, focused, span_start, span_end,
                    span, frames, fmeta, cue_frames, cues_dropped, segments,
                    source_label, work, managed)
    report = buffer.getvalue()

    if not args.json:
        print(report, end="")
        return 0

    json.dump({
        "report": report,
        "source": safety.inline_untrusted(args.source),
        "title": safety.inline_untrusted(info.get("title") or ""),
        "uploader": safety.inline_untrusted(info.get("uploader") or ""),
        "durationSeconds": round(duration, 2),
        "detail": args.detail,
        "focus": ({"start": span_start, "end": span_end} if focused else None),
        "engine": fmeta.get("engine", "none"),
        "fallback": bool(fmeta.get("fallback")),
        "dedupedCount": fmeta.get("deduped", 0),
        "candidateCount": fmeta.get("candidates", 0),
        "cueCount": len(cue_frames),
        "frames": [
            {"path": f["path"], "t": f["timestamp_seconds"], "reason": f["reason"]}
            for f in frames
        ],
        "transcriptSource": source_label,
        "transcriptSegments": len(segments),
        "truncated": bool(fmeta.get("truncated")),
        "probe": meta.get("probe"),
        "workDir": str(work),
        "managedWorkDir": managed,
    }, sys.stdout)
    return 0


def emit_report(
    args, info, meta, duration, focused, span_start, span_end, span,
    frames, fmeta, cue_frames, cues_dropped, segments, source_label, work, managed,
) -> None:
    print()
    print("# watch report")
    print()
    print(f"- **Source:** `{safety.inline_untrusted(args.source)}`")
    if info.get("title"):
        print(f"- **Title:** `{safety.inline_untrusted(info['title'])}`  "
              "_(uploader-supplied)_")
    if info.get("uploader"):
        print(f"- **Uploader:** `{safety.inline_untrusted(info['uploader'])}`")
    print(f"- **Duration:** {media.format_time(duration)} ({duration:.1f}s)")
    if focused:
        print(f"- **Focus:** {media.format_time(span_start)} -> "
              f"{media.format_time(span_end)} ({span:.1f}s)")
    if meta.get("width"):
        print(f"- **Video:** {meta['width']}x{meta['height']} "
              f"({meta.get('codec') or 'unknown'}), probed via {meta.get('probe')}")
    print(f"- **Detail:** {args.detail}")

    if args.detail == "transcript" and not frames:
        print("- **Frames:** none (transcript detail)")
    else:
        bits = [f"{fmeta.get('engine', 'none')} engine"]
        if fmeta.get("fallback"):
            bits.append("uniform fallback (no scene cuts found)")
        if fmeta.get("deduped"):
            bits.append(f"{fmeta['deduped']} near-duplicates dropped")
        if cue_frames:
            bits.append(f"{len(cue_frames)} cue frames pinned")
        if cues_dropped:
            bits.append(f"{cues_dropped} cues outside focus range")
        print(f"- **Frames:** {len(frames)} "
              f"from {fmeta.get('candidates', len(frames))} candidates "
              f"({', '.join(bits)})")
        print(f"- **Frame size:** {args.resolution}px wide "
              f"(~{args.resolution * args.resolution // 750 // 2} tokens each)")
    print(f"- **Transcript:** {len(segments)} segments via {source_label}")

    if duration > 600 and not focused and args.detail in ("efficient", "balanced"):
        per = duration / max(1, len(frames))
        print()
        print(f"> **Sparse scan.** One frame per {per:.0f}s across "
              f"{media.format_time(duration)}. For a question about a specific "
              "moment, re-run with `--start`/`--end`; for full coverage use "
              "`--detail full`.")

    if fmeta.get("truncated"):
        print()
        print("> **Truncated.** The candidate ceiling was reached, so detection "
              "stopped before the end of the range and coverage is NOT complete. "
              "Re-run a narrower `--start`/`--end` window.")

    print()
    print("## Frames")
    print()
    if frames:
        print("**Read every path below with the Read tool** -- they render as "
              "images. Chronological; `t=` is absolute source time.")
        print()
        for frame in frames:
            stamp = frame["timestamp_seconds"]
            # An unknown timestamp is printed as `?`, never as the range start:
            # a confidently wrong `t=` is worse than an admitted gap.
            label = media.format_time(stamp) if stamp is not None else "?"
            print(f"- `{frame['path']}` (t={label}, {frame['reason']})")
    else:
        print("_No frames extracted._")

    print()
    print("## Transcript")
    print()
    if segments:
        print(f"_Source: {source_label}._")
        print()
        print(safety.wrap_untrusted(tx.format_transcript(segments), "transcript"))
    else:
        print(f"_No transcript: {source_label}._")
        if source_label.startswith("blocked"):
            print()
            print("Pass `--allow-remote-transcription` to permit the upload, or "
                  "install a local Whisper CLI to keep audio on this machine.")

    print()
    print("---")
    if managed:
        print(f"_Working files: `{work}` (auto-pruned after {KEEP_RUNS} runs; "
              f"`python watch.py --cleanup` clears them now)._")
    else:
        print(f"_Working files: `{work}` (you supplied --out-dir; not managed)._")


if __name__ == "__main__":
    raise SystemExit(main())
