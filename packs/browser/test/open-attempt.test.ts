/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a call that is not the open of a saved profile (a Private browser, a browser shown by id, a
 *  malformed argument) is remembered by the Browser View as one, so that a later Allow on that profile's approval card opens a browser nobody
 *  asked for; or an open that did name a saved profile is forgotten (or loses its address), so the person's Allow finishes nothing.
 *
 *  `openAttemptOf` (app/view/browser-client.ts) reads the arguments the host delivered with the call that mounted the View. They come over
 *  the bridge as JSON, so nothing about their types is trusted.
 */
import { expect, test } from "bun:test";
import { type OpenAttempt, openAttemptOf } from "../app/view/browser-client";

const ROWS: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> | undefined; readonly attempt: OpenAttempt | null }> = [
	{ name: "a saved profile with an address is that profile and address", args: { engine: "chromium", profile: "work", url: "https://example.com/" }, attempt: { profile: "work", url: "https://example.com/" } },
	{ name: "a saved profile with no address is that profile alone", args: { engine: "chromium", profile: "work" }, attempt: { profile: "work" } },
	{ name: "an address that is not a string is no address", args: { profile: "work", url: 7 }, attempt: { profile: "work" } },
	{ name: "a Private open names no profile", args: { engine: "chromium", url: "https://example.com/" }, attempt: null },
	{ name: "a call with no arguments names no profile", args: undefined, attempt: null },
	{ name: "an empty profile is no profile", args: { profile: "" }, attempt: null },
	{ name: "a whitespace profile is no profile", args: { profile: " \t " }, attempt: null },
	{ name: "a profile that is not a string is no profile", args: { profile: 7 }, attempt: null },
	{ name: "a null profile is no profile", args: { profile: null }, attempt: null },
	{ name: "a browser shown by id is not an open, whatever profile it carries", args: { browserId: "b1", profile: "work" }, attempt: null },
];

for (const { name, args, attempt } of ROWS) {
	test(name, () => {
		expect(openAttemptOf(args)).toEqual(attempt);
	});
}
