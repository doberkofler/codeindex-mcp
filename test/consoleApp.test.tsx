// @vitest-environment jsdom
import {cleanup, screen, waitFor} from '@testing-library/react';
import {userEvent} from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {App} from '../src/ui/console/App.tsx';
import {dashboardOf, installBrowserStubs, jobOf, renderWithProviders, snapshotOf} from './helpers/consoleUi.tsx';

const jsonResponse = async (body: unknown, status = 200): Promise<Response> => {
	await Promise.resolve();

	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => {
			await Promise.resolve();
			return body;
		},
	} as Response;
};

const installFetch = (): ReturnType<typeof vi.fn> => {
	const fetchMock = vi.fn<(input: string) => Promise<Response>>(async (input) => {
		await Promise.resolve();

		if (input === '/api/snapshot') {
			return jsonResponse(snapshotOf());
		}

		if (input.startsWith('/api/analytics')) {
			return jsonResponse(dashboardOf());
		}

		if (input === '/api/jobs') {
			return jsonResponse({
				job: jobOf({id: 'job-2', operation: 'update', state: 'queued', startedAt: null, completedAt: null, durationMs: null, result: null}),
			});
		}

		return jsonResponse({error: {message: 'unexpected request'}}, 500);
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
};

describe('console application composition', () => {
	beforeEach(() => {
		installBrowserStubs();
		sessionStorage.clear();
		localStorage.clear();
		globalThis.history.replaceState(null, '', '/');
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		sessionStorage.clear();
		localStorage.clear();
	});

	it('navigates every page, refreshes, changes theme, and runs an update', async () => {
		const fetchMock = installFetch();
		sessionStorage.setItem('code-index-console-token', 'token');

		renderWithProviders(<App />);

		await screen.findByText('Your code index, at a glance.');

		await userEvent.click(screen.getByRole('button', {name: 'Analytics'}));
		await screen.findByText('Activity timeline');

		await userEvent.click(screen.getByRole('button', {name: 'Operations'}));
		expect(screen.getByText('Recent jobs')).not.toBeNull();

		await userEvent.click(screen.getByRole('button', {name: 'Result'}));
		expect(screen.getByText(/0123456789abcdef/u)).not.toBeNull();
		await userEvent.click(screen.getByRole('button', {name: 'Close'}));

		await userEvent.click(screen.getByText('Configuration'));
		expect(screen.getByText('Security boundary')).not.toBeNull();

		await userEvent.click(screen.getByText('Overview'));
		await userEvent.click(screen.getByRole('button', {name: 'Change color theme'}));
		expect(localStorage.getItem('code-index-console-theme')).toBe('light');

		await userEvent.click(screen.getByRole('button', {name: 'Refresh console data'}));

		await userEvent.click(screen.getByRole('button', {name: 'Update index'}));
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith('/api/jobs', expect.objectContaining({method: 'POST'}));
		});
		const recentJobs = await screen.findByText('Recent jobs');
		expect(recentJobs).not.toBeNull();
	});

	it('asks for a token when none is stored and connects after submission', async () => {
		installFetch();

		renderWithProviders(<App />);

		expect(screen.getByText('Connect to the console')).not.toBeNull();

		await userEvent.type(screen.getByLabelText('Console token'), 'token{enter}');

		const heading = await screen.findByText('Your code index, at a glance.');
		expect(heading).not.toBeNull();
		expect(sessionStorage.getItem('code-index-console-token')).toBe('token');
	});

	it('reports a failed connection and returns to token entry on disconnect', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn<(input: string) => Promise<Response>>(async () => {
				await Promise.resolve();
				return jsonResponse({error: {message: 'bad token'}}, 403);
			}),
		);
		sessionStorage.setItem('code-index-console-token', 'expired');

		renderWithProviders(<App />);

		const failure = await screen.findByText('Console connection failed');
		expect(failure).not.toBeNull();
		expect(screen.getByText('bad token')).not.toBeNull();

		await userEvent.click(screen.getByRole('button', {name: 'Enter a different token'}));

		expect(screen.getByText('Connect to the console')).not.toBeNull();
		expect(sessionStorage.getItem('code-index-console-token')).toBeNull();
	});

	it('renders with stored dark and system theme preferences', async () => {
		installFetch();
		installBrowserStubs({prefersDark: true});
		sessionStorage.setItem('code-index-console-token', 'token');
		localStorage.setItem('code-index-console-theme', 'dark');

		const {unmount} = renderWithProviders(<App />);
		const heading = await screen.findByText('Your code index, at a glance.');
		expect(heading).not.toBeNull();
		unmount();

		localStorage.setItem('code-index-console-theme', 'system');
		renderWithProviders(<App />);
		const systemHeading = await screen.findByText('Your code index, at a glance.');
		expect(systemHeading).not.toBeNull();
	});
});
