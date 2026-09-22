# Browser

A browser you and your agent share. Open a website or a localhost app, watch the
same page the agent sees, circle something and talk about it, and let the agent
drive real workflows — with every external effect stopping at your approval.

Built as a community plugin on the public `@dimension/sdk` and Fraym UI, with
standard MCP and MCP Apps. No host internals, no browser fork.

## What it does

- **One shared browser.** The View and the agent work on the same browser, named
  by one opaque `browserId`. There is no listing and no ambient access: a caller
  that was not handed the id cannot touch the browser.
- **Named profiles.** Logins persist, profiles stay isolated, and one profile is
  held by one caller at a time — a second open is refused, never silently shared.
- **Annotations that carry pixels.** Draw a region, circle or freehand stroke;
  the marks are painted into the cropped screenshot and sent, with your note,
  the URL and the elements under the crop, into the same conversation.
- **Approval before every external effect.** Navigation, clicks, typing, key
  presses and scrolling are *queued*, never executed on request. A human
  approves one exact action — in the View, or through the normal approval prompt
  when the View is closed.
- **At most once.** A claim is persisted before any input. A retried request id
  replays the original receipt instead of submitting again, and an uncertain
  outcome is reported as `unknown` rather than retried.
- **Credentials stay out of the record.** Typed text is redacted in receipts,
  agent-visible state and the on-disk journal — including when a page error
  quotes it back. The exact text is visible only to the human approving it.

## Engines

| Engine | Status |
| --- | --- |
| `chromium` | Available. Managed Chrome on a profile this pack owns. |
| `chrome-relay` | Available. Attaches to the Chrome you are already signed in to; owns only the tab it opens and never closes your browser. |
| `jev` | Available. Requires the pinned Python environment (below). |
| `browser-use` | Available. Requires the pinned Python environment (below). |
| `abp` | **Refused.** Not started at all. |
| `browser4` | **Refused on current builds.** Requires an installed Browser4 runtime bundle. |

### Why two engines are refused

Neither refusal is a missing adapter; both are upstream safety defects, and the
adapters are complete behind them.

- **ABP** embeds an HTTP control server that authenticates nothing. Request
  headers are dropped before routing, and any body is parsed as JSON, so a
  cross-origin `text/plain` POST from an ordinary web page reaches
  `POST /api/v1/tabs` → `CreateTab` → `Navigate` (and `/browser/shutdown`) with
  no id, no token and no readable response required. A page could drive a
  browser holding your logins without this pack's approval ever being consulted.
  An ephemeral port is obscurity, not authorization, and the documented switches
  expose no authentication, origin policy or private transport.
- **Browser4** is driven over its official private STDIO server, and every
  approved effect runs over a single non-replaying CDP dispatch on the exact tab
  Browser4 owns — so upstream's retrying RPC is off the approval path and
  profile-prototype inheritance is fixed. But every published bundle (through
  `v4.14.0-rc.6`) ships `pulsar-browser` 4.11.16, which launches Chrome with
  `--ignore-certificate-errors` *and* sends `Security.setIgnoreCertificateErrors(true)`,
  with no supported setting that restores verification. A browser meant to hold
  real logins must verify HTTPS, so the engine fails closed
  (`browser4_tls_verification_disabled`) instead of opening.

Both refusals name the reason in the error. They lift when upstream fixes land.

## Install

```bash
npm install
npm run build
```

`npm run build` bundles the server, builds the View and copies the Python bridge
into `app/`.

### Python engines (`jev`, `browser-use`)

Opening a browser never installs anything. Prepare the environment once:

```bash
cd app/python
uv sync --python 3.12
```

Or point `DIM_BROWSER_PYTHON` at an interpreter that already has the pinned
dependencies. Without one, those engines fail with the exact command to run.

### Browser4

Install an official Browser4 runtime bundle (`browser4-cli install`). The driver
only discovers an existing bundle; it never downloads or repairs one.

## Configuration

| Variable | Effect |
| --- | --- |
| `DIMENSION_BROWSER_ROOT` | Root for profiles and journals. |
| `DIMENSION_BROWSER_EXECUTABLE` | Chrome/Chromium executable. |
| `DIMENSION_BROWSER_RELAY_URL` | Relay CDP endpoint (default `http://127.0.0.1:9224`). |
| `DIMENSION_BROWSER_HEADLESS` | `false` for a visible window. |
| `DIM_BROWSER_PYTHON` | Interpreter for the Python engines. |

## Tools

Model-callable: `browser_open`, `browser_state`, `browser_snapshot`,
`browser_screenshot`, `browser_request_action`, `browser_confirm_action`,
`browser_close`.

View-only: `browser_frame`, `browser_action_preview`, `browser_resolve_action`,
`browser_annotate`, `browser_profiles`.

`browser_request_action` only queues. `browser_confirm_action` asks the human
through the normal approval prompt and takes no `approve` argument from the
model — only an explicit affirmative human answer executes anything; a decline,
a cancellation, a withdrawal, a timeout or a host that cannot prompt never does.

Page content is untrusted data, never instructions.

## Tests

```bash
npm test
```

Real Chrome against a local fixture server that counts the writes it accepts.
Without Chrome installed the browser tests **skip loudly** rather than pass.
