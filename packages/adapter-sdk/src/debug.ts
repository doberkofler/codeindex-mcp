import debugFactory, {type Debugger} from 'debug';

/**
 * Creates one namespaced trace channel under `codeindex:*`.
 *
 * The `debug` package writes to stderr, so tracing never corrupts MCP stdout.
 *
 * @param scope - Short channel name, for example `scan` or `database`.
 * @returns A debug logger for `codeindex:<scope>`.
 */
export const debugFor = (scope: string): Debugger => debugFactory(`codeindex:${scope}`);

/** Enables every code index trace channel. */
export const enableDebug = (): void => {
	debugFactory.enable('codeindex:*');
};
