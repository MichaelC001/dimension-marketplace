// The diff tab. The fetch lives HERE, so the host is asked for a large diff
// only while this tab is on screen (doc 73 §3) — mounting is the guard.

import { DiffStat, Icon, Spinner, StreamingMarkdown } from "@fraym/ui";
import { useCallback } from "react";
import type { ReviewRef } from "./model";
import type { ReviewDiffPayload, WorkspaceRefShape } from "./shapes";
import { useRead } from "./use-read";

export function DiffTab({
	reviewRef,
	workspace,
	getReviewDiff,
	cacheKey,
}: {
	readonly reviewRef: ReviewRef;
	readonly workspace: WorkspaceRefShape;
	/** Present only because the caller checked the provider offers a diff. */
	readonly getReviewDiff: (workspace: WorkspaceRefShape, ref: ReviewRef) => Promise<ReviewDiffPayload>;
	readonly cacheKey: string;
}) {
	const read = useCallback(() => getReviewDiff(workspace, reviewRef), [getReviewDiff, workspace, reviewRef]);
	const diff = useRead(read, cacheKey);
	const files = diff.value?.files ?? [];
	const firstLoad = diff.value === null && diff.loading;
	const stale = diff.value !== null && diff.loading;
	return (
		<div className="flex flex-col gap-2 p-3" aria-busy={diff.loading || undefined}>
			{firstLoad ? (
				// First load with no diff painted: the shape is unpredictable (file
				// count, patch sizes), so a skeleton would lie — the dot-matrix
				// loader (Spinner `dots`, the onboarding labour-illusion idiom).
				<div className="flex items-center gap-2 text-fr-xs text-fr-text-3" aria-label="Loading diff">
					<Spinner kind="dots" size="xs" label="Loading diff" />
					<span>Loading diff…</span>
				</div>
			) : null}
			{diff.error ? <p className="text-fr-del text-fr-sm">{diff.error}</p> : null}
			<div className={stale ? "flex flex-col gap-2 opacity-60" : "flex flex-col gap-2"}>
			{files.length > 0 ? (
				<span className="flex items-center gap-2 text-fr-2xs text-fr-text-3">
					<span>
						{files.length} file{files.length === 1 ? "" : "s"} changed
					</span>
					<DiffStat additions={files.reduce((sum, file) => sum + file.additions, 0)} deletions={files.reduce((sum, file) => sum + file.deletions, 0)} />
				</span>
			) : null}
			{files.map(file => (
				<details key={file.path} className="group rounded-md border border-fr-border bg-fr-surface" open={files.length <= 3}>
					<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-fr-xs hover:bg-fr-surface-2">
						<Icon name="file" size={12} aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate text-fr-text">{file.path}</span>
						<DiffStat additions={file.additions} deletions={file.deletions} />
					</summary>
					{file.patch ? (
						<div className="border-fr-border-soft border-t">
							<StreamingMarkdown text={`\`\`\`diff\n${file.patch}\n\`\`\``} className="text-fr-2xs" />
						</div>
					) : (
						<span className="block border-fr-border-soft border-t px-3 py-1.5 text-fr-2xs text-fr-text-2">Hunks withheld by the host.</span>
					)}
				</details>
			))}
			{diff.value && diff.value.files.length === 0 && !diff.loading ? <span className="text-fr-xs text-fr-text-3">No file changes.</span> : null}
			{diff.value?.truncated ? <span className="text-fr-2xs text-fr-text-3">More files than the host returned — open on the host for the rest.</span> : null}
			</div>
		</div>
	);
}
