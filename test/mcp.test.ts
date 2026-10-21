import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {afterEach, describe, expect, it} from 'vitest';
import {buildMcpServer} from '../src/transports/mcp/buildMcpServer.ts';
import {createFixtureIndex, silentLogger, type FixtureProjectType} from './helpers/fixture.ts';

type EnvelopeType = Readonly<{ok: boolean; data?: unknown; error?: Readonly<{code: string; message: string}>}>;

type ConnectionType = Readonly<{client: Client; close: () => Promise<void>}>;

const textOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): string => {
	const content = result.content.at(0);

	if (content?.type !== 'text' || content.text === undefined) {
		throw new Error('Expected text content');
	}

	return content.text;
};

const openFixture = async (
	fixtureName: string,
	maxResultBytes: number,
	projects?: readonly FixtureProjectType[],
	extractorId = 'typescript',
): Promise<ConnectionType> => {
	const fixture = createFixtureIndex(fixtureName, projects, extractorId);
	const server = buildMcpServer({index: fixture.index, logger: silentLogger, maxResultBytes});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

	await server.connect(serverTransport);

	const client = new Client({name: 'code-index-test', version: '0.1.0'});

	await client.connect(clientTransport);

	return {
		client,
		close: async (): Promise<void> => {
			await client.close();
			await server.close();
			fixture.cleanup();
		},
	};
};

describe('MCP adapter', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (
		fixtureName = 'simple-project',
		maxResultBytes = 32_768,
		projects?: readonly FixtureProjectType[],
		extractorId = 'typescript',
	): Promise<Client> => (connection = await openFixture(fixtureName, maxResultBytes, projects, extractorId)).client;

	it('registers exactly seven read-only tools', async () => {
		const client = await connect();
		const tools = await client.listTools();

		expect(tools.tools.map((tool) => tool.name).sort()).toStrictEqual([
			'find_dependencies',
			'find_references',
			'find_symbol',
			'index_status',
			'outline',
			'read_symbol',
			'symbol_at',
		]);
	});

	it('stops agents after a complete direct package-usage result', async () => {
		const client = await connect();
		const tools = await client.listTools();
		const instructions = client.getInstructions();
		const description = tools.tools.find((tool) => tool.name === 'find_dependencies')?.description;

		expect(instructions).toContain('call find_dependencies once with transitive false and compact detail');
		expect(instructions).toContain('Direct usage covers external dependencies only');
		expect(instructions).toContain('A current, untruncated direct result is the complete answer');
		expect(instructions).toContain('Do not search manifests, grep source, read the listed files, or expand into downstream consumers');
		expect(instructions).toContain('Use detail evidence only when import statements, bindings, or locations are requested');
		expect(description).toContain('a current untruncated result is the complete answer');
	});

	it('serves find_symbol and read_symbol through the protocol', async () => {
		const client = await connect();
		const found = await client.callTool({name: 'find_symbol', arguments: {query: 'formatUser', limit: 1}});
		const envelope = JSON.parse(textOf(found)) as EnvelopeType & {
			data: {items: readonly {symbolId: string}[]; freshness: {state: string}};
		};

		expect(envelope.ok).toBe(true);
		expect(envelope.data.freshness.state).toBe('current');
		const symbolId = envelope.data.items[0]?.symbolId;
		expect(symbolId).toBeDefined();

		const read = await client.callTool({name: 'read_symbol', arguments: {symbolId, contextLines: 0}});
		const readEnvelope = JSON.parse(textOf(read)) as EnvelopeType & {data: {source: string}};

		expect(readEnvelope.ok).toBe(true);
		expect(readEnvelope.data.source).toContain('export const formatUser');
	});

	it('bounds read_symbol source inside the response envelope', async () => {
		const maxResultBytes = 2000;
		const client = await connect('large-symbol', maxResultBytes);
		const found = await client.callTool({name: 'find_symbol', arguments: {query: 'largeValue', limit: 1}});
		const foundEnvelope = JSON.parse(textOf(found)) as EnvelopeType & {data: {items: readonly {symbolId: string}[]}};
		const symbolId = foundEnvelope.data.items[0]?.symbolId;
		const read = await client.callTool({name: 'read_symbol', arguments: {symbolId, contextLines: 0}});
		const text = textOf(read);
		const envelope = JSON.parse(text) as EnvelopeType & {data: {source: string; truncated: boolean; truncatedReason: string | null}};

		expect(read.isError).not.toBe(true);
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(maxResultBytes);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.source.length).toBeGreaterThan(0);
		expect(envelope.data.source).not.toContain('\uFFFD');
		expect(envelope.data.truncated).toBe(true);
		expect(envelope.data.truncatedReason).toBe('bytes');
	});

	it('returns stable error envelopes without throwing', async () => {
		const client = await connect();
		const result = await client.callTool({name: 'read_symbol', arguments: {symbolId: 'missing', contextLines: 0}});
		const envelope = JSON.parse(textOf(result)) as EnvelopeType;

		expect(result.isError).toBe(true);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe('symbol_not_found');
	});

	it('filters symbols by project context through the protocol', async () => {
		const client = await connect('multi-project', 32_768, [
			{name: 'browser', project: 'tsconfig.json'},
			{name: 'contracts', project: 'contracts/tsconfig.json'},
			{name: 'server', project: 'server/tsconfig.json'},
		]);
		const result = await client.callTool({name: 'find_symbol', arguments: {query: 'ServiceRequest', context: 'server', detail: 'full', limit: 1}});
		const envelope = JSON.parse(textOf(result)) as EnvelopeType & {
			data: {items: readonly {name: string; contexts: readonly string[]}[]};
		};

		expect(envelope.ok).toBe(true);
		expect(envelope.data.items[0]).toMatchObject({name: 'ServiceRequest', contexts: ['browser', 'contracts', 'server']});
	});

	it('reports status through the protocol', async () => {
		const client = await connect();
		const result = await client.callTool({name: 'index_status', arguments: {}});
		const envelope = JSON.parse(textOf(result)) as EnvelopeType & {data: {ready: boolean; counts: {files: number}}};

		expect(envelope.ok).toBe(true);
		expect(envelope.data.ready).toBe(true);
		expect(envelope.data.counts.files).toBe(4);
	});
});

