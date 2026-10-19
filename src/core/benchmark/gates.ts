import {type BenchmarkGateCategoryType, type BenchmarkGateStatusType, type BenchmarkGateType, type BenchmarkGateUnitType} from './evaluationTypes.ts';

type GateValueType = number | string | boolean | null;

type GateDetailType = Readonly<{
	readonly message: string;
	readonly actual?: GateValueType;
	readonly expected?: GateValueType;
	readonly unit?: BenchmarkGateUnitType;
}>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

export const gate = (status: BenchmarkGateStatusType, code: string, category: BenchmarkGateCategoryType, detail: GateDetailType): BenchmarkGateType => ({
	status,
	code,
	category,
	message: detail.message,
	actual: detail.actual ?? null,
	expected: detail.expected ?? null,
	unit: detail.unit ?? null,
});

export const skipped = (code: string, message: string, category: BenchmarkGateCategoryType = 'compatibility'): BenchmarkGateType =>
	gate('skipped', code, category, {message});

export const absoluteGate = (
	input: Readonly<{
		code: string;
		message: string;
		current: number;
		warning: number;
		failure: number;
		unit: BenchmarkGateUnitType;
	}>,
): BenchmarkGateType => {
	const status = input.current > input.failure ? 'failure' : input.current > input.warning ? 'warning' : 'pass';

	return gate(status, input.code, 'absolute', {
		message: `${input.message}; warning above ${String(input.warning)}, failure above ${String(input.failure)}`,
		actual: input.current,
		expected: input.failure,
		unit: input.unit,
	});
};

export const ratioGate = (
	input: Readonly<{
		code: string;
		message: string;
		current: number;
		reference: number;
		warningRatio: number;
		failureRatio: number;
		slack: number;
	}>,
): BenchmarkGateType => {
	if (input.reference <= 0) {
		return skipped(input.code, `${input.message}: reference value is zero`, 'regression');
	}

	const status =
		input.current > input.reference * input.failureRatio + input.slack
			? 'failure'
			: input.current > input.reference * input.warningRatio + input.slack
				? 'warning'
				: 'pass';
	const actual = round2(input.current / input.reference);

	return gate(status, input.code, 'regression', {
		message: `${input.message}: ${actual.toFixed(2)}x reference`,
		actual,
		expected: input.failureRatio,
		unit: 'ratio',
	});
};

export const driftGate = (
	input: Readonly<{
		code: string;
		message: string;
		current: number;
		reference: number;
		tolerance: number;
	}>,
): BenchmarkGateType => {
	const drift = Math.abs(input.current - input.reference) / Math.max(1, input.reference);
	const status = drift > input.tolerance ? 'failure' : 'pass';

	return gate(status, input.code, 'compatibility', {
		message: `${input.message}: ${(drift * 100).toFixed(2)}% drift`,
		actual: round2(drift),
		expected: input.tolerance,
		unit: 'ratio',
	});
};
