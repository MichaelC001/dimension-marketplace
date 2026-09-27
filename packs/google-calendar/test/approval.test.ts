// An event with attendees lands on other people's calendars and emails them, so
// creating one must stop for a human click even in yolo mode; an event only on
// the user's own calendar stays a plain write that yolo auto-approves. Deleting
// an event is irreversible and always asks. Decided by the engine's own
// `resolveApproval` (the pack's `@oh-my-pi/pi-coding-agent` peer) on the tools
// exactly as the default-exported factory registers them.

import { expect, test } from "bun:test";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import googleCalendarExtension from "../index";

type ApprovalSubject = Parameters<typeof resolveApproval>[0];

const tools = new Map<string, ApprovalSubject>();
googleCalendarExtension({
	registerTool(tool: ApprovalSubject) {
		tools.set(tool.name, tool);
	},
} as unknown as Parameters<typeof googleCalendarExtension>[0]);

function yolo(name: string, args: unknown) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`google-calendar extension did not register ${name}`);
	return resolveApproval(tool, args, "yolo").policy;
}

const event = { summary: "Planning", startIso: "2026-10-01T10:00:00Z", endIso: "2026-10-01T11:00:00Z" };

test.each([
	["one attendee", ["a@example.com"]],
	["several attendees", ["a@example.com", "b@example.com"]],
	["a malformed attendee list", "a@example.com"],
])("creating an event with %s prompts even in yolo mode", (_label, attendeeEmails) => {
	expect(yolo("google_calendar_create_event", { ...event, attendeeEmails })).toBe("prompt");
});

test.each([
	["no attendee list", event],
	["an empty attendee list", { ...event, attendeeEmails: [] }],
])("creating an event with %s is a plain write yolo auto-approves", (_label, args) => {
	expect(yolo("google_calendar_create_event", args)).toBe("allow");
});

test("deleting an event prompts even in yolo mode", () => {
	expect(yolo("google_calendar_delete_event", { eventId: "evt_1" })).toBe("prompt");
});
