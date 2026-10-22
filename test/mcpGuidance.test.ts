import {type Client} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {createFakeIndex} from './helpers/fakeIndex.ts';
import {openServer, textOf, type ConnectionType, type EnvelopeType} from './helpers/mcpConnection.ts';

const envelopeOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): EnvelopeType => JSON.parse(textOf(result)) as EnvelopeType;

describe('MCP result guidance', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (): Promise<Client> => {
		connection = await openServer({index: createFakeIndex(), maxResultBytes: 32_768});
		return connection.client;
	};

	it('marks a current untruncated result as authoritative and tells the agent to stop', async () => {
		const client = await connect();
		const envelope = envelopeOf(await client.callTool({name: 'find_symbol', arguments: {query: 'fake', limit: 50}})) as EnvelopeType & {
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
		const envelope = envelopeOf(await client.callTool({name: 'find_symbol', arguments: {query: 'fake', limit: 1}})) as EnvelopeType & {
			data: {truncated: boolean};
			guidance: {action: string; fallbackRequired: boolean};
		};

		expect(envelope.data.truncated).toBe(true);
		expect(envelope.guidance).toMatchObject({action: 'follow_cursor', fallbackRequired: false});
	});

	it('requires a repository text search only when the index has no stored match', async () => {
		const client = await connect();
		const envelope = envelopeOf(await client.callTool({name: 'find_references', arguments: {query: 'MissingThing'}})) as EnvelopeType & {
			data: {kind: string};
			guidance: {action: string; fallbackRequired: boolean; message: string};
		};

		expect(envelope.data.kind).toBe('none');
		expect(envelope.guidance).toMatchObject({action: 'text_search', fallbackRequired: true});
		expect(envelope.guidance.message).toContain('text search');
	});

	it('never attaches guidance to status results', async () => {
		const client = await connect();
		const envelope = envelopeOf(await client.callTool({name: 'index_status', arguments: {}}));

		expect(envelope).not.toHaveProperty('guidance');
	});
});
