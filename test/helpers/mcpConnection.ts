import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {type AnalyticsRecorderType} from '../../src/core/analytics/recorder.ts';
import {buildMcpServer, type McpIndexType} from '../../src/transports/mcp/buildMcpServer.ts';
import {silentLogger} from './silentLogger.ts';

export type EnvelopeType = Readonly<{ok: boolean; data?: unknown; error?: Readonly<{code: string; message: string}>}>;

export type ConnectionType = Readonly<{client: Client; close: () => Promise<void>}>;

export type OpenServerInputType = Readonly<{
	index: McpIndexType;
	maxResultBytes: number;
	analytics?: AnalyticsRecorderType;
}>;

/**
 * Extracts the first text block from one MCP tool result.
 *
 * @param result - Tool result returned by the official client.
 * @returns The text block content.
 * @throws {@link Error} When the first block is not text.
 */
export const textOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): string => {
	const content = result.content.at(0);

	if (content?.type !== 'text' || content.text === undefined) {
		throw new Error('Expected text content');
	}

	return content.text;
};

/**
 * Connects one index to the official client through the in-memory transport.
 *
 * @param input - Index facade, response bound, and optional analytics recorder.
 * @returns A connected client and its teardown.
 */
export const openServer = async (input: OpenServerInputType): Promise<ConnectionType> => {
	const {index, maxResultBytes, analytics} = input;
	const server =
		analytics === undefined
			? buildMcpServer({index, logger: silentLogger, maxResultBytes})
			: buildMcpServer({index, logger: silentLogger, analytics, maxResultBytes});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

	await server.connect(serverTransport);

	const client = new Client({name: 'code-index-test', version: '0.1.0'});

	await client.connect(clientTransport);

	return {
		client,
		close: async (): Promise<void> => {
			await client.close();
			await server.close();
		},
	};
};
