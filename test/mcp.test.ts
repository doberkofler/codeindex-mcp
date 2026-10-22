import {type Client} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeIndexError, IndexNotReadyError, StaleFileError, type ErrorCodeType} from '../src/core/errors/errors.ts';
import {createFakeIndex, FAKE_SOURCE, FAKE_SYMBOL_COUNT, type FakeIndexOptionsType} from './helpers/fakeIndex.ts';
import {openServer, textOf, type ConnectionType, type EnvelopeType} from './helpers/mcpConnection.ts';

const TOOL_NAMES = ['find_dependencies', 'find_references', 'find_symbol', 'index_status', 'outline', 'read_symbol', 'symbol_at'] as const;

type SchemaPropertyType = Readonly<Record<string, unknown>>;

type ToolSchemaType = Readonly<{
	name: string;
	description?: string | undefined;
	inputSchema: Readonly<{
		type?: string | undefined;
		properties?: Readonly<Record<string, SchemaPropertyType>> | undefined;
		required?: readonly string[] | undefined;
	}>;
	annotations?: Readonly<Record<string, unknown>> | undefined;
}>;

const asEnvelope = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): EnvelopeType => JSON.parse(textOf(result)) as EnvelopeType;

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const schemaOf = (tools: readonly ToolSchemaType[], name: string): ToolSchemaType => {
	const tool = tools.find((candidate) => candidate.name === name);

	if (tool === undefined) {
		throw new Error(`Missing tool ${name}`);
	}

	return tool;
};

const propertyOf = (tool: ToolSchemaType, name: string): SchemaPropertyType => {
	const property = tool.inputSchema.properties?.[name];

	if (property === undefined) {
		throw new Error(`Missing property ${name} on ${tool.name}`);
	}

	return property;
};

const failureOf = (code: ErrorCodeType): Error => {
	if (code === 'index_not_ready') {
		return new IndexNotReadyError();
	}

	if (code === 'stale_file') {
		return new StaleFileError('src/fake.ts');
	}

	return code === 'internal_error' ? new Error('secret stack trace') : new CodeIndexError(code, `Failure ${code}`);
};

