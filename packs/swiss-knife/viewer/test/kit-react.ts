import { dirname } from "node:path";
import { mock } from "bun:test";
import * as react from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import * as reactDom from "react-dom";

export function mapKitReact(): void {
	const kitSource = dirname(Bun.resolveSync("@dimension/mcp-app-kit/annotate/react", import.meta.dir));
	mock.module(Bun.resolveSync("react", kitSource), () => react);
	mock.module(Bun.resolveSync("react/jsx-runtime", kitSource), () => jsxRuntime);
	mock.module(Bun.resolveSync("react/jsx-dev-runtime", kitSource), () => jsxDevRuntime);
	mock.module(Bun.resolveSync("react-dom", kitSource), () => reactDom);
}

export function standInRenderers(): void {
	mock.module("../app/view/renderers", () => ({ loadRenderer: () => Promise.resolve(null) }));
}
