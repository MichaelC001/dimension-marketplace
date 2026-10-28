#!/usr/bin/env python3
"""yt-dlp, provisioned by the engine.

yt-dlp is the one tool this engine installs for itself, so a fresh machine only
needs ffmpeg. Resolution order:

1. `python -m yt_dlp` under the interpreter the engine already runs in, when the
   module is importable (or, inside a virtual environment, when the pack-owned
   copy below exists). `pip install yt-dlp` puts `yt-dlp.exe` in a Scripts
   directory that is usually not on PATH, so a PATH lookup alone fails on
   Windows even though the install succeeded.
2. The `yt-dlp` executable on PATH (brew, winget, pipx, apt), but only one that
   cannot be planted: an absolute path outside the working directory, `.exe` on
   Windows. A `.cmd`/`.bat` or a file in the current directory is never run,
   because Windows resolves both ahead of the real PATH.
3. `pip install -U yt-dlp`, then use (1). A virtual environment the engine did
   not create is never written to: there the install goes to a pack-owned
   directory in the user cache (`pip --target`) that is put on the yt-dlp
   child's PYTHONPATH explicitly. Elsewhere it is `pip --user`.

Only the latest yt-dlp is supported, because sites routinely break older
releases. A 403 or sign-in refusal therefore upgrades it and retries once; the
upgrade runs at most once per 24 hours per interpreter, so a site that keeps
answering 403 cannot make the engine reinstall software on every run. A copy
that is present but fails to start (import error) is reinstalled the same way.
Every install runs under an exclusive lock so concurrent watch runs never race
pip, and every install is reported in the tool result.

Every child runs in a fresh empty working directory: `python -m` puts the
working directory first on sys.path, so a project that happens to contain a
`yt_dlp` or `pip` package would otherwise be imported in place of the real one.
"""
from __future__ import annotations

import contextlib
import errno
import hashlib
import importlib
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import proc
import safety

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

PIP_TIMEOUT_SECONDS = 240
VERSION_TIMEOUT_SECONDS = 90
LOCK_WAIT_SECONDS = PIP_TIMEOUT_SECONDS + 2 * VERSION_TIMEOUT_SECONDS + 30
LOCK_POLL_SECONDS = 0.25
RETRY_INTERVAL_SECONDS = 24 * 60 * 60
MODULE_CMD = [sys.executable, "-m", "yt_dlp"]
EXECUTABLE_NAME = "yt-dlp.exe" if sys.platform == "win32" else "yt-dlp"
MANUAL_INSTALL_HINT = (
    "Install it yourself, then retry:\n"
    f'  Any OS:  "{sys.executable}" -m pip install -U yt-dlp\n'
    "  Windows: winget install yt-dlp.yt-dlp\n"
    "  macOS:   brew install yt-dlp\n"
    "  Linux:   pipx install yt-dlp"
)
REFUSAL = re.compile(r"\b403\b|forbidden|sign in|log ?in required|not a bot", re.IGNORECASE)
TRACEBACK_HEAD = "Traceback (most recent call last):"
IMPORT_FAILURE = re.compile(r"(?:ModuleNotFoundError|ImportError)\b")
MISSING_MODULE = re.compile(r"No module named '?yt_dlp\b")

INSTALL = "install"
UPGRADE = "upgrade"
REPAIR = "repair"
RATE_LIMITED = (UPGRADE, REPAIR)
ACTIONS = {
    INSTALL: ("yt-dlp not found; installing it", "installed"),
    UPGRADE: ("upgrading yt-dlp", "upgraded"),
    REPAIR: ("yt-dlp is present but does not start; reinstalling it", "reinstalled"),
}

_resolved: list[str] | None = None
_upgraded = False
_repaired = False
_events: list[str] = []


class ProvisionBlocked(Exception):
    """An install could not start: the cache is unwritable or the lock never freed."""


def cache_root() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = str(Path.home() / "Library" / "Caches")
    else:
        xdg = os.environ.get("XDG_CACHE_HOME", "")
        base = xdg if os.path.isabs(xdg) else str(Path.home() / ".cache")
    return Path(base) / "inso-watch"


def _in_virtualenv() -> bool:
    return sys.prefix != getattr(sys, "base_prefix", sys.prefix)


def pack_target() -> Path | None:
    """Where yt-dlp is installed when the interpreter is a virtual environment."""
    return cache_root() / "yt-dlp" if _in_virtualenv() else None


def _pack_has_module() -> bool:
    target = pack_target()
    return target is not None and (target / "yt_dlp" / "__main__.py").is_file()


def _child_env(cmd: list[str]) -> dict[str, str]:
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    if cmd[:3] == MODULE_CMD and _pack_has_module():
        env["PYTHONPATH"] = os.pathsep.join(
            part for part in (str(pack_target()), env.get("PYTHONPATH")) if part
        )
    return env


