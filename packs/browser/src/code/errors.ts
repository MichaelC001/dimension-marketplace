// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/tool-errors.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: the `omp.agentFacingError` marker is dropped (it exists for OMP's postmortem fatal handler, which the pack does not have).

/**
 * The error types the browser code realm throws into a cell, as OMP names them (matrix rows C9, D8, D9, D16, D22).
 * A `ToolError` is a message written for the model; a `ToolAbortError` is a cancellation.
 */

/** Base error for tool execution failures. Its message is the model-facing text. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }

  /** The text shown to the model. */
  render(): string {
    return this.message;
  }
}

/** Thrown when an operation is aborted through an AbortSignal. */
export class ToolAbortError extends Error {
  static readonly MESSAGE = "Operation aborted";

  constructor(message: string = ToolAbortError.MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolAbortError";
  }
}

/** Throw a `ToolAbortError` if the signal is aborted, keeping a `ToolAbortError` reason as it is. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : undefined;
    throw reason instanceof ToolAbortError ? reason : new ToolAbortError(undefined, { cause: signal.reason });
  }
}

/** Render an error for the model. */
export function renderError(e: unknown): string {
  if (e instanceof ToolError) return e.render();
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * What a host answers, as the `code_needs_consent` refusal, when a cell asks for a saved profile (contract rule 6): the profile holds logins and code runs with full Node, so it stays refused until the
 * "human yes" gate exists (doc 77 §7.8 decision 2). The text says what the model tells the person and what it can do meanwhile, with the tools a code space has; prompt.md says the same in fewer words.
 */
export function savedProfileRefusal(profile: string): string {
  const name = JSON.stringify(profile);
  return `a saved profile (${name}) cannot be driven by code yet: it holds logins, and code runs with full Node. Tell the user so. They can work in it themselves: call browser_view({ profile: ${name} }) and they sign in or do the step in the View. `
    + "Meanwhile code can use a throwaway browser (leave profile out) or the user's own Chrome (app: { relay: true }).";
}
