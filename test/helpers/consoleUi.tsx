import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider} from '@mui/material';
import {render, type RenderResult} from '@testing-library/react';
import {type ReactElement, type ReactNode} from 'react';
import {vi} from 'vitest';
import {type AnalyticsDashboardType} from '../../src/core/analytics/contracts.ts';
import {createConsoleTheme} from '../../src/ui/console/theme.ts';
import {type ConsoleJobType, type ConsoleMetaType, type ConsoleSnapshotType} from '../../src/transports/console/contracts.ts';

export const timestamp = '2026-10-24T10:00:00.000Z';

export const metaOf = (overrides: Partial<ConsoleMetaType> = {}): ConsoleMetaType => ({
	program: 'codeindex-mcp',
	version: '0.7.0',
	nodeVersion: 'v26.0.0',
	schemaVersion: '3',
	projectName: 'fixture',
	rootDir: '/workspace',
	projectFilePath: '/workspace/tsconfig.json',
	extractorId: 'typescript',
	extractorVersion: '0.2.0',
	databasePath: '/storage/index.sqlite',
	analyticsPath: '/storage/events.jsonl',
	analyticsEnabled: true,
	projectId: 'project',
	maxResultBytes: 32_768,
	maxReadLines: 200,
	logLevel: 'error',
	loopbackOnly: true,
	tokenRequired: true,
	operations: ['update', 'rebuild', 'verify', 'qualify'],
	...overrides,
});

export const statusOf = (overrides: Partial<ConsoleSnapshotType['status']> = {}): ConsoleSnapshotType['status'] => ({
	ready: true,
	state: 'published',
	refresh: 'current',
	generationId: '0123456789abcdef',
	building: false,
	scope: {
		root: '/workspace',
		projectName: 'fixture',
		projectFile: 'tsconfig.json',
		projects: [{name: 'root', projectFile: 'tsconfig.json'}],
		extractor: {id: 'typescript', version: '0.2.0', compilerVersion: '6.0.3'},
		projectId: 'project',
		workingCopyId: 'working-copy',
	},
	hashes: {source: 'source', configuration: 'configuration'},
	counts: {files: 12, symbols: 34, occurrences: 56, dependencyEdges: 7, dependencyBindings: 8, diagnostics: 0},
	buildStats: [],
	build: {
		startedAt: timestamp,
		completedAt: timestamp,
		durationMs: 1500,
		stages: {scanMs: 100, compilerMs: 400, extractionMs: 500, insertionMs: 200, verificationMs: 100, publicationMs: 200},
	},
	freshness: {state: 'current', checkedAt: timestamp, dirtyFileCount: 0, staleFiles: 0, sourceChanged: false},
	lease: {projectId: 'project', ownerId: 'owner', processId: 1, acquiredAt: timestamp, heartbeatAt: timestamp, expiresAt: timestamp},
	exclusions: [],
	lastError: null,
	...overrides,
});

export const jobOf = (overrides: Partial<ConsoleJobType> = {}): ConsoleJobType => ({
	id: 'job-1',
	operation: 'update',
	state: 'succeeded',
	createdAt: timestamp,
	startedAt: timestamp,
	completedAt: timestamp,
	durationMs: 1200,
	message: 'Published generation',
	result: {generationId: '0123456789abcdef'},
	...overrides,
});

export const snapshotOf = (overrides: Partial<ConsoleSnapshotType> = {}): ConsoleSnapshotType => ({
	meta: metaOf(),
	status: statusOf(),
	jobs: [jobOf()],
	...overrides,
});

