// Side-effect import: must be the FIRST import of any test file whose import
// graph reaches web-component modules (e.g. plugins-page -> @pierre/trees).
// Other test files in the same bun process leak `HTMLElement` onto globalThis,
// which makes those modules' `typeof HTMLElement !== "undefined"` guard pass and
// then crash on the missing `customElements` registry. linkedom does not provide
// one, so stub the registry surface those guards touch.
if (typeof globalThis.customElements === "undefined") {
	(globalThis as Record<string, unknown>).customElements = {
		get: () => undefined,
		define: () => {},
		// A registration that never completes — the guard only awaits it, so a
		// forever-pending promise is the honest stub.
		whenDefined: () => Promise.withResolvers<CustomElementConstructor>().promise,
	};
}
