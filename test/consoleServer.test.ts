import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {once} from 'node:events';
import {IncomingMessage, request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {buildAnalyticsDashboard} from '../src/core/analytics/dashboard.ts';
import {
	type AnalyticsDashboardType,
	type AnalyticsWindowType,
	type ConsoleJobType,
	type ConsoleMetaType,
	type ConsoleOperationType,
	type ConsoleSnapshotType,
} from '../src/transports/console/contracts.ts';
import {startConsoleServer, type ConsoleServerHandleType, type ConsoleServicePortType} from '../src/transports/console/server.ts';
import {type IndexStatusType} from '../src/core/model.ts';
import {silentLogger} from './helpers/fixture.ts';

const TOKEN = 'test-token';

const authorized = async (url: string | URL, init?: RequestInit): Promise<Response> => {
	const headers = new Headers(init?.headers);
	headers.set('authorization', `Bearer ${TOKEN}`);
	const response = await fetch(url, {...init, headers});
	return response;
};

const status: IndexStatusType = {
	ready: true,
	state: 'published',
	refresh: 'current',
	generationId: 'generation-1',
	building: false,
	scope: {
		root: '/repo',
		projectName: 'project',
		projectFile: '/repo/tsconfig.json',
		projects: [{name: 'root', projectFile: '/repo/tsconfig.json'}],
		extractor: {id: 'typescript', version: '0.1.0', compilerVersion: '6.0.3'},
		projectId: 'project',
		workingCopyId: 'copy',
	},
	hashes: {source: 'source', configuration: 'config'},
	counts: {files: 4, symbols: 10, occurrences: 20, dependencyEdges: 5, dependencyBindings: 6, diagnostics: 0},
	build: {startedAt: null, completedAt: null, durationMs: null, stages: null},
	freshness: {state: 'current', checkedAt: '2026-10-18T00:00:00.000Z', dirtyFileCount: 0, staleFiles: 0, sourceChanged: false},
	lease: null,
	exclusions: [],
	lastError: null,
};

const meta: ConsoleMetaType = {
	program: 'codeindex-mcp',
	version: '0.1.0',
	nodeVersion: 'v26.0.0',
	schemaVersion: '5',
	projectName: 'project',
	rootDir: '/repo',
	projectFilePath: '/repo/tsconfig.json',
	extractorId: 'typescript',
	extractorVersion: '0.1.0',
	databasePath: '/tmp/index.sqlite',
	analyticsPath: '/tmp/events.jsonl',
	analyticsEnabled: true,
	projectId: 'project',
	maxResultBytes: 32_768,
	maxReadLines: 200,
	logLevel: 'error',
	loopbackOnly: true,
	tokenRequired: true,
	operations: ['update', 'rebuild', 'verify', 'benchmark', 'verify-references'],
};

const createService = (): Readonly<{service: ConsoleServicePortType; operations: ConsoleOperationType[]}> => {
	const operations: ConsoleOperationType[] = [];
	const jobs: ConsoleJobType[] = [];
	const dashboard: AnalyticsDashboardType = buildAnalyticsDashboard('/nonexistent/events.jsonl', '24h');
	const service: ConsoleServicePortType = {
		meta,
		status,
		jobs,
		snapshot: (): ConsoleSnapshotType => ({meta, status, jobs}),
		analytics: (_window: AnalyticsWindowType): AnalyticsDashboardType => dashboard,
		runOperation: (operation): ConsoleJobType => {
			operations.push(operation);
			const job: ConsoleJobType = {
				id: `job-${operations.length}`,
				operation,
				state: 'queued',
				createdAt: '2026-10-18T00:00:00.000Z',
				startedAt: null,
				completedAt: null,
				durationMs: null,
				message: null,
				result: null,
			};
			jobs.push(job);
			return job;
		},
	};

	return {service, operations};
};

const createStaticRoot = (): Readonly<{root: string; cleanup: () => void}> => {
	const root = mkdtempSync(path.join(tmpdir(), 'code-index-console-'));
	mkdirSync(path.join(root, 'assets'), {recursive: true});
	writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Console</title>', {encoding: 'utf8'});
	writeFileSync(path.join(root, 'assets', 'app.js'), 'export {};', {encoding: 'utf8'});

	return {
		root,
		cleanup: () => {
			rmSync(root, {recursive: true, force: true});
		},
	};
};

describe('console HTTP server', () => {
	let server: ConsoleServerHandleType | undefined;
	let cleanup: (() => void) | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
		cleanup?.();
		cleanup = undefined;
	});

	const start = async (): Promise<Readonly<{servicePort: ReturnType<typeof createService>; url: string}>> => {
		const staticRoot = createStaticRoot();
		const servicePort = createService();
		const {root, cleanup: dispose} = staticRoot;
		cleanup = dispose;
		server = await startConsoleServer({
			service: servicePort.service,
			token: TOKEN,
			staticRoot: root,
			host: '127.0.0.1',
			port: 0,
			logger: silentLogger,
		});

		return {servicePort, url: server.url};
	};

	it('serves the bundle without a token and protects every API route', async () => {
		const {url} = await start();
		const page = await fetch(url);
		const asset = await fetch(new URL('assets/app.js', url));
		const unauthorized = await fetch(new URL('api/snapshot', url));
		const authorizedResponse = await authorized(new URL('api/snapshot', url));

		expect(page.status).toBe(200);
		await expect(page.text()).resolves.toContain('Console');
		expect(asset.status).toBe(200);
		expect(unauthorized.status).toBe(401);
		expect(authorizedResponse.status).toBe(200);
		await expect(authorizedResponse.json()).resolves.toMatchObject({status: {generationId: 'generation-1'}});
	});

	it('rejects non-loopback hosts and unknown API routes', async () => {
		const {url} = await start();
		const target = new URL(url);
		const badRequest = httpRequest({hostname: target.hostname, port: target.port, path: '/', headers: {host: 'evil.example'}});
		badRequest.end();
		const [badResponse] = await once(badRequest, 'response');

		if (!(badResponse instanceof IncomingMessage)) {
			throw new Error('Expected an HTTP response');
		}

		badResponse.resume();
		const badHostStatus = badResponse.statusCode ?? 0;
		const missing = await authorized(new URL('api/missing', url));

		expect(badHostStatus).toBe(403);
		expect(missing.status).toBe(404);
	});

	it('validates analytics windows and operation allow-lists', async () => {
		const {servicePort, url} = await start();
		const badWindow = await authorized(new URL('api/analytics?window=2y', url));
		const badOperation = await authorized(new URL('api/jobs', url), {
			method: 'POST',
			body: JSON.stringify({operation: 'clean'}),
		});
		const accepted = await authorized(new URL('api/jobs', url), {
			method: 'POST',
			body: JSON.stringify({operation: 'verify'}),
		});

		expect(badWindow.status).toBe(400);
		expect(badOperation.status).toBe(400);
		expect(accepted.status).toBe(202);
		expect(servicePort.operations).toStrictEqual(['verify']);
	});

	it('rejects cross-origin mutations', async () => {
		const {url} = await start();
		const response = await authorized(new URL('api/jobs', url), {
			method: 'POST',
			headers: {origin: 'http://evil.example'},
			body: JSON.stringify({operation: 'verify'}),
		});

		expect(response.status).toBe(403);
	});
});
