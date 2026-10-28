"""Contracts of proc.py: UTF-8 capture and launch failures that never leak OSError."""
from __future__ import annotations

import sys

import pytest

import proc

EMIT_UTF8 = "import sys; sys.stdout.buffer.write('\\u00e9\\u2713'.encode('utf-8'))"
EMIT_INVALID_UTF8 = "import sys; sys.stdout.buffer.write(b'\\xff\\xfeok')"
FAIL_WITH_STDERR = "import sys; sys.stderr.write('boom'); sys.exit(3)"


def test_run_decodes_utf8_output_whatever_the_console_codepage_is():
    result = proc.run([sys.executable, "-c", EMIT_UTF8])

    assert result.stdout == "\u00e9\u2713"


def test_run_replaces_undecodable_bytes_instead_of_raising():
    result = proc.run([sys.executable, "-c", EMIT_INVALID_UTF8])

    assert result.stdout.endswith("ok")
    assert "\ufffd" in result.stdout


def test_run_returns_a_nonzero_exit_to_the_caller_without_raising():
    result = proc.run([sys.executable, "-c", FAIL_WITH_STDERR])

    assert result.returncode == 3
    assert result.stderr == "boom"


def test_run_turns_a_missing_executable_into_an_actionable_exit(tmp_path):
    missing = tmp_path / "no-such-binary-for-watch"

    with pytest.raises(SystemExit) as exit_info:
        proc.run([str(missing), "--version"])

    message = str(exit_info.value)
    assert "cannot run" in message
    assert "no-such-binary-for-watch" in message


def test_spawn_lets_a_missing_executable_raise_oserror(tmp_path):
    missing = tmp_path / "no-such-binary-for-watch"

    with pytest.raises(FileNotFoundError):
        proc.spawn([str(missing), "--version"])
