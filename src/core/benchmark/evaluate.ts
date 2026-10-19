import {type BenchmarkBaselineType, type BenchmarkReferenceScenarioType, type BenchmarkReferenceType} from './baseline.ts';
import {type BenchmarkReportType, type BenchmarkScenarioResultType} from './benchTypes.ts';
import {
	type BenchmarkEvaluationSummaryType,
	type BenchmarkEvaluationType,
	type BenchmarkGateCategoryType,
	type BenchmarkGateStatusType,
	type BenchmarkGateType,
	type BenchmarkGateUnitType,
} from './evaluationTypes.ts';

type GateValueType = number | string | boolean | null;

type GateDetailType = Readonly<{
	readonly message: string;
	readonly actual?: GateValueType;
	readonly expected?: GateValueType;
	readonly unit?: BenchmarkGateUnitType;
}>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const gate = (status: BenchmarkGateStatusType, code: string, category: BenchmarkGateCategoryType, detail: GateDetailType): BenchmarkGateType => ({
	status,
	code,
	category,
	message: detail.message,
	actual: detail.actual ?? null,
	expected: detail.expected ?? null,
	unit: detail.unit ?? null,
});

const skipped = (code: string, message: string, category: BenchmarkGateCategoryType = 'compatibility'): BenchmarkGateType =>
	gate('skipped', code, category, {message});

