import { ENVIRONMENT_CLASSIC } from "@fraym/ui";
//#region src/index.ts
var implementation = ENVIRONMENT_CLASSIC;
/** The bundle contract (doc 68 §16.2): the host takes the default export. */
var src_default = ENVIRONMENT_CLASSIC.component;
//#endregion
export { src_default as default, implementation };
