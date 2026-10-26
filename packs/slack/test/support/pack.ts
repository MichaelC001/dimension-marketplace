import { join } from "node:path";
import { type } from "arktype";

export const packRoot = join(import.meta.dir, "..", "..");
export const shelfRoot = join(packRoot, "..");

const pluginSchema = type({
	extensions: {
		"ai.insodimension.dimension": {
			title: "string",
			icon: "string",
			"supersedes?": "string[]",
			connect: {
				methods: type({
					id: "string",
					label: "string",
					configTarget: "string",
					"configTemplate?": "string",
					"form?": type({ id: "string", "secret?": "boolean" }).array(),
				}).array(),
			},
			toolRenderer: type({ match: "string" }).array(),
			tools: type({ name: "string" }).array(),
		},
	},
});

export const dimension = pluginSchema.assert(await Bun.file(join(packRoot, "plugin.json")).json()).extensions[
	"ai.insodimension.dimension"
];

export function connectMethod(id: "bot" | "user") {
	const found = dimension.connect.methods.find(method => method.id === id);
	if (!found) throw new Error(`plugin.json declares no ${id} connect method`);
	return found;
}

export function connectPath(id: "bot" | "user"): string {
	return `Plugins, ${dimension.title}, Connect, ${connectMethod(id).label}`;
}
