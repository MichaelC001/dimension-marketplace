import { homedir } from "node:os";
import { createLibrary } from "./library";
import { engineHome } from "./paths";
import type { Library } from "./types";

let opening: Promise<Library> | undefined;

export function sharedLibrary(): Promise<Library> {
	const projectsFile = process.env.INSO_PROJECTS_FILE?.trim();
	opening ??= createLibrary({ home: engineHome(process.env, homedir()), ...(projectsFile ? { projectsFile } : {}) }).catch((error: unknown) => {
		opening = undefined;
		throw error;
	});
	return opening;
}
