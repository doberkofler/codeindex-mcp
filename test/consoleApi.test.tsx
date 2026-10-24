// @vitest-environment jsdom
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderHook, waitFor} from '@testing-library/react';
import {type ReactElement, type ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {clearToken, readToken, storeToken, useAnalytics, useRunOperation, useSnapshot} from '../src/ui/console/api.ts';
import {dashboardOf, snapshotOf, timestamp} from './helpers/consoleUi.tsx';

const responseOf = (body: unknown, status = 200): Response =>
	({
		ok: status >= 200 && status < 300,
		status,
		json: async () => {
			await Promise.resolve();
			return body;
		},
	}) as Response;

const wrapperOf = (client: QueryClient) =>
	function QueryWrapper({children}: Readonly<{children: ReactNode}>): ReactElement {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};

const testClient = (): QueryClient => new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false}}});

const resetBrowserState = (): void => {
	sessionStorage.clear();
	globalThis.history.replaceState(null, '', '/');
};

describe('console token flow', () => {
	afterEach(resetBrowserState);

	it('stores a URL-fragment token and strips it from the current URL', () => {
		globalThis.location.hash = '#token=from-hash';

		expect(readToken()).toBe('from-hash');
		expect(sessionStorage.getItem('code-index-console-token')).toBe('from-hash');
		expect(globalThis.location.hash).toBe('');
	});

	it('reuses, replaces, and clears the stored token', () => {
		storeToken('stored');
		expect(readToken()).toBe('stored');

		storeToken('replacement');
		expect(readToken()).toBe('replacement');

		clearToken();
		expect(readToken()).toBeNull();
	});

	it('ignores malformed fragments and falls through to storage', () => {
		storeToken('stored');
		globalThis.location.hash = '#other=value';

		expect(readToken()).toBe('stored');
		expect(globalThis.location.hash).toBe('#other=value');
	});
});

describe('console API requests', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetBrowserState();
	});

	it('loads a snapshot with the bearer token and JSON accept header', async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			await Promise.resolve();
			return responseOf(snapshotOf());
		});
		vi.stubGlobal('fetch', fetchMock);
		const client = testClient();
		const {result, unmount} = renderHook(() => useSnapshot('secret'), {wrapper: wrapperOf(client)});

		await waitFor(() => {
			expect(result.current.isSuccess).toBe(true);
		});

		expect(result.current.data?.status.generationId).toBe('0123456789abcdef');
		expect(fetchMock).toHaveBeenCalledWith('/api/snapshot', {
			headers: {accept: 'application/json', authorization: 'Bearer secret'},
		});

		unmount();
		client.clear();
	});

	it.each([
		['a JSON error envelope', responseOf({error: {message: 'denied'}}, 403), 'denied'],
		[
			'a non-JSON error body',
			{
				ok: false,
				status: 500,
				json: async () => {
					await Promise.resolve();
					throw new Error('not json');
				},
			} as unknown as Response,
			'Request failed with 500',
		],
		['an invalid success payload', responseOf({unexpected: true}), 'Unexpected console response'],
	] as const)('maps %s to a stable message', async (_case, response, message) => {
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async () => {
				await Promise.resolve();
				return response;
			}),
		);
		const client = testClient();
		const {result, unmount} = renderHook(() => useSnapshot('secret'), {wrapper: wrapperOf(client)});

		await waitFor(() => {
			expect(result.current.isError).toBe(true);
		});

		expect(result.current.error).toBeInstanceOf(Error);
		expect(result.current.error?.message).toContain(message);

		unmount();
		client.clear();
	});
});

describe('console API queries and mutations', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetBrowserState();
	});

	it('does not fetch analytics until the window is enabled', async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			await Promise.resolve();
			return responseOf(dashboardOf());
		});
		vi.stubGlobal('fetch', fetchMock);
		const client = testClient();
		const {result, rerender, unmount} = renderHook(({enabled}: Readonly<{enabled: boolean}>) => useAnalytics('secret', '7d', enabled), {
			initialProps: {enabled: false},
			wrapper: wrapperOf(client),
		});

		expect(fetchMock).not.toHaveBeenCalled();

		rerender({enabled: true});

		await waitFor(() => {
			expect(result.current.isSuccess).toBe(true);
		});

		expect(result.current.data?.window.since).toBe('24h');
		expect(fetchMock).toHaveBeenCalledWith('/api/analytics?window=7d', {
			headers: {accept: 'application/json', authorization: 'Bearer secret'},
		});

		unmount();
		client.clear();
	});

	it('posts an operation with JSON content and refreshes the snapshot query', async () => {
		const job = {
			id: 'job-2',
			operation: 'rebuild',
			state: 'queued',
			createdAt: timestamp,
			startedAt: null,
			completedAt: null,
			durationMs: null,
			message: null,
			result: null,
		};
		const fetchMock = vi.fn<typeof fetch>(async () => {
			await Promise.resolve();
			return responseOf({job});
		});
		vi.stubGlobal('fetch', fetchMock);
		const client = testClient();
		client.setQueryData(['snapshot', 'secret'], snapshotOf());
		const {result, unmount} = renderHook(() => useRunOperation('secret'), {wrapper: wrapperOf(client)});

		await result.current.mutateAsync('rebuild');

		await waitFor(() => {
			expect(result.current.isSuccess).toBe(true);
		});

		expect(result.current.data?.job.operation).toBe('rebuild');
		expect(fetchMock).toHaveBeenCalledWith('/api/jobs', {
			method: 'POST',
			body: JSON.stringify({operation: 'rebuild'}),
			headers: {accept: 'application/json', authorization: 'Bearer secret', 'content-type': 'application/json'},
		});

		unmount();
		client.clear();
	});
});
