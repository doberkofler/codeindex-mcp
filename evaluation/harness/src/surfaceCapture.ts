import {hashOf} from './hash.ts';
import {callableToolsOf} from './surface.ts';
import {type RoutingType, type ToolSurfaceType, type TreatmentDefinitionType} from './treatment.ts';

/**
 * Captures the exact tool-name list presented to the model.
 *
 * Native MCP catalog names are prefixed with the configured server name, which
 * is the name OpenCode presents and the model must call. With Code Mode
 * enabled the same catalog is reached through the generic `execute` tool, so
 * its names are permitted and recorded but never presented top-level.
 *
 * @param treatment - Treatment definition.
 * @param catalog - CodeIndex tool names reported by the artifact's MCP catalog.
 * @returns The sorted surface and its digest.
 */
export const toolSurfaceOf = (treatment: TreatmentDefinitionType, catalog: readonly string[] = []): ToolSurfaceType => {
	const codeIndex =
		treatment.kind === 'codeindex' && treatment.mcp !== null ? [...new Set(catalog.map((name) => `${treatment.mcp?.server}_${name}`))].sort() : [];
	const ordinary = [...treatment.ordinaryTools];
	const execute = treatment.codeMode;
	const tools = [...new Set([...ordinary, ...(execute === 'present' ? ['execute'] : codeIndex)])].sort();
	const permitted = [...new Set([...ordinary, ...codeIndex, ...(execute === 'present' ? ['execute'] : [])])].sort();
	const callable = [...new Set([...callableToolsOf(ordinary), ...codeIndex, ...(execute === 'present' ? ['execute'] : [])])].sort();
	const native = treatment.kind === 'no-index' || codeIndex.every((name) => name.startsWith(`${treatment.mcp?.server}_`));

	return {
		treatmentId: treatment.id,
		ordinary,
		codeIndex,
		execute,
		tools,
		permitted,
		callable,
		native,
		digest: hashOf({id: treatment.id, ordinary, codeIndex, execute}),
	};
};

/**
 * Derives observed routing and every unknown-tool outcome.
 *
 * @param surface - Tool surface captured before execution.
 * @param calls - Normalized tool names observed in the event stream.
 * @returns Counts and the sorted list of names outside the captured surface.
 */
export const routingOf = (surface: ToolSurfaceType, calls: readonly string[]): RoutingType => {
	const ordinary = new Set(callableToolsOf(surface.ordinary));
	const codeIndex = new Set(surface.codeIndex);
	const known = new Set([...(surface.permitted ?? surface.tools), ...surface.callable, ...surface.ordinary]);
	const unknown = [...new Set(calls.filter((name) => !known.has(name)))].sort();

	return {
		ordinaryCalls: calls.filter((name) => ordinary.has(name)).length,
		codeIndexCalls: calls.filter((name) => codeIndex.has(name)).length,
		executeCalls: calls.filter((name) => name === 'execute').length,
		unknownTools: unknown,
		native: calls.every((name) => name !== 'execute'),
	};
};
