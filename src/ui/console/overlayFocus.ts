const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let overlayTrigger: HTMLElement | null = null;

const focusableOf = (element: Element | null): HTMLElement | null => {
	if (!(element instanceof globalThis.HTMLElement)) {
		return null;
	}

	return element.matches(FOCUSABLE_SELECTOR) ? element : element.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
};

/**
 * Remembers the element that opens a portaled overlay and removes focus from it
 * before MUI applies `aria-hidden` to its ancestors.
 *
 * @param fallback - Element containing the focused trigger, used when focus
 * currently sits on the document body.
 */
export const rememberOverlayTrigger = (fallback?: Element | null): void => {
	const active = globalThis.document.activeElement;
	const trigger = focusableOf(fallback ?? null) ?? (active instanceof globalThis.HTMLElement && active !== globalThis.document.body ? active : null);
	overlayTrigger = trigger;
	trigger?.blur();
};

/** Restores focus to the element that opened the most recent overlay. */
export const restoreOverlayTrigger = (): void => {
	const trigger = overlayTrigger;
	overlayTrigger = null;

	if (trigger?.isConnected === true) {
		trigger.focus();
	}
};
