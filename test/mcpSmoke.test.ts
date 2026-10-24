import {type Client} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {createCodeIndex} from '../src/core/generation/codeIndex.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {createFixtureConfig, silentLogger} from './helpers/fixture.ts';
import {createGenerationFactSeed} from './helpers/generationFacts.ts';
import {openFixture, textOf, type ConnectionType, type EnvelopeType} from './helpers/mcpClient.ts';
import {openServer} from './helpers/mcpConnection.ts';

const envelopeOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): EnvelopeType => JSON.parse(textOf(result)) as EnvelopeType;

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

type PageEnvelopeType = EnvelopeType &
	Readonly<{
		data: Readonly<{
			items: readonly Readonly<{symbolId: string}>[];
			nextCursor: string | null;
			truncated: boolean;
		}>;
	}>;

const generation = {
	id: 'generation-medium',
	extractorId: 'typescript',
	extractorVersion: '0.1.0',
	compilerVersion: '6.0.3',
	sourceHash: 'medium-source',
	configHash: 'medium-config',
};

type MediumConnectionType = Readonly<{connection: ConnectionType; close: () => Promise<void>}>;

/**
 * Serves a deterministic 2,000-symbol database through the in-memory transport.
 *
 * @returns The connected client and teardown for the temporary database.
 */
const openMediumConnection = async (): Promise<MediumConnectionType> => {
	const maxResultBytes = 32_768;
	const fixture = createFixtureConfig('simple-project');
	const database = IndexDatabase.open(fixture.config.databasePath, {
		rootDir: fixture.config.rootDir,
		projectFilePath: fixture.config.projectFilePath,
		projectId: fixture.config.projectId,
		extractorId: fixture.config.extractorId,
	});

	try {
		database.createGeneration(generation);
		database.insertGenerationFacts({
			generationId: generation.id,
			...createGenerationFactSeed({symbolCount: 2000, path: 'src/medium.ts'}),
		});
		database.publish(generation.id);
		const index = createCodeIndex(fixture.config, database, silentLogger, {watch: false});
		const connection = await openServer({index, maxResultBytes});

		return {
			connection,
			close: async (): Promise<void> => {
				await connection.close();
				database.close();
				fixture.cleanup();
			},
		};
	} catch (error) {
		database.close();
		fixture.cleanup();
		throw error;
	}
};

