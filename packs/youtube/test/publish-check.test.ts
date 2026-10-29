import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { buildChapters, chapterProblems, checkPublish, tagBudget, titleLengthScore } from "../skills/youtube-package/scripts/publish-check.mjs";

const FPS = 30;

function edlOf(seconds: number, markers: [number, string][] = []) {
	return {
		fps: FPS,
		tracks: [{ clips: [{ srcInFrame: 0, srcOutFrame: seconds * FPS, recordStartFrame: 0 }] }],
		markers: markers.map(([at, label]) => ({ frame: at * FPS, label })),
	};
}

const codesOf = (problems: { code: string }[]) => problems.map(problem => problem.code);

describe("buildChapters", () => {
	test("opens the list with an Intro chapter at 00:00 when the first marker is later", () => {
		const result = buildChapters(edlOf(240, [[30, "The ask"], [75, "The cut"]]));

		expect(result.text).toBe("00:00 Intro\n00:30 The ask\n01:15 The cut");
		expect(result.problems).toEqual([]);
	});

	test("names the added opening chapter after introTitle", () => {
		const result = buildChapters(edlOf(240, [[30, "The ask"], [75, "The cut"]]), { introTitle: "Cold open" });

		expect(result.text.split("\n")[0]).toBe("00:00 Cold open");
	});

	test("keeps a marker already at 0 as the first chapter and adds nothing", () => {
		const result = buildChapters(edlOf(240, [[0, "Cold open"], [30, "The ask"], [75, "The cut"]]));

		expect(result.text).toBe("00:00 Cold open\n00:30 The ask\n01:15 The cut");
	});

	test("writes hour-style timestamps from one hour up so the first chapter still reads 00:00:00", () => {
		const result = buildChapters(edlOf(3700, [[1800, "Middle"], [3000, "Late"]]));

		expect(result.text).toBe("00:00:00 Intro\n00:30:00 Middle\n00:50:00 Late");
	});

	test("keeps a chapter under the minimum and reports it, unless mergeShort folds it away", () => {
		const edl = edlOf(240, [[0, "Start"], [30, "Quick"], [35, "Long"], [120, "End"]]);

		const kept = buildChapters(edl);
		const merged = buildChapters(edl, { mergeShort: true });

		expect(kept.chapters.map(chapter => chapter.title)).toEqual(["Start", "Quick", "Long", "End"]);
		expect(codesOf(kept.problems)).toEqual(["chapter-too-short"]);
		expect(merged.chapters.map(chapter => [chapter.seconds, chapter.title])).toEqual([[0, "Start"], [35, "Long"], [120, "End"]]);
		expect(merged.problems).toEqual([]);
	});

	test("mergeShort folds a too-short opening chapter into the one after it", () => {
		const result = buildChapters(edlOf(240, [[0, "Start"], [5, "Two"], [60, "Three"], [100, "Four"]]), { mergeShort: true });

		expect(result.chapters.map(chapter => [chapter.seconds, chapter.title])).toEqual([[0, "Start"], [60, "Three"], [100, "Four"]]);
		expect(result.problems).toEqual([]);
	});

	test.each([
		{ name: "a chapter of exactly 10 s", secondMarkerAt: 10, problems: [] },
		{ name: "a chapter of 9 s", secondMarkerAt: 9, problems: ["chapter-too-short"] },
	])("holds the 10 s minimum: $name", ({ secondMarkerAt, problems }) => {
		const result = buildChapters(edlOf(240, [[0, "A"], [secondMarkerAt, "B"], [60, "C"]]));

		expect(codesOf(result.problems)).toEqual(problems);
	});

	test("returns no chapters and no complaint for a film under 30 s, which cannot hold three of 10 s", () => {
		const result = buildChapters(edlOf(29, [[0, "A"], [10, "B"], [20, "C"]]));

		expect(result.chapters).toEqual([]);
		expect(result.text).toBe("");
		expect(result.problems).toEqual([]);
		expect(result.skipped).toBe(true);
	});

	test("builds chapters for a film of exactly 30 s", () => {
		const result = buildChapters(edlOf(30, [[0, "A"], [10, "B"], [20, "C"]]));

		expect(result.text).toBe("00:00 A\n00:10 B\n00:20 C");
		expect(result.problems).toEqual([]);
	});
});

