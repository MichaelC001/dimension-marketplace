#!/usr/bin/env python3
"""yt-dlp, provisioned by the engine.

yt-dlp is the one tool this engine installs for itself, so a fresh machine only
needs ffmpeg. Resolution order:

1. `python -m yt_dlp` under the interpreter the engine already runs in, when the
   module is importable. `pip install yt-dlp` puts `yt-dlp.exe` in a Scripts
   directory that is usually not on PATH, so a PATH lookup alone fails on
   Windows even though the install succeeded.
2. The `yt-dlp` executable on PATH (brew, winget, pipx, apt).
3. `pip install -U yt-dlp` into that same interpreter, then use (1).

Only the latest yt-dlp is supported, because sites routinely break older
releases. A 403 or sign-in refusal therefore upgrades it once and retries once.

Every child runs in a fresh empty working directory: `python -m` puts the
working directory first on sys.path, so a project that happens to contain a
`yt_dlp` or `pip` package would otherwise be imported in place of the real one.
"""
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import proc
import safety

PIP_TIMEOUT_SECONDS = 240
VERSION_TIMEOUT_SECONDS = 90
MODULE_CMD = [sys.executable, "-m", "yt_dlp"]
MANUAL_INSTALL_HINT = (
    "Install it yourself, then retry:\n"
    "  Windows: py -m pip install -U yt-dlp   (or: winget install yt-dlp.yt-dlp)\n"
    "  macOS:   brew install yt-dlp\n"
    "  Linux:   pipx install yt-dlp"
)
REFUSAL = re.compile(r"\b403\b|forbidden|sign in|log ?in required|not a bot", re.IGNORECASE)

_resolved: list[str] | None = None
_upgraded = False


def _utf8_env() -> dict[str, str]:
    return {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


def _run_isolated(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory(prefix="watch-") as cwd:
        return proc.run(cmd, cwd=cwd, env=_utf8_env(), stdin=subprocess.DEVNULL, **kw)


def _tail(text: str | None, lines: int = 6) -> str:
    return "\n".join((text or "").strip().splitlines()[-lines:])


def _in_virtualenv() -> bool:
    return sys.prefix != getattr(sys, "base_prefix", sys.prefix)


def interpreter_has_module() -> bool:
    """True when `python -m yt_dlp` can start here. Reads the import path only."""
    try:
        spec = importlib.util.find_spec("yt_dlp")
    except (ImportError, ValueError):
        return False
    roots = spec.submodule_search_locations if spec and spec.origin else None
    return any((Path(root) / "__main__.py").is_file() for root in roots or ())


def locate() -> list[str] | None:
    if interpreter_has_module():
        return list(MODULE_CMD)
    on_path = shutil.which("yt-dlp")
    return [on_path] if on_path else None


def version_of(cmd: list[str]) -> str | None:
    try:
        result = _run_isolated([*cmd, "--version"], timeout=VERSION_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return None
    lines = result.stdout.strip().splitlines()
    return lines[0] if result.returncode == 0 and lines else None


def pip_install_command() -> list[str]:
    """`pip install -U yt-dlp` for the running interpreter.

    `--user` keeps a system Python untouched; pip refuses it inside a virtual
    environment, where the environment itself is already the user's.
    """
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
    if not _in_virtualenv():
        cmd.append("--user")
    return [*cmd, "-U", "yt-dlp"]


def _pip_install() -> tuple[bool, str]:
    try:
        result = _run_isolated(pip_install_command(), timeout=PIP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return False, f"pip did not finish within {PIP_TIMEOUT_SECONDS}s"
    return result.returncode == 0, _tail(result.stderr or result.stdout)


def _provision(purpose: str) -> tuple[str | None, str]:
    """pip install, then prove the module runs. Returns (version or None, diagnostic)."""
    print(f"[watch] {purpose} (pip, {sys.executable})...", file=sys.stderr)
    installed, output = _pip_install()
    if not installed:
        return None, output or "pip exited without output"
    version = version_of(MODULE_CMD)
    if version is None:
        return None, f"pip succeeded but `{sys.executable} -m yt_dlp --version` did not run"
    print(f"[watch] yt-dlp is now {safety.inline_untrusted(version, 40)}", file=sys.stderr)
    return version, output


def _install() -> list[str]:
    version, output = _provision("yt-dlp not found; installing it")
    if version is None:
        raise SystemExit(
            "yt-dlp is not installed and installing it automatically failed.\n"
            f"  {safety.labeled_diagnostic(output)}\n"
            + MANUAL_INSTALL_HINT
        )
    return list(MODULE_CMD)


def _upgrade() -> bool:
    """Upgrade once. On success the interpreter's module outranks a PATH copy."""
    global _resolved
    version, output = _provision("upgrading yt-dlp")
    if version is None:
        print("[watch] yt-dlp upgrade failed: " + safety.labeled_diagnostic(output),
              file=sys.stderr)
        return False
    _resolved = list(MODULE_CMD)
    return True


def command() -> list[str]:
    global _resolved
    if _resolved is None:
        _resolved = locate() or _install()
    return _resolved


def was_refused(stderr: str | None) -> bool:
    return any(
        line.startswith("ERROR:") and REFUSAL.search(line)
        for line in (stderr or "").splitlines()
    )


def run(args: list[str]) -> subprocess.CompletedProcess:
    """Run yt-dlp with `args`. A 403 / sign-in refusal upgrades it once and retries once."""
    global _upgraded
    result = _run_isolated([*command(), *args])
    if result.returncode != 0 and not _upgraded and was_refused(result.stderr):
        _upgraded = True
        print("[watch] yt-dlp was refused (HTTP 403 / sign-in); upgrading it once "
              "and retrying once...", file=sys.stderr)
        if _upgrade():
            result = _run_isolated([*command(), *args])
    return result
