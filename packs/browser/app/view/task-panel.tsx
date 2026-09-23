// The task panel: hand the whole job to an upstream agent loop (jev or
// browser-use) running on THIS browser, and watch it live. Everything shown is
// `state.task` as the poll loop last read it — the panel holds no copy.
import { type FormEvent, useState } from "react";
import type { TaskAgent, TaskRun, TaskStatus } from "../../src/contracts";
import { TASK_AGENTS } from "../../src/contracts";
import { Badge, Button, Field, Select, Textarea } from "@fraym/ui/elements"

const TONES: Record<TaskStatus, "blue" | "add" | "warn" | "del" | "mute"> = {
	running: "blue",
	done: "add",
	blocked: "warn",
	failed: "del",
	cancelled: "mute",
};

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export interface TaskPanelProps {
	readonly task: TaskRun | null;
	/** No browser to act on, or another call holds it. */
	readonly disabled: boolean;
	/** A `browser_task` call from this View is in flight. */
	readonly starting: boolean;
	readonly cancelling: boolean;
	/** Starts `browser_task`; progress arrives through `task` via the poll loop. */
	readonly onStart: (agent: TaskAgent, task: string) => void;
	readonly onCancel: () => void;
}

export function TaskPanel({ task, disabled, starting, cancelling, onStart, onCancel }: TaskPanelProps) {
	const [agent, setAgent] = useState<TaskAgent>("jev");
	const [text, setText] = useState("");
	const running = task?.status === "running";

	const submit = (event: FormEvent) => {
		event.preventDefault();
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		onStart(agent, trimmed);
	};

	// The server's elapsedMs is as fresh as the last poll; while running, the
	// start time gives a clock that keeps moving between polls.
	const started = task === null ? Number.NaN : Date.parse(task.startedAt);
	const elapsed = running && Number.isFinite(started) ? Date.now() - started : (task?.elapsedMs ?? 0);

	return (
		<section className="bx-task" aria-label="Agent task">
			<header className="bx-task-head">
				<h2>Task</h2>
				{task !== null && (
					<Badge tone={TONES[task.status]} variant="soft">
						{task.status}
					</Badge>
				)}
			</header>

			<form className="bx-task-form" onSubmit={submit}>
				<Field label="Agent" className="bx-narrow">
					<Select
						value={agent}
						disabled={disabled || running}
						onChange={event => {
							const selected = TASK_AGENTS.find(value => value === event.target.value);
							if (selected) setAgent(selected);
						}}
						options={TASK_AGENTS.map(value => ({ value, label: value }))}
					/>
				</Field>
				<Field label="What should it do?">
					<Textarea
						value={text}
						rows={2}
						placeholder="Find the cheapest direct flight to Lisbon next Friday"
						disabled={disabled || running}
						onChange={event => setText(event.target.value)}
					/>
				</Field>
				<div className="bx-task-buttons">
					<Button
						type="submit"
						size="sm"
						loading={starting && !running}
						loadingText="Starting…"
						disabled={disabled || running || starting || text.trim().length === 0}
					>
						Run task
					</Button>
					{running && (
						<Button type="button" size="sm" variant="destructive" loading={cancelling} loadingText="Cancelling…" onClick={onCancel}>
							Cancel
						</Button>
					)}
				</div>
			</form>

			{task !== null && (
				<>
					<p className="bx-task-meta bx-mono">
						{task.agent} · {task.stepCount} step{task.stepCount === 1 ? "" : "s"} · {formatElapsed(elapsed)} ·{" "}
						{task.usage.modelCalls} model call{task.usage.modelCalls === 1 ? "" : "s"} ·{" "}
						{(task.usage.inputTokens + task.usage.outputTokens).toLocaleString()} tokens
						{task.usage.costUsd !== null && ` · $${task.usage.costUsd.toFixed(4)}`}
					</p>
					<p className="bx-task-goal">{task.task}</p>
					{!running && task.summary.length > 0 && (
						<p className="bx-task-summary" data-status={task.status}>
							{task.summary}
						</p>
					)}
					{task.steps.length === 0 ? (
						<p className="bx-empty">{running ? "Waiting for the first step…" : "No steps recorded."}</p>
					) : (
						<ol className="bx-task-steps">
							{task.steps.toReversed().map(step => (
								<li key={step.n}>
									<span className="bx-mono bx-dim">
										#{step.n} {formatElapsed(step.elapsedMs)}
									</span>{" "}
									{step.action}
								</li>
							))}
						</ol>
					)}
				</>
			)}
		</section>
	);
}
