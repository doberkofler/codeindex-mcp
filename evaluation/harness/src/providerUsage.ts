/** Closed request kinds one user-visible task can cause. */
export const PROVIDER_REQUEST_KINDS = ['agent', 'title', 'compaction', 'other'] as const;

export type ProviderRequestKindType = (typeof PROVIDER_REQUEST_KINDS)[number];

/** Token components that must be provider-reported for an economic claim. */
export const REQUIRED_USAGE_FIELDS = ['nonCachedInputTokens', 'cacheReadTokens', 'visibleOutputTokens'] as const;

export type RequiredUsageFieldType = (typeof REQUIRED_USAGE_FIELDS)[number];

/** Every token component retained for one provider request. */
export type ProviderUsageFieldType = RequiredUsageFieldType | 'cacheWriteTokens' | 'reasoningTokens';

/**
 * Provider-reported token accounting for one request.
 *
 * The components are deliberately non-overlapping. A null component means the
 * provider did not report it; it is never replaced with zero, a byte estimate,
 * or a value from a neighbouring request.
 */
export type ProviderTokenUsageType = Readonly<{
	nonCachedInputTokens: number | null;
	cacheReadTokens: number | null;
	/** Cache-write tiers exactly as the provider named them. */
	cacheWriteTokens: Readonly<Record<string, number>> | null;
	visibleOutputTokens: number | null;
	reasoningTokens: number | null;
	/** Provider-reported total request cost, when the provider supplied one. */
	reportedCostUsd: number | null;
	/** Fields the provider did not report. */
	missingFields: readonly ProviderUsageFieldType[];
	/** Fields the provider reported with a value this harness cannot accept. */
	invalidFields: readonly ProviderUsageFieldType[];
	/** True when every required component was reported and accepted. */
	complete: boolean;
}>;

/** Aggregated provider-reported token components for a request set. */
export type ProviderUsageTotalsType = Readonly<{
	state: 'exact' | 'unavailable' | 'not-applicable';
	nonCachedInputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: Readonly<Record<string, number>> | null;
	visibleOutputTokens: number | null;
	reasoningTokens: number | null;
	/** Non-overlapping sum of every component, including reasoning when known. */
	totalTokens: number | null;
	reportedCostUsd: number | null;
}>;

type NumberFieldType = Readonly<{value: number | null; reported: boolean; valid: boolean}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isTokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isCostAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const numberFieldOf = (record: Readonly<Record<string, unknown>>, names: readonly string[]): NumberFieldType => {
	for (const name of names) {
		if (!Object.hasOwn(record, name)) {
			continue;
		}

		const value = record[name];

		return {value: isTokenCount(value) ? value : null, reported: true, valid: isTokenCount(value)};
	}

	return {value: null, reported: false, valid: true};
};

const costFieldOf = (record: Readonly<Record<string, unknown>>, names: readonly string[]): NumberFieldType => {
	for (const name of names) {
		if (!Object.hasOwn(record, name)) {
			continue;
		}

		const value = record[name];

		return {value: isCostAmount(value) ? value : null, reported: true, valid: isCostAmount(value)};
	}

	return {value: null, reported: false, valid: true};
};

const cacheTierNameOf = (name: string): string | null => (/^[\w.-]{1,64}$/u.test(name) ? name : null);

type CacheWriteFieldType = Readonly<{value: Readonly<Record<string, number>> | null; reported: boolean; valid: boolean}>;

const cacheWriteFieldOf = (record: Readonly<Record<string, unknown>>): CacheWriteFieldType => {
	const tiers = record['cache_creation'];

	if (isRecord(tiers)) {
		const entries: [string, number][] = [];
		let valid = true;

		for (const [rawName, rawValue] of Object.entries(tiers)) {
			const name = cacheTierNameOf(rawName);

			if (name === null || !isTokenCount(rawValue)) {
				valid = false;
				continue;
			}

			entries.push([name, rawValue]);
		}

		return {value: Object.fromEntries(entries), reported: true, valid: valid && entries.length > 0};
	}

	const single = numberFieldOf(record, ['cache_creation_input_tokens', 'cache_write_tokens', 'cache_write_input_tokens']);

	if (!single.reported) {
		return {value: null, reported: false, valid: true};
	}

	return {value: single.valid && single.value !== null ? {default: single.value} : null, reported: true, valid: single.valid};
};

const writeTotalOf = (cacheWrite: CacheWriteFieldType): number => Object.values(cacheWrite.value ?? {}).reduce((total, value) => total + value, 0);

