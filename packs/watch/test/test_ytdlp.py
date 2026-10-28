"""Contracts of ytdlp.py: safe resolution, locked self-provisioning, and refusal recovery."""
from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import threading
import time
import types
from pathlib import Path

import pytest

import ytdlp

MODULE_CMD = [sys.executable, "-m", "yt_dlp"]
PATH_COPY = "/usr/local/bin/yt-dlp"
ARGS = ["--skip-download", "--", "https://example.test/watch?v=x"]
FORBIDDEN = "ERROR: [youtube] x: unable to download video data: HTTP Error 403: Forbidden"
BROKEN_START = "\n".join([
    "Traceback (most recent call last):",
    '  File "<frozen runpy>", line 198, in _run_module_as_main',
    '  File "site-packages/yt_dlp/__main__.py", line 6, in <module>',
    "ModuleNotFoundError: No module named 'yt_dlp.extractor'",
])
LABEL = "[UNTRUSTED-MEDIA-TEXT inline kind=tool-diagnostic]"
VERSION = "2026.10.26"

CHILD_PROBE = """\
import json, os
print(json.dumps({
    "cwd": os.getcwd(),
    "listing": os.listdir("."),
    "utf8": os.environ.get("PYTHONUTF8"),
    "inherited": os.environ.get("WATCH_TEST_INHERITED"),
}))
"""

STDIN_RELAY = """\
import sys
sys.path.insert(0, sys.argv[1])
import ytdlp
child = ytdlp._run_isolated([sys.executable, "-c", "import sys; sys.stdout.write(repr(sys.stdin.read()))"])
sys.stdout.write(child.stdout)
"""

HOLD_THE_INSTALL_LOCK = """\
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import ytdlp
ytdlp.cache_root = lambda: Path(sys.argv[2])
with ytdlp.install_lock():
    sys.stdout.write("held\\n")
    sys.stdout.flush()
    sys.stdin.read()
"""

PACK_OWNED_MAIN = """\
import json, sys
print(json.dumps({"copy": "pack-owned", "argv": sys.argv[1:], "path": sys.path}))
"""

PRINT_PYTHONPATH = "import os; print(os.environ.get('PYTHONPATH', ''))"


@pytest.fixture(autouse=True)
def pristine_module_state(monkeypatch, tmp_path):
    monkeypatch.setattr(ytdlp, "_resolved", None)
    monkeypatch.setattr(ytdlp, "_upgraded", False)
    monkeypatch.setattr(ytdlp, "_repaired", False)
    monkeypatch.setattr(ytdlp, "_events", [])
    monkeypatch.setattr(ytdlp, "cache_root", lambda: tmp_path / "user-cache" / "inso-watch")


def put_executable(directory: Path, name: str = ytdlp.EXECUTABLE_NAME) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    executable = directory / name
    executable.write_bytes(b"")
    executable.chmod(0o755)
    return executable


def set_path(monkeypatch, *entries) -> None:
    monkeypatch.setenv("PATH", os.pathsep.join(str(entry) for entry in entries))


@pytest.fixture
def project(tmp_path, monkeypatch):
    directory = tmp_path / "project"
    directory.mkdir()
    monkeypatch.chdir(directory)
    return directory


@pytest.fixture
def isolated_imports(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "path", [str(tmp_path)])
    monkeypatch.delitem(sys.modules, "yt_dlp", raising=False)
    importlib.invalidate_caches()
    return tmp_path


@pytest.fixture
def fake_yt_dlp_package(isolated_imports):
    def make(*files):
        package = isolated_imports / "yt_dlp"
        package.mkdir()
        for name in files:
            (package / name).write_text("", encoding="utf-8")
        importlib.invalidate_caches()

    return make


class ScriptedYtDlp:
    def __init__(self, *results):
        self.results = list(results)
        self.commands = []

    def __call__(self, cmd, **kw):
        self.commands.append(list(cmd))
        if len(self.commands) > len(self.results):
            raise AssertionError(f"unexpected extra yt-dlp invocation: {cmd}")
        return self.results[len(self.commands) - 1]


