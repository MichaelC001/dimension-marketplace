// The host surfaces this pack touches, restated STRUCTURALLY by the members it
// uses (doc 68 §3.4) — a pack imports contracts, never the host's packages.

import type { StateGlyph } from "@fraym/ui";
import type { ComponentProps } from "react";
import type { ReviewDetail, ReviewDiffFile, ReviewRef, ReviewThread } from "./model";

/** The Store's contract shape. */
export interface HostStoreShape {
	watch<T = unknown>(key: string): { getSnapshot(): T | undefined; subscribe(fn: () => void): () => void };
	act(intent: string, payload?: unknown): void;
}

export interface WorkspaceRefShape {
	readonly workspaceId: string;
	readonly path: string;
}

export interface ReviewDiffPayload {
	readonly files: readonly ReviewDiffFile[];
	readonly truncated: boolean;
}

/** The driver methods this instrument calls. Absent = the provider cannot;
 *  the surface hides. */
export interface WorkspaceDriverShape {
	getReview?(workspace: WorkspaceRefShape, ref: ReviewRef): Promise<ReviewDetail>;
	getReviewThreads?(workspace: WorkspaceRefShape, ref: ReviewRef): Promise<readonly ReviewThread[]>;
	getReviewDiff?(workspace: WorkspaceRefShape, ref: ReviewRef): Promise<ReviewDiffPayload>;
}

/** An intent the `scm:review` grant admits, with the seat's env folded in. */
export type ReviewAct = (intent: string, payload: Record<string, unknown>) => void;

export type Tone = ComponentProps<typeof StateGlyph>["tone"];

/** A world-touching action, held until the dialog confirms it. */
export interface PendingAction {
	readonly title: string;
	readonly description: string;
	readonly confirmLabel: string;
	readonly intent: "default" | "danger";
	readonly input: Record<string, unknown>;
}
