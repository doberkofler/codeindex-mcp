import {type TariffBandType, type TariffSnapshotType} from './economicContract.ts';
import {hashOf} from './hash.ts';
import {type ProviderMeterLedgerType, type ProviderRequestLedgerEntryType} from './providerMeterLedger.ts';
import {type ProviderRequestKindType, type ProviderTokenUsageType} from './providerUsage.ts';

/** One non-overlapping provider component vector retained for a request. */
export type CostComponentsType = Readonly<{
	nonCachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: Readonly<Record<string, number>>;
	visibleOutputTokens: number;
	reasoningTokens: number;
}>;

/** Cost and retained components for one provider request. */
export type RequestCostVectorType = Readonly<{
	ordinal: number;
	kind: ProviderRequestKindType;
	provider: string;
	model: string | null;
	completedAt: string | null;
	billingBand: 'peak' | 'offPeak';
	usage: ProviderTokenUsageType | null;
	components: CostComponentsType | null;
	costUsd: number | null;
	state: 'exact' | 'unavailable';
	reason: string | null;
}>;

/** Complete cost vector for one user-visible task. */
export type TaskCostVectorType = Readonly<{
	recordType: 'task-cost-vector';
	state: 'exact' | 'unavailable' | 'not-applicable';
	currency: 'USD';
	basis: 'official-provider-tariff-snapshot';
	claim: 'total-user-visible-task-cost-not-invoice';
	invoiceTime: false;
	totalUsd: number | null;
	/** Agent-only arithmetic retained as sensitivity evidence. */
	agentOnlyUsd: number | null;
	components: CostComponentsType | null;
	requests: readonly RequestCostVectorType[];
	requestCount: number;
	requestKinds: Readonly<Record<string, number>>;
	tariff: TariffSnapshotType;
	tariffSnapshotAt: string;
	reason: string | null;
}>;

/** Alternative-tariff arithmetic over the same retained task vector. */
export type TariffSensitivityType = Readonly<{
	amount: number | null;
	currency: 'USD';
	basis: 'static-tariff-arithmetic';
	claim: 'sensitivity-not-invoice-time';
	invoiceTime: false;
	tariffId: string;
	tariffSnapshotAt: string;
	/** Digest of the retained components and request timestamps only. */
	vectorDigest: string;
}>;

const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const billingBandOf = (at: string, tariff: TariffSnapshotType): 'peak' | 'offPeak' => {
	const timestamp = new Date(at);

	if (Number.isNaN(timestamp.getTime())) {
		throw new TypeError(`invalid request timestamp "${at}"`);
	}

	const date = timestamp.toISOString().slice(0, 10);

	if (tariff.holidayExclusions.includes(date) || !UTC_DATE.test(date)) {
		return 'offPeak';
	}

	const weekday = timestamp.getUTCDay();
	const isoWeekday = weekday === 0 ? 7 : weekday;
	const hour = timestamp.getUTCHours();
	const peak = tariff.peakWindows.some((window) => window.weekdays.includes(isoWeekday) && hour >= window.startUtcHour && hour < window.endUtcHour);

	return peak ? 'peak' : 'offPeak';
};

const completedUsageOf = (request: ProviderRequestLedgerEntryType): ProviderTokenUsageType | null =>
	request.settlement?.status === 'completed' ? request.settlement.usage : null;

const cacheWritesOf = (
	cacheWriteTokens: Readonly<Record<string, number>> | null,
	rates: TariffBandType,
): Readonly<{writes: Readonly<Record<string, number>> | null; reason: string | null}> => {
	if (cacheWriteTokens === null) {
		return Object.keys(rates.cacheWritePerMillionUsd).length > 0 ? {writes: null, reason: 'missing provider cache-write tiers'} : {writes: {}, reason: null};
	}

	for (const [name, value] of Object.entries(cacheWriteTokens)) {
		if (!Number.isInteger(value) || value < 0) {
			return {writes: null, reason: `invalid cache-write tier "${name}"`};
		}

		if (value > 0 && rates.cacheWritePerMillionUsd[name] === undefined) {
			return {writes: null, reason: `no tariff rate for cache-write tier "${name}"`};
		}
	}

	return {writes: cacheWriteTokens, reason: null};
};