export const toolOf = (overrides: Partial<AnalyticsDashboardType['tools'][number]> = {}): AnalyticsDashboardType['tools'][number] => ({
	name: 'find_symbol',
	calls: 12,
	errors: 1,
	errorRate: 1 / 12,
	p50Ms: 10,
	p95Ms: 50,
	p99Ms: 80,
	bytes: 2048,
	truncated: 1,
	latencyBuckets: [
		{label: '≤10 ms', upperMs: 10, count: 8},
		{label: '>10 ms', upperMs: null, count: 4},
	],
	timeline: [
		{bucketStart: timestamp, calls: 2, errors: 0},
		{bucketStart: '2026-10-24T10:15:00.000Z', calls: 1, errors: 1},
	],
	...overrides,
});

export const dashboardOf = (overrides: Partial<AnalyticsDashboardType> = {}): AnalyticsDashboardType => ({
	generatedAt: timestamp,
	window: {
		since: '24h',
		firstTimestamp: timestamp,
		lastTimestamp: '2026-10-24T10:15:00.000Z',
		events: 30,
		files: 1,
		invalid: 0,
		duplicates: 0,
		bucketMs: 900_000,
	},
	totals: {toolCalls: 12, errors: 1, errorRate: 1 / 12, builds: 2, buildFailures: 0, refreshes: 3, coalesced: 1, bytes: 4096, truncated: 1},
	timeline: [
		{bucketStart: timestamp, events: 20, toolCalls: 10, errors: 0, builds: 1, refreshes: 2},
		{bucketStart: '2026-10-24T10:15:00.000Z', events: 10, toolCalls: 2, errors: 1, builds: 1, refreshes: 1},
	],
	tools: [toolOf()],
	builds: {
		count: 2,
		failures: 0,
		p50Ms: 1000,
		p95Ms: 1500,
		stages: [{stage: 'scan', p50Ms: 100, p95Ms: 150}],
		timeline: [
			{bucketStart: timestamp, timestamp, durationMs: 1000, outcome: 'complete'},
			{bucketStart: '2026-10-24T10:15:00.000Z', timestamp: '2026-10-24T10:15:00.000Z', durationMs: 1500, outcome: 'reused'},
		],
	},
	freshness: [
		{state: 'current', count: 25},
		{state: 'stale', count: 3},
		{state: 'unknown', count: 2},
	],
	watcher: {
		events: 9,
		refreshes: 3,
		coalesced: 1,
		eventToPublicationP95Ms: 80,
		timeline: [{bucketStart: timestamp, events: 9, toolCalls: 0, errors: 0, builds: 0, refreshes: 3}],
	},
	...overrides,
});

export const renderWithProviders = (element: ReactElement, mode: 'light' | 'dark' = 'light'): RenderResult => {
	const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
	const wrapper = ({children}: Readonly<{children: ReactNode}>): ReactElement => (
		<QueryClientProvider client={client}>
			<ThemeProvider theme={createConsoleTheme(mode)}>{children}</ThemeProvider>
		</QueryClientProvider>
	);

	return render(element, {wrapper});
};

export const installBrowserStubs = (options: Readonly<{prefersDark?: boolean; desktop?: boolean}> = {}): void => {
	Object.defineProperty(globalThis, 'matchMedia', {
		writable: true,
		configurable: true,
		value: (query: string): MediaQueryList => {
			const list = {
				matches: query.includes('prefers-color-scheme: dark') ? options.prefersDark === true : options.desktop !== false,
				media: query,
				onchange: null,
				addEventListener: (): void => {
					void 0;
				},
				removeEventListener: (): void => {
					void 0;
				},
				dispatchEvent: (): boolean => false,
			};

			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- jsdom does not implement the deprecated listener aliases.
			return list as unknown as MediaQueryList;
		},
	});

	if (!('ResizeObserver' in globalThis)) {
		class ResizeObserverStub {
			#active = 0;

			public observe(): void {
				this.#active += 1;
			}

			public unobserve(): void {
				this.#active = Math.max(0, this.#active - 1);
			}

			public disconnect(): void {
				this.#active = 0;
			}
		}

		vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	}
};

/** A stable callback for props whose contract is intentionally side-effect free. */
export const noop = (): void => {
	void 0;
};
