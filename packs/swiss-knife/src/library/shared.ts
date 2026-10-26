import { homedir } from "node:os";
import { createLibrary } from "./library";
import { engineHome } from "./paths";
import type { Library } from "./types";

let opening: Promise<Library> | undefined;

export function sharedLibrary(): Promise<Library> {
	opening ??= createLibrary({ home: engineHome(process.env, homedir()) }).catch((error: unknown) => {
		opening = undefined;
		throw error;
	});
	return opening;
}