class ProvisionStub:
    def __init__(self, succeeds):
        self.succeeds = succeeds
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return self.succeeds


class PipStub:
    def __init__(self, succeeds=True, output=""):
        self.succeeds = succeeds
        self.output = output
        self.calls = []

    def __call__(self, **kw):
        self.calls.append(kw)
        return self.succeeds, self.output


@pytest.fixture
def scripted_run(monkeypatch):
    def install(*results, command=("yt-dlp",)):
        runner = ScriptedYtDlp(*results)
        monkeypatch.setattr(ytdlp, "command", lambda: list(command))
        monkeypatch.setattr(ytdlp, "_run_isolated", runner)
        return runner

    return install


@pytest.fixture
def stub_upgrade(monkeypatch):
    def install(succeeds):
        stub = ProvisionStub(succeeds)
        monkeypatch.setattr(ytdlp, "_upgrade", stub)
        return stub

    return install


@pytest.fixture
def stub_repair(monkeypatch):
    def install(succeeds):
        stub = ProvisionStub(succeeds)
        monkeypatch.setattr(ytdlp, "_repair", stub)
        return stub

    return install


@pytest.fixture
def stub_pip(monkeypatch):
    def install(**kw):
        stub = PipStub(**kw)
        monkeypatch.setattr(ytdlp, "_pip_install", stub)
        monkeypatch.setattr(ytdlp, "version_of", lambda cmd: VERSION)
        return stub

    return install


@pytest.fixture
def system_python(monkeypatch):
    monkeypatch.setattr(ytdlp, "_in_virtualenv", lambda: False)


@pytest.fixture
def virtualenv(monkeypatch):
    monkeypatch.setattr(ytdlp, "_in_virtualenv", lambda: True)


def test_locate_prefers_the_interpreter_module_over_a_path_executable(
    monkeypatch, tmp_path, project
):
    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: True)
    set_path(monkeypatch, put_executable(tmp_path / "tools").parent)

    assert ytdlp.locate() == MODULE_CMD


def test_locate_falls_back_to_a_path_executable_without_the_module(
    monkeypatch, tmp_path, project
):
    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: False)
    executable = put_executable(tmp_path / "tools")
    set_path(monkeypatch, executable.parent)

    assert ytdlp.locate() == [str(executable)]


def test_locate_reports_nothing_when_neither_exists(monkeypatch, tmp_path, project):
    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: False)
    set_path(monkeypatch, tmp_path / "empty")

    assert ytdlp.locate() is None


def test_path_lookup_never_resolves_a_batch_file_or_a_bare_script(monkeypatch, tmp_path, project):
    tools = tmp_path / "tools"
    tools.mkdir()
    for name in ("yt-dlp.cmd", "yt-dlp.bat", "yt-dlp.com", "yt-dlp"):
        (tools / name).write_text("echo planted", encoding="utf-8")
    set_path(monkeypatch, tools)

    assert ytdlp.path_executable() is None


@pytest.mark.parametrize(
    "path_entries",
    [
        pytest.param(lambda cwd: ["."], id="dot entry"),
        pytest.param(lambda cwd: ["", str(cwd.parent / "elsewhere")], id="empty entry"),
        pytest.param(lambda cwd: ["bin"], id="relative entry"),
        pytest.param(lambda cwd: [str(cwd)], id="absolute entry that is the cwd"),
        pytest.param(lambda cwd: [str(cwd / "bin")], id="absolute entry under the cwd"),
    ],
)
def test_path_lookup_never_resolves_a_file_planted_in_the_working_directory(
    monkeypatch, project, path_entries
):
    put_executable(project)
    put_executable(project / "bin")
    set_path(monkeypatch, *path_entries(project))

    assert ytdlp.path_executable() is None


