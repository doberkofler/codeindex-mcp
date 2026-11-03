import {afterEach, describe, expect, it} from 'vitest';
import {createMultiAdapterWorkspace, type MultiAdapterWorkspaceType} from './helpers/multiAdapterWorkspace.ts';
import {openServer, textOf, type ConnectionType, type EnvelopeType} from './helpers/mcpConnection.ts';

const envelopeOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): EnvelopeType => JSON.parse(textOf(result)) as EnvelopeType;

describe('MCP multi-adapter addressing', () => {
	let workspace: MultiAdapterWorkspaceType | undefined;
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
		workspace?.cleanup();
		workspace = undefined;
	});

	const connect = async (): Promise<ConnectionType> => {
		workspace = await createMultiAdapterWorkspace();
		connection = await openServer({index: workspace.index, maxResultBytes: 32_768});

		return connection;
	};

	it('filters find_symbol by adapter and returns the owning adapter on every item', async () => {
		const {client} = await connect();
		const result = await client.callTool({name: 'find_symbol', arguments: {query: 'f', adapter: 'oracle', limit: 50}});
		const envelope = envelopeOf(result) as EnvelopeType & {data: {items: readonly {adapter: string; path: string}[]}};

		expect(envelope.ok).toBe(true);
		expect(envelope.data.items.length).toBeGreaterThan(0);
		expect(envelope.data.items.every((item) => item.adapter === 'oracle')).toBe(true);
		expect(envelope.data.items.every((item) => item.path.startsWith('database/'))).toBe(true);
	});

	it('returns stable error codes for unknown adapters, ambiguous contexts, and path mismatches', async () => {
		const {client} = await connect();
		const unknown = envelopeOf(await client.callTool({name: 'find_symbol', arguments: {query: 'f', adapter: 'missing'}}));
		const ambiguous = envelopeOf(await client.callTool({name: 'find_symbol', arguments: {query: 'f', context: 'app'}}));
		const mismatch = envelopeOf(await client.callTool({name: 'outline', arguments: {path: 'database/hr_api.pks', adapter: 'typescript'}}));

		expect(unknown).toMatchObject({ok: false, error: {code: 'unknown_adapter'}});
		expect(ambiguous).toMatchObject({ok: false, error: {code: 'ambiguous_context'}});
		expect(mismatch).toMatchObject({ok: false, error: {code: 'adapter_path_mismatch'}});
	});

	it('reports every configured adapter in the bounded status summary', async () => {
		const {client} = await connect();
		const envelope = envelopeOf(await client.callTool({name: 'index_status', arguments: {}})) as EnvelopeType & {
			data: {scope: {adapters?: readonly {id: string; coverage: string}[]; extractor?: unknown}};
		};

		expect(envelope.ok).toBe(true);
		expect(envelope.data.scope.adapters?.map((adapter) => `${adapter.id}:${adapter.coverage}`)).toStrictEqual(['typescript:present', 'oracle:present']);
		expect(envelope.data.scope.extractor).toBeUndefined();
	});
});