describe('MCP tool surface', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (maxResultBytes = 32_768, options?: FakeIndexOptionsType): Promise<Client> => {
		connection = await openServer({index: createFakeIndex(options), maxResultBytes});
		return connection.client;
	};

	it('registers exactly seven read-only tools with exact input schemas', async () => {
		const client = await connect();
		const listed = await client.listTools();
		const tools = listed.tools as readonly ToolSchemaType[];

		expect(tools.map((tool) => tool.name).sort()).toStrictEqual([...TOOL_NAMES]);

		for (const tool of tools) {
			expect(tool.inputSchema.type).toBe('object');
			expect(tool.annotations).toMatchObject({readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
		}

		const findSymbol = schemaOf(tools, 'find_symbol');
		const findDependencies = schemaOf(tools, 'find_dependencies');
		const findReferences = schemaOf(tools, 'find_references');
		const readSymbol = schemaOf(tools, 'read_symbol');

		expect(findSymbol.inputSchema.required).toStrictEqual(['query']);
		expect(propertyOf(findSymbol, 'detail')).toMatchObject({enum: ['compact', 'full'], default: 'compact'});
		expect(propertyOf(findSymbol, 'limit')).toMatchObject({type: 'integer', minimum: 1, maximum: 100, default: 50});
		expect(propertyOf(findDependencies, 'target')).toMatchObject({type: 'string', minLength: 1});
		expect(propertyOf(findDependencies, 'transitive')).toMatchObject({type: 'boolean', default: false});
		expect(propertyOf(findDependencies, 'detail')).toMatchObject({enum: ['compact', 'evidence'], default: 'compact'});
		expect(propertyOf(findReferences, 'group')).toMatchObject({enum: ['file', 'owner', 'occurrence']});
		expect(propertyOf(readSymbol, 'mode')).toMatchObject({enum: ['text', 'sites', 'names', 'binding_sites', 'binding_contexts'], default: 'text'});
		expect(propertyOf(readSymbol, 'contextLines')).toMatchObject({type: 'integer', minimum: 0, maximum: 20, default: 2});
	});

	it('publishes instructions and one distinct description per tool', async () => {
		const client = await connect();
		const listed = await client.listTools();
		const tools = listed.tools as readonly ToolSchemaType[];
		const instructions = client.getInstructions();
		const descriptionOf = (name: string): string => {
			const {description} = schemaOf(tools, name);

			if (description === undefined) {
				throw new Error(`Missing description for ${name}`);
			}

			return description;
		};

		expect(instructions).toContain('call find_dependencies once with transitive false and compact detail');
		expect(instructions).toContain('A current, untruncated direct result is the complete answer');
		expect(instructions).toContain('When guidance.action is stop and guidance.fallbackRequired is false');
		expect(instructions).toContain('index_status defaults to a bounded summary');
		expect(descriptionOf('index_status')).toContain('bounded summary');
		expect(descriptionOf('outline')).toContain('in source order');
		expect(descriptionOf('find_symbol')).toContain('exact qualified name');
		expect(descriptionOf('find_references')).toContain('exactly one selector');
		expect(descriptionOf('find_dependencies')).toContain('canonical external dependency target');
		expect(descriptionOf('read_symbol')).toContain('refuses stale files');
		expect(descriptionOf('symbol_at')).toContain('innermost stored definition');
	});

	it('rejects invalid arguments before dispatching to the index', async () => {
		const client = await connect();
		const calls = [
			{name: 'outline', arguments: {}},
			{name: 'find_symbol', arguments: {query: 'fake', limit: 0}},
			{name: 'find_dependencies', arguments: {target: 'lodash', transitive: 'yes'}},
			{name: 'read_symbol', arguments: {symbolId: 'symbol-0', contextLines: 21}},
		] as const;
		const results = await Promise.all(calls.map(async (call) => ({call, result: await client.callTool({name: call.name, arguments: call.arguments})})));

		for (const {call, result} of results) {
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain(`Invalid arguments for tool ${call.name}`);
		}
	});
});

describe('MCP projections', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (): Promise<Client> => {
		connection = await openServer({index: createFakeIndex(), maxResultBytes: 32_768});
		return connection.client;
	};

	it('projects the bounded status summary and full status', async () => {
		const client = await connect();
		const summary = await client.callTool({name: 'index_status', arguments: {}});
		const summaryText = textOf(summary);
		const summaryEnvelope = JSON.parse(summaryText) as EnvelopeType & {
			data: {ready: boolean; counts: {files: number}; freshness: {state: string}; scope: {contexts: readonly string[]}; lastError: string | null};
		};
		const full = await client.callTool({name: 'index_status', arguments: {detail: 'full'}});
		const fullEnvelope = JSON.parse(textOf(full)) as EnvelopeType & {
			data: {ready: boolean; hashes: unknown; buildStats: unknown; build: unknown; lease: unknown; exclusions: unknown};
		};

		expect(summaryEnvelope.ok).toBe(true);
		expect(bytesOf(summaryText)).toBeLessThanOrEqual(600);
		expect(summaryEnvelope.data).toMatchObject({ready: true, counts: {files: 4}, freshness: {state: 'current'}, lastError: null});
		expect(summaryEnvelope.data.scope.contexts).toStrictEqual(['root']);
		expect(summaryEnvelope.data).not.toHaveProperty('hashes');
		expect(summaryEnvelope.data).not.toHaveProperty('buildStats');
		expect(summaryEnvelope).not.toHaveProperty('guidance');
		expect(fullEnvelope.ok).toBe(true);
		expect(fullEnvelope.data.ready).toBe(true);
		expect(fullEnvelope.data.hashes).toBeDefined();
		expect(fullEnvelope.data.buildStats).toBeDefined();
		expect(fullEnvelope.data.build).toBeDefined();
		expect(fullEnvelope.data.lease).toBeDefined();
		expect(fullEnvelope.data.exclusions).toBeDefined();
	});

	it('projects compact and full outline and symbol detail', async () => {
		const client = await connect();
		const compactOutline = asEnvelope(await client.callTool({name: 'outline', arguments: {path: 'src/fake.ts', limit: 1}})) as EnvelopeType & {
			data: {items: readonly Record<string, unknown>[]};
		};
		const fullOutline = asEnvelope(await client.callTool({name: 'outline', arguments: {path: 'src/fake.ts', detail: 'full', limit: 1}})) as EnvelopeType & {
			data: {items: readonly Record<string, unknown>[]};
		};
		const compactSymbol = asEnvelope(await client.callTool({name: 'find_symbol', arguments: {query: 'fake', limit: 1}})) as EnvelopeType & {
			data: {items: readonly Record<string, unknown>[]};
		};
		const fullSymbol = asEnvelope(await client.callTool({name: 'find_symbol', arguments: {query: 'fake', detail: 'full', limit: 1}})) as EnvelopeType & {
			data: {items: readonly Record<string, unknown>[]};
		};

		expect(compactOutline.data.items[0]).toMatchObject({symbolId: 'symbol-0', name: 'fakeSymbol0', kind: 'const', path: 'src/fake.ts'});
		expect(compactOutline.data.items[0]).not.toHaveProperty('site');
		expect(fullOutline.data.items[0]).toHaveProperty('site');
		expect(compactSymbol.data.items[0]).toMatchObject({symbolId: 'symbol-0', qualifiedName: 'fakeSymbol0'});
		expect(compactSymbol.data.items[0]).not.toHaveProperty('matched');
		expect(fullSymbol.data.items[0]).toHaveProperty('matched');
	});

	it('serves reference, dependency, source, and position envelopes', async () => {
		const client = await connect();
		const [references, dependencies, evidenceDependencies, source, position] = await Promise.all([
			client.callTool({name: 'find_references', arguments: {query: 'fakeSymbol0'}}),
			client.callTool({name: 'find_dependencies', arguments: {target: 'lodash'}}),
			client.callTool({name: 'find_dependencies', arguments: {target: 'lodash', detail: 'evidence'}}),
			client.callTool({name: 'read_symbol', arguments: {symbolId: 'symbol-0', contextLines: 0}}),
			client.callTool({name: 'symbol_at', arguments: {path: 'src/fake.ts', line: 1}}),
		]);
		const referencesEnvelope = asEnvelope(references) as EnvelopeType & {data: {kind: string; items: readonly {path: string}[]}};
		const dependenciesEnvelope = asEnvelope(dependencies) as EnvelopeType & {
			data: {queryMeaning: string; items: readonly Record<string, unknown>[]; summary: unknown};
		};
		const evidenceEnvelope = asEnvelope(evidenceDependencies) as EnvelopeType & {data: {items: readonly Record<string, unknown>[]}};
		const sourceEnvelope = asEnvelope(source) as EnvelopeType & {data: {source: string; truncated: boolean; truncatedReason: string | null}};
		const positionEnvelope = asEnvelope(position) as EnvelopeType & {data: {path: string; line: number; candidates: readonly {symbol: {name: string}}[]}};

		expect(referencesEnvelope.ok).toBe(true);
		expect(referencesEnvelope.data.kind).toBe('files');
		expect(referencesEnvelope.data.items.map((item) => item.path)).toStrictEqual(['src/consumer-a.ts', 'src/consumer-b.ts']);
		expect(dependenciesEnvelope.ok).toBe(true);
		expect(dependenciesEnvelope.data.queryMeaning).toBe('direct_usage');
		expect(dependenciesEnvelope.data.summary).toStrictEqual({
			totalConsumers: 2,
			directConsumers: 1,
			transitiveConsumers: 1,
			roots: [{path: 'src/root.ts', consumerCount: 2}],
		});
		expect(dependenciesEnvelope.data.items[0]).not.toHaveProperty('evidence');
		expect(evidenceEnvelope.data.items[0]).toHaveProperty('evidence');
		expect(sourceEnvelope.data).toMatchObject({source: FAKE_SOURCE, truncated: false, truncatedReason: null});
		expect(positionEnvelope.data).toMatchObject({path: 'src/fake.ts', line: 1});
		expect(positionEnvelope.data.candidates[0]?.symbol.name).toBe('fakeSymbol0');
	});
});

