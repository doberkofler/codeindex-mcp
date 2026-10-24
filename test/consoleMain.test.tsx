// @vitest-environment jsdom
import {cleanup, screen} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installBrowserStubs, snapshotOf} from './helpers/consoleUi.tsx';

const responseOf = async (body: unknown): Promise<Response> => {
	await Promise.resolve();

	return {
		ok: true,
		status: 200,
		json: async () => {
			await Promise.resolve();
			return body;
		},
	} as Response;
};

describe('console browser entry', () => {
	beforeEach(() => {
		vi.resetModules();
		installBrowserStubs();
		sessionStorage.clear();
		sessionStorage.setItem('code-index-console-token', 'token');
		vi.stubGlobal(
			'fetch',
			vi.fn<(input: string) => Promise<Response>>(async () => {
				await Promise.resolve();
				return responseOf(snapshotOf());
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		globalThis.document.body.replaceChildren();
	});

	it('mounts the application under the root element', async () => {
		const root = globalThis.document.createElement('div');
		root.id = 'root';
		globalThis.document.body.append(root);

		await import('../src/ui/console/main.tsx');

		const heading = await screen.findByText('Your code index, at a glance.');
		expect(heading).not.toBeNull();
	});

	it('rejects a page without the root element', async () => {
		await expect(import('../src/ui/console/main.tsx')).rejects.toThrow('Console root element is missing');
	});
});
