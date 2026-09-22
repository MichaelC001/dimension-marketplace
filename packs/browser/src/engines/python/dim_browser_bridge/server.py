"""Standard MCP stdio server with a deliberately narrow private driver tool set.

This is an ordinary MCP server (`mcp.server.MCPServer`, stdio transport), not a
bespoke JSON-lines protocol — the same shape browser-harness ships upstream. The
tool list is the difference: upstream's `browser-harness-mcp` exposes `browser_js`
and `browser_cdp`, arbitrary-JavaScript and arbitrary-CDP sinks that would make
per-action approval decorative. Nothing here accepts JavaScript or a raw CDP
method. The only scripts this process ever evaluates are the two fixed read-only
DOM helpers the host hands over at initialization.

Approval, action identity and the durable claim stay in the host runtime. This
worker only observes, prepares one target read-only, and dispatches one already
approved action exactly once.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from . import config as config_module
from .common import BridgeError, dump

SERVER = MCPServer("dim-browser-bridge")

_CONFIG: config_module.Config | None = None
_ENGINE: Any = None
_LIFECYCLE = asyncio.Lock()


def _config() -> config_module.Config:
    if _CONFIG is None:  # pragma: no cover - main() loads it before serving
        raise BridgeError("bridge configuration was not loaded")
    return _CONFIG


def _engine() -> Any:
    if _ENGINE is None:
        raise BridgeError("bridge is not open")
    return _ENGINE


def _fail(exc: Exception) -> ToolError:
    """Surface an operational failure without leaking page or typed text."""
    if isinstance(exc, BridgeError):
        return ToolError(str(exc))
    if isinstance(exc, asyncio.TimeoutError):
        return ToolError("browser operation timed out")
    return ToolError(f"{type(exc).__name__}: {exc}")


async def _guarded(coro: Any) -> str:
    try:
        return dump(await coro)
    except Exception as exc:  # noqa: BLE001 - every browser failure reaches the host
        raise _fail(exc) from exc


@SERVER.tool(name="open", description="Start the engine and return its initial state.")
async def open_browser() -> str:
    global _ENGINE
    async with _LIFECYCLE:
        if _ENGINE is not None:
            raise ToolError("bridge is already open")
        config = _config()
        if config.engine == "jev":
            from .jev_engine import JevEngine as Engine
        else:
            from .browser_use_engine import BrowserUseEngine as Engine
        engine = Engine(config)
        try:
            state = await asyncio.wait_for(engine.open(), timeout=config.open_timeout)
        except Exception as exc:  # noqa: BLE001 - a failed open must not leave a half-live engine
            try:
                await asyncio.wait_for(engine.close(), timeout=config.open_timeout)
            except Exception:
                pass
            raise _fail(exc) from exc
        _ENGINE = engine
        return dump(state)


@SERVER.tool(name="state", description="Read url, title, document identity and viewport.")
async def state() -> str:
    return await _guarded(_engine().state())


@SERVER.tool(name="screenshot", description="Capture a base64 viewport PNG at device scale factor one.")
async def screenshot() -> str:
    return await _guarded(_engine().screenshot())


@SERVER.tool(name="snapshot", description="Read the page as bounded redacted text.")
async def snapshot(limit: int) -> str:
    return await _guarded(_engine().snapshot(limit))


@SERVER.tool(name="elements", description="Describe the elements intersecting a viewport region.")
async def elements(region: dict[str, float], limit: int) -> str:
    return await _guarded(_engine().elements(region, limit))


@SERVER.tool(
    name="prepare",
    description="Resolve an action's target read-only and return a single-use dispatch token.",
)
async def prepare(action: dict[str, Any], documentId: str) -> str:  # noqa: N803 - wire field name
    return await _guarded(_engine().prepare(action, documentId))


@SERVER.tool(name="dispatch", description="Execute a prepared action exactly once. Never retried.")
async def dispatch(token: str) -> str:
    return await _guarded(_engine().dispatch(token))


@SERVER.tool(name="dispose", description="Release a prepared action that will not be dispatched.")
async def dispose(token: str) -> str:
    return await _guarded(_engine().dispose(token))


@SERVER.tool(name="shutdown", description="Stop every resource this bridge owns and report whether it is confirmed.")
async def shutdown() -> str:
    global _ENGINE
    async with _LIFECYCLE:
        if _ENGINE is None:
            return dump({"ok": True, "alreadyClosed": True})
        engine, _ENGINE = _ENGINE, None
        try:
            return dump(await engine.close())
        except Exception as exc:  # noqa: BLE001 - an unconfirmed shutdown must stay visible
            raise _fail(exc) from exc


def main() -> None:
    global _CONFIG
    # Library chatter belongs on stderr; the MCP SDK already diverts stray fd-1
    # writes, and nothing here prints. Keep the level high so page-derived text
    # cannot reach a log through a third-party debug statement.
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)
    _CONFIG = config_module.load()
    SERVER.run()