describe('MCP compact detail', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (): Promise<Client> => (connection = await openFixture('simple-project', 32_768)).client;

	it('serves compact items by default and full detail on request', async () => {
		const client = await connect();
		const compactOutline = JSON.parse(textOf(await client.callTool({name: 'outline', arguments: {path: 'src/models.ts', limit: 5}}))) as EnvelopeType & {
			data: {items: readonly Record<string, unknown>[]};
		};
		const fullOutline = JSON.parse(
			textOf(await client.callTool({name: 'outline', arguments: {path: 'src/models.ts', detail: 'full', limit: 5}})),
		) as EnvelopeType & {data: {items: readonly Record<string, unknown>[]}};
		const compactSymbol = JSON.parse(textOf(await client.callTool({name: 'find_symbol', arguments: {query: 'formatUser', limit: 1}}))) as EnvelopeType & {
			data: {items: readonly Record<string, unknown>[]};
		};
		const fullSymbol = JSON.parse(
			textOf(await client.callTool({name: 'find_symbol', arguments: {query: 'formatUser', detail: 'full', limit: 1}})),
		) as EnvelopeType & {data: {items: readonly Record<string, unknown>[]}};

		expect(compactOutline.data.items[0]).toHaveProperty('symbolId');
		expect(compactOutline.data.items[0]).not.toHaveProperty('qualifiedName');
		expect(compactOutline.data.items[0]).not.toHaveProperty('site');
		expect(fullOutline.data.items[0]).toHaveProperty('site');
		expect(compactSymbol.data.items[0]).toHaveProperty('qualifiedName');
		expect(compactSymbol.data.items[0]).not.toHaveProperty('matched');
		expect(fullSymbol.data.items[0]).toHaveProperty('matched');
	});
});

