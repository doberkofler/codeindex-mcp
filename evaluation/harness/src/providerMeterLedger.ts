import {type ProviderRequestKindType, providerUsageTotalsOf, type ProviderTokenUsageType, type ProviderUsageTotalsType} from './providerUsage.ts';

/** Closed failure causes that can settle a started provider request. */
export const PROVIDER_FAILURE_CAUSES = [
	'request-too-large',
	'upstream-unreachable',
	'upstream-http-error',
	'response-too-large',
	'response-truncated',
	'usage-missing',
	'usage-unparseable',
	'client-aborted',
	'proxy-error',
] as const;

export type ProviderFailureCauseType = (typeof PROVIDER_FAILURE_CAUSES)[number];

/** Exactly one terminal settlement for a started request. */
export type ProviderRequestSettlementType =
	| Readonly<{status: 'completed'; usage: ProviderTokenUsageType}>
	| Readonly<{status: 'failed'; cause: ProviderFailureCauseType; httpStatus: number | null}>;

/** Sanitized ledger entry for one provider request. */
export type ProviderRequestLedgerEntryType = Readonly<{
	/** One-based request ordinal within this metering session. */
	ordinal: number;
	kind: ProviderRequestKindType;
	provider: string;
	model: string | null;
	startedAt: string;
	completedAt: string | null;
	/** Offered tool names, in request order. Prompt content is never retained. */
	toolNames: readonly string[];
	requestBytes: number;
	responseBytes: number | null;
	/** Occurrences of a forbidden primary-checkout path in the request body. */
	pathDisclosureCount?: number;
	/** Null only while the request is in flight. */
	settlement: ProviderRequestSettlementType | null;
}>;

/** Sanitized provider-request ledger for one user-visible task. */
export type ProviderMeterLedgerType = Readonly<{
	recordType: 'provider-meter';
	provider: string;
	requests: readonly ProviderRequestLedgerEntryType[];
}>;

/** Reconciliation of started requests with their terminal settlements. */
export type ProviderMeterReconciliationType = Readonly<{
	recordType: 'provider-meter-reconciliation';
	requestCount: number;
	settledCount: number;
	pendingCount: number;
	completedCount: number;
	failedCount: number;
	/** True when ordinals are exactly 1..requestCount without a gap or duplicate. */
	ordinalsContiguous: boolean;
	/** True only when every started request settled exactly once. */
	settledExactlyOnce: boolean;
	failureCauses: readonly Readonly<{ordinal: number; cause: ProviderFailureCauseType}>[];
	/** Total occurrences of a forbidden path in any request body. */
	pathDisclosureCount: number;
	/** True only when no provider request disclosed a forbidden path. */
	pathClean: boolean;
	/** Aggregate over every request caused by the task, including title and compaction. */
	total: ProviderUsageTotalsType;
	/** Agent-only aggregate, retained as sensitivity evidence rather than the primary claim. */
	agentOnly: ProviderUsageTotalsType;
	/** Whether the retained vector can support an economic claim. */
	economicClaim: Readonly<{state: 'exact' | 'invalid' | 'not-applicable'; reason: string | null}>;
	retention: Readonly<{
		containsPrompts: false;
		containsSourceText: false;
		containsCredentials: false;
		containsProviderEnvelopes: false;
	}>;
}>;

/** Input for one loopback provider meter. */
export type ProviderMeterInputType = Readonly<{
	/** Origin that receives the forwarded request, for example `https://api.deepseek.com`. */
	upstreamBaseUrl: string;
	/** Actual provider identity recorded in the ledger. */
	provider: string;
	/** Headers added to the upstream request, such as authorization. Never retained. */
	upstreamHeaders?: Readonly<Record<string, string>>;
	/** Absolute paths that must never occur in a provider request body. */
	forbiddenPaths?: readonly string[];
	/** Request body bound; an oversized request settles with a closed failure cause. */
	maxRequestBytes?: number;
	/** JSON response bound; event-stream lines are bounded independently. */
	maxResponseBytes?: number;
	/** Clock override for deterministic tests. */
	now?: () => Date;
}>;

