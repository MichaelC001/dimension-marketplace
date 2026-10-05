/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a call that is not the open of a saved profile (a Private browser, a browser shown by id, a
 *  malformed argument) is remembered by the Browser View as one, so that a later Allow on that profile's approval card opens a browser nobody
 *  asked for; an open that did name a saved profile is forgotten, so the person's Allow finishes nothing; or the address a pin (or an
 *  agent-written manifest) chose reaches the approval card and the browser as something other than a plain web address the person can read:
 *  a lookalike host, a reversed file name, `https://bank.com@evil.test/`, a `javascript:` URL, or an address too long to read whole.
 *
 *  `openAttemptOf` (app/view/browser-client.ts) reads the arguments the host delivered with the call that mounted the View. They come over
 *  the bridge as JSON, so nothing about their types is trusted. The address it returns is the one string the card shows and the View opens.
 */
import { expect, test } from "bun:test";
import { type OpenAttempt, openAttemptOf } from "../app/view/browser-client";

const WEB = "https://example.com/";
const kept = (name: string, url: string, shown: string): { name: string; args: Record<string, unknown>; attempt: OpenAttempt } => ({ name, args: { engine: "chromium", profile: "work", url }, attempt: { profile: "work", url: shown } });
/** The profile still resumes, to a blank tab: the address is not one the person can be shown safely. */
const dropped = (name: string, url: string): { name: string; args: Record<string, unknown>; attempt: OpenAttempt } => ({ name, args: { engine: "chromium", profile: "work", url }, attempt: { profile: "work" } });

const ROWS: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> | undefined; readonly attempt: OpenAttempt | null }> = [
	kept("a web address is that profile and address", WEB, WEB),
	kept("an http address is kept too (a local page)", "http://localhost:3000/x?y=1#z", "http://localhost:3000/x?y=1#z"),
	kept("the address is the normalised one, not the text the pin gave: scheme and host fold to lower case and a bare host gets its slash", "HTTPS://Example.COM", WEB),
	kept("an internationalised host is its punycode form, so a lookalike (Cyrillic a) cannot read as the real site", "https://\u0430pple.com/", "https://xn--pple-43d.com/"),
	kept("a bidi override in the path is percent-encoded, so a reversed file name cannot disguise itself", "https://example.com/doc\u202Egnp.exe", "https://example.com/doc%E2%80%AEgnp.exe"),
	kept("a control character in the query is percent-encoded", "https://example.com/?q=a\u0007b", "https://example.com/?q=a%07b"),
	kept("an address of exactly 2048 characters is kept", WEB + "a".repeat(2028), WEB + "a".repeat(2028)),
	dropped("an address one character over 2048 is dropped", WEB + "a".repeat(2029)),
	dropped("the length is the normalised address's, not the text the pin gave: 300 bidi characters are 2700 once encoded", WEB + "\u202E".repeat(300)),
	dropped("an address with a user name reads as the host before the @ and is dropped", "https://bank.com@evil.test/"),
	dropped("an address with a user name and password is dropped", "https://user:secret@example.com/"),
	dropped("a javascript: address is dropped", "javascript:alert(1)"),
	dropped("a data: address is dropped", "data:text/html,<p>hi</p>"),
	dropped("a file: address is dropped", "file:///C:/Windows/win.ini"),
	dropped("about:blank is dropped", "about:blank"),
	dropped("an ftp: address is dropped", "ftp://example.com/"),
	dropped("text that is not an address is dropped", "not an address"),
	{ name: "an address that is not a string is dropped", args: { profile: "work", url: 7 }, attempt: { profile: "work" } },
	{ name: "a saved profile with no address is that profile alone", args: { engine: "chromium", profile: "work" }, attempt: { profile: "work" } },
	{ name: "a Private open names no profile", args: { engine: "chromium", url: WEB }, attempt: null },
	{ name: "a call with no arguments names no profile", args: undefined, attempt: null },
	{ name: "an empty profile is no profile", args: { profile: "" }, attempt: null },
	{ name: "a whitespace profile is no profile", args: { profile: " \t " }, attempt: null },
	{ name: "a profile that is not a string is no profile", args: { profile: 7 }, attempt: null },
	{ name: "a null profile is no profile", args: { profile: null }, attempt: null },
	{ name: "a browser shown by id is not an open, whatever profile and address it carries", args: { browserId: "b1", profile: "work", url: WEB }, attempt: null },
];

for (const { name, args, attempt } of ROWS) {
	test(name, () => {
		expect(openAttemptOf(args)).toEqual(attempt);
	});
}
