import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {buildMcpServer} from '../../src/transports/mcp/buildMcpServer.ts';
import {createFixtureIndex, silentLogger, type FixtureProjectType} from './fixture.ts';

export type EnvelopeType = Readonly<{ok: boolean; data?: unknown; error?: Readonly<{code: string; message: string}>}>;

export type ConnectionType = Readonly<{client: Client; close: () => Promise<void>}>;

export const textOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): string => {
	const content = result.content.at(0);

	if (content?.type !== 'text' || content.text === undefined) {
		throw new Error('Expected text content');
	}

	return content.text;
};

/**
 * Serves one fixture through the in-memory MCP transport.
 *
 * @param fixtureName - Fixture directory name.
 * @param maxResultBytes - Configured response bound.
 * @param projects - Optional configured project contexts.
 * @param extractorId - Extractor identifier.
 * @returns A connected client and its teardown.
 */
export const openFixture = async (
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