def test_path_lookup_skips_an_unsafe_entry_and_keeps_looking(monkeypatch, tmp_path, project):
    put_executable(project)
    trusted = put_executable(tmp_path / "tools")
    set_path(monkeypatch, project, ".", trusted.parent)

    assert ytdlp.path_executable() == str(trusted)


@pytest.mark.skipif(sys.platform == "win32", reason="the execute bit is a POSIX notion")
def test_path_lookup_skips_a_file_without_the_execute_bit(monkeypatch, tmp_path, project):
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "yt-dlp").write_text("not executable", encoding="utf-8")
    set_path(monkeypatch, tools)

    assert ytdlp.path_executable() is None


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        pytest.param(("__init__.py", "__main__.py"), True, id="runnable package"),
        pytest.param(("__init__.py",), False, id="package without __main__"),
        pytest.param((), False, id="empty directory is a namespace package"),
    ],
)
def test_interpreter_has_module_only_for_a_package_that_dash_m_can_start(
    fake_yt_dlp_package, files, expected
):
    fake_yt_dlp_package(*files)

    assert ytdlp.interpreter_has_module() is expected


def test_interpreter_has_module_is_false_when_yt_dlp_is_not_importable(isolated_imports):
    assert ytdlp.interpreter_has_module() is False


def test_interpreter_has_module_treats_a_spec_less_placeholder_as_absent(monkeypatch):
    monkeypatch.setitem(sys.modules, "yt_dlp", types.ModuleType("yt_dlp"))

    assert ytdlp.interpreter_has_module() is False


def test_pip_install_command_installs_for_the_user_outside_a_virtualenv(system_python):
    cmd = ytdlp.pip_install_command()

    assert all(isinstance(part, str) for part in cmd)
    assert cmd[:4] == [sys.executable, "-m", "pip", "install"]
    assert cmd[-2:] == ["-U", "yt-dlp"]
    assert "--user" in cmd
    assert "--target" not in cmd
    assert "--force-reinstall" not in cmd


def test_pip_install_command_never_writes_into_a_virtualenv(virtualenv):
    cmd = ytdlp.pip_install_command()

    assert cmd[:4] == [sys.executable, "-m", "pip", "install"]
    assert cmd[-2:] == ["-U", "yt-dlp"]
    assert "--user" not in cmd
    assert cmd[cmd.index("--target") + 1] == str(ytdlp.cache_root() / "yt-dlp")


def test_pip_install_command_forces_a_reinstall_only_when_asked(system_python):
    assert "--force-reinstall" in ytdlp.pip_install_command(force_reinstall=True)
    assert "--force-reinstall" not in ytdlp.pip_install_command()


def test_command_installs_once_when_absent_and_verifies_the_module_it_installed(
    monkeypatch, system_python, isolated_imports
):
    verified = []
    pip = PipStub()

    def version_of(cmd):
        verified.append(cmd)
        return VERSION

    monkeypatch.setattr(ytdlp, "locate", lambda: None)
    monkeypatch.setattr(ytdlp, "_pip_install", pip)
    monkeypatch.setattr(ytdlp, "version_of", version_of)

    assert ytdlp.command() == ytdlp.MODULE_CMD
    assert ytdlp.command() == ytdlp.MODULE_CMD
    assert pip.calls == [{"force_reinstall": False}]
    assert verified == [ytdlp.MODULE_CMD]


def test_command_resolves_once_and_never_installs_what_it_found(monkeypatch):
    lookups = []

    def locate():
        lookups.append("locate")
        return [PATH_COPY]

    def pip_install(**kw):
        raise AssertionError("pip must not run when yt-dlp was found")

    monkeypatch.setattr(ytdlp, "locate", locate)
    monkeypatch.setattr(ytdlp, "_pip_install", pip_install)

    assert ytdlp.command() == [PATH_COPY]
    assert ytdlp.command() == [PATH_COPY]
    assert lookups == ["locate"]


