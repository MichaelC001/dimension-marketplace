"""Shared bridge plumbing: JSON results, safe errors, fixed-script composition.

Nothing in this module ever formats page content, typed text or credentials into
a message. Bridge errors travel to the host through MCP's tool-error channel and
are logged by the MCP SDK, so their text must stay payload free.
"""

from __future__ import annotations

import json
import secrets
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

# A prepared action is one approval in flight. The host's runtime caps pending
# actions far below this; the cap here only stops an abandoned preparation from
# pinning observation state forever.
PREPARED_LIMIT = 64


class BridgeError(Exception):
    """Operational failure whose message carries no page or typed text."""


def dump(value: Any) -> str:
    """Serialize a tool result as JSON text (non-finite floats are rejected)."""
    return json.dumps(value, ensure_ascii=False, allow_nan=False, default=str)


def scrub(message: str, secret: str | None) -> str:
    """Strip approved typed text out of a third-party failure message.

    Upstream error strings sometimes quote the value they were writing. A tool
    error is logged by the MCP SDK and travels to the host, so a password typed
    into a login form must never ride along inside one.
    """
    return message.replace(secret, "[redacted]") if secret else message



def invoke(source: str, *args: Any) -> str:
    """Compose a call of a parent-owned read-only script with JSON literal args.

    `source` is one of the fixed script sources handed over at initialization;
    arguments are JSON literals (ensure_ascii keeps them inside the ASCII range,
    so U+2028/U+2029 can never break out of the expression). No caller-supplied
    JavaScript ever reaches this function.
    """
    literals = ", ".join(json.dumps(arg) for arg in args)
    return f"({source})({literals})"


@dataclass
class Prepared:
    """One approved-but-not-yet-dispatched action, bound to an observed target."""

    kind: str
    document_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    # The approved text of a `type` action. Held in memory only, never logged,
    # never echoed in a result or an error.
    text: str | None = None


class PreparedStore:
    """Single-use registry of prepared actions.

    `take` pops, so a dispatch can never run twice even if the host retries the
    call: the second attempt finds nothing and fails instead of mutating again.
    """

    def __init__(self, limit: int = PREPARED_LIMIT) -> None:
        self._limit = limit
        self._items: OrderedDict[str, Prepared] = OrderedDict()

    def put(self, prepared: Prepared) -> str:
        while len(self._items) >= self._limit:
            self._items.popitem(last=False)
        token = secrets.token_hex(16)
        self._items[token] = prepared
        return token

    def take(self, token: str) -> Prepared:
        prepared = self._items.pop(token, None)
        if prepared is None:
            raise BridgeError("prepared action is unknown or was already dispatched")
        return prepared

    def drop(self, token: str) -> bool:
        return self._items.pop(token, None) is not None

    def clear(self) -> None:
        self._items.clear()
