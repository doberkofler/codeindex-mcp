import {type Client} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {createFakeIndex} from './helpers/fakeIndex.ts';
import {openServer, textOf, type ConnectionType, type EnvelopeType} from './helpers/mcpConnection.ts';

describe('MCP status detail', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (): Promise<Client> => {
		connection = await openServer({index: createFakeIndex(), maxResultBytes: 32_768});
		return connection.client;
	};

	it('reports the bounded status summary through the protocol', async () => {
		const client = await connect();
		const result = await client.callTool({name: 'index_status', arguments: {}});
		const text = textOf(result);
		const envelope = JSON.parse(text) as EnvelopeType & {
			data: {
				ready: boolean;
				counts: {files: number};
				freshness: {state: string};
				scope: {contexts: readonly string[]};
				lastError: string | null;
			};
		};

		expect(envelope.ok).toBe(true);
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(600);
		expect(envelope.data.ready).toBe(true);
		expect(envelope.data.counts.files).toBe(4);
		expect(envelope.data.freshness.state).toBe('current');
		expect(envelope.data.scope.contexts).toStrictEqual(['root']);
		expect(envelope.data.lastError).toBeNull();
		expect(envelope.data).not.toHaveProperty('hashes');
		expect(envelope.data).not.toHaveProperty('buildStats');
		expect(envelope.data).not.toHaveProperty('build');
		expect(envelope.data).not.toHaveProperty('lease');
		expect(envelope.data).not.toHaveProperty('exclusions');
		expect(envelope).not.toHaveProperty('guidance');
	});

	it('serves the complete status only when full detail is requested', async () => {
		const client = await connect();
		const result = await client.callTool({name: 'index_status', arguments: {detail: 'full'}});
		const envelope = JSON.parse(textOf(result)) as EnvelopeType & {
			data: {ready: boolean; hashes: unknown; buildStats: unknown; build: unknown; lease: unknown; exclusions: unknown};
		};

		expect(envelope.ok).toBe(true);
		expect(envelope.data.ready).toBe(true);
		expect(envelope.data.hashes).toBeDefined();
		expect(envelope.data.buildStats).toBeDefined();
		expect(envelope.data.build).toBeDefined();
		expect(envelope.data.lease).toBeDefined();
		expect(envelope.data.exclusions).toBeDefined();
	});
});
