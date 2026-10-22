import {afterEach, describe, expect, it, vi} from 'vitest';
import {type AnalyticsRecorderType} from '../src/core/analytics/recorder.ts';
import {CodeIndexError} from '../src/core/errors/errors.ts';
import {createFakeIndex} from './helpers/fakeIndex.ts';
import {openServer, type ConnectionType} from './helpers/mcpConnection.ts';

type RecordedFieldsType = Readonly<Record<string, unknown>> | undefined;

const fieldOf = (fields: RecordedFieldsType, key: string): unknown => fields?.[key];

type AnalyticsConnectionType = Readonly<{client: ConnectionType['client']; analytics: AnalyticsRecorderType; close: () => Promise<void>}>;

const open = async (failure?: Error): Promise<AnalyticsConnectionType> => {
	const analytics: AnalyticsRecorderType = {
		enabled: true,
		path: '/tmp/events.jsonl',
		record: vi.fn<AnalyticsRecorderType['record']>(),
		close: vi.fn<() => void>(),
	};
	const {client, close} = await openServer({index: createFakeIndex(failure === undefined ? {} : {failure}), analytics, maxResultBytes: 32_768});

	return {client, analytics, close};
};

describe('MCP server analytics', () => {
	let connection: AnalyticsConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	it('records every tool completion with its freshness and truncation state', async () => {
		connection = await open();
		const {analytics, client} = connection;

		await client.callTool({name: 'index_status', arguments: {}});
		await client.callTool({name: 'outline', arguments: {path: 'src/fake.ts', limit: 1}});
		await client.callTool({name: 'find_symbol', arguments: {query: 'fake', limit: 1}});
		await client.callTool({name: 'find_references', arguments: {symbolId: 'symbol-0', limit: 2}});
		await client.callTool({name: 'find_dependencies', arguments: {target: 'lodash'}});

		const {calls} = vi.mocked(analytics.record).mock;

		expect(calls.map(([event]) => event)).toStrictEqual(Array.from({length: 5}, () => 'mcp_tool_call'));
		expect(calls.map(([, fields]) => fieldOf(fields, 'tool'))).toStrictEqual([
			'index_status',
			'outline',
			'find_symbol',
			'find_references',
			'find_dependencies',
		]);
		expect(calls.map(([, fields]) => fieldOf(fields, 'freshness'))).toStrictEqual(['current', 'current', 'current', 'current', 'current']);
		expect(calls.map(([, fields]) => fieldOf(fields, 'truncated'))).toStrictEqual([false, true, true, false, false]);
		expect(calls.every(([, fields]) => typeof fieldOf(fields, 'bytes') === 'number')).toBe(true);
	});

	it('records failed calls with the stable error code and no freshness', async () => {
		connection = await open(new CodeIndexError('symbol_not_found', 'Unknown symbol'));
		const {analytics, client} = connection;

		const result = await client.callTool({name: 'find_symbol', arguments: {query: 'fake'}});
		const call = vi.mocked(analytics.record).mock.calls.at(0);
		const fields = call?.[1];

		expect(result.isError).toBe(true);
		expect(fields).toMatchObject({tool: 'find_symbol', ok: false, errorCode: 'symbol_not_found', freshness: null});
	});

	it('keeps analytics optional', async () => {
		const {client, close} = await openServer({index: createFakeIndex(), maxResultBytes: 1024});

		try {
			const result = await client.callTool({name: 'index_status', arguments: {}});

			expect(result.isError).not.toBe(true);
		} finally {
			await close();
		}
	});
});