const componentsOfRequest = (
	request: ProviderRequestLedgerEntryType,
	tariff: TariffSnapshotType,
	band: 'peak' | 'offPeak',
): Readonly<{components: CostComponentsType | null; reason: string | null}> => {
	const usage = completedUsageOf(request);

	if (usage === null) {
		return {components: null, reason: request.settlement === null ? 'request is not settled' : 'request failed'};
	}

	const {nonCachedInputTokens, cacheReadTokens, cacheWriteTokens, visibleOutputTokens, reasoningTokens} = usage;

	if (nonCachedInputTokens === null || cacheReadTokens === null || visibleOutputTokens === null) {
		return {components: null, reason: `missing provider components: ${usage.missingFields.join(', ') || 'required usage'}`};
	}

	const writes = cacheWritesOf(cacheWriteTokens, tariff.bands[band]);

	if (writes.writes === null) {
		return {components: null, reason: writes.reason};
	}

	return {
		components: {
			nonCachedInputTokens,
			cacheReadTokens,
			cacheWriteTokens: writes.writes,
			visibleOutputTokens,
			reasoningTokens: reasoningTokens ?? 0,
		},
		reason: null,
	};
};

const costOfComponentsAt = (components: CostComponentsType, band: 'peak' | 'offPeak', tariff: TariffSnapshotType): number | null => {
	const rates = tariff.bands[band];
	let amount = (components.nonCachedInputTokens * rates.cacheMissInputPerMillionUsd) / 1_000_000;
	amount += (components.cacheReadTokens * rates.cacheReadInputPerMillionUsd) / 1_000_000;
	amount += (components.visibleOutputTokens * rates.outputPerMillionUsd) / 1_000_000;
	amount += (components.reasoningTokens * rates.reasoningPerMillionUsd) / 1_000_000;

	for (const [name, value] of Object.entries(components.cacheWriteTokens)) {
		if (value === 0) {
			continue;
		}

		const rate = rates.cacheWritePerMillionUsd[name];

		if (rate === undefined) {
			return null;
		}

		amount += (value * rate) / 1_000_000;
	}

	return amount;
};

/**
 * Prices exactly one provider request from its retained components.
 *
 * @param request - One settled ledger request.
 * @param tariff - Frozen tariff snapshot.
 * @returns Request components, billing band, cost, and state.
 */
export const requestCostVectorOf = (request: ProviderRequestLedgerEntryType, tariff: TariffSnapshotType): RequestCostVectorType => {
	const at = request.completedAt ?? request.startedAt;
	const band = billingBandOf(at, tariff);
	const {components, reason} = componentsOfRequest(request, tariff, band);
	const usage = completedUsageOf(request);
	const costUsd = components === null ? null : costOfComponentsAt(components, band, tariff);
	const state = components !== null && costUsd !== null ? 'exact' : 'unavailable';

	return {
		ordinal: request.ordinal,
		kind: request.kind,
		provider: request.provider,
		model: request.model,
		completedAt: request.completedAt,
		billingBand: band,
		usage,
		components,
		costUsd,
		state,
		reason: state === 'exact' ? null : (reason ?? 'cost is unavailable from the retained components'),
	};
};

const emptyComponents = (): CostComponentsType => ({
	nonCachedInputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: {},
	visibleOutputTokens: 0,
	reasoningTokens: 0,
});

const sumComponents = (requests: readonly RequestCostVectorType[]): CostComponentsType =>
	requests.reduce((total, request) => {
		if (request.components === null) {
			return total;
		}

		const writes: Record<string, number> = {...total.cacheWriteTokens};

		for (const [name, value] of Object.entries(request.components.cacheWriteTokens)) {
			writes[name] = (writes[name] ?? 0) + value;
		}

		return {
			nonCachedInputTokens: total.nonCachedInputTokens + request.components.nonCachedInputTokens,
			cacheReadTokens: total.cacheReadTokens + request.components.cacheReadTokens,
			cacheWriteTokens: writes,
			visibleOutputTokens: total.visibleOutputTokens + request.components.visibleOutputTokens,
			reasoningTokens: total.reasoningTokens + request.components.reasoningTokens,
		};
	}, emptyComponents());