describe("chapterProblems", () => {
	test.each([
		{ name: "an empty list", at: [], duration: 120, codes: ["chapters-too-few"] },
		{ name: "two chapters", at: [0, 30], duration: 120, codes: ["chapters-too-few"] },
		{ name: "a first chapter at 5 s", at: [5, 40, 80], duration: 120, codes: ["chapters-first-not-zero"] },
		{ name: "a 5 s chapter in the middle", at: [0, 30, 35], duration: 120, codes: ["chapter-too-short"] },
		{ name: "a 5 s last chapter, measured to the end of the film", at: [0, 30, 115], duration: 120, codes: ["chapter-too-short"] },
		{ name: "three chapters of 10 s or more", at: [0, 10, 20], duration: 30, codes: [] },
	])("$name", ({ at, duration, codes }) => {
		const chapters = at.map((seconds, index) => ({ seconds, title: `Chapter ${index + 1}` }));

		expect(codesOf(chapterProblems(chapters, duration))).toEqual(codes);
	});
});

describe("titleLengthScore", () => {
	test.each([
		[0, 0],
		[19, 2],
		[20, 4],
		[29, 4],
		[30, 5],
		[50, 5],
		[51, 4],
		[60, 4],
		[61, 2],
		[70, 2],
		[71, 1],
		[100, 1],
		[101, 0],
	])("a title of %i characters scores %i", (length, score) => {
		expect(titleLengthScore(length)).toBe(score);
	});
});

describe("tagBudget", () => {
	test.each([
		{ name: "no tags", tags: [], budget: 0 },
		{ name: "one plain tag, no comma", tags: ["editor"], budget: 6 },
		{ name: "two plain tags, one comma between them", tags: ["a", "b"], budget: 3 },
		{ name: "a tag with a space counts its two quotes", tags: ["video editor"], budget: 14 },
		{ name: "quotes and the comma together", tags: ["video editor", "ai"], budget: 17 },
		{ name: "an emoji counts as one character, not two code units", tags: ["🎬"], budget: 1 },
		{ name: "accented letters count once each", tags: ["café"], budget: 4 },
	])("$name", ({ tags, budget }) => {
		expect(tagBudget(tags)).toBe(budget);
	});
});

const PRODUCTION = "demo-film";
const MASTER = "renders/final-ab12cd34.mp4";
const RECEIPT = "receipts/render-20261030T120000-ab12cd34-final.json";
const EDIT_REVISION = "ab12cd34";
const MASTER_BYTES = "final render bytes";
const HOOK = "A video editor that stops and asks before it touches your footage: we cut a three minute film where every insert, every trim and every b-roll swap waits for a person's yes.";
const CHAPTER_BLOCK = "00:00 Cold open\n00:30 The ask\n01:15 The cut";
const SOURCES_AND_HASHTAGS = "Sources: https://example.com/the-cut-is-data\n\n#VideoEditing";
const CAPTIONS = "1\n00:00:00,000 --> 00:00:03,000\nA video editor that asks first.\n\n2\n00:00:03,500 --> 00:00:08,000\nEvery cut is a file.\n";
const THUMBNAIL_IDS = ["a", "b", "c"];

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

const scoredTitle = (text: string, pattern: string) => ({
	text,
	chars: text.length,
	pattern,
	scores: { accuracy: 5, clarity: 4, curiosity: 4, search: 4, length: 5, risk: 5 },
	total: 27,
});

// biome-ignore lint/suspicious/noExplicitAny: the publish document is loose JSON that each case mutates in a different place
type Publish = Record<string, any>;
type Edit = (publish: Publish, dir: string) => void;

const made: string[] = [];

