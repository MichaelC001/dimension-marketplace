// Google Meet connector — a standard OMP plugin. Two tool families, one plugin:
//
//  1. REST-after-the-fact (rest.ts, cross-platform): create/end Meet spaces and
//     read conference records, participants, recordings, and transcripts over the
//     Meet REST API v2, authenticated via the plugin's `oauth` connect flow
//     (see fraym.plugin.json). No Google SDK — plain fetch, mirroring the sibling
//     google-calendar connector.
//
//  2. Live transcribe (bot.ts, cross-platform): join a meet.google.com URL in a
//     headless Chromium (puppeteer-core), enable Meet's own live captions, and
//     scrape them to a transcript file the agent can poll. LISTEN-ONLY — the bot
//     cannot speak or stream audio into the call (that needs a virtual-audio device
//     + a realtime voice model and is a documented FUTURE capability). See bot.ts.
//
// `skills/`/`rules/` load via OMP's native plugin discovery; this module only
// registers the tools. The connect flow obtains and refreshes the credential the
// REST tools read.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createMeetLiveTools } from "./bot";
import { createMeetRestTools } from "./rest";

export default function googleMeetExtension(pi: ExtensionAPI): void {
	for (const tool of createMeetRestTools()) pi.registerTool(tool);
	for (const tool of createMeetLiveTools()) pi.registerTool(tool);
}