def test_failed_install_exits_with_a_labeled_diagnostic_and_every_manual_hint(
    monkeypatch, system_python, isolated_imports
):
    monkeypatch.setattr(ytdlp, "locate", lambda: None)
    monkeypatch.setattr(
        ytdlp, "_pip_install", lambda **kw: (False, "ERROR: Could not find a version")
    )

    with pytest.raises(SystemExit) as exit_info:
        ytdlp.command()

    message = str(exit_info.value)
    assert LABEL in message
    assert "ERROR: Could not find a version" in message
    assert f'"{sys.executable}" -m pip install -U yt-dlp' in message
    assert "py -m" not in message
    assert "brew install yt-dlp" in message
    assert "pipx install yt-dlp" in message


def test_install_that_cannot_run_afterwards_still_exits_with_the_manual_hints(
    monkeypatch, system_python, isolated_imports
):
    monkeypatch.setattr(ytdlp, "locate", lambda: None)
    monkeypatch.setattr(ytdlp, "_pip_install", lambda **kw: (True, ""))
    monkeypatch.setattr(ytdlp, "version_of", lambda cmd: None)

    with pytest.raises(SystemExit) as exit_info:
        ytdlp.command()

    message = str(exit_info.value)
    assert LABEL in message
    assert f'"{sys.executable}" -m pip install -U yt-dlp' in message
    assert "pipx install yt-dlp" in message


def test_a_partial_install_is_reinstalled_by_force_but_a_missing_one_is_not(
    monkeypatch, fake_yt_dlp_package, system_python, stub_pip
):
    pip = stub_pip()

    ytdlp._install()
    fake_yt_dlp_package("__init__.py")
    ytdlp._install()

    assert [call["force_reinstall"] for call in pip.calls] == [False, True]


def test_an_install_that_cannot_take_the_lock_is_refused_without_running_pip(
    monkeypatch, tmp_path, system_python
):
    blocker = tmp_path / "a-file"
    blocker.write_text("not a directory", encoding="utf-8")
    monkeypatch.setattr(ytdlp, "cache_root", lambda: blocker / "inso-watch")
    monkeypatch.setattr(ytdlp, "_pip_install", lambda **kw: pytest.fail("pip ran unlocked"))

    version, output = ytdlp._provision(ytdlp.INSTALL)

    assert version is None
    assert "cannot create the install lock" in output


def test_concurrent_installs_never_run_pip_at_the_same_time_and_install_once(
    monkeypatch, system_python
):
    state = {"active": 0, "peak": 0, "calls": 0, "installed": False}

    def pip_install(**kw):
        state["calls"] += 1
        state["active"] += 1
        state["peak"] = max(state["peak"], state["active"])
        time.sleep(0.4)
        state["installed"] = True
        state["active"] -= 1
        return True, ""

    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: state["installed"])
    monkeypatch.setattr(ytdlp, "_pip_install", pip_install)
    monkeypatch.setattr(ytdlp, "version_of", lambda cmd: VERSION)
    results = []
    barrier = threading.Barrier(3)

    def worker():
        barrier.wait()
        results.append(ytdlp._provision(ytdlp.INSTALL))

    threads = [threading.Thread(target=worker) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert results == [(VERSION, "")] * 3
    assert state["peak"] == 1
    assert state["calls"] == 1


@pytest.fixture
def lock_holder(pack_root):
    holders = []

    def start():
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                HOLD_THE_INSTALL_LOCK,
                str(pack_root / "scripts"),
                str(ytdlp.cache_root()),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        holders.append(holder)
        assert holder.stdout.readline() == "held\n"
        return holder

    yield start
    for holder in holders:
        holder.kill()
        holder.wait(timeout=30)
        holder.stdin.close()
        holder.stdout.close()


def test_an_install_waits_for_a_lock_another_process_holds_then_gives_up_cleanly(
    monkeypatch, system_python, lock_holder
):
    lock_holder()
    monkeypatch.setattr(ytdlp, "LOCK_WAIT_SECONDS", 0.6)
    monkeypatch.setattr(ytdlp, "LOCK_POLL_SECONDS", 0.05)
    monkeypatch.setattr(ytdlp, "_pip_install", lambda **kw: pytest.fail("pip ran under a held lock"))

    version, output = ytdlp._provision(ytdlp.INSTALL)

    assert version is None
    assert "another watch run" in output


def test_a_crashed_lock_holder_never_leaves_a_stale_lock(
    monkeypatch, system_python, lock_holder, stub_pip
):
    holder = lock_holder()
    holder.kill()
    holder.wait(timeout=30)
    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: False)
    monkeypatch.setattr(ytdlp, "LOCK_WAIT_SECONDS", 10)
    pip = stub_pip()

    version, _ = ytdlp._provision(ytdlp.INSTALL)

    assert version == VERSION
    assert len(pip.calls) == 1


