"""Shared fixtures for the watch engine tests."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

PACK_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PACK_ROOT / "scripts"

if sys.path[0] != str(SCRIPTS_DIR):
    sys.path.insert(0, str(SCRIPTS_DIR))


@pytest.fixture
def pack_root() -> Path:
    return PACK_ROOT


@pytest.fixture
def completed():
    def make(returncode: int = 0, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(
            args=["fake"], returncode=returncode, stdout=stdout, stderr=stderr
        )

    return make
