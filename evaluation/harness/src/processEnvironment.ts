/** Prefix reserved for CodeIndex runtime configuration. */
const CODE_INDEX_ENVIRONMENT_PREFIX = 'CODE_INDEX_';

/**
 * Builds an environment for an isolated evaluation child process.
 *
 * CodeIndex configuration inherited from the operator could redirect the MCP
 * artifact to another workspace or project. Evaluation children therefore
 * receive no ambient CodeIndex configuration; explicit overrides are added
 * only by the harness call site.
 *
 * @param overrides - Explicit environment entries owned by the child process.
 * @returns A copy of the process environment without ambient CodeIndex config.
 */
export const isolatedProcessEnvironmentOf = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
	const environment: NodeJS.ProcessEnv = {};

	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith(CODE_INDEX_ENVIRONMENT_PREFIX)) {
			environment[name] = value;
		}
	}

	return {...environment, ...overrides};
};
