import {type Client} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {openFixture, textOf, type ConnectionType, type EnvelopeType} from './helpers/mcpClient.ts';

describe('MCP result guidance', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (): Promise<Client> => (connection = await openFixture('simple-project', 32_768)).client;

	it('marks a current untruncated result as authoritative and tells the agent to stop', async () => {
		const client = await connect();
		const result = await client.callTool({name: 'find_symbol', arguments: {query: 'formatUser', limit: 1}});
		const envelope = JSON.parse(textOf(result)) as EnvelopeType & {
			guidance: {action: string; fallbackRequired: boolean; message: string};
		};

		expect(envelope.guidance).toStrictEqual({
			action: 'stop',
			fallbackRequired: false,
			message: 'Complete result; no fallback search is required.',
		});
	});

	it('requires the next page before an answer when the result is truncated', async () => {
		const client = await connect();
		const result = await client.callTool({name: 'find_symbol', arguments: {query: 'User', limit: 1}});
		const envelope = JSON.parse(textOf(result)) as EnvelopeType & {
			data: {truncated: boolean};
			guidance: {action: string; fallbackRequired: boolean};
		};

		expect(envelope.data.truncated).toBe(true);
		expect(envelope.guidance).toMatchObject({action: 'follow_cursor', fallbackRequired: false});
	});

	it('requires a repository text search only when the index has no stored match', async () => {
		const client = await connect();
		const result = await client.callTool({name: 'find_references', arguments: {query: 'MissingThing'}});
		const envelope = JSON.parse(textOf(result)) as EnvelopeType & {
			data: {kind: string};
			guidance: {action: string; fallbackRequired: boolean; message: string};
		};

		expect(envelope.data.kind).toBe('none');
		expect(envelope.guidance).toMatchObject({action: 'text_search', fallbackRequired: true});
		expect(envelope.guidance.message).toContain('text search');
	});
});
