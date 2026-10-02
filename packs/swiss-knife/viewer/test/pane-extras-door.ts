// A test about what `DocPane` does AROUND its document (the opening surface, the error card, the reload) has no use for
// the annotation layer it seats beside it, so it stands the layer in with nothing for the length of its own file.
//
// `mock.module` rewrites a module that is already loaded IN PLACE and has no way to be lifted, so a stand-in that is
// never put back answers for every test file that sorts after this one: `pane-extras.test.tsx` mounts the real layer
// and found a null. `silencePaneExtras()` returns the way back; call it in `afterAll`.
//
// The layer cannot load under bun until the kit's `react` mappings (its tsconfig maps `react` and the JSX runtimes onto
// type declarations, which bun cannot run) point at the real modules, the same instances the test uses, so there is one
// React. That is what `pane-extras.test.tsx` does for itself; the real layer is loaded once here, before it is replaced,
// to have something to put back.
import { dirname } from "node:path";
import { mock } from "bun:test";
import * as react from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import type * as PaneExtrasModule from "../app/view/pane-extras";
import type { PaneExtrasProps } from "../app/view/pane-shared";

const PANE_EXTRAS = "../app/view/pane-extras";

/** Replace `PaneExtras` with a component that draws nothing, or with `stand` (a test that asserts on what the pane
 *  renders the layer WITH records its props there); the result puts the real module back. Call it after the DOM is
 *  installed (`installReact`), and before the module under test is imported. */
export async function silencePaneExtras(stand: (props: PaneExtrasProps) => null = () => null): Promise<() => void> {
	const kitSource = dirname(Bun.resolveSync("@dimension/mcp-app-kit/annotate/react", import.meta.dir));
	for (const [id, real] of [
		["react", react],
		["react/jsx-runtime", jsxRuntime],
		["react/jsx-dev-runtime", jsxDevRuntime],
	] as const) {
		mock.module(Bun.resolveSync(id, kitSource), () => real);
	}
	// Dynamic by necessity: the module must load after the DOM and the mappings above are in place. The copy is taken
	// BEFORE the mock goes in: the namespace it is read from is the one the mock rewrites.
	const real: typeof PaneExtrasModule = { ...(await import(PANE_EXTRAS)) };
	mock.module(PANE_EXTRAS, () => ({ ...real, PaneExtras: stand }));
	return () => void mock.module(PANE_EXTRAS, () => real);
}
