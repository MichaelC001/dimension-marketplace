import { fail } from "../store.js";
import type { EngineDriver, EngineOptions } from "./types.js";

/**
 * ABP — the Agent Browser Protocol browser
 * (github.com/theredsix/agent-browser-protocol, default branch `dev`).
 *
 * NOT AVAILABLE, and deliberately not merely unimplemented: the full REST
 * transport for this engine was written, reviewed and then withdrawn, because
 * starting the browser at all is the unsafe act. It remains in this file's git
 * history if upstream ever closes the gap below.
 *
 * ABP is a Chromium fork that embeds an HTTP control server in the browser
 * process, and that server authenticates nothing:
 *
 *  - `AbpHttpServer::HandleRequestOnUI` forwards only method, path and body to
 *    the REST controller — every request header is dropped before routing, so
 *    no Origin, Host, Content-Type or authorization check is even possible.
 *  - `AbpController` parses an arbitrary body with `base::JSONReader`, so a
 *    CORS "simple request" (`text/plain`) from any page qualifies.
 *  - `POST /api/v1/tabs` reaches `CreateTab` -> `::Navigate`, and
 *    `POST /api/v1/browser/shutdown` needs no id at all. Neither requires a
 *    readable response, so the same-origin policy never protects the caller.
 *
 * A web page the agent visits could therefore drive a browser holding real
 * logins without this pack's approval ledger being consulted once. The
 * ephemeral port is obscurity, not authorization, and the documented switches
 * (`abp_switches.cc`: port, config, pause, session dir, window, zoom, timing)
 * expose no authentication, no origin policy and no private transport.
 *
 * Reviewed against upstream source on 2026-09-22.
 */
export async function createAbpDriver(options: EngineOptions): Promise<EngineDriver> {
	// Nothing was started — no process, no profile directory, no port — so the
	// profile lock goes straight back rather than being stranded by the refusal.
	options.onClosed();
	return fail(
		"abp_unauthenticated_control_port",
		"The ABP browser is not available: it exposes an unauthenticated local control port, so any page it visits could drive it " +
			"(open tabs, navigate, shut it down) without this pack's approval. Upstream offers no authentication, origin check or " +
			"private transport for those routes, so a browser holding your logins is not started. Use the chromium, chrome-relay, " +
			"jev or browser-use engine.",
	);
}