const hasAnthropicCacheOf = (record: Readonly<Record<string, unknown>>): boolean =>
	['cache_read_input_tokens', 'cache_read_tokens', 'cache_creation_input_tokens', 'cache_write_tokens'].some((name) => Object.hasOwn(record, name));

const inclusiveInputOf = (input: NumberFieldType, cacheRead: NumberFieldType, cacheWrite: CacheWriteFieldType): NumberFieldType => {
	if (!cacheRead.valid || !cacheWrite.valid || input.value === null) {
		return {value: null, reported: true, valid: false};
	}

	if (!cacheRead.reported) {
		return {value: null, reported: false, valid: true};
	}

	const nonCached = input.value - (cacheRead.value ?? 0) - writeTotalOf(cacheWrite);

	return nonCached < 0 ? {value: null, reported: true, valid: false} : {value: nonCached, reported: true, valid: true};
};

const promptInputOf = (prompt: NumberFieldType, cacheRead: NumberFieldType, cacheWrite: CacheWriteFieldType): NumberFieldType => {
	if (!cacheRead.reported && !cacheWrite.reported) {
		// The provider schema has no cache field at all. `prompt_tokens` is the
		// whole input; the cache components stay null because they were not
		// reported, which makes the economic claim unavailable.
		return prompt;
	}

	if (!cacheRead.valid || !cacheWrite.valid || prompt.value === null) {
		return {value: null, reported: true, valid: false};
	}

	if (!cacheRead.reported) {
		return {value: null, reported: false, valid: true};
	}

	// A provider schema without a cache-write field has no cache-write tokens,
	// so an unreported tier map contributes zero rather than an unknown amount.
	// `prompt_tokens` stays the inclusive input total and `cached_tokens` its
	// cached subset, which makes the remainder exact.

	const nonCached = prompt.value - (cacheRead.value ?? 0) - writeTotalOf(cacheWrite);

	return nonCached < 0 ? {value: null, reported: true, valid: false} : {value: nonCached, reported: true, valid: true};
};

const nonCachedInputOf = (record: Readonly<Record<string, unknown>>, cacheRead: NumberFieldType, cacheWrite: CacheWriteFieldType): NumberFieldType => {
	const explicit = numberFieldOf(record, ['non_cached_input_tokens', 'nonCachedInputTokens', 'prompt_cache_miss_tokens', 'cache_miss_tokens']);

	if (explicit.reported) {
		return explicit;
	}

	const input = numberFieldOf(record, ['input_tokens', 'inputTokens']);

	if (input.reported) {
		// Anthropic-compatible usage reports `input_tokens` outside cache reads and
		// cache creation, so it is already the non-cached component. The OpenAI
		// Responses shape instead reports `input_tokens` as the inclusive total,
		// with `input_tokens_details.cached_tokens` as a subset.
		return hasAnthropicCacheOf(record) || (!cacheRead.reported && !cacheWrite.reported) ? input : inclusiveInputOf(input, cacheRead, cacheWrite);
	}

	const prompt = numberFieldOf(record, ['prompt_tokens', 'promptTokens']);

	return prompt.reported ? promptInputOf(prompt, cacheRead, cacheWrite) : {value: null, reported: false, valid: true};
};

const usageFieldsOf = (
	record: Readonly<Record<string, unknown>>,
): Readonly<{
	nonCachedInput: NumberFieldType;
	cacheRead: NumberFieldType;
	cacheWrite: CacheWriteFieldType;
	visibleOutput: NumberFieldType;
	reasoning: NumberFieldType;
	reportedCost: NumberFieldType;
}> => {
	const cacheRead = numberFieldOf(record, ['cache_read_input_tokens', 'cache_read_tokens', 'prompt_cache_hit_tokens', 'cached_tokens']);
	const cacheWrite = cacheWriteFieldOf(record);
	const output = numberFieldOf(record, ['completion_tokens', 'output_tokens', 'total_output_tokens']);
	const reasoning = numberFieldOf(record, ['reasoning_tokens', 'reasoning_output_tokens', 'thoughts_tokens']);
	const explicitVisible = numberFieldOf(record, ['visible_output_tokens']);
	let visible = explicitVisible;

	if (!visible.reported && output.reported) {
		if (reasoning.reported && reasoning.valid && reasoning.value !== null && output.value !== null) {
			const remainder = output.value - reasoning.value;

			visible = {value: remainder < 0 ? null : remainder, reported: true, valid: remainder >= 0};
		} else {
			visible = output;
		}
	}

	return {
		nonCachedInput: nonCachedInputOf(record, cacheRead, cacheWrite),
		cacheRead,
		cacheWrite,
		visibleOutput: visible,
		reasoning,
		reportedCost: costFieldOf(record, ['cost_usd', 'total_cost_usd', 'cost']),
	};
};