describe('MCP direct dependency usage', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (fixtureName: string): Promise<Client> => {
		connection = await openFixture(fixtureName, 32_768);
		return connection.client;
	};

	it('serves compact direct package usage by default', async () => {
		const client = await connect('dependency-graph');
		const result = await client.callTool({name: 'find_dependencies', arguments: {target: 'lodash'}});
		const text = textOf(result);
		const envelope = JSON.parse(text) as EnvelopeType & {
			data: {
				queryMeaning: string;
				items: readonly {path: string; depth: number; directRoot: string; evidence?: unknown}[];
				freshness: {state: string};
				summary: unknown;
			};
		};

		expect(envelope.ok).toBe(true);
		expect(new TextEncoder().encode(text).length).toBeLessThan(8192);
		expect(envelope.data.queryMeaning).toBe('direct_usage');
		expect(envelope.data.freshness.state).toBe('current');
		expect(envelope.data.summary).toStrictEqual({
			totalConsumers: 3,
			directConsumers: 3,
			transitiveConsumers: 0,
			roots: [],
		});
		expect(envelope.data.items).toStrictEqual([
			{path: 'src/adapters/escape.ts', depth: 1, directRoot: 'src/adapters/escape.ts'},
			{path: 'src/adapters/lodash_api.ts', depth: 1, directRoot: 'src/adapters/lodash_api.ts'},
			{path: 'src/cycle/a.ts', depth: 1, directRoot: 'src/cycle/a.ts'},
		]);
		expect(envelope.data.items[0]).not.toHaveProperty('evidence');
	});

	it('returns evidence only when explicitly requested', async () => {
		const client = await connect('dependency-graph');
		const result = await client.callTool({
			name: 'find_dependencies',
			arguments: {target: 'lodash', transitive: true, detail: 'evidence', limit: 100},
		});
		const envelope = JSON.parse(textOf(result)) as EnvelopeType & {
			data: {
				items: readonly {
					path: string;
					depth: number;
					directRoot: string;
					relationship: string;
					evidenceCount: number;
					evidence: {kind: string; rawTarget: string; bindings: readonly {localName: string | null}[]};
				}[];
			};
		};

		expect(envelope.ok).toBe(true);
		expect(envelope.data.items.find((item) => item.path === 'src/adapters/lodash_api.ts')).toMatchObject({
			directRoot: 'src/adapters/lodash_api.ts',
			relationship: 'direct',
			evidenceCount: 1,
			evidence: {kind: 'import', rawTarget: 'lodash'},
		});
		expect(envelope.data.items.find((item) => item.path === 'src/consumers/dynamic.ts')?.evidence.kind).toBe('dynamic-import');
		expect(envelope.data.items.find((item) => item.path === 'src/adapters/lodash_api.ts')?.evidence.bindings.map((binding) => binding.localName)).toContain(
			'externalDebounce',
		);
	});
});

describe('MCP dependency impact', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (fixtureName: string): Promise<Client> => {
		connection = await openFixture(fixtureName, 32_768);
		return connection.client;
	};

	it('serves grouped module impact with per-root counts', async () => {
		const client = await connect('dependency-impact');
		const result = await client.callTool({name: 'find_dependencies', arguments: {target: 'lodash', transitive: true, limit: 100}});
		const text = textOf(result);
		const envelope = JSON.parse(text) as EnvelopeType & {
			data: {
				queryMeaning: string;
				items: readonly {path: string; directRoot: string}[];
				summary: unknown;
			};
		};

		expect(envelope.ok).toBe(true);
		expect(new TextEncoder().encode(text).length).toBeLessThan(8192);
		expect(envelope.data.queryMeaning).toBe('dependency_impact');
		expect(envelope.data.summary).toStrictEqual({
			totalConsumers: 53,
			directConsumers: 2,
			transitiveConsumers: 51,
			roots: [
				{path: 'src/boundary/barrel.ts', consumerCount: 42},
				{path: 'src/boundary/narrow.ts', consumerCount: 42},
			],
		});
		expect(envelope.data.items).toHaveLength(84);
		expect(
			envelope.data.items
				.filter((item) => item.path === 'src/shared/shared.ts')
				.map((item) => item.directRoot)
				.sort(),
		).toStrictEqual(['src/boundary/barrel.ts', 'src/boundary/narrow.ts']);
	});

	it('keeps the default impact page within the compact byte target', async () => {
		const client = await connect('dependency-impact');
		const result = await client.callTool({name: 'find_dependencies', arguments: {target: 'lodash', transitive: true}});
		const text = textOf(result);
		const envelope = JSON.parse(text) as EnvelopeType & {data: {items: readonly unknown[]}};

		expect(envelope.ok).toBe(true);
		expect(new TextEncoder().encode(text).length).toBeLessThan(4096);
		expect(envelope.data.items).toHaveLength(25);
	});

	it('filters module impact to one direct root and rejects invalid roots', async () => {
		const client = await connect('dependency-impact');
		const filtered = await client.callTool({
			name: 'find_dependencies',
			arguments: {target: 'lodash', transitive: true, root: 'src/boundary/narrow.ts', limit: 100},
		});
		const envelope = JSON.parse(textOf(filtered)) as EnvelopeType & {
			data: {items: readonly {directRoot: string}[]; summary: unknown};
		};

		expect(envelope.ok).toBe(true);
		expect(envelope.data.items.every((item) => item.directRoot === 'src/boundary/narrow.ts')).toBe(true);
		expect(envelope.data.summary).toStrictEqual({
			totalConsumers: 42,
			directConsumers: 1,
			transitiveConsumers: 41,
			roots: [{path: 'src/boundary/narrow.ts', consumerCount: 42}],
		});

		const invalidResults = await Promise.all([
			client.callTool({name: 'find_dependencies', arguments: {target: 'lodash', transitive: true, root: 'src/shared/shared.ts'}}),
			client.callTool({name: 'find_dependencies', arguments: {target: 'lodash', transitive: false, root: 'src/boundary/narrow.ts'}}),
		]);

		for (const invalid of invalidResults) {
			const invalidEnvelope = JSON.parse(textOf(invalid)) as EnvelopeType;

			expect(invalid.isError).toBe(true);
			expect(invalidEnvelope.error?.code).toBe('invalid_argument');
		}
	});
});

