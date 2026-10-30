import { describe, expect, test } from "bun:test";
import { isOwnWrite, type RevisionSpan, spanOf } from "../src/library/revision";

describe("which write a View may adopt as its own", () => {
	const rows: { name: string; span: RevisionSpan; last: string | undefined; own: boolean }[] = [
		{ name: "a span that starts at the remembered marker and moves only the own count", span: { before: "4:2", after: "5:2" }, last: "4:2", own: true },
		{ name: "a span that changed no row", span: { before: "4:2", after: "4:2" }, last: "4:2", own: true },
		{ name: "an own count that gains a digit beside a multi-digit foreign part", span: { before: "9:12", after: "10:12" }, last: "9:12", own: true },
		{ name: "a foreign commit inside the span", span: { before: "4:2", after: "5:3" }, last: "4:2", own: false },
		{ name: "a foreign part that only extends the old one", span: { before: "4:2", after: "5:21" }, last: "4:2", own: false },
		{ name: "a remembered marker older than the span", span: { before: "5:2", after: "6:2" }, last: "4:2", own: false },
		{ name: "a remembered marker older than a span that also holds a foreign commit", span: { before: "5:2", after: "6:3" }, last: "4:2", own: false },
		{ name: "a remembered marker already at the span's end", span: { before: "4:2", after: "5:2" }, last: "5:2", own: false },
		{ name: "nothing remembered yet", span: { before: "4:2", after: "5:2" }, last: undefined, own: false },
	];
	for (const { name, span, last, own } of rows) {
		test(`${name} is ${own ? "" : "not "}an own write`, () => expect(isOwnWrite(span, last)).toBe(own));
	}
});

describe("the span a tool answer carries", () => {
	const span = { before: "4:2", after: "5:2" };
	const rows: { name: string; content: unknown; expected: RevisionSpan | undefined }[] = [
		{ name: "no content", content: undefined, expected: undefined },
		{ name: "null", content: null, expected: undefined },
		{ name: "a string", content: "revision", expected: undefined },
		{ name: "a number", content: 7, expected: undefined },
		{ name: "an array", content: [span], expected: undefined },
		{ name: "an object without a revision", content: { item: {} }, expected: undefined },
		{ name: "a null revision", content: { revision: null }, expected: undefined },
		{ name: "a revision that is a marker string", content: { revision: "4:2" }, expected: undefined },
		{ name: "a revision that is an array", content: { revision: ["4:2", "5:2"] }, expected: undefined },
		{ name: "a revision without an after", content: { revision: { before: "4:2" } }, expected: undefined },
		{ name: "a revision without a before", content: { revision: { after: "5:2" } }, expected: undefined },
		{ name: "a revision whose ends are numbers", content: { revision: { before: 4, after: 5 } }, expected: undefined },
		{ name: "a revision whose after is null", content: { revision: { before: "4:2", after: null } }, expected: undefined },
		{ name: "a revision beside other members", content: { item: {}, revision: span }, expected: span },
		{ name: "a revision with members beyond its ends", content: { revision: { ...span, note: "extra" } }, expected: span },
	];
	for (const { name, content, expected } of rows) {
		test(`${name} gives ${expected === undefined ? "no span" : "the span"}`, () => expect(spanOf(content)).toEqual(expected));
	}
});
