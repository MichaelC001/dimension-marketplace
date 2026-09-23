"""Runs jev_ultrafast.Agent tick by tick so a cancel request is honoured between actions.

jev reaches Chrome through a browser-harness daemon named by BU_NAME and pointed at the CDP
websocket by BU_CDP_WS; the daemon is stopped on exit. jev's own background tab stays open.
"""

import os
import uuid

TOKEN_KEYS = {
    "inputTokens": ("input_tokens", "prompt_tokens", "inputTokens", "promptTokens"),
    "outputTokens": ("output_tokens", "completion_tokens", "outputTokens", "completionTokens"),
}


def _tally(state):
    """Cumulative usage over every model call jev made (choices + field text)."""
    calls = state["decisions"] + state["text_calls"]
    usage = {"modelCalls": len(calls), "inputTokens": 0, "outputTokens": 0, "costUsd": None}
    for call in calls:
        raw = call.get("usage") or {}
        for field, keys in TOKEN_KEYS.items():
            usage[field] += next((int(raw[k]) for k in keys if isinstance(raw.get(k), (int, float))), 0)
        if isinstance(raw.get("cost"), (int, float)):
            usage["costUsd"] = (usage["costUsd"] or 0) + raw["cost"]
    return usage


def _label(entry):
    label = f"{entry['kind']} '{entry['action']}'"
    return f"{label} = {entry['text']!r}" if entry.get("text") is not None else label


def run(request, cancel, report):
    missing = [k for k in ("TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY") if not os.environ.get(k)]
    if missing:
        return "failed", f"jev needs {' and '.join(missing)} in the browser server's environment."
    name = f"dim-{uuid.uuid4().hex[:12]}"
    # browser_harness reads both at import time, so they are set before jev is imported.
    os.environ["BU_CDP_WS"] = request["cdpUrl"]
    os.environ["BU_NAME"] = name
    try:
        from jev_ultrafast import Agent

        if cancel.is_set():
            return "cancelled", "Cancelled before start."
        try:
            agent = Agent(request.get("startUrl") or "about:blank", request["task"])
        except RuntimeError as exc:
            # The harness daemon's first CDP calls sometimes miss its 5 s IPC
            # budget while Chrome is busy adopting the new tab. Starting is
            # read-only (a blank tab, then navigation), so one retry is safe.
            if "timed out" not in str(exc):
                raise
            print(f"jev start retried after: {exc}", flush=True)
            agent = Agent(request.get("startUrl") or "about:blank", request["task"])
        state = agent.state
        try:
            while state["status"] not in ("done", "blocked"):
                if cancel.is_set():
                    return "cancelled", f"Cancelled after {len(state['history'])} actions."
                if len(state["history"]) >= request["maxSteps"]:
                    return "blocked", f"Stopped at the {request['maxSteps']}-action limit."
                seen = len(state["history"])
                agent.command("tick")
                report.usage = _tally(state)
                for entry in state["history"][seen:]:
                    report.step(_label(entry), entry["url"])
        finally:
            report.usage = _tally(state)
        url = state["page"]["url"]
        if state["status"] == "done":
            return "done", f"Done after {len(state['history'])} actions at {url}."
        return "blocked", f"jev could not make progress at {url}."
    finally:
        _stop_daemon(name)


def _stop_daemon(name):
    from browser_harness import admin

    try:
        admin.restart_daemon(name=name)
        stopped = not admin.daemon_alive(name)
    except Exception as exc:
        print(f"harness daemon {name} stop failed: {exc!r}", flush=True)
        return
    if not stopped:
        print(f"harness daemon {name} still alive after stop", flush=True)
