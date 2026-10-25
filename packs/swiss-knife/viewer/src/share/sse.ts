export interface ServerEvent {
	readonly event: string;
	readonly id?: string;
	readonly data: string;
}

const MAX_BUFFERED_CHARS = 1 << 20;

export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
			if (buffer.length > MAX_BUFFERED_CHARS) throw new Error("the event stream sent a message that is too large");
			for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const event = parseBlock(block);
				if (event !== undefined) yield event;
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

function parseBlock(block: string): ServerEvent | undefined {
	let event = "message";
	let id: string | undefined;
	const data: string[] = [];
	for (const line of block.split("\n")) {
		if (line === "" || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "id") id = value;
		else if (field === "data") data.push(value);
	}
	if (data.length === 0 && event === "message") return undefined;
	return { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
}
