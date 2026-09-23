// Direct controls: every button runs `browser_act` NOW and the frame follows.
// Typed text is ephemeral — it lives in the input until the action ran, is
// cleared immediately after, is masked on demand for credentials, and is never
// written to storage of any kind.
import { type FormEvent, useState } from "react";
import type { BrowserAction } from "../../src/contracts";
import { Button, Field, Input, Label } from "@fraym/ui/elements"

export interface ControlsProps {
	readonly url: string;
	readonly disabled: boolean;
	readonly busy: boolean;
	/** Runs the action and answers true only when it completed — a failed
	 *  action keeps the human's draft so it can be corrected. */
	readonly onAct: (action: BrowserAction) => Promise<boolean>;
}

export function Controls({ url, disabled, busy, onAct }: ControlsProps) {
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
	const noSelector = disabled || busy || selector.trim().length === 0;

	const submitNavigate = async (event: FormEvent) => {
		event.preventDefault();
		const target = shownAddress.trim();
		if (target.length === 0) return;
		if (await onAct({ kind: "navigate", url: target })) setAddressDirty(false);
	};

	// The server's type action REQUIRES a selector (it has no focused-element
	// form), and an empty text is legitimate: it clears the field.
	const submitType = async (event: FormEvent) => {
		event.preventDefault();
		const target = selector.trim();
		if (target.length === 0) return;
		if (await onAct({ kind: "type", selector: target, text })) setText("");
	};

	// press and scroll act on the page, so the shared selector box must not ride along.
	const scroll = (event: FormEvent) => {
		event.preventDefault();
		void onAct({
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
					Go
				</Button>
			</form>

			<form className="bx-row" onSubmit={event => void submitType(event)}>
				<Field label="CSS selector" helper="Used by Type, Select option and Click selector. Key press and scroll act on the page." className="bx-grow">
					<Input
						value={selector}
						placeholder="input[name=q]"
						autoComplete="off"
						spellCheck={false}
						disabled={disabled}
						onChange={event => setSelector(event.target.value)}
					/>
				</Field>
				<Field label="Text / option" helper="Type replaces the field's value (empty clears it); Select picks the option with this value or label." className="bx-grow">
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
				<Button type="submit" variant="outline" disabled={noSelector}>
					Type
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={noSelector || text.length === 0}
					onClick={() => void onAct({ kind: "select", selector: selector.trim(), value: text })}
				>
					Select option
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={noSelector}
					onClick={() => void onAct({ kind: "click", selector: selector.trim() })}
				>
					Click selector
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
					onClick={() => void onAct({ kind: "press", key: key.trim() })}
				>
					Press key
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
					Scroll
				</Button>
			</form>
		</section>
	);
}