const fieldStateOf = (field: NumberFieldType, required: boolean): Readonly<{value: number | null; missing: boolean; invalid: boolean}> => ({
	value: field.value,
	missing: required && !field.reported,
	invalid: field.reported && !field.valid,
});

const mergeUsageRecordsOf = (records: readonly Readonly<Record<string, unknown>>[]): Record<string, unknown> => {
	const merged: Record<string, unknown> = {};

	for (const record of records) {
		for (const [name, value] of Object.entries(record)) {
			merged[name] = value;
		}

		const details = record['completion_tokens_details'];
		const outputDetails = record['output_tokens_details'];
		const promptDetails = record['prompt_tokens_details'];
		const inputDetails = record['input_tokens_details'];

		if (isRecord(details) && isTokenCount(details['reasoning_tokens'])) {
			merged['reasoning_tokens'] = details['reasoning_tokens'];
		}

		if (isRecord(outputDetails) && isTokenCount(outputDetails['reasoning_tokens'])) {
			merged['reasoning_tokens'] = outputDetails['reasoning_tokens'];
		}

		if (isRecord(promptDetails) && isTokenCount(promptDetails['cached_tokens'])) {
			merged['cached_tokens'] = promptDetails['cached_tokens'];
		}

		if (isRecord(inputDetails) && isTokenCount(inputDetails['cached_tokens'])) {
			merged['cached_tokens'] = inputDetails['cached_tokens'];
		}
	}

	return merged;
};

/**
 * Extracts every provider usage object from one JSON response or event chunk.
 *
 * OpenAI-compatible, Anthropic-compatible, and message-envelope shapes are
 * accepted. Nothing except the usage objects is retained.
 *
 * @param value - Parsed response body or one event-stream payload.
 * @returns Usage records in encounter order, without enclosing prompts or text.
 */
export const providerUsageRecordsOf = (value: unknown): readonly Readonly<Record<string, unknown>>[] => {
	if (!isRecord(value)) {
		return [];
	}

	const records: Readonly<Record<string, unknown>>[] = [];
	const {message, choices, response, result, data} = value;
	const top = value['usage'];

	if (isRecord(top)) {
		records.push(top);
	}

	if (isRecord(message) && isRecord(message['usage'])) {
		records.push(message['usage']);
	}

	if (isRecord(response) && isRecord(response['usage'])) {
		records.push(response['usage']);
	}

	if (isRecord(result) && isRecord(result['usage'])) {
		records.push(result['usage']);
	}

	if (isRecord(data) && isRecord(data['usage'])) {
		records.push(data['usage']);
	}

	if (Array.isArray(choices)) {
		for (const choice of choices) {
			if (isRecord(choice) && isRecord(choice['usage'])) {
				records.push(choice['usage']);
			}
		}
	}

	return records;
};

/**
 * Converts one or more provider usage records into non-overlapping components.
 *
 * Later records override earlier snapshots, so a streaming response can report
 * input and output usage in different chunks while the terminal snapshot wins
 * where both name the same component.
 *
 * @param records - Provider usage objects from one request.
 * @returns The retained token accounting.
 */
