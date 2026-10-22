import {type RouteMcpToolType} from './routePlan.ts';

/** Generic interface-contract probes executed against one artifact. */
export type ContractPlanType = Readonly<{
	pagination: Readonly<{
		tool: RouteMcpToolType;
		arguments: Readonly<Record<string, unknown>>;
		/** Hard bound that prevents a broken cursor from looping forever. */
		maxPages: number;
	}>;
	truncation: Readonly<{
		/** Artifact response budget used for this probe only. */
		maxResultBytes: number;
		tool: RouteMcpToolType;
		arguments: Readonly<Record<string, unknown>>;
	}>;
	staleFile: Readonly<{
		/** Exact symbol query that resolves one indexed declaration. */
		query: string;
		/** Expected definition path of that symbol. */
		path: string;
	}>;
	failure: Readonly<{
		tool: RouteMcpToolType;
		arguments: Readonly<Record<string, unknown>>;
		expectedErrorCode: string;
	}>;
}>;

/** A model-free route plan pinned to one suite version. */

export const CONTRACT_KEYS = new Set(['pagination', 'truncation', 'staleFile', 'failure']);
export const PAGINATION_KEYS = new Set(['tool', 'arguments', 'maxPages']);
export const TRUNCATION_KEYS = new Set(['maxResultBytes', 'tool', 'arguments']);
export const STALE_FILE_KEYS = new Set(['query', 'path']);
export const FAILURE_KEYS = new Set(['tool', 'arguments', 'expectedErrorCode']);