@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        pytest.param(BROKEN_START, True, id="import failure after a traceback"),
        pytest.param(
            "Traceback (most recent call last):\n  File \"x\", line 1\nImportError: cannot import name 'y'",
            True,
            id="import error",
        ),
        pytest.param(
            f"{sys.executable}: No module named yt_dlp.__main__; 'yt_dlp' is a package", True,
            id="python cannot find the package",
        ),
        pytest.param(FORBIDDEN, False, id="a refusal"),
        pytest.param("ERROR: Video unavailable", False, id="an ordinary yt-dlp error"),
        pytest.param(
            "ERROR: [x] a page said:\nImportError: pretend", False,
            id="server text without a traceback",
        ),
        pytest.param(
            "Traceback (most recent call last):\n  File \"x\", line 1\nKeyError: 'id'", False,
            id="a runtime traceback is not a broken install",
        ),
        pytest.param("", False, id="empty stderr"),
        pytest.param(None, False, id="no stderr"),
    ],
)
def test_module_failed_to_start_recognises_only_python_failing_to_import_yt_dlp(stderr, expected):
    assert ytdlp.module_failed_to_start(stderr) is expected


def test_a_module_that_fails_to_start_is_reinstalled_once_and_the_retry_returned(
    completed, scripted_run, stub_repair
):
    broken = completed(1, stderr=BROKEN_START)
    recovered = completed(0, stdout="done")
    runner = scripted_run(broken, recovered, command=MODULE_CMD)
    repair = stub_repair(True)

    result = ytdlp.run(ARGS)

    assert result is recovered
    assert repair.calls == 1
    assert runner.commands == [[*MODULE_CMD, *ARGS], [*MODULE_CMD, *ARGS]]


def test_a_module_that_still_fails_after_a_reinstall_is_returned_and_never_reinstalled_again(
    completed, scripted_run, stub_repair
):
    first = completed(1, stderr=BROKEN_START)
    second = completed(1, stderr=BROKEN_START)
    later = completed(1, stderr=BROKEN_START)
    runner = scripted_run(first, second, later, command=MODULE_CMD)
    repair = stub_repair(True)

    assert ytdlp.run(ARGS) is second
    assert ytdlp.run(ARGS) is later
    assert len(runner.commands) == 3
    assert repair.calls == 1


def test_a_failed_reinstall_returns_the_original_failure(completed, scripted_run, stub_repair):
    broken = completed(1, stderr=BROKEN_START)
    runner = scripted_run(broken, command=MODULE_CMD)
    repair = stub_repair(False)

    assert ytdlp.run(ARGS) is broken
    assert len(runner.commands) == 1
    assert repair.calls == 1


@pytest.mark.parametrize(
    ("command", "returncode", "stderr"),
    [
        pytest.param([PATH_COPY], 1, BROKEN_START, id="a PATH copy is not ours to reinstall"),
        pytest.param(MODULE_CMD, 0, BROKEN_START, id="a run that exited zero"),
        pytest.param(MODULE_CMD, 1, "ERROR: Video unavailable", id="an ordinary failure"),
    ],
)
def test_only_a_failing_interpreter_module_with_an_import_error_is_reinstalled(
    completed, scripted_run, stub_repair, command, returncode, stderr
):
    result = completed(returncode, stderr=stderr)
    runner = scripted_run(result, command=command)
    repair = stub_repair(True)

    assert ytdlp.run(ARGS) is result
    assert len(runner.commands) == 1
    assert repair.calls == 0