const requestKindsOf = (requests: readonly ProviderRequestLedgerEntryType[]): Readonly<Record<string, number>> => {
	const counts: Record<string, number> = {};

	for (const request of requests) {
		counts[request.kind] = (counts[request.kind] ?? 0) + 1;
	}

	return counts;
};

/**
 * Prices every provider request caused by one user-visible task.
 *
 * Title, compaction, and every other closed request kind are included. Any
 * unsettled, failed, or incompletely reported request makes the task total
 * unavailable instead of silently smaller.
 *
 * @param ledger - Sanitized provider-request ledger for one task.
 * @param tariff - Frozen tariff snapshot.
 * @returns The task vector and its exactness state.
 */
export const taskCostVectorOf = (ledger: ProviderMeterLedgerType, tariff: TariffSnapshotType): TaskCostVectorType => {
	const requests = ledger.requests.map((request) => requestCostVectorOf(request, tariff));
	const exact = requests.length > 0 && requests.every((request) => request.state === 'exact');
	const agents = requests.filter((request) => request.kind === 'agent' && request.state === 'exact');
	const reasons = [...new Set(requests.flatMap((request) => (request.reason === null ? [] : [request.reason])))];

	return {
		recordType: 'task-cost-vector',
		state: requests.length === 0 ? 'not-applicable' : exact ? 'exact' : 'unavailable',
		currency: tariff.currency,
		basis: 'official-provider-tariff-snapshot',
		claim: 'total-user-visible-task-cost-not-invoice',
		invoiceTime: false,
		totalUsd: exact ? requests.reduce((total, request) => total + (request.costUsd ?? 0), 0) : null,
		agentOnlyUsd:
			agents.length === 0
				? null
				: agents.length === requests.filter((request) => request.kind === 'agent').length
					? agents.reduce((total, request) => total + (request.costUsd ?? 0), 0)
					: null,
		components: exact ? sumComponents(requests) : null,
		requests,
		requestCount: requests.length,
		requestKinds: requestKindsOf(ledger.requests),
		tariff,
		tariffSnapshotAt: tariff.retrievedAt,
		reason: requests.length === 0 ? 'no provider requests' : exact ? null : reasons.join('; ') || 'cost is unavailable',
	};
};

const vectorDigestOf = (vector: TaskCostVectorType): string =>
	hashOf({
		requests: vector.requests.map((request) => ({ordinal: request.ordinal, completedAt: request.completedAt, components: request.components})),
	});

/**
 * Applies a different tariff to an already-retained vector.
 *
 * This is sensitivity arithmetic over the same request components. It is never
 * labelled invoice-time cost.
 *
 * @param vector - Exact task vector.
 * @param tariff - Alternative tariff snapshot.
 * @returns Sensitivity amount with its explicit claim boundary.
 */
export const tariffSensitivityOf = (vector: TaskCostVectorType, tariff: TariffSnapshotType): TariffSensitivityType => {
	const base = {
		currency: tariff.currency,
		basis: 'static-tariff-arithmetic' as const,
		claim: 'sensitivity-not-invoice-time' as const,
		invoiceTime: false as const,
		tariffId: tariff.id,
		tariffSnapshotAt: tariff.retrievedAt,
		vectorDigest: vectorDigestOf(vector),
	};

	if (vector.state !== 'exact') {
		return {...base, amount: null};
	}

	let amount = 0;

	for (const request of vector.requests) {
		if (request.completedAt === null || request.components === null) {
			return {...base, amount: null};
		}

		const requestCost = costOfComponentsAt(request.components, billingBandOf(request.completedAt, tariff), tariff);

		if (requestCost === null) {
			return {...base, amount: null};
		}

		amount += requestCost;
	}

	return {...base, amount};
};
