import {type Client} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {openFixture, textOf, type ConnectionType, type EnvelopeType} from './helpers/mcpClient.ts';

const envelopeOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): EnvelopeType => JSON.parse(textOf(result)) as EnvelopeType;

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

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
});
