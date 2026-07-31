// Fraym's components carry their own stylesheets as side-effect imports, and a
// consumer typechecking THROUGH Fraym's source sees them. The bundler handles
// the real thing; the type system only needs to know they exist.
//
// This mirrors `fraym/packages/ui/src/asset-imports.d.ts` rather than importing
// it: a `.d.ts` is not part of a package's export surface, so every consumer of
// the library declares this for itself. That is a property of consuming a UI
// library from source, and it disappears the day @fraym/ui ships built types.
declare module "*.css" {}
declare module "*?url" {
	const url: string;
	export default url;
}