def test_a_reinstall_forces_pip_reports_itself_and_is_attempted_at_most_once_a_day(
    system_python, stub_pip
):
    pip = stub_pip()

    assert ytdlp._repair() is True
    assert ytdlp._repair() is False

    assert pip.calls == [{"force_reinstall": True}]
    assert len(ytdlp.provisioning_notes()) == 1
    assert ytdlp.provisioning_notes()[0].startswith(f"reinstalled yt-dlp {VERSION}")


@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        pytest.param(
            "ERROR: [youtube] x: Sign in to confirm you\u2019re not a bot. Use --cookies",
            True,
            id="sign-in wall",
        ),
        pytest.param(FORBIDDEN, True, id="http 403 forbidden"),
        pytest.param("WARNING: retrying\nERROR: HTTP Error 403\n", True, id="error line after a warning"),
        pytest.param("ERROR: Private video. Login required to view", True, id="login required"),
        pytest.param("ERROR: forbidden", True, id="lowercase forbidden"),
        pytest.param("ERROR: Video unavailable", False, id="unavailable video"),
        pytest.param("ERROR: connect to port 4030 refused", False, id="403 inside a larger number"),
        pytest.param("[download] Destination: Sign in 403.mp4", False, id="403 in a progress line"),
        pytest.param("WARNING: HTTP Error 403: Forbidden, retrying", False, id="refusal text in a warning"),
        pytest.param("", False, id="empty stderr"),
        pytest.param(None, False, id="no stderr"),
    ],
)
def test_was_refused_counts_only_refusals_reported_on_error_lines(stderr, expected):
    assert ytdlp.was_refused(stderr) is expected


def test_a_refusal_upgrades_yt_dlp_once_and_returns_the_retry(
    completed, scripted_run, stub_upgrade
):
    refused = completed(1, stderr=FORBIDDEN)
    recovered = completed(0, stdout="done")
    runner = scripted_run(refused, recovered)
    upgrade = stub_upgrade(True)

    result = ytdlp.run(ARGS)

    assert result is recovered
    assert upgrade.calls == 1
    assert runner.commands == [["yt-dlp", *ARGS], ["yt-dlp", *ARGS]]


def test_the_retry_after_an_upgrade_runs_the_interpreter_module_not_the_path_copy(
    monkeypatch, completed, stub_pip, system_python
):
    monkeypatch.setattr(ytdlp, "_resolved", [PATH_COPY])
    stub_pip()
    runner = ScriptedYtDlp(completed(1, stderr=FORBIDDEN), completed(0))
    monkeypatch.setattr(ytdlp, "_run_isolated", runner)

    ytdlp.run(ARGS)

    assert runner.commands == [[PATH_COPY, *ARGS], [*MODULE_CMD, *ARGS]]


def test_a_second_refusal_is_returned_and_the_process_never_upgrades_again(
    completed, scripted_run, stub_upgrade
):
    first = completed(1, stderr=FORBIDDEN)
    second = completed(1, stderr=FORBIDDEN)
    later = completed(1, stderr=FORBIDDEN)
    runner = scripted_run(first, second, later)
    upgrade = stub_upgrade(True)

    assert ytdlp.run(ARGS) is second
    assert len(runner.commands) == 2

    assert ytdlp.run(ARGS) is later
    assert len(runner.commands) == 3
    assert upgrade.calls == 1


