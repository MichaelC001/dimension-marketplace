"""browser-use engine: BrowserSession plus the actor layer, never Agent.

`browser_use.Agent` is the autonomous loop and is deliberately not imported.
This engine uses only:

* `BrowserSession` / `BrowserProfile` — lifecycle, its own Chrome launched into
  a named profile directory it owns, CDP sessions and PNG capture;
* `browser_use.actor.page.Page` and `browser_use.actor.element.Element` — target
  scoped navigation, key presses and per-element click/fill addressed by
  `backend_node_id` inside the CDP session that produced it.

`browser_use.tools` is not used either: its `input` action carries an internal
"concatenation" second attempt and its `select_dropdown` retries lazy options,
neither of which can be switched off. The actor layer performs one CDP
interaction per call, which is what "dispatch exactly once" requires.

No LLM is constructed anywhere here, so the engine runs without model keys; the
only LLM-backed entry points on the actor (`get_element_by_prompt`,
`extract_content`) are never called.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any
from urllib.parse import urlparse

from .common import BridgeError, Prepared, PreparedStore, invoke, scrub
from .config import Config

# Fixed read-only scripts shipped with this file; no caller-supplied JavaScript
# is ever evaluated. Identity mirrors what jev guards on: tag, role, label,
# read-only and content-editable state — never a field's value.
_ELEMENT_GUARD = """() => {
  const e = this;
  if (!e || !e.isConnected) return '';
  if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) return '';
  if (!e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return '';
  const rect = e.getBoundingClientRect();
  if (!rect.width || !rect.height) return '';
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return '';
  if (!e.contains(document.elementFromPoint(cx, cy))) return '';
  const editable = e.tagName === 'INPUT' || e.tagName === 'TEXTAREA';
  const label = (e.getAttribute('aria-label') || e.getAttribute('name') || e.getAttribute('placeholder') ||
    (editable ? '' : e.innerText || '')).trim().replace(/\\s+/g, ' ').slice(0, 120);
  return [e.tagName, e.getAttribute('role') || '', label, String(!!e.readOnly), String(!!e.isContentEditable)]
    .join('\\u001f');
}"""

_POINT_GUARD = """((x, y) => {
  const at = document.elementFromPoint(x, y);
  if (!at || !at.isConnected) return null;
  if (at.matches(':disabled') || at.closest('[aria-disabled="true"],[inert]')) return null;
  if (!at.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return null;
  const rect = at.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const editable = at.tagName === 'INPUT' || at.tagName === 'TEXTAREA';
  const label = (at.getAttribute('aria-label') || at.getAttribute('name') || at.getAttribute('placeholder') ||
    (editable ? '' : at.innerText || '')).trim().replace(/\\s+/g, ' ').slice(0, 120);
  return {identity: [at.tagName, at.getAttribute('role') || '', label,
    String(!!at.readOnly), String(!!at.isContentEditable)].join('\\u001f')};
})"""

_PRIVACY_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-domain-reliability",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-pings",
]

_KILL_CONFIRM_TIMEOUT = 15.0


class BrowserUseEngine:
    """Driver over a browser-use session that owns its own Chrome profile."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._session: Any = None
        self._page: Any = None
        self._target_id: str | None = None
        self._browser_pid: int | None = None
        self._cdp_endpoint: str | None = None
        self._lock = asyncio.Lock()
        self._prepared = PreparedStore()

    # -- plumbing ---------------------------------------------------------
    async def _cdp(self) -> Any:
        return await self._session.get_or_create_cdp_session(self._target_id, focus=False)

    async def _evaluate(self, expression: str) -> Any:
        cdp = await self._cdp()
        result = await cdp.cdp_client.send.Runtime.evaluate(
            params={"expression": expression, "returnByValue": True, "awaitPromise": False},
            session_id=cdp.session_id,
        )
        if result.get("exceptionDetails"):
            raise BridgeError("page changed during evaluation")
        return result.get("result", {}).get("value")

    async def _document(self) -> tuple[str, str]:
        cdp = await self._cdp()
        tree = await cdp.cdp_client.send.Page.getFrameTree(session_id=cdp.session_id)
        frame = tree.get("frameTree", {}).get("frame", {})
        loader = frame.get("loaderId")
        if not loader:
            raise BridgeError("browser did not report a document identity")
        return str(loader), str(frame.get("url") or "")

    async def _require_document(self, document_id: str) -> None:
        current, _ = await self._document()
        if current != document_id:
            raise BridgeError("document changed since the action was observed")

    # -- lifecycle --------------------------------------------------------
    async def open(self) -> dict[str, Any]:
        from browser_use.actor.page import Page
        from browser_use.browser.profile import BrowserProfile
        from browser_use.browser.session import BrowserSession

        viewport = {"width": self._config.width, "height": self._config.height}
        profile_kwargs: dict[str, Any] = {
            # A profile directory this driver owns; the host's lock covers it.
            "user_data_dir": self._config.user_data_dir,
            "profile_directory": self._config.profile_name,
            "is_local": True,
            "keep_alive": False,
            # Provably read-only observation: the interaction highlight injects
            # a div into the page, and the debug overlay injects a whole tree.
            "highlight_elements": False,
            "dom_highlight_elements": False,
            # No extension downloads, no ad-blocker, no URL rewriting.
            "enable_default_extensions": False,
            "viewport": viewport,
            "window_size": viewport,
            "device_scale_factor": 1.0,
            "args": list(_PRIVACY_ARGS),
        }
        if self._config.headless is not None:
            profile_kwargs["headless"] = self._config.headless
        if self._config.executable_path:
            profile_kwargs["executable_path"] = self._config.executable_path

        self._session = BrowserSession(browser_profile=BrowserProfile(**profile_kwargs))
        await asyncio.wait_for(self._session.start(), timeout=self._config.open_timeout)
        target_id = self._session.agent_focus_target_id
        if not target_id:
            raise BridgeError("browser-use session started without a page target")
        self._target_id = target_id
        self._page = Page(self._session, target_id)
        await self._page.set_viewport_size(self._config.width, self._config.height)
        self._browser_pid = await self._read_browser_pid()
        self._cdp_endpoint = self._session.cdp_url
        return await self.state()

    async def _read_browser_pid(self) -> int | None:
        """PID of the Chrome this session launched, read over public CDP."""
        try:
            info = await self._session.cdp_client.send.SystemInfo.getProcessInfo()
        except Exception:
            return None
        for process in info.get("processInfo", []) or []:
            if process.get("type") == "browser":
                pid = process.get("id")
                return int(pid) if isinstance(pid, int) else None
        return None

    async def close(self) -> dict[str, Any]:
        self._prepared.clear()
        stopped = True
        if self._session is not None:
            try:
                # kill() saves storage state, then BrowserKillEvent terminates
                # the Chrome this session launched. An attached (foreign)
                # browser has no subprocess and is never killed by this path.
                await asyncio.wait_for(self._session.kill(), timeout=self._config.open_timeout)
            except Exception:
                stopped = False
            self._session = None
            self._page = None
        exited = await self._confirm_browser_exit() if stopped else False
        return {"ok": bool(stopped and exited), "browserStopped": stopped, "browserExited": exited}

    async def _confirm_browser_exit(self) -> bool:
        """Confirm the launched Chrome is really gone before the host unlocks.

        Two independent signals, both from public sources: the browser process
        id CDP reported at open, and whether anything still accepts connections
        on its DevTools endpoint. An unknown PID is tolerated, an unknown
        endpoint is not — a shutdown nobody can confirm keeps the lock.
        """
        import psutil

        loop = asyncio.get_running_loop()
        deadline = loop.time() + _KILL_CONFIRM_TIMEOUT
        while True:
            process_gone = self._browser_pid is None or not psutil.pid_exists(self._browser_pid)
            endpoint_gone = await self._endpoint_closed()
            if process_gone and endpoint_gone:
                return True
            if loop.time() >= deadline:
                return False
            await asyncio.sleep(0.1)

    async def _endpoint_closed(self) -> bool:
        """True when nothing answers on the DevTools endpoint any more."""
        endpoint = self._cdp_endpoint
        if not endpoint:
            return False
        parsed = urlparse(endpoint)
        host, port = parsed.hostname, parsed.port
        if not host or not port:
            return False
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=2.0)
        except (OSError, asyncio.TimeoutError):
            return True
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass
        return False

    # -- reads ------------------------------------------------------------
    async def state(self) -> dict[str, Any]:
        async with self._lock:
            document_id, url = await self._document()
            try:
                title = await self._page.get_title()
            except Exception:
                title = ""
            return {
                "url": url,
                "title": title if isinstance(title, str) else "",
                "documentId": document_id,
                "viewport": {"width": self._config.width, "height": self._config.height},
            }

    async def screenshot(self) -> dict[str, Any]:
        async with self._lock:
            data = await self._session.take_screenshot(full_page=False, format="png")
            if not data:
                raise BridgeError("browser returned no screenshot data")
            return {"data": base64.b64encode(data).decode("ascii")}

    async def snapshot(self, limit: int) -> dict[str, Any]:
        async with self._lock:
            document_id, _ = await self._document()
            text = await self._evaluate(invoke(self._config.scripts.page_text, limit))
            return {"text": text if isinstance(text, str) else "", "documentId": document_id}

    async def elements(self, region: dict[str, Any], limit: int) -> dict[str, Any]:
        async with self._lock:
            text = await self._evaluate(invoke(self._config.scripts.elements_in_region, region, limit))
            return {"text": text if isinstance(text, str) else ""}

    # -- action preparation ------------------------------------------------
    async def prepare(self, action: dict[str, Any], document_id: str) -> dict[str, Any]:
        async with self._lock:
            await self._require_document(document_id)
            kind = action.get("kind")
            if kind == "navigate":
                url = action.get("url")
                if not isinstance(url, str) or not url:
                    raise BridgeError("navigate action has no url")
                prepared, label = Prepared("navigate", document_id, {"url": url}), url
            elif kind == "press":
                key = action.get("key")
                if not isinstance(key, str) or not key:
                    raise BridgeError("press action has no key")
                prepared, label = Prepared("press", document_id, {"key": key}), key
            elif kind == "scroll":
                x = int(action.get("x") or self._config.width // 2)
                y = int(action.get("y") or self._config.height // 2)
                payload = {
                    "x": x,
                    "y": y,
                    "deltaX": int(action.get("deltaX") or 0),
                    "deltaY": int(action.get("deltaY") or 0),
                }
                prepared, label = Prepared("scroll", document_id, payload), "scroll"
            elif kind in ("click", "type"):
                prepared, label = await self._prepare_target(action, document_id, kind)
            else:
                raise BridgeError(f"unsupported action kind: {kind!r}")
            token = self._prepared.put(prepared)
            return {"token": token, "documentId": document_id, "label": label}

    async def _prepare_target(self, action: dict[str, Any], document_id: str, kind: str) -> tuple[Prepared, str]:
        selector = action.get("selector")
        selector = selector if isinstance(selector, str) and selector else None
        x, y = action.get("x"), action.get("y")
        if selector is None and (x is None or y is None):
            raise BridgeError(f"{kind} action has neither a selector nor coordinates")
        text = action.get("text")
        if kind == "type" and not isinstance(text, str):
            raise BridgeError("type action has no text")

        if selector is not None:
            elements = await self._page.get_elements_by_css_selector(selector)
            if not elements:
                raise BridgeError("selector matched no element")
            element = elements[0]
            identity = await element.evaluate(_ELEMENT_GUARD)
            if not identity:
                raise BridgeError("target is missing, hidden, disabled or covered")
            # backend_node_id is only meaningful inside the CDP session that
            # captured it, which is exactly what this Element carries.
            payload = {"mode": "element", "element": element, "identity": identity}
            return Prepared(kind, document_id, payload, text=text), identity.split("\u001f")[2]

        guard = await self._evaluate(invoke(_POINT_GUARD, x, y))
        if not isinstance(guard, dict):
            raise BridgeError("target is missing, hidden, disabled or covered")
        payload = {"mode": "point", "x": x, "y": y, "identity": guard["identity"]}
        return Prepared(kind, document_id, payload, text=text), guard["identity"].split("\u001f")[2]

    async def dispose(self, token: str) -> dict[str, Any]:
        return {"released": self._prepared.drop(token)}

    # -- dispatch ----------------------------------------------------------
    async def dispatch(self, token: str) -> dict[str, Any]:
        prepared = self._prepared.take(token)
        async with self._lock:
            await self._require_document(prepared.document_id)
            kind, payload = prepared.kind, prepared.payload
            if kind == "navigate":
                await self._page.goto(payload["url"])
                return {"dispatched": "navigate"}
            if kind == "press":
                await self._page.press(payload["key"])
                return {"dispatched": "press"}
            if kind == "scroll":
                await self._wheel(payload["x"], payload["y"], payload["deltaX"], payload["deltaY"])
                return {"dispatched": "scroll"}
            if payload["mode"] == "element":
                element = payload["element"]
                identity = await element.evaluate(_ELEMENT_GUARD)
                if identity != payload["identity"]:
                    raise BridgeError("target changed since approval")
                if kind == "click":
                    await element.click()
                else:
                    # One actor fill: focus, clear, insert. The Tools registry's
                    # `input` action is avoided precisely because it re-writes
                    # the field on a concatenation mismatch.
                    try:
                        await element.fill(prepared.text or "", clear=True)
                    except Exception as exc:  # noqa: BLE001 - message may quote the value
                        raise BridgeError(scrub(f"{type(exc).__name__}: {exc}", prepared.text)) from exc
                return {"dispatched": kind}
            guard = await self._evaluate(invoke(_POINT_GUARD, payload["x"], payload["y"]))
            if not isinstance(guard, dict) or guard["identity"] != payload["identity"]:
                raise BridgeError("target changed since approval")
            await self._click_point(payload["x"], payload["y"])
            if kind == "type":
                await self._page.press("Control+A")
                cdp = await self._cdp()
                try:
                    await cdp.cdp_client.send.Input.insertText(
                        params={"text": prepared.text or ""}, session_id=cdp.session_id
                    )
                except Exception as exc:  # noqa: BLE001 - message may quote the value
                    raise BridgeError(scrub(f"{type(exc).__name__}: {exc}", prepared.text)) from exc
            return {"dispatched": kind}

    async def _wheel(self, x: int, y: int, delta_x: int, delta_y: int) -> None:
        cdp = await self._cdp()
        await cdp.cdp_client.send.Input.dispatchMouseEvent(
            params={"type": "mouseWheel", "x": x, "y": y, "deltaX": delta_x, "deltaY": delta_y},
            session_id=cdp.session_id,
        )

    async def _click_point(self, x: int, y: int) -> None:
        cdp = await self._cdp()
        for event in ("mousePressed", "mouseReleased"):
            await cdp.cdp_client.send.Input.dispatchMouseEvent(
                params={"type": event, "x": x, "y": y, "button": "left", "clickCount": 1},
                session_id=cdp.session_id,
            )
