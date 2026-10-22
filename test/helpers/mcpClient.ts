import {createFixtureIndex, type FixtureProjectType} from './fixture.ts';
import {openServer, type ConnectionType} from './mcpConnection.ts';

export type {ConnectionType, EnvelopeType} from './mcpConnection.ts';
export {textOf} from './mcpConnection.ts';

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
	const connection = await openServer({index: fixture.index, maxResultBytes});

	return {
		client: connection.client,
		close: async (): Promise<void> => {
			await connection.close();
			fixture.cleanup();
		},
	};
};