describe('MCP bounds and errors', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (maxResultBytes = 32_768, options?: FakeIndexOptionsType): Promise<Client> => {
		connection = await openServer({index: createFakeIndex(options), maxResultBytes});
		return connection.client;
	};

	it('shortens symbol pages by the configured byte bound and keeps cursor continuity', async () => {
		const maxResultBytes = 4096;
		const client = await connect(maxResultBytes);
		type SymbolItemType = Readonly<{symbolId: string}>;

		const collect = async (cursor?: string, collected: readonly SymbolItemType[] = []): Promise<readonly SymbolItemType[]> => {
			const result = await client.callTool({name: 'find_symbol', arguments: {query: 'fake', limit: 2, cursor}});
			const text = textOf(result);
			const envelope = JSON.parse(text) as EnvelopeType & {data: {items: readonly SymbolItemType[]; nextCursor: string | null; truncated: boolean}};

			expect(result.isError).not.toBe(true);
			expect(bytesOf(text)).toBeLessThanOrEqual(maxResultBytes);
			expect(envelope.ok).toBe(true);
			expect(envelope.data.items.length).toBeGreaterThan(0);
			expect(envelope.data.truncated).toBe(envelope.data.nextCursor !== null);
			const entries = [...collected, ...envelope.data.items];

			return envelope.data.nextCursor === null ? entries : collect(envelope.data.nextCursor, entries);
		};

		const entries = await collect();
		const ids = entries.map((item) => item.symbolId);

		expect(entries).toHaveLength(FAKE_SYMBOL_COUNT);
		expect(new Set(ids).size).toBe(FAKE_SYMBOL_COUNT);
		expect(ids[0]).toBe('symbol-0');
		expect(ids.at(-1)).toBe(`symbol-${FAKE_SYMBOL_COUNT - 1}`);
	});

	it('maps every stable failure code to a bounded error envelope', async () => {
		const codes = [
			'index_not_ready',
			'index_build_failed',
			'file_not_indexed',
			'symbol_not_found',
			'stale_file',
			'invalid_cursor',
			'invalid_argument',
			'internal_error',
		] as const;
		const outcomes = await Promise.all(
			codes.map(async (code) => {
				const probe = await openServer({index: createFakeIndex({failure: failureOf(code)}), maxResultBytes: 32_768});

				try {
					const result = await probe.client.callTool({name: 'find_symbol', arguments: {query: 'fake'}});
					return {code, isError: result.isError, envelope: asEnvelope(result)};
				} finally {
					await probe.close();
				}
			}),
		);

		for (const {code, isError, envelope} of outcomes) {
			expect(isError).toBe(true);
			expect(envelope.ok).toBe(false);
			expect(envelope.error?.code).toBe(code);
			expect(envelope.error?.message.length).toBeGreaterThan(0);
			expect(envelope.error?.message).not.toContain('stack trace');
		}

		expect(outcomes.at(-1)?.envelope.error?.message).toBe('Internal index failure');
	});

	it('bounds an oversized success result as response_too_large', async () => {
		const maxResultBytes = 512;
		const client = await connect(maxResultBytes);
		const result = await client.callTool({name: 'find_symbol', arguments: {query: 'fake', limit: 100}});
		const text = textOf(result);
		const envelope = JSON.parse(text) as EnvelopeType;

		expect(result.isError).toBe(true);
		expect(bytesOf(text)).toBeLessThanOrEqual(maxResultBytes);
		expect(envelope.ok).toBe(false);
		expect(envelope.error).toMatchObject({code: 'response_too_large'});
		expect(text).not.toContain('at ');
	});
});