describe('MCP paginated response bounds', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (
		fixtureName: string,
		maxResultBytes: number,
		projects?: readonly FixtureProjectType[],
		extractorId = 'typescript',
	): Promise<Client> => {
		connection = await openFixture(fixtureName, maxResultBytes, projects, extractorId);
		return connection.client;
	};

	it('shortens compact impact pages without losing or duplicating grouped entries', async () => {
		const maxResultBytes = 2000;
		const client = await connect('dependency-impact', maxResultBytes);

		type CompactItemType = Readonly<{path: string; depth: number; directRoot: string}>;

		const collectEntries = async (cursor?: string, collected: readonly CompactItemType[] = []): Promise<readonly CompactItemType[]> => {
			const result = await client.callTool({
				name: 'find_dependencies',
				arguments: {target: 'lodash', transitive: true, limit: 100, cursor},
			});
			const text = textOf(result);
			const envelope = JSON.parse(text) as EnvelopeType & {
				data: {items: readonly CompactItemType[]; nextCursor: string | null; summary: {totalConsumers: number}};
			};

			expect(result.isError).not.toBe(true);
			expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(maxResultBytes);
			expect(envelope.ok).toBe(true);
			expect(envelope.data.items.length).toBeGreaterThan(0);
			expect(envelope.data.summary.totalConsumers).toBe(53);
			const entries = [...collected, ...envelope.data.items];

			return envelope.data.nextCursor === null ? entries : collectEntries(envelope.data.nextCursor, entries);
		};

		const entries = await collectEntries();
		const keys = entries.map((item) => `${item.directRoot}\u0000${item.path}`);

		expect(entries).toHaveLength(84);
		expect(new Set(keys).size).toBe(84);
		expect(entries.filter((item) => item.directRoot === 'src/boundary/barrel.ts')).toHaveLength(42);
		expect(entries.filter((item) => item.directRoot === 'src/boundary/narrow.ts')).toHaveLength(42);
	});

	it('applies the byte bound to symbol pages', async () => {
		const maxResultBytes = 2048;
		const client = await connect('dependency-graph', maxResultBytes);
		const result = await client.callTool({name: 'find_symbol', arguments: {query: 'alpha', limit: 100}});
		const text = textOf(result);
		const envelope = JSON.parse(text) as EnvelopeType & {data: {items: readonly unknown[]; nextCursor: string | null}};

		expect(result.isError).not.toBe(true);
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(maxResultBytes);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.items.length).toBeGreaterThan(0);
		expect(envelope.data.nextCursor).not.toBeNull();
	});
});

describe('MCP Oracle adapter', () => {
	it('serves all seven tools for an Oracle manifest', async () => {
		const connection = await openFixture('oracle-project', 32_768, [{name: 'app', project: 'oracle-index.json'}], 'oracle');
		const {client} = connection;

		try {
			const status = await client.callTool({name: 'index_status', arguments: {}});
			const outline = await client.callTool({name: 'outline', arguments: {path: 'database/hr_api.pks', kinds: ['package'], detail: 'full', limit: 100}});
			const symbols = await client.callTool({
				name: 'find_symbol',
				arguments: {query: 'owner["APP"]::HR_API.DELETE_EMPLOYEE', match: 'qualified', detail: 'full'},
			});
			const symbolData = JSON.parse(textOf(symbols)) as EnvelopeType & {data: {items: readonly {symbolId: string; match: string}[]}};
			const exact = symbolData.data.items.find((item) => item.match === 'exact_qualified');
			const references = await client.callTool({name: 'find_references', arguments: {symbolId: exact?.symbolId ?? ''}});
			const dependencies = await client.callTool({name: 'find_dependencies', arguments: {target: 'APP.HR_API'}});
			const source = await client.callTool({name: 'read_symbol', arguments: {symbolId: exact?.symbolId ?? ''}});

			for (const result of [status, outline, symbols, references, dependencies, source]) {
				expect(result.isError).not.toBe(true);
			}

			expect(textOf(outline)).toContain(String.raw`owner[\"APP\"]::HR_API`);
			expect(textOf(references)).toContain('database/hr_api.pkb');
			expect(textOf(dependencies)).toContain('database/maintenance_run.prc');
		} finally {
			await connection.close();
		}
	});
});
