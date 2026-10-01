// The page-picking layer (doc 88 section 2). OWNED BY the element slice; the dispatcher in
// `pane-extras.tsx` mounts it for `html` documents and passes the shared props.
import type { ReactNode } from "react";
import type { PaneExtrasProps } from "./pane-shared";

export function ElementPicks(_props: PaneExtrasProps): ReactNode {
	return null;
}
