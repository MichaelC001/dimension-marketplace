/**
 * The focus ring of every control in the viewer's bars: a solid 2 px accent ring, the one the transport's buttons and
 * the scrubber's knob wear. The shared `IconButton` falls back to the faint `fr-accent-line`, which on a dark bar is
 * hard to find; this is passed as its class and wins (the classes are merged). A ring is a shadow, so it never changes
 * a control's size.
 */
export const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent";
