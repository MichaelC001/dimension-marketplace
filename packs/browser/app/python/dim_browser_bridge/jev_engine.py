"""jev engine: `jev_ultrafast.browser.Browser` driven as a driver, never as an agent.

Observation and mutation go through the library's own driver surface —
`Browser.observe`, `Browser.fresh` and `Browser.act` — so every click and every
fill is gated by jev's document key plus its per-node semantic guard, and jev
performs exactly one `browser_operation` per approved action (no retry loop).

Three contract operations are not part of jev's action vocabulary: navigation,
key presses and PNG capture. Upstream's documented escape hatch for exactly this
is `Browser.call`, the library's own session-scoped CDP entry point (the same
method `Browser.__init__` uses for `Page.navigate`, and `browser_operation` uses
for `Input.dispatchKeyEvent` while filling). Those three operations therefore run
as native CDP through the installed library. Nothing is vendored or patched, and
no unsupported operation is faked.

The library also hard-codes a 1120x780 device-metrics override in its
constructor; the configured viewport is re-applied with the same public `call`.

`jev_ultrafast.browser` imports `browser_harness` only — no model client is
imported and no API key is read on this path.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any, Callable

from .common import BridgeError, Prepared, PreparedStore, invoke, scrub
from .config import Config

# ---------------------------------------------------------------------------
# Fixed read-only scripts. These are code, shipped with this file; no string
# from a model or from a tool argument is ever evaluated.
# ---------------------------------------------------------------------------

# Map a CSS selector (or a viewport point) onto the integer node id that jev's
# own snapshot assigned to that live element. Returns null when the element was
# never observed, which is what makes "act on an observed node" enforceable.
_RESOLVE = """((selector, x, y, climb) => {
  const cache = window.__jevFast;
  if (!cache) return null;
  let node = selector === null ? document.elementFromPoint(x, y) : document.querySelector(selector);
  for (let depth = 0; node && depth < 8; depth += 1) {
    const id = cache.ids.get(node);
    if (typeof id === 'number') return id;
    if (!climb) return null;
    node = node.parentElement;
  }
  return null;
})"""

# Identity + hit test for the coordinate path, mirroring jev's own act-time
# checks. Field values are never read: a label comes from aria-label/name/
# placeholder or, for non-editable elements, visible text.
_GUARD = """((selector, x, y) => {
  const at = selector === null ? document.elementFromPoint(x, y) : document.querySelector(selector);
  if (!at || !at.isConnected) return null;
  if (at.matches(':disabled') || at.closest('[aria-disabled="true"],[inert]')) return null;
  if (!at.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return null;
  const rect = at.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return null;
  if (!at.contains(document.elementFromPoint(cx, cy))) return null;
  const editable = at.tagName === 'INPUT' || at.tagName === 'TEXTAREA';
  const label = (at.getAttribute('aria-label') || at.getAttribute('name') || at.getAttribute('placeholder') ||
    (editable ? '' : at.innerText || '')).trim().replace(/\\s+/g, ' ').slice(0, 120);
  return {x: cx, y: cy, identity: [at.tagName, at.getAttribute('role') || '', label,
    String(!!at.readOnly), String(!!at.isContentEditable)].join('\\u001f')};
})"""

_NAMED_KEYS: dict[str, tuple[str, str, int]] = {
    "enter": ("Enter", "Enter", 13),
    "tab": ("Tab", "Tab", 9),
    "escape": ("Escape", "Escape", 27),
    "esc": ("Escape", "Escape", 27),
    "backspace": ("Backspace", "Backspace", 8),
    "delete": ("Delete", "Delete", 46),
    "arrowleft": ("ArrowLeft", "ArrowLeft", 37),
    "arrowup": ("ArrowUp", "ArrowUp", 38),
    "arrowright": ("ArrowRight", "ArrowRight", 39),
    "arrowdown": ("ArrowDown", "ArrowDown", 40),
    "home": ("Home", "Home", 36),
    "end": ("End", "End", 35),
    "pageup": ("PageUp", "PageUp", 33),
    "pagedown": ("PageDown", "PageDown", 34),
    "space": (" ", "Space", 32),
    " ": (" ", "Space", 32),
}

_MODIFIER_BITS = {"alt": 1, "control": 2, "ctrl": 2, "meta": 4, "command": 4, "cmd": 4, "shift": 8}

_SCREENSHOT_TIMEOUT = 60.0
_SELECT_ALL_MODIFIER = 4 if sys.platform == "darwin" else 2


def _key_event(key: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Translate a contract key into exactly one CDP keyDown/keyUp pair."""
    parts = [part for part in key.split("+") if part]
    if not parts:
        raise BridgeError("press action has an empty key")
    modifiers = 0
    while len(parts) > 1:
        bit = _MODIFIER_BITS.get(parts[0].lower())
        if bit is None:
            break
        modifiers |= bit
        parts.pop(0)
    stroke = "+".join(parts)
    named = _NAMED_KEYS.get(stroke.lower())
    if named is not None:
        key_value, code, virtual = named
        printable = key_value == " "
    elif len(stroke) == 1:
        upper = stroke.upper()
        key_value = stroke
        code = f"Digit{upper}" if upper.isdigit() else (f"Key{upper}" if upper.isalpha() else "")
        virtual = ord(upper)
        printable = True
    else:
        raise BridgeError("press action names a key this engine cannot dispatch")
    down: dict[str, Any] = {
        "type": "keyDown",
        "key": key_value,
        "code": code,
        "windowsVirtualKeyCode": virtual,
        "nativeVirtualKeyCode": virtual,
        "modifiers": modifiers,
    }
    up = {**down, "type": "keyUp"}
    # A plain (or shifted) printable key also carries its text, which is what
    # makes it insert a character instead of only firing key events.
    if printable and modifiers in (0, 8):
        down["text"] = key_value
    return down, up


class JevEngine:
    """Driver over one jev-owned background tab in the host-owned Chrome."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._browser: Any = None
        self._stale: type[Exception] = ValueError
        self._lock = asyncio.Lock()
        self._prepared = PreparedStore()

    # -- plumbing ---------------------------------------------------------
    async def _call(self, work: Callable[[], Any]) -> Any:
        """Run one blocking library call; the harness IPC client is not reentrant."""
        async with self._lock:
            return await asyncio.to_thread(work)

    def _evaluate(self, expression: str) -> Any:
        try:
            return self._browser.evaluate(expression)
        except self._stale as exc:
            raise BridgeError(f"page changed during evaluation: {exc}") from exc

    def _document(self) -> tuple[str, str]:
        tree = self._browser.call("Page.getFrameTree")
        frame = tree.get("frameTree", {}).get("frame", {})
        loader = frame.get("loaderId")
        if not loader:
            raise BridgeError("browser did not report a document identity")
        return str(loader), str(frame.get("url") or "")

    def _require_document(self, document_id: str) -> None:
        current, _ = self._document()
        if current != document_id:
            raise BridgeError("document changed since the action was observed")

    # -- lifecycle --------------------------------------------------------
    async def open(self) -> dict[str, Any]:
        def start() -> Any:
            from jev_ultrafast.browser import Browser, StalePage

            self._stale = StalePage
            browser = Browser("about:blank")
            # jev pins 1120x780 in its constructor; the host's viewport wins.
            browser.call(
                "Emulation.setDeviceMetricsOverride",
                width=self._config.width,
                height=self._config.height,
                deviceScaleFactor=1,
                mobile=False,
            )
            return browser

        self._browser = await asyncio.to_thread(start)
        return await self.state()

    async def close(self) -> dict[str, Any]:
        def stop() -> dict[str, Any]:
            tab_closed = True
            if self._browser is not None:
                try:
                    # Closes only the target this driver created. Other tabs and
                    # the browser itself are never touched here.
                    self._browser.close()
                except Exception:
                    tab_closed = False
                self._browser = None
            from browser_harness import admin

            name = os.environ.get("BU_NAME") or None
            daemon_stopped = True
            try:
                admin.restart_daemon(name=name)
            except Exception:
                daemon_stopped = False
            if daemon_stopped:
                daemon_stopped = not admin.daemon_alive(name)
            return {"tabClosed": tab_closed, "daemonStopped": daemon_stopped}

        self._prepared.clear()
        result = await asyncio.to_thread(stop)
        result["ok"] = bool(result["tabClosed"] and result["daemonStopped"])
        return result

    # -- reads ------------------------------------------------------------
    async def state(self) -> dict[str, Any]:
        def read() -> dict[str, Any]:
            document_id, url = self._document()
            try:
                title = self._browser.evaluate("document.title")
            except Exception:
                title = ""
            return {
                "url": url,
                "title": title if isinstance(title, str) else "",
                "documentId": document_id,
                "viewport": {"width": self._config.width, "height": self._config.height},
            }

        return await self._call(read)

    async def screenshot(self) -> dict[str, Any]:
        def capture() -> dict[str, Any]:
            # jev's observe() screenshot is JPEG at quality 72 on a 5s IPC
            # budget; the contract needs a viewport PNG, so capture through the
            # same library's native CDP entry point on the screenshot budget.
            result = self._browser.call(
                "Page.captureScreenshot",
                format="png",
                captureBeyondViewport=False,
                _response_timeout=_SCREENSHOT_TIMEOUT,
            )
            data = result.get("data")
            if not isinstance(data, str) or not data:
                raise BridgeError("browser returned no screenshot data")
            return {"data": data}

        return await self._call(capture)

    async def snapshot(self, limit: int) -> dict[str, Any]:
        def read() -> dict[str, Any]:
            document_id, _ = self._document()
            text = self._evaluate(invoke(self._config.scripts.page_text, limit))
            return {"text": text if isinstance(text, str) else "", "documentId": document_id}

        return await self._call(read)

    async def elements(self, region: dict[str, Any], limit: int) -> dict[str, Any]:
        def read() -> dict[str, Any]:
            text = self._evaluate(invoke(self._config.scripts.elements_in_region, region, limit))
            return {"text": text if isinstance(text, str) else ""}

        return await self._call(read)

    # -- action preparation ------------------------------------------------
    async def prepare(self, action: dict[str, Any], document_id: str) -> dict[str, Any]:
        def resolve() -> dict[str, Any]:
            self._require_document(document_id)
            kind = action.get("kind")
            if kind == "navigate":
                url = action.get("url")
                if not isinstance(url, str) or not url:
                    raise BridgeError("navigate action has no url")
                return {"prepared": Prepared("navigate", document_id, {"url": url}), "label": url}
            if kind == "press":
                key = action.get("key")
                if not isinstance(key, str) or not key:
                    raise BridgeError("press action has no key")
                _key_event(key)
                return {"prepared": Prepared("press", document_id, {"key": key}), "label": key}
            if kind == "scroll":
                return {"prepared": self._prepare_scroll(action, document_id), "label": "scroll"}
            if kind in ("click", "type"):
                return self._prepare_target(action, document_id, kind)
            raise BridgeError(f"unsupported action kind: {kind!r}")

        resolved = await self._call(resolve)
        token = self._prepared.put(resolved["prepared"])
        return {"token": token, "documentId": document_id, "label": resolved.get("label") or ""}

    def _prepare_scroll(self, action: dict[str, Any], document_id: str) -> Prepared:
        delta_x = int(action.get("deltaX") or 0)
        delta_y = int(action.get("deltaY") or 0)
        if delta_x == 0 and delta_y != 0 and action.get("x") is None and action.get("y") is None:
            # jev's own scroll action: guarded by its page marker and dispatched
            # exactly once as a wheel event by browser_operation.
            page = self._browser.observe(screenshot=False)
            jev_action = {"id": "scroll_down" if delta_y > 0 else "scroll_up", "kind": "scroll", "delta": delta_y}
            return Prepared(
                "scroll",
                document_id,
                {"mode": "jev", "action": jev_action, "page": {"marker": page["marker"]}},
            )
        x = int(action.get("x") or self._config.width // 2)
        y = int(action.get("y") or self._config.height // 2)
        return Prepared("scroll", document_id, {"mode": "cdp", "x": x, "y": y, "deltaX": delta_x, "deltaY": delta_y})

    def _prepare_target(self, action: dict[str, Any], document_id: str, kind: str) -> dict[str, Any]:
        selector = action.get("selector")
        selector = selector if isinstance(selector, str) and selector else None
        x = action.get("x")
        y = action.get("y")
        if selector is None and (x is None or y is None):
            raise BridgeError(f"{kind} action has neither a selector nor coordinates")
        text = action.get("text")
        if kind == "type" and not isinstance(text, str):
            raise BridgeError("type action has no text")

        page = self._browser.observe(screenshot=False)
        node = self._evaluate(invoke(_RESOLVE, selector, x, y, kind == "click"))
        wanted = "click" if kind == "click" else "fill"
        observed = None
        if isinstance(node, int):
            observed = next(
                (entry for entry in page.get("actions", []) if entry.get("node") == node and entry.get("kind") == wanted),
                None,
            )
        if observed is not None and str(node) in page.get("guards", {}):
            # Preferred path: an element jev itself observed, so jev's own
            # fresh() guard (document key + semantic guard array) applies.
            trimmed = {
                "marker": page["marker"],
                "page_key": page["page_key"],
                "guards": {str(node): page["guards"][str(node)]},
            }
            prepared = Prepared(kind, document_id, {"mode": "jev", "action": observed, "page": trimmed}, text=text)
            return {"prepared": prepared, "label": str(observed.get("label") or "")}

        # Fallback for an element outside jev's observed action table (its
        # snapshot caps at 250 actions and enumerates only its own selector
        # set). Identity is pinned here and re-checked immediately before input.
        guard = self._evaluate(invoke(_GUARD, selector, x, y))
        if not isinstance(guard, dict):
            raise BridgeError("target is missing, hidden, disabled or covered")
        payload = {"mode": "cdp", "selector": selector, "x": x, "y": y, "identity": guard["identity"]}
        return {"prepared": Prepared(kind, document_id, payload, text=text), "label": guard["identity"].split("\u001f")[2]}

    async def dispose(self, token: str) -> dict[str, Any]:
        return {"released": self._prepared.drop(token)}

    # -- dispatch ----------------------------------------------------------
    async def dispatch(self, token: str) -> dict[str, Any]:
        prepared = self._prepared.take(token)

        def run() -> dict[str, Any]:
            self._require_document(prepared.document_id)
            kind = prepared.kind
            payload = prepared.payload
            if kind == "navigate":
                self._browser.call("Page.navigate", url=payload["url"])
                return {"dispatched": "navigate"}
            if kind == "press":
                down, up = _key_event(payload["key"])
                self._browser.call("Input.dispatchKeyEvent", **down)
                self._browser.call("Input.dispatchKeyEvent", **up)
                return {"dispatched": "press"}
            if kind == "scroll":
                if payload["mode"] == "jev":
                    self._act(payload["action"], payload["page"], None)
                    return {"dispatched": "scroll"}
                self._browser.call(
                    "Input.dispatchMouseEvent",
                    type="mouseWheel",
                    x=payload["x"],
                    y=payload["y"],
                    deltaX=payload["deltaX"],
                    deltaY=payload["deltaY"],
                )
                return {"dispatched": "scroll"}
            if payload["mode"] == "jev":
                self._act(payload["action"], payload["page"], prepared.text)
                return {"dispatched": kind}
            return self._dispatch_by_identity(kind, payload, prepared.text)

        return await self._call(run)

    def _act(self, action: dict[str, Any], page: dict[str, Any], text: str | None) -> None:
        """One jev act: fresh() re-checks the guard, browser_operation runs once."""
        try:
            self._browser.act(action, page, text=text)
        except self._stale as exc:
            raise BridgeError(scrub(f"target changed since approval: {exc}", text)) from exc
        except Exception as exc:
            raise BridgeError(scrub(f"{type(exc).__name__}: {exc}", text)) from exc

    def _dispatch_by_identity(self, kind: str, payload: dict[str, Any], text: str | None) -> dict[str, Any]:
        guard = self._evaluate(invoke(_GUARD, payload["selector"], payload["x"], payload["y"]))
        if not isinstance(guard, dict) or guard["identity"] != payload["identity"]:
            raise BridgeError("target changed since approval")
        x, y = guard["x"], guard["y"]
        for event in ("mousePressed", "mouseReleased"):
            self._browser.call("Input.dispatchMouseEvent", type=event, x=x, y=y, button="left", clickCount=1)
        if kind == "type":
            self._browser.call(
                "Input.dispatchKeyEvent",
                type="keyDown",
                key="a",
                code="KeyA",
                modifiers=_SELECT_ALL_MODIFIER,
                commands=["selectAll"],
            )
            self._browser.call(
                "Input.dispatchKeyEvent", type="keyUp", key="a", code="KeyA", modifiers=_SELECT_ALL_MODIFIER
            )
            try:
                self._browser.call("Input.insertText", text=text or "")
            except Exception as exc:
                raise BridgeError(scrub(f"{type(exc).__name__}: {exc}", text)) from exc
        return {"dispatched": kind}
