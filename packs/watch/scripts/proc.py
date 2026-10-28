#!/usr/bin/env python3
"""Subprocess helpers shared by every engine module. Never a shell.

Output is captured and decoded as UTF-8 with `errors="replace"`. That is not
cosmetic: ffmpeg and yt-dlp echo the source's own metadata, and on a Windows
console Python otherwise decodes it as cp1252 and raises UnicodeDecodeError on
the first non-ASCII video title.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


def spawn(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """Run `cmd`, capturing UTF-8 text. An unlaunchable binary raises OSError."""
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw
    )


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """spawn, with a launch failure turned into an actionable exit.

    WinError 4551 (blocked by Application Control) and a missing execute bit
    both arrive as OSError; without this they surface as a bare traceback.
    """
    try:
        return spawn(cmd, **kw)
    except OSError as exc:
        raise SystemExit(
            f"cannot run {Path(cmd[0]).name}: {exc.strerror or type(exc).__name__}. "
            "Check that it is installed and that this machine's application-control "
            "policy allows it."
        ) from None
