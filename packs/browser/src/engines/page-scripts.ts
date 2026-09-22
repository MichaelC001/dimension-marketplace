import type { BrowserRegion } from "../contracts.js";
const PAGE_TEXT_SCRIPT = (limit: number): string => {
	const parts: string[] = [`# ${document.title}`, document.location.href, ""];
	const body = document.body?.innerText ?? "";
	parts.push(body.replace(/\n{3,}/g, "\n\n").trim());
	const controls: string[] = [];
	const nodes = document.querySelectorAll("a[href], button, input, textarea, select, [role='button'], [role='link']");
	for (let i = 0; i < nodes.length && controls.length < 200; i += 1) {
		const el = nodes[i] as HTMLElement;
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		// Credential boundary: a password/hidden field's value is described, never
		// read.
		const input = el as HTMLInputElement;
		const type = (input.type ?? "").toLowerCase();
		const secret = el.tagName === "INPUT" && (type === "password" || type === "hidden");
		// A text control's current value is what makes a snapshot actionable, so it
		// is included — except for password/hidden fields, which are only ever
		// described. Empty strings must fall through, hence `||` rather than `??`.
		const editable = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
		const value = secret ? "[redacted]" : editable ? (input.value ?? "") : "";
		// Editable controls report their LIVE value first: a textarea's innerText
		// can still be the markup's original text after the value changed.
		const label = (
			(editable
				? value || el.getAttribute("aria-label") || ""
				: el.getAttribute("aria-label") || el.innerText || "") ||
			el.getAttribute("name") ||
			el.getAttribute("placeholder") ||
			""
		)
			.trim()
			.replace(/\s+/g, " ")
			.slice(0, 80);
		const id = el.id ? `#${el.id}` : "";
		controls.push(`${el.tagName.toLowerCase()}${id} "${label}" @${Math.round(rect.x)},${Math.round(rect.y)}`);
	}
	if (controls.length > 0) parts.push("", "## interactive", controls.join("\n"));
	const text = parts.join("\n");
	return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
};
const ELEMENTS_IN_REGION_SCRIPT = (region: BrowserRegion, limit: number): string => {
	const out: string[] = [];
	const nodes = document.querySelectorAll("body *");
	for (let i = 0; i < nodes.length && out.length < 60; i += 1) {
		const el = nodes[i] as HTMLElement;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		const intersects =
			r.left < region.x + region.width && r.right > region.x && r.top < region.y + region.height && r.bottom > region.y;
		if (!intersects) continue;
		if (el.children.length > 0 && r.width * r.height > region.width * region.height * 4) continue;
		const input = el as HTMLInputElement;
		const secret = el.tagName === "INPUT" && ["password", "hidden"].includes((input.type ?? "").toLowerCase());
		const editable = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
		const label = secret
			? "[redacted input]"
			: ((editable ? input.value || "" : "") || el.getAttribute("aria-label") || el.innerText || "")
					.trim()
					.replace(/\s+/g, " ")
					.slice(0, 100);
		const id = el.id ? `#${el.id}` : "";
		out.push(
			`${el.tagName.toLowerCase()}${id} [${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}] ${label}`,
		);
	}
	const text = out.join("\n");
	return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
};
const SELECT_ALL_SCRIPT = (el: Element): boolean => {
	const field = el as HTMLInputElement | HTMLTextAreaElement;
	if (typeof field.select !== "function") return false;
	const type = ((field as HTMLInputElement).type ?? "").toLowerCase();
	if (el.tagName === "INPUT" && ["checkbox", "radio", "file", "range", "color", "button", "submit"].includes(type)) {
		return false;
	}
	field.select();
	return true;
};

export { PAGE_TEXT_SCRIPT, ELEMENTS_IN_REGION_SCRIPT, SELECT_ALL_SCRIPT };
