import { resolve } from "node:path";

export type Environment = Readonly<Record<string, string | undefined>>;

export function engineHome(env: Environment, userHome: string): string {
	const explicit = env.INSO_HOME?.trim();
	if (explicit) return resolve(explicit);
	return resolve(userHome, env.PI_CONFIG_DIR?.trim() || ".inso");
}

export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
	const slashed = platform === "win32" ? path.replaceAll("\\", "/") : path;
	return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}
