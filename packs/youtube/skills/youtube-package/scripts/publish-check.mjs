#!/usr/bin/env node
// youtube-package helper. Builds the chapter list from a production's edl.json markers and gates
// receipts/publish.json before anything is uploaded. Read-only: it never writes into a production.
// Zero dependencies; runs on node >= 22 and on bun.
//
//   node publish-check.mjs chapters <production-dir> [--duration <seconds>] [--intro-title <text> | --intro-title-file <path>] [--min-seconds 10] [--merge-short]
//   node publish-check.mjs check    <production-dir> [--file receipts/publish.json] [--stage package|upload] [--no-files] [--json]
//   node publish-check.mjs title    <text...> | --file <path>
//
// Exit code: 0 clean (warnings allowed), 1 findings with errors, 2 bad usage.
//
// Why a script and not prose: chapter arithmetic (frames to seconds, the 10 second rule, the 00:00
// start), byte budgets and file hashes are things a model gets wrong silently and a script never does.
// The judgement (which title, which thumbnail, whether a clip needs the disclosure) stays with the
// agent and the person; this only refuses a package that breaks a rule YouTube states in writing.

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The sha256 of a file read in 8 MB blocks, so a master of any size is hashed without being held in memory. */
function sha256File(path) {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
	const descriptor = openSync(path, "r");
	try {
		for (let read = readSync(descriptor, buffer, 0, buffer.length, null); read > 0; read = readSync(descriptor, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
	} finally {
		closeSync(descriptor);
	}
	return hash.digest("hex");
}

export const RULES = {
	titleMaxChars: 100,
	descriptionMaxBytes: 5000,
	tagsMaxChars: 500,
	chapterMinSeconds: 10,
	chapterMinCount: 3,
	hookChars: 150,
	hashtagsShownAboveTitle: 3,
	hashtagsIgnoredAbove: 60,
	thumbnailWidth: 1280,
	thumbnailHeight: 720,
	thumbnailMaxBytes: 2 * 1024 * 1024,
	thumbnailWords: 4,
	shortsMaxSeconds: 180,
	endScreenMinSeconds: 25,
	scoreMax: 5,
	titleTotalMin: 22,
};

const TOP_LEVEL = new Set(["brief.md", "storyboard.json", "edl.json", "media", "renders", "transcripts", "breakdowns", "receipts"]);
const VISIBILITY = ["unlisted", "public", "private", "scheduled"];
const CATEGORIES = [
	"Film & Animation",
	"Autos & Vehicles",
	"Music",
	"Pets & Animals",
	"Sports",
	"Travel & Events",
	"Gaming",
	"People & Blogs",
	"Comedy",
	"Entertainment",
	"News & Politics",
	"Howto & Style",
	"Education",
	"Science & Technology",
	"Nonprofits & Activism",
];
const DISCLOSE_CATEGORIES = ["real-person-says-or-does", "altered-real-footage", "realistic-scene-did-not-occur", "ai-music", "voice-of-someone-else"];
const NO_DISCLOSURE_CATEGORIES = ["not-realistic", "minor-edit", "own-voice-clone", "production-assistance", "unaltered-real"];
const NEEDS_CREDIT_LICENSES = new Set(["cc-by", "commentary"]);
const MUST_BE_COVERED_LICENSES = new Set(["generated", "commentary", "unknown"]);
const OWN_LICENSES = new Set(["owned", "cc0"]);
const VARIANT_IDS = ["a", "b", "c"];

// ---------------------------------------------------------------------------------------------
// small helpers

const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = value => typeof value === "string" && value.trim().length > 0;
const isWhole = value => Number.isInteger(value) && value >= 0;
const chars = text => Array.from(text).length;
const byteLength = text => new TextEncoder().encode(text).length;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const two = number => String(number).padStart(2, "0");

/** A production-relative path as the production folder allows it: a known top-level name, no `..`, no drive, no backslash. */
export function isProductionPath(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
	if (/[\\:*?"<>|\u0000-\u001f]/.test(value)) return false;
	const segments = value.split("/");
	if (segments.some(segment => segment === "" || segment === "." || segment === ".." || segment.endsWith(".") || segment.endsWith(" "))) return false;
	return TOP_LEVEL.has(segments[0]);
}

function readJson(path) {
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

class Findings {
	errors = [];
	warnings = [];
	error(code, path, message) {
		this.errors.push({ code, path, message });
	}
	warn(code, path, message) {
		this.warnings.push({ code, path, message });
	}
}

// ---------------------------------------------------------------------------------------------
// chapters

/** `00:00` under an hour, `00:00:00` from an hour up, so the first chapter always starts "00:00". */
export function formatTimestamp(seconds, withHours) {
	const whole = Math.max(0, Math.round(seconds));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	return withHours ? `${two(hours)}:${two(minutes)}:${two(whole % 60)}` : `${two(hours * 60 + minutes)}:${two(whole % 60)}`;
}

/** The edit's length in seconds: the last frame any clip ends on, as video-editor's edlDurationFrames counts it. */
export function edlDurationSeconds(edl) {
	let end = 0;
	for (const track of edl.tracks ?? []) {
		for (const clip of track.clips ?? []) {
			const frames = Math.max(1, Math.round((clip.srcOutFrame - clip.srcInFrame) / (clip.speed ?? 1)));
			end = Math.max(end, clip.recordStartFrame + frames);
		}
	}
	return end / edl.fps;
}

/** Chapters from markers. Pure: returns the list and what it had to do, never touches a file. */
export function buildChapters(edl, options = {}) {
	const minSeconds = options.minSeconds ?? RULES.chapterMinSeconds;
	const introTitle = options.introTitle ?? "Intro";
	const duration = options.durationSeconds ?? edlDurationSeconds(edl);
	const notes = [];
	const problems = [];
	if (!(edl.fps > 0)) problems.push({ code: "bad-edl", message: "edl.json has no positive fps" });
	if (!(duration > 0)) problems.push({ code: "bad-duration", message: "the edit has no length" });
	if (problems.length > 0) return { chapters: [], text: "", duration, notes, problems };
	if (duration < RULES.chapterMinCount * minSeconds) {
		notes.push(`the video runs ${Math.round(duration)} s; ${RULES.chapterMinCount} chapters of ${minSeconds} s need ${RULES.chapterMinCount * minSeconds} s, so it has none`);
		return { chapters: [], text: "", duration, notes, problems, skipped: true };
	}

	const markers = (edl.markers ?? [])
		.filter(marker => isWhole(marker.frame) && isText(marker.label))
		.map(marker => ({ seconds: Math.round(marker.frame / edl.fps), title: marker.label.trim().replace(/\s+/g, " ") }))
		.sort((left, right) => left.seconds - right.seconds);

	let list = [];
	for (const marker of markers) {
		const previous = list[list.length - 1];
		if (previous && previous.seconds === marker.seconds) {
			notes.push(`marker "${marker.title}" shares second ${marker.seconds} with "${previous.title}"; kept the first`);
			continue;
		}
		list.push(marker);
	}
	if (list.length === 0 || list[0].seconds > 0) {
		list.unshift({ seconds: 0, title: introTitle });
		notes.push(`no marker at 0 s; added "${introTitle}" at 00:00`);
	}

	if (options.mergeShort === true) {
		let changed = true;
		while (changed) {
			changed = false;
			for (let index = 0; index < list.length; index++) {
				const end = index + 1 < list.length ? list[index + 1].seconds : duration;
				if (end - list[index].seconds >= minSeconds) continue;
				if (list.length <= 1) break;
				const drop = index === 0 ? 1 : index;
				notes.push(`merged "${list[drop].title}" at ${list[drop].seconds} s into the chapter before it (it ran ${Math.round(end - list[index].seconds)} s, under ${minSeconds})`);
				list.splice(drop, 1);
				changed = true;
				break;
			}
		}
	}

	const withHours = duration >= 3600;
	const chapters = list.map(item => ({ seconds: item.seconds, timestamp: formatTimestamp(item.seconds, withHours), title: item.title }));
	problems.push(...chapterProblems(chapters, duration, minSeconds));
	return { chapters, text: chapters.map(chapter => `${chapter.timestamp} ${chapter.title}`).join("\n"), duration, notes, problems };
}

/** YouTube's three written chapter rules plus the ones that make a list unparseable. */
export function chapterProblems(chapters, duration, minSeconds = RULES.chapterMinSeconds) {
	const problems = [];
	if (chapters.length < RULES.chapterMinCount) problems.push({ code: "chapters-too-few", message: `YouTube needs at least ${RULES.chapterMinCount} chapters, found ${chapters.length}` });
	if (chapters.length > 0 && chapters[0].seconds !== 0) problems.push({ code: "chapters-first-not-zero", message: `the first chapter must start at 00:00, it starts at ${chapters[0].timestamp ?? chapters[0].seconds}` });
	for (let index = 0; index < chapters.length; index++) {
		const chapter = chapters[index];
		const next = index + 1 < chapters.length ? chapters[index + 1].seconds : duration;
		if (index > 0 && chapter.seconds <= chapters[index - 1].seconds) problems.push({ code: "chapters-not-ascending", message: `"${chapter.title}" does not start after the chapter before it` });
		if (chapter.seconds > duration) problems.push({ code: "chapters-past-end", message: `"${chapter.title}" starts at ${chapter.seconds} s, after the ${Math.round(duration)} s video ends` });
		else if (next - chapter.seconds < minSeconds) problems.push({ code: "chapter-too-short", message: `"${chapter.title}" lasts ${Math.max(0, Math.round(next - chapter.seconds))} s, under the ${minSeconds} s minimum` });
		if (!isText(chapter.title)) problems.push({ code: "chapter-title-empty", message: `the chapter at ${chapter.timestamp ?? chapter.seconds} has no title` });
		else if (/[<>]/.test(chapter.title)) problems.push({ code: "chapter-title-angle-bracket", message: `"${chapter.title}" holds < or >, which a description cannot carry` });
	}
	return problems;
}

const CHAPTER_LINE = /^(\d{1,2}(?::\d{2}){1,2})\s+(\S.*?)\s*$/;

function timestampSeconds(stamp) {
	const parts = stamp.split(":").map(Number);
	return parts.reduce((total, part) => total * 60 + part, 0);
}

/** The chapter block in a description, and whether it is one unbroken run of lines. */
export function parseDescriptionChapters(text) {
	const lines = text.split(/\r?\n/);
	const found = [];
	lines.forEach((line, index) => {
		const match = CHAPTER_LINE.exec(line);
		if (match) found.push({ line: index, seconds: timestampSeconds(match[1]), timestamp: match[1], title: match[2] });
	});
	const contiguous = found.every((entry, index) => index === 0 || entry.line === found[index - 1].line + 1);
	return { chapters: found, contiguous };
}

// ---------------------------------------------------------------------------------------------
// titles

/** 0-5. Deterministic so a recorded score cannot drift from the text: 30-50 characters is the band every niche favoured. */
export function titleLengthScore(length) {
	if (length > RULES.titleMaxChars || length === 0) return 0;
	if (length >= 30 && length <= 50) return 5;
	if ((length >= 51 && length <= 60) || (length >= 20 && length <= 29)) return 4;
	if (length >= 61 && length <= 70) return 2;
	if (length < 20) return 2;
	return 1;
}

const EMOJI = /\p{Extended_Pictographic}/gu;

export function lintTitle(text) {
	const out = [];
	const length = chars(text);
	if (length === 0) out.push({ severity: "error", code: "title-empty", message: "the title is empty" });
	if (length > RULES.titleMaxChars) out.push({ severity: "error", code: "title-too-long", message: `${length} characters; YouTube allows ${RULES.titleMaxChars}` });
	else if (length > 70) out.push({ severity: "warning", code: "title-truncates", message: `${length} characters; phone feeds cut titles near 60 to 70, so the end will not be seen` });
	if (/[<>]/.test(text)) out.push({ severity: "error", code: "title-angle-bracket", message: "a title cannot hold < or >" });
	const shouting = text.split(/\s+/).filter(word => word.length >= 3 && word === word.toUpperCase() && /\p{L}/u.test(word));
	if (shouting.length >= 3) out.push({ severity: "warning", code: "title-shouting", message: `${shouting.length} ALL CAPS words (${shouting.slice(0, 3).join(", ")}); YouTube advises limiting caps and emoji` });
	if ((text.match(EMOJI) ?? []).length >= 2) out.push({ severity: "warning", code: "title-emoji", message: "two or more emoji; YouTube advises limiting them" });
	if (/[!?]{2,}/.test(text) || /\.\.\.|\u2026\s*$/.test(text)) out.push({ severity: "warning", code: "title-punctuation", message: "repeated punctuation or a trailing ellipsis reads as bait" });
	if (/^(this|these)\b/i.test(text.trim())) out.push({ severity: "warning", code: "title-vague-opener", message: 'opens on "this" or "these" with nothing named; name the thing so the topic is clear before the click' });
	return out;
}

// ---------------------------------------------------------------------------------------------
// tags

/** The Data API's budget: commas between tags count, and a tag holding a space counts with its two quotes. */
export function tagBudget(tags) {
	return tags.reduce((total, tag) => total + chars(tag) + (tag.includes(" ") ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

// ---------------------------------------------------------------------------------------------
// captions

export function parseSrt(text) {
	const cues = [];
	const problems = [];
	if (text.charCodeAt(0) === 0xfeff) problems.push({ code: "srt-bom", message: "the file starts with a byte-order mark; YouTube asks for plain UTF-8" });
	const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
	let previousEnd = 0;
	for (const block of blocks) {
		const lines = block.split("\n");
		const timing = lines.find(line => line.includes("-->"));
		const match = timing && /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(timing.trim());
		if (!match) {
			problems.push({ code: "srt-bad-cue", message: `a cue has no valid "hh:mm:ss,mmm --> hh:mm:ss,mmm" line: ${JSON.stringify(block.slice(0, 60))}` });
			continue;
		}
		const start = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
		const end = Number(match[5]) * 3600 + Number(match[6]) * 60 + Number(match[7]) + Number(match[8]) / 1000;
		const body = lines.slice(lines.indexOf(timing) + 1).join(" ").trim();
		if (end <= start) problems.push({ code: "srt-backwards-cue", message: `a cue ends at ${end} s, not after it starts at ${start} s` });
		if (start + 0.001 < previousEnd) problems.push({ code: "srt-overlap", message: `a cue starts at ${start} s before the previous one ends at ${previousEnd} s` });
		if (body.length === 0) problems.push({ code: "srt-empty-cue", message: `the cue at ${start} s has no text` });
		previousEnd = Math.max(previousEnd, end);
		cues.push({ start, end, text: body });
	}
	return { cues, problems, lastEnd: previousEnd };
}

// ---------------------------------------------------------------------------------------------
// the gate

function loadAssets(directory) {
	const folder = join(directory, "media");
	if (!existsSync(folder)) return [];
	return readdirSync(folder)
		.filter(name => name.endsWith(".asset.json"))
		.map(name => readJson(join(folder, name)).value)
		.filter(record => isRecord(record) && isText(record.id));
}

function checkMaster(directory, publish, findings, options, duration) {
	const master = publish.master;
	if (!isRecord(master)) return findings.error("master-missing", "master", "master is required: the final render this package is for");
	if (!isProductionPath(master.path) || !master.path.startsWith("renders/")) findings.error("master-path", "master.path", "master.path must sit under renders/ in the production");
	if (!(master.durationSeconds > 0)) findings.error("master-duration", "master.durationSeconds", "master.durationSeconds must be the master's length in seconds");
	if (!isText(master.editRevision)) findings.error("master-revision", "master.editRevision", "master.editRevision must be the edit revision the render receipt names");
	if (!options.files || !isProductionPath(master.path)) return;
	const file = join(directory, master.path);
	if (!existsSync(file)) return findings.error("master-file-missing", "master.path", `${master.path} does not exist`);
	const edl = readJson(join(directory, "edl.json")).value;
	if (edl?.fps > 0 && master.durationSeconds > 0) {
		const edited = edlDurationSeconds(edl);
		if (Math.abs(edited - master.durationSeconds) > 1) findings.warn("master-duration-drift", "master.durationSeconds", `the edit runs ${edited.toFixed(2)} s, the package says ${master.durationSeconds} s; chapters were checked against the package value`);
	}
	if (!isProductionPath(master.renderReceipt)) return findings.error("master-receipt", "master.renderReceipt", "master.renderReceipt must be the receipts/render-...-final.json the render wrote");
	const receipt = readJson(join(directory, master.renderReceipt));
	if (receipt.error) return findings.error("master-receipt-unreadable", "master.renderReceipt", `${master.renderReceipt}: ${receipt.error}`);
	const body = receipt.value;
	if (body.profile !== "final") findings.error("master-not-final", "master.renderReceipt", `the receipt is for the "${body.profile}" profile; a package needs a final render`);
	if (body.output?.path !== master.path) findings.error("master-receipt-path", "master.renderReceipt", `the receipt is for ${body.output?.path}, the package names ${master.path}`);
	if (isText(master.editRevision) && body.editRevision !== master.editRevision) findings.error("master-stale", "master.editRevision", "the render receipt is for a different edit revision than the package records");
	const bytes = statSync(file).size;
	if (typeof body.output?.bytes === "number" && body.output.bytes !== bytes) findings.error("master-replaced", "master.path", `${master.path} is ${bytes} bytes, its render receipt says ${body.output.bytes}: the file changed after the render`);
	if (typeof body.output?.sha256 === "string") {
		if (sha256File(file) !== body.output.sha256) findings.error("master-replaced", "master.path", `${master.path} does not hash to the sha256 its render receipt records: the file changed after the render`);
		if (typeof master.sha256 === "string" && body.output.sha256 !== master.sha256) findings.error("master-hash", "master.sha256", "master.sha256 differs from the render receipt");
	}
	if (duration > 0 && duration < 1) findings.warn("master-short", "master.durationSeconds", "under a second");
}

function checkTitle(publish, findings) {
	const title = publish.title;
	if (!isRecord(title) || !Array.isArray(title.options)) return findings.error("title-missing", "title", "title.chosen and title.options are required");
	if (title.options.length < 3) findings.error("title-options", "title.options", `${title.options.length} options; score at least 3 so the choice is a comparison and not the first idea`);
	const patterns = new Set();
	let chosen;
	title.options.forEach((option, index) => {
		const path = `title.options[${index}]`;
		if (!isRecord(option) || !isText(option.text)) return findings.error("title-option-shape", path, "each option needs text and scores");
		const length = chars(option.text);
		if (option.chars !== length) findings.error("title-chars", `${path}.chars`, `chars is ${option.chars}, the text is ${length}`);
		if (isText(option.pattern)) patterns.add(option.pattern);
		const scores = option.scores;
		const dimensions = ["accuracy", "clarity", "curiosity", "search", "length", "risk"];
		if (!isRecord(scores) || dimensions.some(key => !Number.isInteger(scores[key]) || scores[key] < 0 || scores[key] > RULES.scoreMax)) {
			return findings.error("title-scores", `${path}.scores`, `scores needs whole numbers 0-${RULES.scoreMax} for ${dimensions.join(", ")}`);
		}
		if (scores.length !== titleLengthScore(length)) findings.error("title-length-score", `${path}.scores.length`, `length score is ${scores.length}; ${length} characters scores ${titleLengthScore(length)}`);
		const total = dimensions.reduce((sum, key) => sum + scores[key], 0);
		if (option.total !== total) findings.error("title-total", `${path}.total`, `total is ${option.total}, the scores add to ${total}`);
		if (option.text === title.chosen) chosen = option;
	});
	if (patterns.size < 2 && title.options.length >= 2) findings.warn("title-patterns", "title.options", "every option uses one pattern; vary the angle so a test teaches something");
	if (!isText(title.chosen)) return findings.error("title-chosen", "title.chosen", "title.chosen is required");
	if (!chosen) return findings.error("title-chosen-unscored", "title.chosen", "the chosen title is not one of the scored options");
	for (const item of lintTitle(chosen.text)) (item.severity === "error" ? findings.error : findings.warn).call(findings, item.code, "title.chosen", item.message);
	if (chosen.scores?.accuracy < 4) findings.error("title-accuracy", "title.chosen", "accuracy below 4: a title that overpromises is malicious clickbait under YouTube's spam policy and costs the retention it was meant to win");
	if (chosen.scores?.risk < 4) findings.error("title-risk", "title.chosen", "risk below 4: rewrite before it ships");
	if (chosen.total < RULES.titleTotalMin) findings.error("title-total-low", "title.chosen", `the chosen title totals ${chosen.total}; ship one at ${RULES.titleTotalMin} or more of ${6 * RULES.scoreMax}, or write a better option`);
}

function checkDescription(publish, findings, duration) {
	const description = publish.description;
	if (!isRecord(description) || !isText(description.text)) return findings.error("description-missing", "description.text", "description.text is required");
	const text = description.text;
	const bytes = byteLength(text);
	if (bytes > RULES.descriptionMaxBytes) findings.error("description-too-long", "description.text", `${bytes} bytes; the limit is ${RULES.descriptionMaxBytes}`);
	if (/[<>]/.test(text)) findings.error("description-angle-bracket", "description.text", "a description cannot hold < or >");
	const hook = Array.from(text).slice(0, RULES.hookChars).join("");
	if (/https?:\/\//i.test(hook)) findings.error("description-hook-link", "description.text", `the first ${RULES.hookChars} characters are all a viewer sees before "more": spend them on the video, not a link`);
	if (CHAPTER_LINE.test(hook.split("\n")[0])) findings.error("description-hook-timestamps", "description.text", "the description opens with the chapter list; open with a sentence about the video");
	if (/^\s*#/.test(hook)) findings.warn("description-hook-hashtag", "description.text", "the description opens with a hashtag; put hashtags at the end");
	if (/^\s*in this video\b/i.test(hook)) findings.warn("description-hook-filler", "description.text", '"In this video" spends the first words on nothing; say what the video shows');
	if (isText(description.primaryKeyword) && !hook.toLowerCase().includes(description.primaryKeyword.toLowerCase())) findings.warn("description-hook-keyword", "description.primaryKeyword", `"${description.primaryKeyword}" is not in the first ${RULES.hookChars} characters`);

	const parsed = parseDescriptionChapters(text);
	const tooShortForChapters = duration > 0 && duration < RULES.chapterMinCount * RULES.chapterMinSeconds;
	if (tooShortForChapters) {
		if (parsed.chapters.length > 0) findings.error("chapters-on-short-video", "description.text", `a ${Math.round(duration)} s video cannot hold ${RULES.chapterMinCount} chapters of ${RULES.chapterMinSeconds} s; remove the timestamp lines`);
		if (Array.isArray(description.chapters) && description.chapters.length > 0) findings.error("chapters-drift", "description.chapters", "a video this short has no chapters; description.chapters must be empty");
	} else {
		for (const problem of chapterProblems(parsed.chapters, duration)) findings.error(problem.code, "description.text", problem.message);
		if (parsed.chapters.length > 0 && !parsed.contiguous) findings.error("chapters-not-contiguous", "description.text", "chapter lines must be one unbroken run; another line of timestamps in the description breaks the list");
		if (!Array.isArray(description.chapters)) findings.error("chapters-missing", "description.chapters", "description.chapters is required (build it with the chapters command)");
		else {
			const same = description.chapters.length === parsed.chapters.length && description.chapters.every((chapter, index) => chapter.seconds === parsed.chapters[index].seconds && chapter.title === parsed.chapters[index].title);
			if (!same) findings.error("chapters-drift", "description.chapters", "description.chapters does not match the chapter lines in description.text");
		}
	}

	const hashtags = Array.isArray(description.hashtags) ? description.hashtags : [];
	for (const tag of hashtags) {
		if (!/^#[\p{L}\p{N}_]+$/u.test(tag)) findings.error("hashtag-shape", "description.hashtags", `"${tag}" must be # and then letters, digits or _ with no spaces`);
		else if (!text.includes(tag)) findings.error("hashtag-absent", "description.hashtags", `${tag} is listed but is not in description.text`);
	}
	if (hashtags.length > RULES.hashtagsIgnoredAbove) findings.error("hashtags-ignored", "description.hashtags", `more than ${RULES.hashtagsIgnoredAbove} hashtags and YouTube ignores all of them`);
	else if (hashtags.length > RULES.hashtagsShownAboveTitle) findings.warn("hashtags-many", "description.hashtags", `${hashtags.length} hashtags; only ${RULES.hashtagsShownAboveTitle} show above the title and more dilute them`);

	for (const [index, source] of (Array.isArray(description.sources) ? description.sources : []).entries()) {
		const path = `description.sources[${index}]`;
		if (!isRecord(source) || !isText(source.label)) findings.error("source-shape", path, "a source needs label and url");
		else if (typeof source.url !== "string" || !/^https:\/\//.test(source.url)) findings.error("source-url", path, `"${source.label}" needs an https url`);
		else if (!text.includes(source.url)) findings.error("source-absent", path, `${source.url} is listed as a source but is not in description.text`);
	}
}

function checkTags(publish, findings) {
	const tags = publish.tags;
	if (!Array.isArray(tags)) return findings.error("tags-missing", "tags", "tags is required (an empty list is allowed: YouTube says tags play a minimal role)");
	const seen = new Set();
	for (const tag of tags) {
		if (!isText(tag) || /[<>]/.test(tag)) findings.error("tag-shape", "tags", `${JSON.stringify(tag)} is not a usable tag`);
		else if (seen.has(tag.toLowerCase())) findings.error("tag-duplicate", "tags", `"${tag}" is listed twice`);
		else seen.add(tag.toLowerCase());
	}
	const budget = tagBudget(tags.filter(isText));
	if (budget > RULES.tagsMaxChars) findings.error("tags-too-long", "tags", `${budget} characters against the ${RULES.tagsMaxChars} budget (commas count, and a tag with a space counts its quotes)`);
	if (tags.length > 15) findings.warn("tags-many", "tags", `${tags.length} tags; YouTube says tags help only with common misspellings`);
}

function checkThumbnail(directory, publish, findings, options, titleText) {
	const thumbnail = publish.thumbnail;
	if (!isRecord(thumbnail)) return findings.error("thumbnail-missing", "thumbnail", "thumbnail.brief and thumbnail.variants are required");
	const brief = thumbnail.brief;
	if (!isRecord(brief) || !isText(brief.concept) || !isText(brief.text)) findings.error("thumbnail-brief", "thumbnail.brief", "the brief needs a concept and the words on the image (text)");
	else {
		const words = brief.text.trim().split(/\s+/).length;
		if (words > RULES.thumbnailWords) findings.error("thumbnail-words", "thumbnail.brief.text", `${words} words; at 168 px wide more than ${RULES.thumbnailWords} cannot be read`);
		const titleWords = new Set(String(titleText ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
		const textWords = brief.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
		if (textWords.length > 1 && textWords.every(word => titleWords.has(word))) findings.warn("thumbnail-repeats-title", "thumbnail.brief.text", "every word on the thumbnail is already in the title; give it a hook the title does not say");
	}
	const variants = Array.isArray(thumbnail.variants) ? thumbnail.variants : [];
	if (variants.length === 0 && options.stage === "package") return;
	const testsThumbnails = isRecord(thumbnail.abTest) && thumbnail.abTest.run === true && thumbnail.abTest.target !== "title";
	if (variants.length < (testsThumbnails ? 2 : 1)) findings.error("thumbnail-variants", "thumbnail.variants", testsThumbnails ? "thumbnail.abTest plans a thumbnail test and YouTube's A/B test takes 2 or 3 thumbnails; list 2 or 3 variants, or set abTest.run to false for one thumbnail" : "at least one thumbnail variant is required");
	else if (testsThumbnails && variants.length < 3) findings.warn("thumbnail-variants", "thumbnail.variants", "3 variants is the brief; 2 is the least a test needs");
	const ids = new Set();
	variants.forEach((variant, index) => {
		const path = `thumbnail.variants[${index}]`;
		if (!isRecord(variant) || !VARIANT_IDS.includes(variant.id) || ids.has(variant.id)) return findings.error("thumbnail-variant-id", path, "each variant needs a distinct id a, b or c");
		ids.add(variant.id);
		if (!isProductionPath(variant.path) || !variant.path.startsWith("renders/")) return findings.error("thumbnail-path", `${path}.path`, "a variant path must sit under renders/");
		if (variant.width !== RULES.thumbnailWidth || variant.height !== RULES.thumbnailHeight) findings.error("thumbnail-size", path, `${variant.width}x${variant.height}; a thumbnail is ${RULES.thumbnailWidth}x${RULES.thumbnailHeight}`);
		if (!["png", "jpg"].includes(variant.format)) findings.error("thumbnail-format", `${path}.format`, "format is png or jpg");
		if (!(variant.bytes > 0) || variant.bytes > RULES.thumbnailMaxBytes) findings.error("thumbnail-bytes", `${path}.bytes`, `${variant.bytes} bytes; the limit is ${RULES.thumbnailMaxBytes} (2 MB, which every upload route accepts)`);
		if (variant.phoneCheck !== true) findings.error("thumbnail-phone-check", `${path}.phoneCheck`, "phoneCheck must be true once the 168x94 sheet was read and passed");
		if (!options.files) return;
		const file = join(directory, variant.path);
		if (!existsSync(file)) return findings.error("thumbnail-file-missing", `${path}.path`, `${variant.path} does not exist`);
		const bytes = readFileSync(file);
		if (bytes.length !== variant.bytes) findings.error("thumbnail-changed", `${path}.bytes`, `${variant.path} is ${bytes.length} bytes, the package says ${variant.bytes}: it changed after it was measured`);
		else if (typeof variant.sha256 !== "string") findings.error("thumbnail-hash-missing", `${path}.sha256`, "sha256 is required so a change after measurement is caught (thumbnail-pack.mjs inspect prints it)");
		else if (sha256(bytes) !== variant.sha256) findings.error("thumbnail-hash", `${path}.sha256`, `${variant.path} differs from the file that was measured`);
	});
	if (!isText(thumbnail.chosen) || !ids.has(thumbnail.chosen)) findings.error("thumbnail-chosen", "thumbnail.chosen", "thumbnail.chosen must be the id of the variant to upload as the thumbnail (a, b or c)");
}

function checkSettings(publish, findings, assets, directory, options) {
	const settings = publish.settings;
	if (!isRecord(settings)) return findings.error("settings-missing", "settings", "settings is required");
	if (!VISIBILITY.includes(settings.visibility)) findings.error("visibility", "settings.visibility", `visibility is one of ${VISIBILITY.join(", ")}`);
	else if (settings.visibility === "scheduled" && !isText(settings.scheduledAt)) findings.error("visibility-scheduled", "settings.scheduledAt", "a scheduled video needs scheduledAt (ISO 8601 with offset)");
	if (settings.madeForKids !== false) findings.error("made-for-kids", "settings.madeForKids", "madeForKids must be stated; this package is for audiences that are not made for kids (set false), and a made-for-kids film is a different job");
	if (typeof settings.ageRestricted !== "boolean") findings.error("age-restricted", "settings.ageRestricted", "ageRestricted must be true or false");
	if (!CATEGORIES.includes(settings.category)) findings.error("category", "settings.category", `category is one of Studio's names: ${CATEGORIES.join(", ")}`);
	if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(settings.language ?? "")) findings.error("language", "settings.language", 'language is a code such as "en" or "en-US"');
	if (!["standard", "cc-by"].includes(settings.license)) findings.error("license", "settings.license", 'license is "standard" or "cc-by"');
	else if (settings.license === "cc-by" && assets.some(asset => !OWN_LICENSES.has(asset.license))) findings.error("license-cc-by", "settings.license", "CC BY is for content you can license under CC BY (your own, CC BY or public domain). Assets here are not all owned or cc0, so the license is standard");

	const altered = settings.alteredContent;
	if (!isRecord(altered) || typeof altered.disclose !== "boolean" || !Array.isArray(altered.assets) || !isText(altered.assessedAt)) {
		findings.error("altered-missing", "settings.alteredContent", "alteredContent needs disclose (true or false), assets (a verdict per generated asset) and assessedAt");
		return;
	}
	const verdicts = new Map();
	altered.assets.forEach((entry, index) => {
		const path = `settings.alteredContent.assets[${index}]`;
		if (!isRecord(entry) || !isText(entry.id) || !isText(entry.reason)) return findings.error("altered-entry", path, "each entry needs id, verdict, category and a reason");
		verdicts.set(entry.id, entry);
		const set = entry.verdict === "disclose" ? DISCLOSE_CATEGORIES : entry.verdict === "no-disclosure" ? NO_DISCLOSURE_CATEGORIES : undefined;
		if (!set) return findings.error("altered-verdict", `${path}.verdict`, 'verdict is "disclose" or "no-disclosure"');
		if (!set.includes(entry.category)) findings.error("altered-category", `${path}.category`, `${entry.verdict} takes one of: ${set.join(", ")}`);
		if (entry.category === "own-voice-clone" && entry.confirmedByPerson !== true) findings.error("altered-voice", path, "own-voice-clone needs confirmedByPerson: true, set only after the person said the voice is their own");
	});
	if (options.files) {
		for (const asset of assets) {
			if (MUST_BE_COVERED_LICENSES.has(asset.license) && !verdicts.has(asset.id)) findings.error("altered-uncovered", "settings.alteredContent.assets", `asset "${asset.id}" (${asset.license}${asset.kind ? `, ${asset.kind}` : ""}) has no verdict`);
		}
		for (const id of verdicts.keys()) if (!assets.some(asset => asset.id === id)) findings.warn("altered-unknown-asset", "settings.alteredContent.assets", `"${id}" is not an asset record in media/`);
	}
	const anyDisclose = [...verdicts.values()].some(entry => entry.verdict === "disclose");
	if (altered.disclose !== anyDisclose) findings.error("altered-disagrees", "settings.alteredContent.disclose", anyDisclose ? "an asset needs the disclosure, so disclose must be true" : "no asset needs the disclosure, so disclose must be false: record what is true");
	if (altered.disclose === true && !publish.description?.text?.includes("AI")) findings.warn("altered-description", "description.text", "the film carries the label; consider one plain line in the description naming what is AI-made");
}

function checkCredits(publish, findings, assets) {
	const text = publish.description?.text ?? "";
	for (const asset of assets) {
		if (!NEEDS_CREDIT_LICENSES.has(asset.license) && !(asset.attributionRequired === true)) continue;
		if (!isText(asset.attribution)) findings.error("credit-missing", "description.text", `"${asset.id}" needs a credit line and its record has no attribution`);
		else if (!text.includes(asset.attribution)) findings.error("credit-absent", "description.text", `the credit line for "${asset.id}" (${JSON.stringify(asset.attribution)}) is not in the description`);
		if (asset.license === "commentary" && !isText(asset.sourceUrl)) findings.error("commentary-source-missing", "description.text", `commentary clip "${asset.id}" has no sourceUrl in its record`);
		else if (asset.license === "commentary" && !text.includes(asset.sourceUrl)) findings.error("commentary-source-absent", "description.text", `the source of commentary clip "${asset.id}" (${asset.sourceUrl}) is not in the description`);
	}
}

function checkCaptions(directory, publish, findings, options, duration) {
	const captions = publish.captions;
	if (!isRecord(captions)) return findings.error("captions-missing", "captions", "captions is required: the SRT to upload, or { file: null, reason } when there is no speech");
	if (captions.file === null) return isText(captions.reason) ? undefined : findings.error("captions-reason", "captions.reason", "say why there is no caption file");
	if (!isProductionPath(captions.file) || !captions.file.startsWith("renders/") || !captions.file.endsWith(".srt")) return findings.error("captions-path", "captions.file", "captions.file must be a .srt under renders/");
	if (!isText(captions.language)) findings.error("captions-language", "captions.language", "captions.language must match settings.language so the track is filed under the spoken language");
	else if (captions.language !== publish.settings?.language) findings.warn("captions-language-differs", "captions.language", `captions are ${captions.language}, the video language is ${publish.settings?.language}`);
	if (captions.reviewed !== true) findings.warn("captions-unreviewed", "captions.reviewed", "read the SRT against the script and the claim list (names, product terms, numbers) and set reviewed: true");
	if (!options.files) return;
	const file = join(directory, captions.file);
	if (!existsSync(file)) return findings.error("captions-file-missing", "captions.file", `${captions.file} does not exist`);
	const parsed = parseSrt(readFileSync(file, "utf8"));
	for (const problem of parsed.problems) findings.error(problem.code, "captions.file", problem.message);
	if (parsed.cues.length === 0) findings.error("captions-empty", "captions.file", "no cues");
	if (duration > 0 && parsed.lastEnd > duration + 1) findings.error("captions-past-end", "captions.file", `the last cue ends at ${parsed.lastEnd.toFixed(1)} s, after the ${duration.toFixed(1)} s master`);
}

/** YouTube's A/B test: up to 3 titles and/or thumbnails, desktop Studio, not for private, made-for-kids or Shorts (help answer 16391400). */
function checkAbTest(publish, findings) {
	const plan = publish.thumbnail?.abTest;
	if (!isRecord(plan) || plan.run !== true) return;
	if (!["thumbnail", "title", "title-and-thumbnail"].includes(plan.target)) return findings.error("ab-test-target", "thumbnail.abTest.target", 'target is "thumbnail", "title" or "title-and-thumbnail"');
	if (publish.settings?.visibility === "private") findings.error("ab-test-private", "settings.visibility", "YouTube does not run an A/B test on a private video; publish it unlisted or public, or set abTest.run to false");
	const variantIds = new Set((publish.thumbnail?.variants ?? []).filter(isRecord).map(variant => variant.id));
	if (plan.target !== "title") {
		if (!Array.isArray(plan.order) || plan.order.length < 2 || plan.order.length > 3 || plan.order.some(id => !variantIds.has(id))) findings.error("ab-test-order", "thumbnail.abTest.order", "order lists 2 or 3 variant ids, the one to show by default first");
		else if (plan.order[0] !== publish.thumbnail?.chosen) findings.error("ab-test-first", "thumbnail.abTest.order", "the first variant uploaded is the default when the test is inconclusive, so it must be thumbnail.chosen");
	}
	if (plan.target !== "thumbnail" && (!Array.isArray(plan.titles) || plan.titles.length < 2 || plan.titles.length > 3 || plan.titles[0] !== publish.title?.chosen || plan.titles.some(text => !(publish.title?.options ?? []).some(option => option.text === text)))) findings.error("ab-test-titles", "thumbnail.abTest.titles", "titles lists 2 or 3 of the scored options, the chosen title first");
}

function checkUpload(publish, findings) {
	const upload = publish.upload;
	if (upload === undefined) return;
	if (!isRecord(upload) || !/^[A-Za-z0-9_-]{11}$/.test(upload.videoId ?? "")) return findings.error("upload-video-id", "upload.videoId", "upload.videoId must be the 11 character id YouTube gave the video");
	if (upload.url !== `https://youtu.be/${upload.videoId}`) findings.error("upload-url", "upload.url", `upload.url must be https://youtu.be/${upload.videoId}`);
	if (!VISIBILITY.includes(upload.visibility)) findings.error("upload-visibility", "upload.visibility", `upload.visibility is one of ${VISIBILITY.join(", ")}`);
	if (upload.visibility !== publish.settings?.visibility) findings.warn("upload-visibility-differs", "upload.visibility", `uploaded as ${upload.visibility}, the package says ${publish.settings?.visibility}`);
	if (!Array.isArray(upload.readback) || upload.readback.length === 0) findings.error("upload-readback", "upload.readback", "upload.readback must list every field read back from the edit page");
	else for (const row of upload.readback) if (row?.ok !== true) findings.error("upload-readback-mismatch", "upload.readback", `${row?.field ?? "a field"} did not read back as expected: wanted ${JSON.stringify(row?.expected)}, saw ${JSON.stringify(row?.actual)}`);
}

function checkExtras(publish, findings, duration) {
	const shorts = Array.isArray(publish.shorts) ? publish.shorts : [];
	shorts.forEach((short, index) => {
		const path = `shorts[${index}]`;
		if (!isRecord(short) || !isText(short.title) || !(short.toSeconds > short.fromSeconds) || !(short.fromSeconds >= 0)) return findings.error("short-shape", path, "a short needs title, fromSeconds and toSeconds (to after from)");
		if (short.toSeconds - short.fromSeconds > RULES.shortsMaxSeconds) findings.error("short-long", path, `a Short is at most ${RULES.shortsMaxSeconds} s`);
		if (short.toSeconds > duration + 0.5) findings.error("short-past-end", path, "the cut-down runs past the end of the master");
		if (chars(short.title) > RULES.titleMaxChars) findings.error("short-title", path, "the Short's title is over 100 characters");
	});
	const endScreen = publish.endScreen;
	if (isRecord(endScreen) && endScreen.enabled === true) {
		if (duration < RULES.endScreenMinSeconds) findings.error("end-screen-short", "endScreen", `an end screen needs a video of ${RULES.endScreenMinSeconds} s or more; this is ${duration.toFixed(0)} s`);
		if (publish.settings?.madeForKids === true) findings.error("end-screen-kids", "endScreen", "end screens are not available on made-for-kids videos");
	}
}

function findPlaceholders(value, path, findings) {
	if (typeof value === "string") {
		if (/\b(TODO|TBD|FIXME|lorem ipsum|placeholder)\b/i.test(value) || /<[A-Za-z][^<>\n]*>/.test(value)) findings.error("placeholder", path, `looks like a placeholder: ${JSON.stringify(value.slice(0, 60))}`);
	} else if (Array.isArray(value)) value.forEach((item, index) => findPlaceholders(item, `${path}[${index}]`, findings));
	else if (isRecord(value)) for (const [key, item] of Object.entries(value)) findPlaceholders(item, path ? `${path}.${key}` : key, findings);
}

/** The whole gate. `options.files: false` checks the document alone (no disk reads of the production). */
export function checkPublish(directory, options = {}) {
	const settings = { files: options.files !== false, file: options.file ?? "receipts/publish.json", stage: options.stage === "package" ? "package" : "upload" };
	const findings = new Findings();
	if (!isProductionPath(settings.file)) {
		findings.error("file-path", "file", "--file must be a production-relative path such as receipts/publish.json");
		return { ok: false, ...summarize(findings) };
	}
	const target = join(directory, settings.file);
	const loaded = readJson(target);
	if (loaded.error) {
		findings.error("unreadable", settings.file, loaded.error);
		return { ok: false, ...summarize(findings) };
	}
	const publish = loaded.value;
	if (!isRecord(publish)) {
		findings.error("unreadable", settings.file, "publish.json must be an object");
		return { ok: false, ...summarize(findings) };
	}
	if (publish.version !== 1) findings.error("version", "version", "version must be 1");
	if (publish.production !== basename(resolve(directory))) findings.error("production", "production", `production is ${JSON.stringify(publish.production)}, the folder is ${JSON.stringify(basename(resolve(directory)))}`);
	const assets = settings.files ? loadAssets(directory) : [];
	const duration = Number(publish.master?.durationSeconds) || 0;
	checkMaster(directory, publish, findings, settings, duration);
	checkTitle(publish, findings);
	const chosenTitle = publish.title?.chosen;
	checkDescription(publish, findings, duration);
	checkTags(publish, findings);
	checkThumbnail(directory, publish, findings, settings, chosenTitle);
	checkSettings(publish, findings, assets, directory, settings);
	checkCredits(publish, findings, assets);
	checkCaptions(directory, publish, findings, settings, duration);
	checkExtras(publish, findings, duration);
	checkUpload(publish, findings);
	checkAbTest(publish, findings);
	findPlaceholders(publish, "", findings);
	return { ok: findings.errors.length === 0, ...summarize(findings) };
}

function summarize(findings) {
	return { errors: findings.errors, warnings: findings.warnings };
}

// ---------------------------------------------------------------------------------------------
// command line

function flag(argv, name) {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

/** Free text comes from a flag, or from a file named by the flag with -file added: model-written text never has to pass through a shell string. */
function textFlag(argv, name) {
	const file = flag(argv, `${name}-file`);
	return file !== undefined ? readFileSync(file, "utf8").trim() : flag(argv, name);
}

function runChapters(argv) {
	const directory = argv[0];
	if (!directory) return usage();
	const edl = readJson(join(directory, "edl.json"));
	if (edl.error) {
		console.error(`cannot read ${join(directory, "edl.json")}: ${edl.error}`);
		return 2;
	}
	const durationFlag = flag(argv, "--duration");
	const result = buildChapters(edl.value, {
		...(durationFlag !== undefined ? { durationSeconds: Number(durationFlag) } : {}),
		...(textFlag(argv, "--intro-title") !== undefined ? { introTitle: textFlag(argv, "--intro-title") } : {}),
		...(flag(argv, "--min-seconds") !== undefined ? { minSeconds: Number(flag(argv, "--min-seconds")) } : {}),
		mergeShort: argv.includes("--merge-short"),
	});
	console.log(JSON.stringify({ ok: result.problems.length === 0, durationSeconds: result.duration, chapters: result.chapters, text: result.text, notes: result.notes, problems: result.problems }, null, 2));
	return result.problems.length === 0 ? 0 : 1;
}

function runCheck(argv) {
	const directory = argv[0];
	if (!directory) return usage();
	const stage = flag(argv, "--stage");
	if (stage !== undefined && stage !== "package" && stage !== "upload") return usage();
	const result = checkPublish(directory, { file: flag(argv, "--file"), stage, files: !argv.includes("--no-files") });
	if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
	else {
		for (const finding of result.errors) console.log(`✗ ${finding.code} ${finding.path}: ${finding.message}`);
		for (const finding of result.warnings) console.log(`! ${finding.code} ${finding.path}: ${finding.message}`);
		console.log(result.ok ? `READY (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : `NOT READY (${result.errors.length} error${result.errors.length === 1 ? "" : "s"}, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})`);
	}
	return result.ok ? 0 : 1;
}

function runTitle(argv) {
	const fileFlag = flag(argv, "--file");
	const text = (fileFlag !== undefined ? readFileSync(fileFlag, "utf8") : argv.join(" ")).trim();
	if (!text) return usage();
	const length = chars(text);
	console.log(JSON.stringify({ text, chars: length, lengthScore: titleLengthScore(length), findings: lintTitle(text) }, null, 2));
	return lintTitle(text).some(item => item.severity === "error") ? 1 : 0;
}

function usage() {
	console.error("usage: publish-check.mjs chapters <production-dir> [--duration s] [--intro-title text | --intro-title-file path] [--min-seconds 10] [--merge-short]\n       publish-check.mjs check <production-dir> [--file receipts/publish.json] [--stage package|upload] [--no-files] [--json]\n       publish-check.mjs title <text...> | --file <path>");
	return 2;
}

function main(argv) {
	const [command, ...rest] = argv;
	if (command === "chapters") return runChapters(rest);
	if (command === "check") return runCheck(rest);
	if (command === "title") return runTitle(rest);
	return usage();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
