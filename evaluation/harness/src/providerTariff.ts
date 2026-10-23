import {type ProviderUsageTotalsType} from './providerUsage.ts';

/** One provider-reported cost vector and the arithmetic that produced it. */
export type StaticTariffType = Readonly<{
	id: string;
	currency: 'USD';
	perMillionTokens: Readonly<{
		nonCachedInput: number;
		cacheRead: number;
		cacheWrite: Readonly<Record<string, number>>;
		visibleOutput: number;
		reasoning: number;
	}>;
}>;

/** Static-tariff arithmetic, explicitly not an invoice-time cost. */
export type StaticTariffCostType = Readonly<{
	amount: number | null;
	currency: 'USD';
	basis: 'static-tariff-arithmetic';
	claim: 'sensitivity-not-invoice-time';
	invoiceTime: false;
	tariffId: string;
}>;

/**
 * Applies a static tariff to already-retained provider components.
 *
 * The result is labelled sensitivity arithmetic. It is never an invoice-time
 * cost and is never presented as one.
 *
 * @param totals - Exact provider components.
 * @param tariff - Versioned static tariff.
 * @returns Static-tariff arithmetic or an unavailable result.
 */
export const staticTariffCostOf = (totals: ProviderUsageTotalsType, tariff: StaticTariffType): StaticTariffCostType => {
	const base = {
		currency: tariff.currency,
		basis: 'static-tariff-arithmetic' as const,
		claim: 'sensitivity-not-invoice-time' as const,
		invoiceTime: false as const,
		tariffId: tariff.id,
	};

	if (
		totals.state !== 'exact' ||
		totals.nonCachedInputTokens === null ||
		totals.cacheReadTokens === null ||
		totals.cacheWriteTokens === null ||
		totals.visibleOutputTokens === null
	) {
		return {...base, amount: null};
	}

	let amount = (totals.nonCachedInputTokens * tariff.perMillionTokens.nonCachedInput) / 1_000_000;
	amount += (totals.cacheReadTokens * tariff.perMillionTokens.cacheRead) / 1_000_000;

	for (const [name, value] of Object.entries(totals.cacheWriteTokens)) {
		const rate = tariff.perMillionTokens.cacheWrite[name];

		if (rate === undefined) {
			return {...base, amount: null};
		}

		amount += (value * rate) / 1_000_000;
	}

	amount += (totals.visibleOutputTokens * tariff.perMillionTokens.visibleOutput) / 1_000_000;

	if (totals.reasoningTokens !== null) {
		amount += (totals.reasoningTokens * tariff.perMillionTokens.reasoning) / 1_000_000;
	}

	return {...base, amount};
};