describe('MCP vertical smoke', () => {
	let connection: ConnectionType | undefined;

	afterEach(async () => {
		await connection?.close();
		connection = undefined;
	});

	const connect = async (fixtureName: string, maxResultBytes: number): Promise<Client> => {
		connection = await openFixture(fixtureName, maxResultBytes);
		return connection.client;
	};

	it('serves all seven tools over one real TypeScript index', async () => {
		const maxResultBytes = 2000;
		const client = await connect('large-symbol', maxResultBytes);

		const status = await client.callTool({name: 'index_status', arguments: {}});
		const outline = await client.callTool({name: 'outline', arguments: {path: 'src/large.ts', limit: 10}});
		const symbols = await client.callTool({name: 'find_symbol', arguments: {query: 'largeValue', limit: 1}});
		const symbolsEnvelope = envelopeOf(symbols) as EnvelopeType & {data: {items: readonly {symbolId: string}[]}};
		const symbolId = symbolsEnvelope.data.items[0]?.symbolId ?? '';
		const [references, dependencies, source, position] = await Promise.all([
			client.callTool({name: 'find_references', arguments: {symbolId}}),
			client.callTool({name: 'find_dependencies', arguments: {target: 'lodash'}}),
			client.callTool({name: 'read_symbol', arguments: {symbolId, contextLines: 0}}),
			client.callTool({name: 'symbol_at', arguments: {path: 'src/large.ts', line: 1}}),
		]);
		const sourceText = textOf(source);
		const sourceEnvelope = JSON.parse(sourceText) as EnvelopeType & {data: {source: string; truncated: boolean; truncatedReason: string | null}};

		for (const result of [status, outline, symbols, references, dependencies, source, position]) {
			expect(result.isError).not.toBe(true);
		}

		expect(envelopeOf(status)).toMatchObject({ok: true, data: {ready: true, counts: {files: 1}}});
		expect(textOf(outline)).toContain('largeValue');
		expect(symbolsEnvelope).toMatchObject({ok: true, data: {freshness: {state: 'current'}}});
		expect(envelopeOf(references)).toMatchObject({ok: true, data: {selector: 'symbolId'}});
		expect(envelopeOf(dependencies)).toMatchObject({ok: true, data: {queryMeaning: 'direct_usage'}});
		expect(envelopeOf(position)).toMatchObject({ok: true, data: {path: 'src/large.ts', line: 1}});
		expect(sourceEnvelope.ok).toBe(true);
		expect(sourceEnvelope.data.source).toContain('largeValue');
		expect(sourceEnvelope.data.source).not.toContain('\uFFFD');
		expect(bytesOf(sourceText)).toBeLessThanOrEqual(maxResultBytes);
		expect(sourceEnvelope.data.truncated).toBe(true);
		expect(sourceEnvelope.data.truncatedReason).toBe('bytes');
	});

	it('serves deterministic medium find_symbol and outline pages with stable pagination and bounded work', async () => {
		const {connection: mediumConnection, close: closeMedium} = await openMediumConnection();
		connection = mediumConnection;

		try {
			const startedAt = performance.now();
			const firstSymbols = await connection.client.callTool({name: 'find_symbol', arguments: {query: 'example', limit: 50}});
			const firstOutline = await connection.client.callTool({name: 'outline', arguments: {path: 'src/medium.ts', limit: 50}});
			const elapsedMs = performance.now() - startedAt;
			const firstSymbolPage = envelopeOf(firstSymbols) as PageEnvelopeType;
			const firstOutlinePage = envelopeOf(firstOutline) as PageEnvelopeType;

			expect(firstSymbolPage.ok).toBe(true);
			expect(firstOutlinePage.ok).toBe(true);
			expect(firstSymbolPage.data.items.length).toBeGreaterThan(0);
			expect(firstOutlinePage.data.items.length).toBeGreaterThan(0);
			expect(firstSymbolPage.data.nextCursor).not.toBeNull();
			expect(firstOutlinePage.data.nextCursor).not.toBeNull();

			const secondSymbols = await connection.client.callTool({
				name: 'find_symbol',
				arguments: {query: 'example', limit: 50, cursor: firstSymbolPage.data.nextCursor},
			});
			const secondOutline = await connection.client.callTool({
				name: 'outline',
				arguments: {path: 'src/medium.ts', limit: 50, cursor: firstOutlinePage.data.nextCursor},
			});
			const secondSymbolPage = envelopeOf(secondSymbols) as PageEnvelopeType;
			const secondOutlinePage = envelopeOf(secondOutline) as PageEnvelopeType;
			const firstSymbolIds = new Set(firstSymbolPage.data.items.map((item) => item.symbolId));
			const firstOutlineIds = new Set(firstOutlinePage.data.items.map((item) => item.symbolId));

			expect(secondSymbolPage.data.items.filter((item) => firstSymbolIds.has(item.symbolId))).toStrictEqual([]);
			expect(secondOutlinePage.data.items.filter((item) => firstOutlineIds.has(item.symbolId))).toStrictEqual([]);
			expect(firstSymbolPage.data.items.length + secondSymbolPage.data.items.length).toBeLessThanOrEqual(100);
			expect(firstOutlinePage.data.items.length + secondOutlinePage.data.items.length).toBeLessThanOrEqual(100);
			expect({
				stage: 'mcp.medium.find_symbol_and_outline_elapsed',
				elapsedMs: Math.round(elapsedMs),
				boundMs: 5000,
				withinBound: elapsedMs <= 5000,
			}).toStrictEqual({
				stage: 'mcp.medium.find_symbol_and_outline_elapsed',
				elapsedMs: Math.round(elapsedMs),
				boundMs: 5000,
				withinBound: true,
			});
		} finally {
			await closeMedium();
			connection = undefined;
		}
	});
});