def _run_isolated(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory(prefix="watch-") as cwd:
        return proc.run(cmd, cwd=cwd, env=_child_env(cmd), stdin=subprocess.DEVNULL, **kw)


def _tail(text: str | None, lines: int = 6) -> str:
    return "\n".join((text or "").strip().splitlines()[-lines:])


def interpreter_has_module() -> bool:
    """True when `python -m yt_dlp` can start here. Reads the import path only."""
    try:
        spec = importlib.util.find_spec("yt_dlp")
    except (ImportError, ValueError):
        return False
    roots = spec.submodule_search_locations if spec and spec.origin else None
    return any((Path(root) / "__main__.py").is_file() for root in roots or ())


def _partial_install_present() -> bool:
    try:
        spec = importlib.util.find_spec("yt_dlp")
    except (ImportError, ValueError):
        return False
    return spec is not None and not interpreter_has_module()


def _is_under(path: str, root: str) -> bool:
    root = os.path.normcase(root)
    try:
        return os.path.commonpath([os.path.normcase(path), root]) == root
    except ValueError:
        return False


def path_executable() -> str | None:
    """The `yt-dlp` executable on PATH, or None when none is safe to run.

    Safe means absolute, outside the working directory, and a real executable:
    `yt-dlp.exe` on Windows (never `.cmd`/`.bat`, which cmd.exe interprets), an
    executable file elsewhere. Relative and empty PATH entries are skipped,
    because they resolve against whatever directory the engine was started in.
    """
    try:
        cwd = os.getcwd()
    except OSError:
        return None
    cwd_real = os.path.realpath(cwd)
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        entry = entry.strip().strip('"')
        if not entry or not os.path.isabs(entry):
            continue
        candidate = os.path.abspath(os.path.join(entry, EXECUTABLE_NAME))
        if not os.path.isfile(candidate):
            continue
        if sys.platform != "win32" and not os.access(candidate, os.X_OK):
            continue
        if _is_under(candidate, cwd) or _is_under(os.path.realpath(candidate), cwd_real):
            continue
        return candidate
    return None


def locate() -> list[str] | None:
    if interpreter_has_module() or _pack_has_module():
        return list(MODULE_CMD)
    on_path = path_executable()
    return [on_path] if on_path else None


def version_of(cmd: list[str]) -> str | None:
    try:
        result = _run_isolated([*cmd, "--version"], timeout=VERSION_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return None
    lines = result.stdout.strip().splitlines()
    return lines[0] if result.returncode == 0 and lines else None


def pip_install_command(*, force_reinstall: bool = False) -> list[str]:
    """`pip install -U yt-dlp` for the running interpreter.

    `--user` keeps a system Python untouched. Inside a virtual environment the
    engine did not create, nothing is written to the environment: pip installs
    into the pack-owned directory (`--target`) that `_child_env` puts on the
    yt-dlp child's PYTHONPATH. `--force-reinstall` repairs a partial install
    that `-U` alone would report as already satisfied.
    """
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
    target = pack_target()
    cmd += ["--target", str(target)] if target is not None else ["--user"]
    if force_reinstall:
        cmd.append("--force-reinstall")
    return [*cmd, "-U", "yt-dlp"]


def _pip_install(*, force_reinstall: bool = False) -> tuple[bool, str]:
    try:
        result = _run_isolated(
            pip_install_command(force_reinstall=force_reinstall), timeout=PIP_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        return False, f"pip did not finish within {PIP_TIMEOUT_SECONDS}s"
    return result.returncode == 0, _tail(result.stderr or result.stdout)


def _try_lock(fd: int) -> bool:
    try:
        if sys.platform == "win32":
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
            return False
        raise ProvisionBlocked(f"cannot lock the install file: {exc.strerror or exc}") from None
    return True


def _unlock(fd: int) -> None:
    if sys.platform == "win32":
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)


@contextlib.contextmanager
def install_lock():
    """Exclusive across processes. The OS drops it when the holder dies, so it cannot go stale."""
    root = cache_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        fd = os.open(root / "install.lock", os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        raise ProvisionBlocked(
            f"cannot create the install lock under {root}: {exc.strerror or exc}"
        ) from None
    try:
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while not _try_lock(fd):
            if time.monotonic() >= deadline:
                raise ProvisionBlocked(
                    f"another watch run has been installing yt-dlp for over {LOCK_WAIT_SECONDS}s"
                )
            time.sleep(LOCK_POLL_SECONDS)
        try:
            yield
        finally:
            _unlock(fd)
    finally:
        os.close(fd)


def _stamp_path(action: str) -> Path:
    interpreter = os.path.realpath(sys.executable).encode("utf-8", "replace")
    return cache_root() / f"{action}-{hashlib.sha256(interpreter).hexdigest()[:16]}.stamp"


def _stamp_is_fresh(action: str) -> bool:
    try:
        age = time.time() - _stamp_path(action).stat().st_mtime
    except OSError:
        return False
    return 0 <= age < RETRY_INTERVAL_SECONDS


def _stamp(action: str) -> None:
    path = _stamp_path(action)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(int(time.time())), encoding="utf-8")
    except OSError as exc:
        raise ProvisionBlocked(
            f"cannot record the {action} under {path.parent}: {exc.strerror or exc}"
        ) from None


def _settled_elsewhere(action: str) -> bool:
    """Evaluated under the lock: did a concurrent run already do this work?"""
    if action in RATE_LIMITED:
        return _stamp_is_fresh(action)
    importlib.invalidate_caches()
    return interpreter_has_module() or _pack_has_module()


def _install_location() -> str:
    target = pack_target()
    if target is None:
        return f"for this user account (pip --user, {sys.executable})"
    return f"into {target} (the virtual environment {sys.prefix} was left untouched)"


def _provision(action: str, *, force_reinstall: bool = False) -> tuple[str | None, str]:
    """pip install under the lock, then prove the module runs. Returns (version or None, diagnostic)."""
    purpose, verb = ACTIONS[action]
    try:
        with install_lock():
            if _settled_elsewhere(action):
                return version_of(MODULE_CMD), ""
            if action in RATE_LIMITED:
                _stamp(action)
            print(f"[watch] {purpose} (pip, {sys.executable})...", file=sys.stderr)
            installed, output = _pip_install(force_reinstall=force_reinstall)
            if not installed:
                return None, output or "pip exited without output"
            version = version_of(MODULE_CMD)
            if version is None:
                return None, f"pip succeeded but `{sys.executable} -m yt_dlp --version` did not run"
    except ProvisionBlocked as blocked:
        return None, str(blocked)
    shown = safety.inline_untrusted(version, 40)
    _events.append(f"{verb} yt-dlp {shown} {_install_location()}")
    print(f"[watch] yt-dlp is now {shown}", file=sys.stderr)
    return version, output


def provisioning_notes() -> list[str]:
    """What this process installed, upgraded or reinstalled, for the tool result."""
    return list(_events)


def _install() -> list[str]:
    version, output = _provision(INSTALL, force_reinstall=_partial_install_present())
    if version is None:
        raise SystemExit(
            "yt-dlp is not installed and installing it automatically failed.\n"
            f"  {safety.labeled_diagnostic(output)}\n"
            + MANUAL_INSTALL_HINT
        )
    return list(MODULE_CMD)


def _reprovision(action: str, *, force_reinstall: bool = False) -> bool:
    """Run a rate-limited install. On success the interpreter's module outranks a PATH copy."""
    global _resolved
    if _stamp_is_fresh(action):
        print(f"[watch] yt-dlp {action} was already attempted within the last 24 h; "
              "not attempting it again", file=sys.stderr)
        return False
    version, output = _provision(action, force_reinstall=force_reinstall)
    if version is None:
        print(f"[watch] yt-dlp {action} failed: " + safety.labeled_diagnostic(output),
              file=sys.stderr)
        return False
    _resolved = list(MODULE_CMD)
    return True


def _upgrade() -> bool:
    return _reprovision(UPGRADE)


def _repair() -> bool:
    return _reprovision(REPAIR, force_reinstall=True)


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


def module_failed_to_start(stderr: str | None) -> bool:
    """True when stderr is Python failing to import yt-dlp, not yt-dlp reporting an error.

    A Python traceback ends in its exception line, so an import failure is the
    last line after a `Traceback` header; `python -m` on a vanished package is
    one first line. yt-dlp's own failures are `ERROR:` lines, which carry
    server-supplied text and must never be able to look like this.
    """
    lines = [line for line in (stderr or "").splitlines() if line.strip()]
    if not lines:
        return False
    if any(line.strip() == TRACEBACK_HEAD for line in lines) and IMPORT_FAILURE.match(lines[-1]):
        return True
    return bool(MISSING_MODULE.search(lines[0]))


def run(args: list[str]) -> subprocess.CompletedProcess:
    """Run yt-dlp with `args`.

    A copy that fails to start is reinstalled once; a 403 / sign-in refusal
    upgrades it (at most once per 24 h) and retries once.
    """
    global _upgraded, _repaired
    cmd = command()
    result = _run_isolated([*cmd, *args])
    if (
        result.returncode != 0
        and cmd[:3] == MODULE_CMD
        and not _repaired
        and module_failed_to_start(result.stderr)
    ):
        _repaired = True
        print("[watch] yt-dlp is installed but did not start; reinstalling it once "
              "and retrying once...", file=sys.stderr)
        if _repair():
            result = _run_isolated([*command(), *args])
    if result.returncode != 0 and not _upgraded and was_refused(result.stderr):
        _upgraded = True
        print("[watch] yt-dlp was refused (HTTP 403 / sign-in); trying one upgrade "
              "(at most once per 24 h) and retrying once...", file=sys.stderr)
        if _upgrade():
            result = _run_isolated([*command(), *args])
    return result
