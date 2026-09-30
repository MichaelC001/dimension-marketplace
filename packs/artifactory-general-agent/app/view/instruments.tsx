// The instrument bar's controls: a readout with a label and a hint, and the two
// shapes a setting takes — a row of ticks (`Segments`) and a rising meter
// (`Meter`). Any of them can be set aside (`disabled`) when the key it draws is
// held in Everything else, or the host does not offer it — a control that would
// change nothing is never drawn as if it would.
import type { ReactNode } from "react";

export function Instrument({ label, value, hint, children }: { label: string; value: string; hint: string; children?: ReactNode }) {
	return (
		<div className="fg-instrument" title={hint}>
			<div className="fg-instrument-read">
				<span className="fg-instrument-label">{label}</span>
				<span className="fg-instrument-value">{value}</span>
			</div>
			{children}
		</div>
	);
}

export function Segments<T extends string>({
	options,
	value,
	labels,
	onChange,
	disabled = false,
	disabledOptions = [],
}: {
	options: readonly T[];
	value: T | null;
	labels: Record<T, string>;
	onChange: (value: T) => void;
	/** Every tick: set aside. */
	disabled?: boolean;
	/** Just these ticks. */
	disabledOptions?: readonly T[];
}) {
	return (
		<div className="fg-segments" role="radiogroup" aria-disabled={disabled || undefined}>
			{options.map(option => (
				<button
					key={option}
					type="button"
					role="radio"
					aria-checked={option === value}
					aria-label={labels[option]}
					disabled={disabled || disabledOptions.includes(option)}
					onClick={() => onChange(option)}
				>
					<span className="fg-segment-tick" aria-hidden="true" />
				</button>
			))}
		</div>
	);
}

export function Meter<T extends string>({ steps, value, labels, onChange, disabled = false }: { steps: readonly T[]; value: T; labels: Record<T, string>; onChange: (value: T) => void; disabled?: boolean }) {
	const index = steps.indexOf(value);
	return (
		<div className="fg-meter" role="radiogroup" aria-label="Thinking level" aria-disabled={disabled || undefined}>
			{steps.map((step, i) => (
				<button
					key={step}
					type="button"
					role="radio"
					aria-checked={step === value}
					aria-label={labels[step]}
					data-lit={i <= index || undefined}
					data-inherit={step === steps[0] || undefined}
					disabled={disabled}
					onClick={() => onChange(step)}
				/>
			))}
		</div>
	);
}