def test_a_failed_upgrade_returns_the_original_failure_and_is_never_attempted_again(
    completed, scripted_run, stub_upgrade
):
    refused = completed(1, stderr=FORBIDDEN)
    later = completed(1, stderr=FORBIDDEN)
    runner = scripted_run(refused, later)
    upgrade = stub_upgrade(False)

    assert ytdlp.run(ARGS) is refused
    assert len(runner.commands) == 1

    assert ytdlp.run(ARGS) is later
    assert len(runner.commands) == 2
    assert upgrade.calls == 1


@pytest.mark.parametrize(
    ("returncode", "stderr"),
    [
        pytest.param(1, "ERROR: Video unavailable", id="not a refusal"),
        pytest.param(
            1,
            "[download] Destination: Sign in 403.mp4\nERROR: ffmpeg exited",
            id="refusal words only in a progress line",
        ),
        pytest.param(
            1,
            "WARNING: [youtube] HTTP Error 403: Forbidden, retrying\nERROR: Video unavailable",
            id="refusal words only in a warning",
        ),
        pytest.param(0, FORBIDDEN, id="refusal text on a run that exited zero"),
    ],
)
def test_failures_that_are_not_a_refusal_neither_upgrade_nor_retry(
    completed, scripted_run, stub_upgrade, returncode, stderr
):
    result = completed(returncode, stderr=stderr)
    runner = scripted_run(result)
    upgrade = stub_upgrade(True)

    assert ytdlp.run(ARGS) is result
    assert len(runner.commands) == 1
    assert upgrade.calls == 0


def test_a_successful_upgrade_makes_the_interpreter_module_outrank_a_path_copy(
    monkeypatch, system_python, stub_pip
):
    monkeypatch.setattr(ytdlp, "_resolved", [PATH_COPY])
    stub_pip()

    assert ytdlp._upgrade() is True
    assert ytdlp.command() == MODULE_CMD


def test_a_failed_upgrade_keeps_the_working_command_and_labels_pip_output(
    monkeypatch, capsys, system_python, stub_pip
):
    monkeypatch.setattr(ytdlp, "_resolved", [PATH_COPY])
    stub_pip(succeeds=False, output="ERROR: no network")

    assert ytdlp._upgrade() is False
    assert ytdlp.command() == [PATH_COPY]
    reported = capsys.readouterr().err
    assert LABEL in reported
    assert "ERROR: no network" in reported


def test_an_upgrade_runs_at_most_once_in_24_hours_even_across_processes(
    system_python, stub_pip
):
    pip = stub_pip()

    assert ytdlp._upgrade() is True
    assert ytdlp._upgrade() is False

    assert len(pip.calls) == 1


def test_a_failed_upgrade_also_uses_up_the_daily_attempt(system_python, stub_pip):
    pip = stub_pip(succeeds=False, output="ERROR: no network")

    assert ytdlp._upgrade() is False
    assert ytdlp._upgrade() is False

    assert len(pip.calls) == 1


def test_an_upgrade_is_allowed_again_once_a_day_has_passed(system_python, stub_pip):
    pip = stub_pip()
    assert ytdlp._upgrade() is True
    stamp = ytdlp._stamp_path(ytdlp.UPGRADE)
    yesterday = time.time() - 25 * 60 * 60
    os.utime(stamp, (yesterday, yesterday))

    assert ytdlp._upgrade() is True

    assert len(pip.calls) == 2


def test_the_daily_upgrade_limit_belongs_to_one_interpreter(monkeypatch, system_python, stub_pip):
    pip = stub_pip()
    assert ytdlp._upgrade() is True

    monkeypatch.setattr(sys, "executable", str(Path(sys.executable).with_name("another-python")))

    assert ytdlp._upgrade() is True
    assert len(pip.calls) == 2


def test_a_refusal_within_a_day_of_an_upgrade_is_returned_without_installing_anything(
    completed, monkeypatch, scripted_run, system_python, stub_pip
):
    pip = stub_pip()
    assert ytdlp._upgrade() is True
    monkeypatch.setattr(ytdlp, "_events", [])
    refused = completed(1, stderr=FORBIDDEN)
    runner = scripted_run(refused)

    assert ytdlp.run(ARGS) is refused
    assert len(runner.commands) == 1
    assert len(pip.calls) == 1
    assert ytdlp.provisioning_notes() == []