/** Running loopback provider meter. */
export type ProviderMeterType = Readonly<{
	provider: string;
	baseUrl: string;
	port: number;
	/** Current sanitized ledger, including in-flight requests. */
	ledger: () => ProviderMeterLedgerType;
	reconciliation: () => ProviderMeterReconciliationType;
	close: () => Promise<void>;
}>;

/** Retention guarantees attached to every ledger and reconciliation. */
const RETENTION = {
	containsPrompts: false,
	containsSourceText: false,
	containsCredentials: false,
	containsProviderEnvelopes: false,
} as const;

const unsettledTotalsOf = (): ProviderUsageTotalsType => ({
	state: 'unavailable',
	nonCachedInputTokens: null,
	cacheReadTokens: null,
	cacheWriteTokens: null,
	visibleOutputTokens: null,
	reasoningTokens: null,
	totalTokens: null,
	reportedCostUsd: null,
});

const totalsOfRequests = (requests: readonly ProviderRequestLedgerEntryType[]): ProviderUsageTotalsType => {
	const settled = requests.every((request) => request.settlement?.status === 'completed');
	const usages = requests.flatMap((request) => (request.settlement?.status === 'completed' ? [request.settlement.usage] : []));

	return settled ? providerUsageTotalsOf(usages) : unsettledTotalsOf();
};

/**
 * Reconciles every started request with exactly one settlement.
 *
 * The primary total includes every request the task caused. Agent-only usage is
 * reported separately as sensitivity evidence. Any pending or failed request
 * makes the affected economic claim invalid instead of silently smaller.
 *
 * @param ledger - Sanitized provider-request ledger.
 * @returns The reconciliation and both aggregates.
 */
export const reconcileProviderMeterLedger = (ledger: ProviderMeterLedgerType): ProviderMeterReconciliationType => {
	const pending = ledger.requests.filter((request) => request.settlement === null);
	const settled = ledger.requests.filter((request) => request.settlement !== null);
	const failures = ledger.requests.flatMap((request) =>
		request.settlement?.status === 'failed' ? [{ordinal: request.ordinal, cause: request.settlement.cause}] : [],
	);
	const ordinals = ledger.requests.map((request) => request.ordinal);
	const ordinalsContiguous = ordinals.every((ordinal, index) => ordinal === index + 1);
	const settledExactlyOnce = pending.length === 0 && ordinalsContiguous;
	const pathDisclosureCount = ledger.requests.reduce((total, request) => total + (request.pathDisclosureCount ?? 0), 0);
	const total = totalsOfRequests(ledger.requests);
	const agentOnly = totalsOfRequests(ledger.requests.filter((request) => request.kind === 'agent'));
	const reason =
		ledger.requests.length === 0
			? 'no provider requests'
			: pathDisclosureCount > 0
				? `${pathDisclosureCount} primary-checkout path disclosure(s) reached a provider request`
				: !settledExactlyOnce
					? `${pending.length} provider request(s) are not settled`
					: failures.length > 0
						? `${failures.length} provider request(s) failed`
						: total.state !== 'exact'
							? 'one or more provider requests lack required usage'
							: null;

	return {
		recordType: 'provider-meter-reconciliation',
		requestCount: ledger.requests.length,
		settledCount: settled.length,
		pendingCount: pending.length,
		completedCount: ledger.requests.filter((request) => request.settlement?.status === 'completed').length,
		failedCount: failures.length,
		ordinalsContiguous,
		settledExactlyOnce,
		failureCauses: failures,
		pathDisclosureCount,
		pathClean: pathDisclosureCount === 0,
		total,
		agentOnly,
		economicClaim: {
			state: ledger.requests.length === 0 ? 'not-applicable' : reason === null ? 'exact' : 'invalid',
			reason,
		},
		retention: RETENTION,
	};
};

/**
 * Returns the OpenCode provider configuration that routes one model through a meter.
 *
 * @param input - Meter base URL, provider name, and model ID.
 * @returns Configuration content for `OPENCODE_CONFIG_CONTENT`.
 */
export const providerMeterConfigOf = (input: Readonly<{baseUrl: string; provider: string; modelId: string}>): unknown => ({
	providers: {
		[input.provider]: {
			name: 'Metered Provider',
			package: 'aisdk:@ai-sdk/openai-compatible',
			settings: {baseURL: input.baseUrl},
			models: {[input.modelId]: {}},
		},
	},
});
