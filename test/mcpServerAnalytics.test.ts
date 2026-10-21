import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type AnalyticsRecorderType} from '../src/core/analytics/recorder.ts';
import {type CodeIndex} from '../src/core/generation/codeIndex.ts';
import {buildMcpServer} from '../src/transports/mcp/buildMcpServer.ts';
import {silentLogger} from './helpers/fixture.ts';

type ConnectionType = Readonly<{client: Client; analytics: AnalyticsRecorderType; close: () => Promise<void>}>;

const page = (freshness: unknown): Readonly<{generationId: string; freshness: unknown; items: readonly unknown[]; nextCursor: null; truncated: boolean}> => ({
	generationId: 'generation-1',
	freshness,
	items: [],
	nextCursor: null,
	truncated: false,
});

const open = async (): Promise<ConnectionType> => {
	const index = {
		getStatus: () => ({
			ready: true,
			state: 'published',
			refresh: 'current',
			generationId: 'generation-1',
			building: false,
			scope: {projectName: 'root', projects: [], extractor: {id: 'typescript', version: '1', compilerVersion: '5.0.0'}},
			counts: {files: 0, symbols: 0, occurrences: 0, dependencyEdges: 0, dependencyBindings: 0, diagnostics: 0},
			freshness: {state: 'current', checkedAt: '2026-01-01T00:00:00.000Z', dirtyFileCount: null, staleFiles: 0, sourceChanged: false},
			lastError: null,
		}),
		getOutline: () => page({state: 'current'}),
		findSymbols: () => page('current'),
		findReferences: () => page(42),
		findDependencies: () => page(null),
		readSymbol: () => ({source: '', truncated: false}),
	} as unknown as CodeIndex;
	const analytics: AnalyticsRecorderType = {
		enabled: true,
		path: '/tmp/events.jsonl',
		record: vi.fn<AnalyticsRecorderType['record']>(),
		close: vi.fn<() => void>(),
	};
	const server = buildMcpServer({index, logger: silentLogger, analytics, maxResultBytes: 32_768});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

	await server.connect(serverTransport);

	const client = new Client({name: 'analytics-test', version: '0.1.0'});

	await client.connect(clientTransport);

	return {
		client,
		analytics,
		close: async (): Promise<void> => {
			await client.close();
			await server.close();
		},
	};
};

describe('MCP server analytics', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	it('records freshness only when the envelope exposes a supported shape', async () => {
		connection = await open();
		const {analytics, client} = connection;

		await client.callTool({name: 'index_status', arguments: {}});
		await client.callTool({name: 'outline', arguments: {path: 'src/index.ts', limit: 1}});
		await client.callTool({name: 'find_symbol', arguments: {query: 'formatUser', limit: 1}});
		await client.callTool({name: 'find_references', arguments: {symbolId: 'symbol-1', limit: 1}});
		await client.callTool({name: 'find_dependencies', arguments: {target: 'lodash'}});

		const freshness = vi.mocked(analytics.record).mock.calls.map(([, fields]) => (fields as {freshness?: unknown} | undefined)?.freshness);

		expect(freshness).toStrictEqual(['current', 'current', 'current', null, null]);
		expect(vi.mocked(analytics.record).mock.calls.map(([event]) => event)).toStrictEqual(Array.from({length: 5}, () => 'mcp_tool_call'));
	});

	it('keeps analytics optional', async () => {
		const index = {
			getStatus: () => ({
				ready: true,
				state: 'published',
				refresh: 'current',
				generationId: 'generation-1',
				building: false,
				scope: {projectName: 'root', projects: [], extractor: {id: 'typescript', version: '1', compilerVersion: '5.0.0'}},
				counts: {files: 0, symbols: 0, occurrences: 0, dependencyEdges: 0, dependencyBindings: 0, diagnostics: 0},
				freshness: {state: 'current', checkedAt: '2026-01-01T00:00:00.000Z', dirtyFileCount: null, staleFiles: 0, sourceChanged: false},
				lastError: null,
			}),
		} as unknown as CodeIndex;
		const server = buildMcpServer({index, logger: silentLogger, maxResultBytes: 1024});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		await server.connect(serverTransport);

		const client = new Client({name: 'analytics-test', version: '0.1.0'});

		await client.connect(clientTransport);

		const result = await client.callTool({name: 'index_status', arguments: {}});

		expect(result.isError).not.toBe(true);
		await client.close();
		await server.close();
	});
});
