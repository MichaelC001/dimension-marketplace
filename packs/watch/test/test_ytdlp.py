"""Contracts of ytdlp.py: resolution order, self-provisioning, and refusal recovery."""
from __future__ import annotations

import importlib
import json
import subprocess
import sys
import types
from pathlib import Path

import pytest

import ytdlp

MODULE_CMD = [sys.executable, "-m", "yt_dlp"]
PATH_COPY = "/usr/local/bin/yt-dlp"
ARGS = ["--skip-download", "--", "https://example.test/watch?v=x"]
FORBIDDEN = "ERROR: [youtube] x: unable to download video data: HTTP Error 403: Forbidden"
LABEL = "[UNTRUSTED-MEDIA-TEXT inline kind=tool-diagnostic]"

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


@pytest.fixture(autouse=True)
def pristine_module_state(monkeypatch):
    monkeypatch.setattr(ytdlp, "_resolved", None)
    monkeypatch.setattr(ytdlp, "_upgraded", False)


def pretend_path_has(monkeypatch, executable):
    def which(name):
        return executable if name == "yt-dlp" else None

    monkeypatch.setattr(ytdlp, "shutil", types.SimpleNamespace(which=which))


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


class UpgradeStub:
    def __init__(self, succeeds):
        self.succeeds = succeeds
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return self.succeeds


@pytest.fixture
def scripted_run(monkeypatch):
    def install(*results):
        runner = ScriptedYtDlp(*results)
        monkeypatch.setattr(ytdlp, "command", lambda: ["yt-dlp"])
        monkeypatch.setattr(ytdlp, "_run_isolated", runner)
        return runner

    return install


@pytest.fixture
def stub_upgrade(monkeypatch):
    def install(succeeds):
        stub = UpgradeStub(succeeds)
        monkeypatch.setattr(ytdlp, "_upgrade", stub)
        return stub

    return install


def test_locate_prefers_the_interpreter_module_over_a_path_executable(monkeypatch):
    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: True)
    pretend_path_has(monkeypatch, PATH_COPY)

    assert ytdlp.locate() == MODULE_CMD


def test_locate_falls_back_to_the_path_executable_without_the_module(monkeypatch):
    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: False)
    pretend_path_has(monkeypatch, PATH_COPY)

    assert ytdlp.locate() == [PATH_COPY]


def test_locate_reports_nothing_when_neither_exists(monkeypatch):
    monkeypatch.setattr(ytdlp, "interpreter_has_module", lambda: False)
    pretend_path_has(monkeypatch, None)

    assert ytdlp.locate() is None


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


@pytest.mark.parametrize("in_virtualenv", [True, False], ids=["virtualenv", "system python"])
def test_pip_install_command_is_an_argv_that_adds_user_only_outside_a_virtualenv(
    monkeypatch, in_virtualenv
):
    monkeypatch.setattr(ytdlp, "_in_virtualenv", lambda: in_virtualenv)

    cmd = ytdlp.pip_install_command()

    assert isinstance(cmd, list)
    assert all(isinstance(part, str) for part in cmd)
    assert cmd[:4] == [sys.executable, "-m", "pip", "install"]
    assert cmd[-2:] == ["-U", "yt-dlp"]
    assert ("--user" in cmd) is (not in_virtualenv)


def test_command_installs_once_when_absent_and_verifies_the_module_it_installed(monkeypatch):
    installs = []
    verified = []

    def pip_install():
        installs.append("pip")
        return True, ""

    def version_of(cmd):
        verified.append(cmd)
        return "2026.10.26"

    monkeypatch.setattr(ytdlp, "locate", lambda: None)
    monkeypatch.setattr(ytdlp, "_pip_install", pip_install)
    monkeypatch.setattr(ytdlp, "version_of", version_of)

    assert ytdlp.command() == ytdlp.MODULE_CMD
    assert ytdlp.command() == ytdlp.MODULE_CMD
    assert installs == ["pip"]
    assert verified == [ytdlp.MODULE_CMD]


def test_command_resolves_once_and_never_installs_what_it_found(monkeypatch):
    lookups = []

    def locate():
        lookups.append("locate")
        return [PATH_COPY]

    def pip_install():
        raise AssertionError("pip must not run when yt-dlp was found")

    monkeypatch.setattr(ytdlp, "locate", locate)
    monkeypatch.setattr(ytdlp, "_pip_install", pip_install)

    assert ytdlp.command() == [PATH_COPY]
    assert ytdlp.command() == [PATH_COPY]
    assert lookups == ["locate"]


def test_failed_install_exits_with_a_labeled_diagnostic_and_every_manual_hint(monkeypatch):
    monkeypatch.setattr(ytdlp, "locate", lambda: None)
    monkeypatch.setattr(
        ytdlp, "_pip_install", lambda: (False, "ERROR: Could not find a version")
    )

    with pytest.raises(SystemExit) as exit_info:
        ytdlp.command()

    message = str(exit_info.value)
    assert LABEL in message
    assert "ERROR: Could not find a version" in message
    assert "py -m pip install -U yt-dlp" in message
    assert "brew install yt-dlp" in message
    assert "pipx install yt-dlp" in message


def test_install_that_cannot_run_afterwards_still_exits_with_the_manual_hints(monkeypatch):
    monkeypatch.setattr(ytdlp, "locate", lambda: None)
    monkeypatch.setattr(ytdlp, "_pip_install", lambda: (True, ""))
    monkeypatch.setattr(ytdlp, "version_of", lambda cmd: None)

    with pytest.raises(SystemExit) as exit_info:
        ytdlp.command()

    message = str(exit_info.value)
    assert LABEL in message
    assert "pipx install yt-dlp" in message


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
    monkeypatch, completed
):
    monkeypatch.setattr(ytdlp, "_resolved", [PATH_COPY])
    monkeypatch.setattr(ytdlp, "_provision", lambda purpose: ("2026.10.26", ""))
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


def test_a_successful_upgrade_makes_the_interpreter_module_outrank_a_path_copy(monkeypatch):
    monkeypatch.setattr(ytdlp, "_resolved", [PATH_COPY])
    monkeypatch.setattr(ytdlp, "_provision", lambda purpose: ("2026.10.26", ""))

    assert ytdlp._upgrade() is True
    assert ytdlp.command() == MODULE_CMD


def test_a_failed_upgrade_keeps_the_working_command_and_labels_pip_output(monkeypatch, capsys):
    monkeypatch.setattr(ytdlp, "_resolved", [PATH_COPY])
    monkeypatch.setattr(ytdlp, "_provision", lambda purpose: (None, "ERROR: no network"))

    assert ytdlp._upgrade() is False
    assert ytdlp.command() == [PATH_COPY]
    reported = capsys.readouterr().err
    assert LABEL in reported
    assert "ERROR: no network" in reported


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
