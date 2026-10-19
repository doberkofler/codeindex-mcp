export type BenchmarkGateStatusType = 'pass' | 'warning' | 'failure' | 'skipped';

export type BenchmarkGateCategoryType = 'compatibility' | 'absolute' | 'regression' | 'plan' | 'hygiene';

export type BenchmarkGateUnitType = 'ms' | 'bytes' | 'ratio' | 'count' | null;

export type BenchmarkGateType = Readonly<{
	readonly status: BenchmarkGateStatusType;
	readonly code: string;
	readonly category: BenchmarkGateCategoryType;
	readonly message: string;
	readonly actual: number | string | boolean | null;
	readonly expected: number | string | boolean | null;
	readonly unit: BenchmarkGateUnitType;
}>;

export type BenchmarkEvaluationSummaryType = Readonly<{
	readonly pass: number;
	readonly warning: number;
	readonly failure: number;
	readonly skipped: number;
}>;

export type BenchmarkEvaluationType = Readonly<{
	readonly schemaVersion: 1;
	readonly generatedAt: string;
	readonly reportGeneratedAt: string;
	readonly baselineSchemaVersion: number;
	readonly reportSchemaVersion: number;
	readonly status: Exclude<BenchmarkGateStatusType, 'skipped'>;
	readonly summary: BenchmarkEvaluationSummaryType;
	readonly gates: readonly BenchmarkGateType[];
}>;