export const providerUsageFromRecordsOf = (records: readonly Readonly<Record<string, unknown>>[]): ProviderTokenUsageType => {
	const merged = mergeUsageRecordsOf(records);
	const fields = usageFieldsOf(merged);
	const nonCached = fieldStateOf(fields.nonCachedInput, true);
	const cacheRead = fieldStateOf(fields.cacheRead, true);
	// A provider that exposes no cache-write tier reports no cache-write field.
	// Absence is an empty tier map for that provider, never an inferred value.
	const cacheWrite = {
		value: fields.cacheWrite.value ?? {},
		missing: false,
		invalid: fields.cacheWrite.reported && !fields.cacheWrite.valid,
	};
	const visible = fieldStateOf(fields.visibleOutput, true);
	const reasoning = fieldStateOf(fields.reasoning, false);
	const states: readonly [ProviderUsageFieldType, Readonly<{value: number | Readonly<Record<string, number>> | null; missing: boolean; invalid: boolean}>][] = [
		['nonCachedInputTokens', nonCached],
		['cacheReadTokens', cacheRead],
		['cacheWriteTokens', cacheWrite],
		['visibleOutputTokens', visible],
		['reasoningTokens', reasoning],
	];
	const missingFields = states.filter(([, state]) => state.missing).map(([name]) => name);
	const invalidFields = states.filter(([, state]) => state.invalid).map(([name]) => name);
	const requiredComplete = states
		.filter(([name]) => name === 'nonCachedInputTokens' || name === 'cacheReadTokens' || name === 'visibleOutputTokens')
		.every(([, state]) => !state.missing && !state.invalid && state.value !== null);

	return {
		nonCachedInputTokens: nonCached.value,
		cacheReadTokens: cacheRead.value,
		cacheWriteTokens: cacheWrite.value,
		visibleOutputTokens: visible.value,
		reasoningTokens: reasoning.value,
		reportedCostUsd: fields.reportedCost.valid ? fields.reportedCost.value : null,
		missingFields,
		invalidFields,
		complete: requiredComplete && invalidFields.length === 0,
	};
};

/**
 * Extracts provider usage from one complete JSON response body.
 *
 * @param value - Parsed response body.
 * @returns Usage accounting, or null when the body carried no usage object.
 */
export const providerUsageOf = (value: unknown): ProviderTokenUsageType | null => {
	const records = providerUsageRecordsOf(value);

	return records.length === 0 ? null : providerUsageFromRecordsOf(records);
};

/**
 * Sums one cache-write tier map.
 *
 * @param tiers - Tier amounts, or null when the provider did not report them.
 * @returns Tier total, or null.
 */
export const cacheWriteTotalOf = (tiers: Readonly<Record<string, number>> | null): number | null =>
	tiers === null ? null : Object.values(tiers).reduce((total, value) => total + value, 0);

/**
 * Aggregates provider-reported components over one request set.
 *
 * An unavailable component makes the whole per-component aggregate null. The
 * arithmetic is never completed with a zero or with another request's value.
 *
 * @param usages - Usage records in request order.
 * @returns The aggregate and its exactness state.
 */
export const providerUsageTotalsOf = (usages: readonly ProviderTokenUsageType[]): ProviderUsageTotalsType => {
	if (usages.length === 0) {
		return {
			state: 'not-applicable',
			nonCachedInputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			visibleOutputTokens: null,
			reasoningTokens: null,
			totalTokens: null,
			reportedCostUsd: null,
		};
	}

	const complete = usages.every((usage) => usage.complete);
	const nonCached = usages.reduce((total, usage) => total + (usage.nonCachedInputTokens ?? 0), 0);
	const cacheRead = usages.reduce((total, usage) => total + (usage.cacheReadTokens ?? 0), 0);
	const visible = usages.reduce((total, usage) => total + (usage.visibleOutputTokens ?? 0), 0);
	const reasoning = usages.every((usage) => usage.reasoningTokens !== null) ? usages.reduce((total, usage) => total + (usage.reasoningTokens ?? 0), 0) : null;
	const writeTiers: Record<string, number> = {};
	let tiersKnown = true;

	for (const usage of usages) {
		if (usage.cacheWriteTokens === null) {
			tiersKnown = false;
			continue;
		}

		for (const [name, value] of Object.entries(usage.cacheWriteTokens)) {
			writeTiers[name] = (writeTiers[name] ?? 0) + value;
		}
	}

	const reportedCost = usages.every((usage) => usage.reportedCostUsd !== null)
		? usages.reduce((total, usage) => total + (usage.reportedCostUsd ?? 0), 0)
		: null;

	if (!complete) {
		return {
			state: 'unavailable',
			nonCachedInputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			visibleOutputTokens: null,
			reasoningTokens: reasoning,
			totalTokens: null,
			reportedCostUsd: reportedCost,
		};
	}

	const totalTokens = usages.reduce((total, usage) => {
		const write = cacheWriteTotalOf(usage.cacheWriteTokens) ?? 0;

		return total + (usage.nonCachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + write + (usage.visibleOutputTokens ?? 0) + (usage.reasoningTokens ?? 0);
	}, 0);

	return {
		state: 'exact',
		nonCachedInputTokens: nonCached,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: tiersKnown ? writeTiers : null,
		visibleOutputTokens: visible,
		reasoningTokens: reasoning,
		totalTokens,
		reportedCostUsd: reportedCost,
	};
};