afterEach(() => {
	for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(dir: string, relative: string, content: string) {
	const file = join(dir, relative);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function validPackage(dir: string): Publish {
	put(dir, MASTER, MASTER_BYTES);
	put(dir, RECEIPT, JSON.stringify({ profile: "final", editRevision: EDIT_REVISION, output: { path: MASTER, bytes: Buffer.byteLength(MASTER_BYTES), sha256: sha256(MASTER_BYTES) } }));
	put(dir, "renders/captions-en.srt", CAPTIONS);
	const variants = THUMBNAIL_IDS.map(id => {
		const path = `renders/thumbnails/${PRODUCTION}-${id}.png`;
		const bytes = `thumbnail ${id} bytes`;
		put(dir, path, bytes);
		return { id, path, format: "png", width: 1280, height: 720, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes), phoneCheck: true };
	});
	return {
		version: 1,
		production: PRODUCTION,
		createdAt: "2026-10-30T12:30:00.000Z",
		master: { path: MASTER, durationSeconds: 120, editRevision: EDIT_REVISION, renderReceipt: RECEIPT, sha256: sha256(MASTER_BYTES) },
		title: {
			chosen: "How a video editor asks before it cuts",
			options: [
				scoredTitle("How a video editor asks before it cuts", "how-to"),
				scoredTitle("The edit that waits for your yes", "contrast"),
				scoredTitle("Why every cut in this film is a file", "claim"),
			],
		},
		thumbnail: {
			brief: { concept: "the three words on a dark slate", text: "CUT IS DATA" },
			variants,
			chosen: "a",
		},
		description: {
			primaryKeyword: "video editor",
			text: `${HOOK}\n\n${CHAPTER_BLOCK}\n\n${SOURCES_AND_HASHTAGS}`,
			chapters: [
				{ seconds: 0, timestamp: "00:00", title: "Cold open" },
				{ seconds: 30, timestamp: "00:30", title: "The ask" },
				{ seconds: 75, timestamp: "01:15", title: "The cut" },
			],
			sources: [{ label: "The cut is data", url: "https://example.com/the-cut-is-data" }],
			hashtags: ["#VideoEditing"],
		},
		tags: ["video editor", "ai video editing"],
		captions: { file: "renders/captions-en.srt", language: "en", source: "export_edl srt", reviewed: true },
		settings: {
			visibility: "unlisted",
			madeForKids: false,
			ageRestricted: false,
			category: "Science & Technology",
			language: "en",
			license: "standard",
			alteredContent: { disclose: false, assessedAt: "2026-10-30T12:25:00.000Z", assets: [] },
		},
	};
}

function gate(edit?: Edit, options?: { files?: boolean }) {
	const root = mkdtempSync(join(tmpdir(), "youtube-publish-"));
	made.push(root);
	const dir = join(root, PRODUCTION);
	const publish = validPackage(dir);
	edit?.(publish, dir);
	put(dir, "receipts/publish.json", JSON.stringify(publish, null, 2));
	return checkPublish(dir, options);
}

const refusals = (result: { errors: { code: string }[] }) => codesOf(result.errors);

function recordAsset(dir: string, asset: Record<string, string>) {
	put(dir, `media/${asset.id}.asset.json`, JSON.stringify(asset));
}

function recordVerdict(publish: Publish, id: string, verdict: Record<string, unknown>) {
	publish.settings.alteredContent.assets.push({ id, reason: "assessed by the person and the agent", ...verdict });
}

describe("checkPublish on a production folder", () => {
	test("passes a complete package whose files on disk match what it records", () => {
		const result = gate();

		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	test("refuses a render receipt for a different edit revision than the package records", () => {
		const result = gate(publish => {
			publish.master.editRevision = "0000dead";
		});

		expect(refusals(result)).toEqual(["master-stale"]);
		expect(result.ok).toBe(false);
	});

	test.each([
		{ name: "a thumbnail of a different length", retouched: "thumbnail a, retouched after the phone check", codes: ["thumbnail-changed"] },
		{ name: "a thumbnail of the same length with other bytes", retouched: "thumbnail Z bytes", codes: ["thumbnail-hash"] },
	])("refuses $name than the one measured", ({ retouched, codes }) => {
		const result = gate((publish, dir) => {
			put(dir, publish.thumbnail.variants[0].path, retouched);
		});

		expect(refusals(result)).toEqual(codes);
	});

	test.each([
		{ name: "a generated asset with no altered-content verdict", covered: false, codes: ["altered-uncovered"] },
		{ name: "the same asset once it has a verdict", covered: true, codes: [] },
	])("$name", ({ covered, codes }) => {
		const result = gate((publish, dir) => {
			recordAsset(dir, { id: "title-card", kind: "image", license: "generated" });
			if (covered) recordVerdict(publish, "title-card", { verdict: "no-disclosure", category: "not-realistic" });
		});

		expect(refusals(result)).toEqual(codes);
	});

	test.each([
		{ name: "confirmedByPerson is absent", confirmation: {}, codes: ["altered-voice"] },
		{ name: "confirmedByPerson is false", confirmation: { confirmedByPerson: false }, codes: ["altered-voice"] },
		{ name: "the person confirmed the voice is their own", confirmation: { confirmedByPerson: true }, codes: [] },
	])("an own-voice-clone verdict where $name", ({ confirmation, codes }) => {
		const result = gate((publish, dir) => {
			recordAsset(dir, { id: "vo-main", kind: "audio", license: "generated" });
			recordVerdict(publish, "vo-main", { verdict: "no-disclosure", category: "own-voice-clone", ...confirmation });
		});

		expect(refusals(result)).toEqual(codes);
	});

	test.each([
		{ name: "the credit line absent from the description", addition: "\nSource: https://example.com/show", codes: ["credit-absent"] },
		{ name: "the credit line and the source both in the description", addition: "\nClip: Example Show, 2026 (https://example.com/show)", codes: [] },
	])("a commentary clip with $name", ({ addition, codes }) => {
		const result = gate((publish, dir) => {
			recordAsset(dir, { id: "clip-1", kind: "video", license: "commentary", attribution: "Clip: Example Show, 2026", sourceUrl: "https://example.com/show" });
			recordVerdict(publish, "clip-1", { verdict: "no-disclosure", category: "unaltered-real" });
			publish.description.text += addition;
		});

		expect(refusals(result)).toEqual(codes);
	});

	test.each([
		{ name: "a generated asset", asset: { id: "title-card", kind: "image", license: "generated" }, judged: true, codes: ["license-cc-by"] },
		{ name: "only an owned asset", asset: { id: "own-music", kind: "audio", license: "owned" }, judged: false, codes: [] },
	])("the cc-by license with $name", ({ asset, judged, codes }) => {
		const result = gate((publish, dir) => {
			publish.settings.license = "cc-by";
			recordAsset(dir, asset);
			if (judged) recordVerdict(publish, asset.id, { verdict: "no-disclosure", category: "not-realistic" });
		});

		expect(refusals(result)).toEqual(codes);
	});

	test.each([
		{ visibility: "private", codes: ["ab-test-private"] },
		{ visibility: "unlisted", codes: [] },
	])("a thumbnail A/B test on a $visibility video", ({ visibility, codes }) => {
		const result = gate(publish => {
			publish.settings.visibility = visibility;
			publish.thumbnail.abTest = { run: true, target: "thumbnail", order: ["a", "b", "c"] };
		});

		expect(refusals(result)).toEqual(codes);
	});

	test.each([
		{ name: "chapter lines in the description of a 20 s film", chaptered: true, codes: ["chapters-on-short-video"] },
		{ name: "a 20 s film described without chapter lines", chaptered: false, codes: [] },
	])("$name", ({ chaptered, codes }) => {
		const result = gate(publish => {
			publish.master.durationSeconds = 20;
			publish.description.chapters = [];
			if (!chaptered) publish.description.text = `${HOOK}\n\n${SOURCES_AND_HASHTAGS}`;
		});

		expect(refusals(result)).toEqual(codes);
	});

	test("files:false checks the document alone, so a package can be gated before its renders exist", () => {
		const unrendered: Edit = (_publish, dir) => rmSync(join(dir, "renders"), { recursive: true });

		expect(refusals(gate(unrendered))).toContain("master-file-missing");
		expect(gate(unrendered, { files: false }).errors).toEqual([]);
	});
});
