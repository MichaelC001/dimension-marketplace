// Every human intent in this View becomes a REQUEST, never an execution: each
// button queues `browser_request_action` and the page does not move until a
// human approves it in the queue. Typed text is ephemeral — it lives in the
// input until the request is queued, is cleared immediately after, is masked on
// demand for credentials, and is never written to storage of any kind.
import { type FormEvent, useState } from "react";
import type { BrowserAction } from "../../src/contracts";
import { Button, Field, Input, Label } from "@fraym/ui/elements"

export interface ControlsProps {
	readonly url: string;
	readonly disabled: boolean;
	readonly busy: boolean;
	/** Queues the request and resolves true only when the runtime accepted it —
	 *  a refused request keeps the human's draft so it can be corrected. */
	readonly onRequest: (action: BrowserAction) => Promise<boolean>;
}

export function Controls({ url, disabled, busy, onRequest }: ControlsProps) {
	const [address, setAddress] = useState(url);
	const [addressDirty, setAddressDirty] = useState(false);
	const [selector, setSelector] = useState("");
	const [text, setText] = useState("");
	const [masked, setMasked] = useState(false);
	const [key, setKey] = useState("Enter");
	const [deltaX, setDeltaX] = useState("0");
	const [deltaY, setDeltaY] = useState("600");

	// The address bar follows the page until the human starts editing it.
	const shownAddress = addressDirty ? address : url;

	const submitNavigate = async (event: FormEvent) => {
		event.preventDefault();
		const target = shownAddress.trim();
		if (target.length === 0) return;
		if (await onRequest({ kind: "navigate", url: target })) setAddressDirty(false);
	};

	// The server's type action REQUIRES a selector (it has no focused-element
	// form), and an empty text is a legitimate request: it clears the field.
	const submitType = async (event: FormEvent) => {
		event.preventDefault();
		const target = selector.trim();
		if (target.length === 0) return;
		const accepted = await onRequest({ kind: "type", selector: target, text });
		// Ephemeral by contract: the typed value leaves this View with the
		// request and is dropped the moment it does — but only once it is
		// actually queued, so a refusal does not cost the human the draft.
		if (accepted) setText("");
	};

	// press and scroll are unscoped in the server's schema (strict objects with
	// no selector member), so the shared selector box must not ride along.
	const scroll = (event: FormEvent) => {
		event.preventDefault();
		void onRequest({
			kind: "scroll",
			deltaX: Number.parseInt(deltaX, 10) || 0,
			deltaY: Number.parseInt(deltaY, 10) || 0,
		});
	};

	return (
		<section className="bx-controls" aria-label="Browser controls">
			<form className="bx-row bx-row-address" onSubmit={event => void submitNavigate(event)}>
				<Field label="Address" className="bx-grow">
					<Input
						type="url"
						value={shownAddress}
						placeholder="https://example.com"
						autoComplete="off"
						spellCheck={false}
						disabled={disabled}
						onChange={event => {
							setAddress(event.target.value);
							setAddressDirty(true);
						}}
					/>
				</Field>
				<Button type="submit" disabled={disabled || busy || shownAddress.trim().length === 0}>
					Request navigation
				</Button>
			</form>

			<form className="bx-row" onSubmit={event => void submitType(event)}>
				<Field label="CSS selector" helper="Required to type; also used by Request click on selector. Key press and scroll act on the page." className="bx-grow">
					<Input
						value={selector}
						placeholder="input[name=q]"
						autoComplete="off"
						spellCheck={false}
						disabled={disabled}
						onChange={event => setSelector(event.target.value)}
					/>
				</Field>
				<Field label="Text to type" helper="Empty replaces the field's value with nothing — that is how you clear it." className="bx-grow">
					<Input
						type={masked ? "password" : "text"}
						value={text}
						autoComplete="off"
						spellCheck={false}
						disabled={disabled}
						onChange={event => setText(event.target.value)}
					/>
				</Field>
				<div className="bx-mask">
					<input
						id="bx-mask-toggle"
						type="checkbox"
						checked={masked}
						disabled={disabled}
						onChange={event => setMasked(event.target.checked)}
					/>
					<Label htmlFor="bx-mask-toggle">Credential (mask)</Label>
				</div>
				<Button type="submit" variant="outline" disabled={disabled || busy || selector.trim().length === 0}>
					Request type
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={disabled || busy || selector.trim().length === 0}
					onClick={() => void onRequest({ kind: "click", selector: selector.trim() })}
				>
					Request click on selector
				</Button>
			</form>

			<form className="bx-row" onSubmit={scroll}>
				<Field label="Key" className="bx-narrow">
					<Input
						value={key}
						autoComplete="off"
						spellCheck={false}
						disabled={disabled}
						onChange={event => setKey(event.target.value)}
					/>
				</Field>
				<Button
					type="button"
					variant="outline"
					disabled={disabled || busy || key.trim().length === 0}
					onClick={() => void onRequest({ kind: "press", key: key.trim() })}
				>
					Request key press
				</Button>
				<Field label="Scroll Δx" className="bx-narrow">
					<Input
						type="number"
						value={deltaX}
						disabled={disabled}
						onChange={event => setDeltaX(event.target.value)}
					/>
				</Field>
				<Field label="Scroll Δy" className="bx-narrow">
					<Input
						type="number"
						value={deltaY}
						disabled={disabled}
						onChange={event => setDeltaY(event.target.value)}
					/>
				</Field>
				<Button type="submit" variant="outline" disabled={disabled || busy}>
					Request scroll
				</Button>
			</form>
		</section>
	);
}
