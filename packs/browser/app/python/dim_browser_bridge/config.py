"""Bridge configuration, read once from a private file named by the environment.

The host writes this file before spawning the worker and deletes it once the
worker is up. Two things are deliberate:

* The fixed read-only page scripts arrive HERE, at initialization, and never as
  a tool argument. No tool on this server accepts JavaScript, so neither a model
  nor another MCP client can ever get a script evaluated.
* Nothing that a user types ever passes through argv or the environment; typed
  text only ever arrives as an argument of an already-approved `prepare` call.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

CONFIG_ENV = "DIM_BROWSER_BRIDGE_CONFIG"

ENGINES = ("jev", "browser-use")


@dataclass(frozen=True)
class Scripts:
    """Parent-owned read-only DOM helpers (src/engines/page-scripts.ts)."""

    page_text: str
    elements_in_region: str


@dataclass(frozen=True)
class Config:
    engine: str
    width: int
    height: int
    headless: bool | None
    executable_path: str | None
    user_data_dir: str
    profile_name: str
    scripts: Scripts
    open_timeout: float
    call_timeout: float


def _text(raw: dict, key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"bridge config field {key!r} must be a non-empty string")
    return value


def _optional_text(raw: dict, key: str) -> str | None:
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError(f"bridge config field {key!r} must be a non-empty string or null")
    return value


def _positive_int(raw: dict, key: str) -> int:
    value = raw.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"bridge config field {key!r} must be a positive integer")
    return value


def _positive_float(raw: dict, key: str, fallback: float) -> float:
    value = raw.get(key, fallback)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f"bridge config field {key!r} must be a positive number")
    return float(value)


def load() -> Config:
    path = os.environ.get(CONFIG_ENV)
    if not path:
        raise ValueError(f"{CONFIG_ENV} is not set; the bridge is started by its host, not by hand")
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("bridge config must be a JSON object")

    engine = _text(raw, "engine")
    if engine not in ENGINES:
        raise ValueError(f"bridge config engine must be one of {ENGINES}")

    viewport = raw.get("viewport")
    if not isinstance(viewport, dict):
        raise ValueError("bridge config field 'viewport' must be an object")

    headless = raw.get("headless")
    if headless is not None and not isinstance(headless, bool):
        raise ValueError("bridge config field 'headless' must be a boolean or null")

    scripts = raw.get("scripts")
    if not isinstance(scripts, dict):
        raise ValueError("bridge config field 'scripts' must be an object")

    return Config(
        engine=engine,
        width=_positive_int(viewport, "width"),
        height=_positive_int(viewport, "height"),
        headless=headless,
        executable_path=_optional_text(raw, "executablePath"),
        user_data_dir=_text(raw, "userDataDir"),
        profile_name=raw.get("profileName") or "Default",
        scripts=Scripts(
            page_text=_text(scripts, "pageText"),
            elements_in_region=_text(scripts, "elementsInRegion"),
        ),
        open_timeout=_positive_float(raw, "openTimeout", 60.0),
        call_timeout=_positive_float(raw, "callTimeout", 30.0),
    )
