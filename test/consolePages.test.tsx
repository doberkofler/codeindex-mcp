// @vitest-environment jsdom
import {cleanup, screen} from '@testing-library/react';
import {userEvent} from '@testing-library/user-event';
import {type ReactElement} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AnalyticsPage} from '../src/ui/console/AnalyticsPage.tsx';
import {AppShell, type ThemeModeType, type ViewType} from '../src/ui/console/AppShell.tsx';
import {ConfigurationPage} from '../src/ui/console/ConfigurationPage.tsx';
import {OperationsPage} from '../src/ui/console/OperationsPage.tsx';
import {OverviewPage} from '../src/ui/console/OverviewPage.tsx';
import {TokenGate} from '../src/ui/console/TokenGate.tsx';
import {
	type AnalyticsDashboardType,
	type AnalyticsToolType,
	type AnalyticsWindowType,
	type ConsoleJobType,
	type ConsoleOperationType,
} from '../src/transports/console/contracts.ts';
import {dashboardOf, installBrowserStubs, jobOf, metaOf, noop, renderWithProviders, snapshotOf, statusOf, timestamp, toolOf} from './helpers/consoleUi.tsx';

const analyticsElement = (
	props: Readonly<{
		dashboard: AnalyticsDashboardType | undefined;
		window: AnalyticsWindowType;
		loading: boolean;
		error: string | null;
		selectedTool: AnalyticsToolType | null;
		onWindowChange: (window: AnalyticsWindowType) => void;
		onSelectTool: (tool: AnalyticsToolType | null) => void;
	}>,
): ReactElement => (
	<AnalyticsPage
		dashboard={props.dashboard}
		window={props.window}
		loading={props.loading}
		error={props.error}
		selectedTool={props.selectedTool}
		onWindowChange={props.onWindowChange}
		onSelectTool={props.onSelectTool}
	/>
);

