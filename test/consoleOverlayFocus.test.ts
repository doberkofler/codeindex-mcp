// @vitest-environment jsdom
import {afterEach, describe, expect, it} from 'vitest';
import {rememberOverlayTrigger, restoreOverlayTrigger} from '../src/ui/console/overlayFocus.ts';

const container = (): HTMLElement => {
	const element = globalThis.document.createElement('div');
	globalThis.document.body.append(element);
	return element;
};

describe('console overlay focus restoration', () => {
	afterEach(() => {
		globalThis.document.body.replaceChildren();
	});

	it('resolves the first focusable descendant of the fallback container', () => {
		const fallback = container();
		const button = globalThis.document.createElement('button');
		fallback.append(button);
		button.focus();

		rememberOverlayTrigger(fallback);

		expect(globalThis.document.activeElement).toBe(globalThis.document.body);

		restoreOverlayTrigger();

		expect(globalThis.document.activeElement).toBe(button);
	});

	it('falls back to the focused element when the fallback has no focusable descendant', () => {
		const trigger = globalThis.document.createElement('button');
		globalThis.document.body.append(trigger);
		trigger.focus();

		rememberOverlayTrigger(null);

		expect(globalThis.document.activeElement).toBe(globalThis.document.body);

		restoreOverlayTrigger();

		expect(globalThis.document.activeElement).toBe(trigger);
	});

	it('does nothing when focus sits on the document body without a fallback', () => {
		globalThis.document.body.focus();

		rememberOverlayTrigger();
		restoreOverlayTrigger();

		expect(globalThis.document.activeElement).toBe(globalThis.document.body);
	});

	it('blurs a focused non-focusable element and restores it', () => {
		const element = container();
		element.tabIndex = -1;
		element.focus();

		rememberOverlayTrigger();
		expect(globalThis.document.activeElement).toBe(globalThis.document.body);

		restoreOverlayTrigger();
		expect(globalThis.document.activeElement).toBe(element);
	});

	it('ignores a disconnected trigger and a second restore', () => {
		const trigger = globalThis.document.createElement('button');
		globalThis.document.body.append(trigger);
		trigger.focus();

		rememberOverlayTrigger();
		trigger.remove();
		restoreOverlayTrigger();
		expect(globalThis.document.activeElement).toBe(globalThis.document.body);

		restoreOverlayTrigger();
		expect(globalThis.document.activeElement).toBe(globalThis.document.body);
	});

	it('ignores a fallback that is not an element', () => {
		rememberOverlayTrigger(globalThis.document as unknown as Element);

		expect(globalThis.document.activeElement).toBe(globalThis.document.body);
		restoreOverlayTrigger();
	});
});