const absoluteGate = (
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

const ratioGate = (
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

const driftGate = (
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

const compatibilityGates = (report: BenchmarkReportType, baseline: BenchmarkBaselineType): readonly BenchmarkGateType[] => {
	const gates: BenchmarkGateType[] = [];
	const {compatibility} = baseline;

	gates.push(
		gate(report.schemaVersion === baseline.reportSchemaVersion ? 'pass' : 'failure', 'compatibility.report_schema', 'compatibility', {
			message: 'Benchmark report schema must match the baseline',
			actual: report.schemaVersion,
			expected: baseline.reportSchemaVersion,
		}),
	);

	if (compatibility.workspaceKind !== null) {
		gates.push(
			gate(report.workspace.kind === compatibility.workspaceKind ? 'pass' : 'failure', 'compatibility.workspace_kind', 'compatibility', {
				message: 'Workspace kind must match the baseline',
				actual: report.workspace.kind,
				expected: compatibility.workspaceKind,
			}),
		);
	}

	if (compatibility.profile !== null) {
		gates.push(
			gate(report.workspace.profile === compatibility.profile ? 'pass' : 'failure', 'compatibility.workspace_profile', 'compatibility', {
				message: 'Generated profile must match the baseline',
				actual: report.workspace.profile ?? 'null',
				expected: compatibility.profile,
			}),
		);
	}

	const present = new Set(report.scenarios.map((scenario) => scenario.name));
	const missing = baseline.requiredScenarios.filter((name) => !present.has(name));

	gates.push(
		baseline.requiredScenarios.length === 0
			? skipped('compatibility.required_scenarios', 'No scenarios are required')
			: gate(missing.length === 0 ? 'pass' : 'failure', 'compatibility.required_scenarios', 'compatibility', {
					message: missing.length === 0 ? 'All required scenarios ran' : `Missing required scenarios: ${missing.join(', ')}`,
					actual: missing.length,
					expected: 0,
					unit: 'count',
				}),
	);

	const {reference} = baseline;

	if (reference === null) {
		gates.push(skipped('compatibility.reference', 'No reference measurements supplied; relative regression gates are skipped'));
		return gates;
	}

	gates.push(gate('pass', 'compatibility.reference', 'compatibility', {message: 'Reference measurements are present'}));
	const machineMatches =
		reference.machine.platform === report.machine.platform &&
		reference.machine.arch === report.machine.arch &&
		reference.machine.cpuModel === report.machine.cpuModel;

	gates.push(
		gate(machineMatches ? 'pass' : 'warning', 'compatibility.machine', 'compatibility', {
			message: machineMatches ? 'Reference machine matches' : 'Reference machine differs; compare results cautiously',
			actual: `${report.machine.platform}/${report.machine.arch}`,
			expected: `${reference.machine.platform}/${reference.machine.arch}`,
		}),
		driftGate({
			code: 'compatibility.file_count',
			message: 'Workspace file count drift',
			current: report.workspace.fileCount,
			reference: reference.workspace.fileCount,
			tolerance: compatibility.fileCountToleranceRatio,
		}),
		driftGate({
			code: 'compatibility.symbol_count',
			message: 'Workspace symbol count drift',
			current: report.workspace.symbolCount,
			reference: reference.workspace.symbolCount,
			tolerance: compatibility.symbolCountToleranceRatio,
		}),
	);

	return gates;
};

const planGates = (report: BenchmarkReportType): readonly BenchmarkGateType[] => {
	const cursor = report.scenarios.find((scenario) => scenario.kind === 'cursor');

	if (cursor === undefined) {
		return [];
	}

	if (cursor.samples.length === 0) {
		return [
			gate('failure', 'plan.samples', 'plan', {
				message: 'Deep cursor scenario produced no samples',
				actual: 0,
				expected: 1,
				unit: 'count',
			}),
		];
	}

	const missingIndex = cursor.samples.filter((sample) => !sample.usesIndex);
	const tempBTree = cursor.samples.filter((sample) => sample.usesTempBTree);
	const detail = missingIndex
		.slice(0, 5)
		.map((sample) => `${sample.kind}@${String(sample.depth)}`)
		.join(', ');

	return [
		gate(missingIndex.length === 0 ? 'pass' : 'failure', 'plan.index_usage', 'plan', {
			message: missingIndex.length === 0 ? 'All deep cursor samples used an intended index' : `Deep cursor samples missed intended indexes: ${detail}`,
			actual: missingIndex.length,
			expected: 0,
			unit: 'count',
		}),
		gate(tempBTree.length === 0 ? 'pass' : 'warning', 'plan.temp_btree', 'plan', {
			message: tempBTree.length === 0 ? 'No deep cursor sample used a temporary B-tree' : 'Some deep cursor samples used a temporary B-tree',
			actual: tempBTree.length,
			expected: 0,
			unit: 'count',
		}),
	];
};

const editGates = (report: BenchmarkReportType, baseline: BenchmarkBaselineType): readonly BenchmarkGateType[] => {
	const edit = report.scenarios.find((scenario) => scenario.kind === 'edit');

	if (edit === undefined) {
		return [];
	}

	const p95 = edit.percentiles.p95Ms;

	if (p95 === null) {
		return [
			gate('failure', 'absolute.edit.p95', 'absolute', {
				message: 'Edit-to-fresh produced no latency samples',
				expected: baseline.thresholds.editP95FailureMs,
				unit: 'ms',
			}),
		];
	}

	return [
		absoluteGate({
			code: 'absolute.edit.p95',
			message: 'Edit-to-fresh p95',
			current: p95,
			warning: baseline.thresholds.editP95WarningMs,
			failure: baseline.thresholds.editP95FailureMs,
			unit: 'ms',
		}),
	];
};

const queryGates = (report: BenchmarkReportType, baseline: BenchmarkBaselineType): readonly BenchmarkGateType[] => {
	const gates: BenchmarkGateType[] = [];

	for (const [name, percentile] of Object.entries(report.queries)) {
		if (percentile.p95Ms !== null) {
			gates.push(
				absoluteGate({
					code: `absolute.query.${name}.p95`,
					message: `${name} p95`,
					current: percentile.p95Ms,
					warning: baseline.thresholds.queryP95WarningMs,
					failure: baseline.thresholds.queryP95FailureMs,
					unit: 'ms',
				}),
			);
		}
	}

	return gates.length === 0 ? [skipped('absolute.query.p95', 'No query latency samples were recorded', 'absolute')] : gates;
};

const hygieneGates = (report: BenchmarkReportType): readonly BenchmarkGateType[] => {
	const gates: BenchmarkGateType[] = [];
	const freshnessOk = report.freshness.state === 'current' && report.freshness.dirtyFileCount === 0;

	gates.push(
		gate(freshnessOk ? 'pass' : 'warning', 'hygiene.freshness', 'hygiene', {
			message: freshnessOk ? 'Index is current after measurement' : 'Index is not current after measurement',
			actual: `${report.freshness.state}/${String(report.freshness.dirtyFileCount ?? 'unknown')}`,
			expected: 'current/0',
		}),
	);

	const reusable = report.scenarios.filter((scenario) => scenario.kind !== 'cursor');
	const unconsumed = reusable.filter((scenario) => scenario.reuse.artifactRowsAfter > 0 && scenario.reuse.artifactRowsRead === 0);

	gates.push(
		reusable.length === 0
			? skipped('hygiene.artifact_consumption', 'No build scenario recorded extraction artifacts', 'hygiene')
			: gate(unconsumed.length === 0 ? 'pass' : 'warning', 'hygiene.artifact_consumption', 'hygiene', {
					message: unconsumed.length === 0 ? 'Extraction artifacts were consumed' : 'Extraction artifacts are persisted but not consumed',
					actual: unconsumed.length,
					expected: 0,
					unit: 'count',
				}),
	);

	return gates;
};

const ratioPairFor = (kind: BenchmarkScenarioResultType['kind'], baseline: BenchmarkBaselineType): Readonly<{warning: number; failure: number}> => {
	if (kind === 'edit') {
		return {warning: baseline.thresholds.editWarningRatio, failure: baseline.thresholds.editFailureRatio};
	}

	if (kind === 'cursor') {
		return {warning: baseline.thresholds.queryWarningRatio, failure: baseline.thresholds.queryFailureRatio};
	}

	return {warning: baseline.thresholds.buildWarningRatio, failure: baseline.thresholds.buildFailureRatio};
};

const scenarioRegressionGates = (
	current: BenchmarkScenarioResultType,
	reference: BenchmarkReferenceScenarioType,
	baseline: BenchmarkBaselineType,
): readonly BenchmarkGateType[] => {
	const wall = ratioPairFor(current.kind, baseline);
	const gates: BenchmarkGateType[] = [
		ratioGate({
			code: `regression.${current.name}.wall`,
			message: `${current.name} wall time`,
			current: current.wallMs,
			reference: reference.wallMs,
			warningRatio: wall.warning,
			failureRatio: wall.failure,
			slack: baseline.thresholds.latencySlackMs,
		}),
		ratioGate({
			code: `regression.${current.name}.rss`,
			message: `${current.name} peak RSS`,
			current: current.resources.rssPeakBytes,
			reference: reference.resources.rssPeakBytes,
			warningRatio: baseline.thresholds.memoryWarningRatio,
			failureRatio: baseline.thresholds.memoryFailureRatio,
			slack: baseline.thresholds.memorySlackBytes,
		}),
		ratioGate({
			code: `regression.${current.name}.cpu`,
			message: `${current.name} CPU time`,
			current: current.resources.cpuUserMs + current.resources.cpuSystemMs,
			reference: reference.resources.cpuUserMs + reference.resources.cpuSystemMs,
			warningRatio: baseline.thresholds.cpuWarningRatio,
			failureRatio: baseline.thresholds.cpuFailureRatio,
			slack: baseline.thresholds.cpuSlackMs,
		}),
		ratioGate({
			code: `regression.${current.name}.storage`,
			message: `${current.name} storage`,
			current: current.storage.totalBytes,
			reference: reference.storage.totalBytes,
			warningRatio: baseline.thresholds.storageWarningRatio,
			failureRatio: baseline.thresholds.storageFailureRatio,
			slack: baseline.thresholds.storageSlackBytes,
		}),
	];

	if (current.kind === 'edit' && reference.percentiles !== undefined && reference.percentiles.p95Ms !== null && current.percentiles.p95Ms !== null) {
		gates.push(
			ratioGate({
				code: 'regression.edit_to_fresh.p95',
				message: 'Edit-to-fresh p95',
				current: current.percentiles.p95Ms,
				reference: reference.percentiles.p95Ms,
				warningRatio: baseline.thresholds.editWarningRatio,
				failureRatio: baseline.thresholds.editFailureRatio,
				slack: baseline.thresholds.latencySlackMs,
			}),
		);
	}

	if (current.kind === 'cursor' && reference.samples !== undefined && reference.samples.length > 0 && current.samples.length > 0) {
		gates.push(
			ratioGate({
				code: 'regression.deep_cursor.max',
				message: 'Deep cursor maximum page latency',
				current: Math.max(...current.samples.map((sample) => sample.elapsedMs)),
				reference: Math.max(...reference.samples.map((sample) => sample.elapsedMs)),
				warningRatio: baseline.thresholds.queryWarningRatio,
				failureRatio: baseline.thresholds.queryFailureRatio,
				slack: baseline.thresholds.querySlackMs,
			}),
		);
	}

	return gates;
};

const queryRegressionGates = (report: BenchmarkReportType, reference: BenchmarkReferenceType, baseline: BenchmarkBaselineType): readonly BenchmarkGateType[] =>
	Object.entries(reference.queries).map(([name, referenceQuery]) => {
		const current = report.queries[name];

		if (current === undefined) {
			return gate('warning', `regression.query.${name}`, 'regression', {message: `${name} was absent from the current report`});
		}

		if (current.p95Ms === null || referenceQuery.p95Ms === null) {
			return skipped(`regression.query.${name}.p95`, `${name} had no p95 samples`, 'regression');
		}

		return ratioGate({
			code: `regression.query.${name}.p95`,
			message: `${name} p95`,
			current: current.p95Ms,
			reference: referenceQuery.p95Ms,
			warningRatio: baseline.thresholds.queryWarningRatio,
			failureRatio: baseline.thresholds.queryFailureRatio,
			slack: baseline.thresholds.querySlackMs,
		});
	});

const regressionGates = (report: BenchmarkReportType, baseline: BenchmarkBaselineType): readonly BenchmarkGateType[] => {
	const {reference} = baseline;

	if (reference === null) {
		return [];
	}

	const gates = reference.scenarios.flatMap((referenceScenario) => {
		const current = report.scenarios.find((scenario) => scenario.name === referenceScenario.name);

		return current === undefined
			? [
					gate('warning', `regression.${referenceScenario.name}.present`, 'regression', {
						message: `${referenceScenario.name} was absent from the current report`,
					}),
				]
			: scenarioRegressionGates(current, referenceScenario, baseline);
	});

	return [...gates, ...queryRegressionGates(report, reference, baseline)];
};

const referenceMachineMatches = (report: BenchmarkReportType, baseline: BenchmarkBaselineType): boolean => {
	const {reference} = baseline;

	return (
		reference !== null &&
		reference.machine.platform === report.machine.platform &&
		reference.machine.arch === report.machine.arch &&
		reference.machine.cpuModel === report.machine.cpuModel
	);
};
const capRelativeFailures = (gates: readonly BenchmarkGateType[], machineMatches: boolean): readonly BenchmarkGateType[] =>
	machineMatches ? gates : gates.map((entry) => (entry.category === 'regression' && entry.status === 'failure' ? {...entry, status: 'warning'} : entry));

const summaryOf = (gates: readonly BenchmarkGateType[]): BenchmarkEvaluationSummaryType => ({
	pass: gates.filter((entry) => entry.status === 'pass').length,
	warning: gates.filter((entry) => entry.status === 'warning').length,
	failure: gates.filter((entry) => entry.status === 'failure').length,
	skipped: gates.filter((entry) => entry.status === 'skipped').length,
});
/**
 * Evaluates one benchmark report against a versioned baseline.
 *
 * Compatibility failures and invalid deep-cursor plans fail. Relative
 * regressions and hygiene debt warn unless the configured ratio is exceeded.
 *
 * @param report - Completed benchmark report.
 * @param baseline - Parsed baseline thresholds and optional reference.
 * @returns Explicit gate results with an aggregate status.
 */
export const evaluateBenchmark = (report: BenchmarkReportType, baseline: BenchmarkBaselineType): BenchmarkEvaluationType => {
	const gates = capRelativeFailures(
		[
			...compatibilityGates(report, baseline),
			...planGates(report),
			...editGates(report, baseline),
			...queryGates(report, baseline),
			...hygieneGates(report),
			...regressionGates(report, baseline),
		],
		referenceMachineMatches(report, baseline),
	);
	const summary = summaryOf(gates);
	const status: BenchmarkEvaluationType['status'] = summary.failure > 0 ? 'failure' : summary.warning > 0 ? 'warning' : 'pass';

	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		reportGeneratedAt: report.generatedAt,
		baselineSchemaVersion: baseline.schemaVersion,
		reportSchemaVersion: report.schemaVersion,
		status,
		summary,
		gates,
	};
};