// oxlint-disable-next-line eslint/max-lines-per-function -- Page scenarios share fixtures and browser stubs across the file.
describe('console pages', () => {
	beforeEach(() => {
		installBrowserStubs();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	describe('console overview page', () => {
		it('renders metrics, scope, stages, and recent operations', async () => {
			const onOpenOperations = vi.fn<() => void>();
			const onRunUpdate = vi.fn<() => void>();

			renderWithProviders(<OverviewPage snapshot={snapshotOf()} busy={false} onOpenOperations={onOpenOperations} onRunUpdate={onRunUpdate} />);

			expect(screen.getByText('Your code index, at a glance.')).not.toBeNull();
			expect(screen.getByText('Files')).not.toBeNull();
			expect(screen.getByText('Build stages')).not.toBeNull();
			expect(screen.getByText('Freshness & scope')).not.toBeNull();
			expect(screen.getByText('Live and current')).not.toBeNull();
			expect(screen.getByText('Recent operations')).not.toBeNull();
			expect(screen.getByText('update')).not.toBeNull();

			await userEvent.click(screen.getByRole('button', {name: 'Operations'}));
			// oxlint-disable-next-line vitest/prefer-to-have-length -- Assert the exact call count without the conflicting mock-call rules.
			expect(onOpenOperations.mock.calls.length).toBe(1);
			await userEvent.click(screen.getByRole('button', {name: 'Update index'}));
			// oxlint-disable-next-line vitest/prefer-to-have-length -- Assert the exact call count without the conflicting mock-call rules.
			expect(onRunUpdate.mock.calls.length).toBe(1);
		});

		it('renders empty stages, no lease, project-wide freshness, and no recent jobs', () => {
			renderWithProviders(
				<OverviewPage
					snapshot={snapshotOf({
						status: statusOf({
							build: {startedAt: null, completedAt: null, durationMs: null, stages: null},
							freshness: {state: 'stale', checkedAt: timestamp, dirtyFileCount: null, staleFiles: 2, sourceChanged: true},
							lease: null,
							lastError: 'build failed',
						}),
						jobs: [],
					})}
					busy
					onOpenOperations={noop}
					onRunUpdate={noop}
				/>,
			);

			expect(screen.getByText('No build stage timings recorded yet')).not.toBeNull();
			expect(screen.getByText('No active owner')).not.toBeNull();
			expect(screen.getByText('project-wide', {exact: false})).not.toBeNull();
			expect(screen.getByText('No completed build')).not.toBeNull();
			expect(screen.getByText('No console operations have run yet.')).not.toBeNull();
			expect(screen.getByText('build failed')).not.toBeNull();
			expect(screen.getByRole('button', {name: 'Update index'})).toHaveProperty('disabled', true);
		});
	});

	describe('console operations page', () => {
		it('renders idle state and dispatches every operation', async () => {
			const onRun = vi.fn<(operation: ConsoleOperationType) => void>();
			const {rerender} = renderWithProviders(
				<OperationsPage snapshot={snapshotOf({jobs: []})} activeJob={null} error={null} resultJob={null} onRun={onRun} onShowResult={noop} />,
			);

			expect(screen.getByText('No operation is running.')).not.toBeNull();
			expect(screen.getByText('No jobs have run in this console session.')).not.toBeNull();

			for (const operation of ['update', 'rebuild', 'verify', 'qualify'] as const) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- One page must process the clicks in source order.
				await userEvent.click(screen.getByRole('button', {name: `Run ${operation}`}));
			}

			const operations: ConsoleOperationType[] = [];

			for (const call of onRun.mock.calls) {
				operations.push(call[0]);
			}

			expect(operations).toStrictEqual(['update', 'rebuild', 'verify', 'qualify']);

			rerender(
				<OperationsPage
					snapshot={snapshotOf()}
					activeJob={jobOf({state: 'running', operation: 'verify'})}
					error="operation failed"
					resultJob={null}
					onRun={onRun}
					onShowResult={noop}
				/>,
			);

			expect(screen.getByText('operation failed')).not.toBeNull();
			expect(screen.getByText(/is running/u)).not.toBeNull();
			expect(screen.getByRole('button', {name: 'Run update'})).toHaveProperty('disabled', true);
		});

		it('opens and closes a job result dialog', async () => {
			const onShowResult = vi.fn<(job: ConsoleJobType | null) => void>();
			const job = jobOf();

			const {rerender} = renderWithProviders(
				<OperationsPage snapshot={snapshotOf({jobs: [job]})} activeJob={null} error={null} resultJob={null} onRun={noop} onShowResult={onShowResult} />,
			);

			await userEvent.click(screen.getByRole('button', {name: 'Result'}));
			expect(onShowResult).toHaveBeenCalledWith(job);

			rerender(<OperationsPage snapshot={snapshotOf({jobs: [job]})} activeJob={null} error={null} resultJob={job} onRun={noop} onShowResult={onShowResult} />);

			expect(screen.getByText(/0123456789abcdef/u)).not.toBeNull();

			await userEvent.click(screen.getByRole('button', {name: 'Close'}));
			expect(onShowResult).toHaveBeenLastCalledWith(null);
		});

		it('renders every job state, absent message and timing, and closes on Escape', async () => {
			const onShowResult = vi.fn<(job: ConsoleJobType | null) => void>();
			const jobs = [
				jobOf({id: 'succeeded', state: 'succeeded'}),
				jobOf({id: 'failed', state: 'failed', message: null, startedAt: null, durationMs: null}),
				jobOf({id: 'running', state: 'running'}),
				jobOf({id: 'queued', state: 'queued'}),
			];

			const {rerender} = renderWithProviders(
				<OperationsPage snapshot={snapshotOf({jobs})} activeJob={null} error={null} resultJob={null} onRun={noop} onShowResult={onShowResult} />,
			);

			for (const state of ['succeeded', 'failed', 'running', 'queued']) {
				expect(screen.getAllByText(state).length).toBeGreaterThan(0);
			}
			expect(screen.getAllByText('—').length).toBeGreaterThan(0);

			rerender(
				<OperationsPage snapshot={snapshotOf({jobs})} activeJob={null} error={null} resultJob={jobs[0] ?? null} onRun={noop} onShowResult={onShowResult} />,
			);

			await userEvent.keyboard('{Escape}');
			expect(onShowResult).toHaveBeenCalledWith(null);
		});

		it('disables result for a job without a result and renders null dialog content', () => {
			const job = jobOf({result: null});
			const {rerender} = renderWithProviders(
				<OperationsPage snapshot={snapshotOf({jobs: [job]})} activeJob={null} error={null} resultJob={null} onRun={noop} onShowResult={noop} />,
			);

			expect(screen.getByRole('button', {name: 'Result'})).toHaveProperty('disabled', true);

			rerender(<OperationsPage snapshot={snapshotOf({jobs: [job]})} activeJob={null} error={null} resultJob={job} onRun={noop} onShowResult={noop} />);

			expect(screen.getByText('null')).not.toBeNull();
		});
	});

	describe('console analytics page', () => {
		it('renders loading, unavailable, and empty states', () => {
			const props = {dashboard: undefined, window: '24h' as const, error: null, selectedTool: null, onWindowChange: noop, onSelectTool: noop};
			const {rerender} = renderWithProviders(analyticsElement({...props, loading: true}));

			expect(globalThis.document.querySelectorAll('.MuiSkeleton-root')).toHaveLength(3);

			rerender(analyticsElement({...props, loading: false, error: 'analytics failed'}));
			expect(screen.getByText('analytics failed')).not.toBeNull();
			expect(screen.getByText('Analytics are not available yet.')).not.toBeNull();

			const empty = dashboardOf({window: {...dashboardOf().window, events: 0}});
			rerender(analyticsElement({...props, loading: false, dashboard: empty}));
			expect(screen.getByText('No analytics in this window')).not.toBeNull();
		});

		it('renders a complete dashboard and forwards window and tool selection', async () => {
			const onWindowChange = vi.fn<(window: AnalyticsWindowType) => void>();
			const onSelectTool = vi.fn<(tool: AnalyticsToolType | null) => void>();
			const dashboard = dashboardOf();

			const {rerender} = renderWithProviders(
				analyticsElement({
					dashboard,
					window: '24h',
					loading: false,
					error: null,
					selectedTool: null,
					onWindowChange,
					onSelectTool,
				}),
			);

			expect(screen.getByText('Activity timeline')).not.toBeNull();
			expect(screen.getByText('Build health')).not.toBeNull();
			expect(screen.getByText('Freshness & watcher')).not.toBeNull();
			expect(screen.getByText('find_symbol')).not.toBeNull();
			expect(screen.getByText('25')).not.toBeNull();

			await userEvent.click(screen.getByText('7d'));
			expect(onWindowChange).toHaveBeenCalledWith('7d');

			await userEvent.click(screen.getByText('find_symbol'));
			expect(onSelectTool).toHaveBeenCalledWith(dashboard.tools[0]);

			rerender(
				analyticsElement({
					dashboard: dashboardOf({
						tools: [],
						builds: {...dashboard.builds, stages: [], timeline: []},
						freshness: [],
						window: {...dashboard.window, firstTimestamp: null, lastTimestamp: null},
					}),
					window: '7d',
					loading: false,
					error: null,
					selectedTool: null,
					onWindowChange,
					onSelectTool,
				}),
			);

			expect(screen.getByText('No MCP tool calls have been recorded in this window.')).not.toBeNull();
			expect(screen.getByText('No build events in this window')).not.toBeNull();
			expect(screen.getByText('No stage timings')).not.toBeNull();
			expect(screen.getByText('No freshness samples')).not.toBeNull();

			rerender(
				analyticsElement({
					dashboard,
					window: '24h',
					loading: false,
					error: null,
					selectedTool: toolOf(),
					onWindowChange,
					onSelectTool,
				}),
			);

			await userEvent.click(screen.getByRole('button', {name: 'Close'}));
			expect(onSelectTool).toHaveBeenCalledWith(null);
		});
	});

	describe('console configuration and token gate', () => {
		it('renders enabled and disabled analytics boundaries', () => {
			const {rerender} = renderWithProviders(<ConfigurationPage meta={metaOf()} />);

			expect(screen.getByText('/workspace')).not.toBeNull();
			expect(screen.getByText('analytics enabled')).not.toBeNull();
			expect(screen.getByText('Intentionally absent')).not.toBeNull();

			rerender(<ConfigurationPage meta={metaOf({analyticsEnabled: false})} />);
			expect(screen.getByText('analytics disabled')).not.toBeNull();
		});

		it('rejects an empty token, retries after a rejection, and renders the rejection', async () => {
			const onSubmit = vi.fn<(token: string) => void>();
			const {rerender} = renderWithProviders(<TokenGate error={null} onSubmit={onSubmit} />);

			await userEvent.click(screen.getByRole('button', {name: 'Open console'}));
			expect(screen.getByText('Enter the token printed by the console command.')).not.toBeNull();

			const input = screen.getByLabelText('Console token');
			await userEvent.type(input, '  secret-token  {enter}');
			expect(onSubmit).toHaveBeenCalledWith('secret-token');

			rerender(<TokenGate error="Token rejected" onSubmit={onSubmit} />);
			expect(screen.getByText('Token rejected')).not.toBeNull();

			await userEvent.clear(input);
			await userEvent.type(input, 'retry-token{enter}');
			expect(onSubmit).toHaveBeenLastCalledWith('retry-token');
		});
	});

	describe('console shell navigation', () => {
		it('renders desktop navigation and dispatches every control', async () => {
			const onViewChange = vi.fn<(view: ViewType) => void>();
			const onThemeModeChange = vi.fn<(mode: ThemeModeType) => void>();
			const onRefresh = vi.fn<() => void>();

			renderWithProviders(
				<AppShell
					snapshot={snapshotOf()}
					view="overview"
					themeMode="system"
					onViewChange={onViewChange}
					onThemeModeChange={onThemeModeChange}
					onRefresh={onRefresh}
				>
					<div>page body</div>
				</AppShell>,
			);

			expect(screen.getByText('page body')).not.toBeNull();
			expect(screen.getByText('Code Index')).not.toBeNull();

			for (const view of ['Analytics', 'Operations', 'Configuration', 'Overview'] as const) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- Navigation clicks must settle before the next view renders.
				await userEvent.click(screen.getByRole('button', {name: view}));
			}

			const views: ViewType[] = [];

			for (const call of onViewChange.mock.calls) {
				views.push(call[0]);
			}

			expect(views).toStrictEqual(['analytics', 'operations', 'configuration', 'overview']);
			expect(screen.getByRole('button', {name: 'Change color theme'})).not.toBeNull();
			await userEvent.click(screen.getByRole('button', {name: 'Change color theme'}));
			expect(onThemeModeChange).toHaveBeenCalledWith('light');
			await userEvent.click(screen.getByRole('button', {name: 'Refresh console data'}));
			// oxlint-disable-next-line vitest/prefer-to-have-length -- Assert the exact call count without the conflicting mock-call rules.
			expect(onRefresh.mock.calls.length).toBe(1);
		});

		it('opens and closes the mobile drawer navigation', async () => {
			installBrowserStubs({desktop: false});
			const onViewChange = vi.fn<(view: ViewType) => void>();

			renderWithProviders(
				<AppShell snapshot={snapshotOf()} view="overview" themeMode="dark" onViewChange={onViewChange} onThemeModeChange={noop} onRefresh={noop}>
					<div>mobile body</div>
				</AppShell>,
			);

			await userEvent.click(screen.getByRole('button', {name: 'Open navigation'}));
			const analytics = screen.getAllByRole('button', {name: 'Analytics'}).at(-1);

			if (analytics === undefined) {
				throw new Error('Expected mobile analytics navigation');
			}

			await userEvent.click(analytics);
			expect(onViewChange).toHaveBeenCalledWith('analytics');
		});
	});
});