def test_a_system_python_install_is_reported_as_a_user_install(system_python, stub_pip):
    stub_pip()

    ytdlp._upgrade()

    [note] = ytdlp.provisioning_notes()
    assert note.startswith(f"upgraded yt-dlp {VERSION}")
    assert "pip --user" in note


def test_a_virtualenv_install_is_reported_as_going_to_the_pack_directory(virtualenv, stub_pip):
    stub_pip()

    ytdlp._upgrade()

    [note] = ytdlp.provisioning_notes()
    assert note.startswith(f"upgraded yt-dlp {VERSION}")
    assert str(ytdlp.cache_root() / "yt-dlp") in note
    assert "left untouched" in note


def test_an_install_that_failed_or_was_skipped_reports_nothing(system_python, stub_pip):
    stub_pip(succeeds=False, output="ERROR: no network")

    ytdlp._upgrade()
    ytdlp._upgrade()

    assert ytdlp.provisioning_notes() == []


@pytest.fixture
def pack_owned_copy(virtualenv, monkeypatch, tmp_path, project):
    package = ytdlp.cache_root() / "yt-dlp" / "yt_dlp"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "__main__.py").write_text(PACK_OWNED_MAIN, encoding="utf-8")
    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: False)
    set_path(monkeypatch, tmp_path / "no-tools")
    return package.parent


def test_inside_a_virtualenv_the_child_runs_the_pack_owned_copy_on_an_explicit_module_path(
    pack_owned_copy, monkeypatch, tmp_path
):
    user_modules = tmp_path / "user-modules"
    monkeypatch.setenv("PYTHONPATH", str(user_modules))

    result = ytdlp.run(["--version"])

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["copy"] == "pack-owned"
    assert report["argv"] == ["--version"]
    search_path = [os.path.normcase(entry) for entry in report["path"]]
    pack = search_path.index(os.path.normcase(str(pack_owned_copy)))
    assert pack < search_path.index(os.path.normcase(str(user_modules)))


def test_outside_a_virtualenv_the_pack_owned_directory_is_ignored(
    pack_owned_copy, system_python
):
    assert ytdlp.locate() is None


def test_the_pack_owned_directory_is_only_ever_given_to_the_interpreter_module(
    pack_owned_copy, monkeypatch
):
    monkeypatch.setenv("PYTHONPATH", "the-users-own")

    result = ytdlp._run_isolated([sys.executable, "-c", PRINT_PYTHONPATH])

    assert result.stdout.strip() == "the-users-own"


def test_run_isolated_runs_in_a_fresh_empty_directory_with_forced_utf8_and_inherited_env(
    tmp_path, monkeypatch
):
    (tmp_path / "marker.txt").write_text("the caller's project", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PYTHONUTF8", "0")
    monkeypatch.setenv("WATCH_TEST_INHERITED", "kept")

    result = ytdlp._run_isolated([sys.executable, "-c", CHILD_PROBE])

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert Path(report["cwd"]).resolve() != tmp_path.resolve()
    assert report["listing"] == []
    assert report["utf8"] == "1"
    assert report["inherited"] == "kept"
    assert not Path(report["cwd"]).exists()


def test_run_isolated_gives_the_child_no_stdin_even_when_the_caller_has_data(pack_root):
    relay = subprocess.run(
        [sys.executable, "-c", STDIN_RELAY, str(pack_root / "scripts")],
        input="typed at the caller\n",
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert relay.returncode == 0, relay.stderr
    assert relay.stdout == "''"


def test_run_isolated_round_trips_non_ascii_child_output():
    result = ytdlp._run_isolated([sys.executable, "-c", "print('\\u00e9\\u2713')"])

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "\u00e9\u2713"
