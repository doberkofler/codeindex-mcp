import {presentedToolsOf, surfaceDifferencesOf} from './surface.ts';
import {type ToolSurfaceType} from './treatment.ts';
import {type ProviderRequestKindType} from './providerUsage.ts';

/**
 * Closed causes that can reject an agent request-1 surface.
 *
 * A cause describes the request that was actually admitted. An eventual union
 * of later requests never turns a failure into a pass.
 */
export const SURFACE_FAILURE_CAUSES = [
	'mcp-not-ready',
	'probe-failed',
	'no-agent-request',
	'empty-agent-request',
	'duplicate-tools',
	'late-surface',
	'incomplete-surface',
	'unknown-tools',
	'codeindex-in-no-index',
	'path-disclosure',
] as const;

export type SurfaceFailureCauseType = (typeof SURFACE_FAILURE_CAUSES)[number];

/** One provider request reduced to the facts the surface proof needs. */
export type SurfaceRequestType = Readonly<{
	/** One-based provider-request ordinal. */
	ordinal: number;
	kind: ProviderRequestKindType;
	toolNames: readonly string[];
	/** Occurrences of a forbidden primary-checkout path in the request body. */
	pathDisclosureCount?: number;
}>;

/** The directly inspected agent request-1 surface verdict. */
export type SurfaceRequestLedgerType = Readonly<{
	recordType: 'surface-request-ledger';
	treatmentId: string;
	/** Exact declared names, sorted. */
	declared: readonly string[];
	/** Every provider request observed, in ordinal order. */
	requests: readonly SurfaceRequestType[];
	/** The first agent request, or null when none was admitted. */
	firstAgentRequest: SurfaceRequestType | null;
	agentRequests: number;
	titleRequests: number;
	result: 'pass' | 'fail';
	cause: SurfaceFailureCauseType | null;
	/** Human-readable differences for a failed verdict; empty on pass. */
	differences: readonly string[];
}>;

/**
 * Returns names that occur more than once, sorted.
 *
 * @param names - Offered names in request order.
 * @returns Sorted duplicate names.
 */
export const duplicateToolNamesOf = (names: readonly string[]): readonly string[] =>
	[...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort();

const laterAgentToolsOf = (requests: readonly SurfaceRequestType[], first: SurfaceRequestType): ReadonlySet<string> =>
	new Set(requests.filter((request) => request.kind === 'agent' && request.ordinal !== first.ordinal).flatMap((request) => request.toolNames));

const firstAgentRequestOf = (requests: readonly SurfaceRequestType[]): SurfaceRequestType | null =>
	requests.find((request) => request.kind === 'agent') ?? null;

const causeOfIncompleteOf = (
	input: Readonly<{
		surface: ToolSurfaceType;
		missing: readonly string[];
		later: ReadonlySet<string>;
		unexpected: readonly string[];
		duplicate: readonly string[];
	}>,
): SurfaceFailureCauseType => {
	if (input.duplicate.length > 0) {
		return 'duplicate-tools';
	}

	if (input.missing.some((name) => input.later.has(name))) {
		return 'late-surface';
	}

	if (input.surface.codeIndex.length === 0 && input.unexpected.some((name) => name.startsWith('codeindex_'))) {
		return 'codeindex-in-no-index';
	}

	if (input.unexpected.length > 0) {
		return 'unknown-tools';
	}

	return 'incomplete-surface';
};

/**
 * Builds the direct agent request-1 verdict without throwing.
 *
 * Only the first agent request participates in the pass condition. Title
 * requests are counted separately and never contribute tools. A name that
 * first appears on a later agent request produces `late-surface`.
 *
 * @param surface - Exact declared surface for the treatment.
 * @param requests - Every provider request in ordinal order.
 * @returns The verdict and the inspected request-1 facts.
 */
export const surfaceRequestLedgerOf = (surface: ToolSurfaceType, requests: readonly SurfaceRequestType[]): SurfaceRequestLedgerType => {
	const firstAgentRequest = firstAgentRequestOf(requests);
	const declared = presentedToolsOf(surface);
	const base = {
		recordType: 'surface-request-ledger' as const,
		treatmentId: surface.treatmentId,
		declared,
		requests,
		firstAgentRequest,
		agentRequests: requests.filter((request) => request.kind === 'agent').length,
		titleRequests: requests.filter((request) => request.kind === 'title').length,
	};
	const disclosed = requests.filter((request) => (request.pathDisclosureCount ?? 0) > 0);

	if (disclosed.length > 0) {
		return {
			...base,
			result: 'fail',
			cause: 'path-disclosure',
			differences: disclosed.map((request) => `provider request ${request.ordinal} (${request.kind}) discloses the primary checkout path`),
		};
	}

	if (firstAgentRequest === null) {
		return {
			...base,
			result: 'fail',
			cause: 'no-agent-request',
			differences: ['no agent request was admitted'],
		};
	}

	if (firstAgentRequest.toolNames.length === 0) {
		return {
			...base,
			result: 'fail',
			cause: 'empty-agent-request',
			differences: ['agent request 1 offered no tools'],
		};
	}

	const duplicate = duplicateToolNamesOf(firstAgentRequest.toolNames);
	const differences = surfaceDifferencesOf(surface, firstAgentRequest.toolNames);
	const expected = new Set(declared);
	const observed = new Set(firstAgentRequest.toolNames);
	const missing = [...expected].filter((name) => !observed.has(name)).sort();
	const unexpected = [...observed].filter((name) => !expected.has(name)).sort();

	if (duplicate.length > 0 || differences.length > 0) {
		const cause = causeOfIncompleteOf({
			surface,
			missing,
			later: laterAgentToolsOf(requests, firstAgentRequest),
			unexpected,
			duplicate,
		});

		return {
			...base,
			result: 'fail',
			cause,
			differences: [...duplicate.map((name) => `tool ${name} is offered more than once on agent request 1`), ...differences].sort(),
		};
	}

	return {...base, result: 'pass', cause: null, differences: []};
};

/** Error carrying the closed cause and the request-1 ledger. */
export class SurfaceReadinessError extends Error {
	public override readonly cause: SurfaceFailureCauseType;
	public readonly ledger: SurfaceRequestLedgerType;

	/**
	 * @param ledger - Failed request-1 verdict.
	 */
	public constructor(ledger: SurfaceRequestLedgerType) {
		const cause = ledger.cause ?? 'incomplete-surface';

		super(`agent request 1 does not present the declared ${ledger.treatmentId} surface (${cause}): ${ledger.differences.join('; ')}`);
		this.name = 'SurfaceReadinessError';
		this.cause = cause;
		this.ledger = ledger;
	}
}

/**
 * Requires agent request 1 to equal the declared surface exactly.
 *
 * @param surface - Exact declared surface for the treatment.
 * @param requests - Every provider request in ordinal order.
 * @returns The passing ledger.
 * @throws {@link SurfaceReadinessError} With a closed cause when request 1 differs.
 */
export const assertRequestOneSurface = (surface: ToolSurfaceType, requests: readonly SurfaceRequestType[]): SurfaceRequestLedgerType => {
	const ledger = surfaceRequestLedgerOf(surface, requests);

	if (ledger.result !== 'pass') {
		throw new SurfaceReadinessError(ledger);
	}

	return ledger;
};
