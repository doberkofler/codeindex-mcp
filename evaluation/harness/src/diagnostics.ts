import {type RunResultType} from './runTypes.ts';

/** Owner a diagnostic anomaly is attributed to. */
export const DIAGNOSTIC_ATTRIBUTIONS = ['harness', 'model', 'codeindex', 'integration'] as const;

export type DiagnosticAttributionType = (typeof DIAGNOSTIC_ATTRIBUTIONS)[number];

/** Every anomaly kind the diagnostic contract can record. */
export const DIAGNOSTIC_ANOMALY_KINDS = [
	'dirty-checkout',
	'process-failed',
	'restoration-failed',
	'retried',
	'timed-out',
	'unknown-tool',
	'unstructured-answer',
	'correctness-failed',
	'workflow-failed',
	'invalid-tool-input',
	'codeindex-error',
] as const;

export type DiagnosticAnomalyKindType = (typeof DIAGNOSTIC_ANOMALY_KINDS)[number];

/** Anomaly kinds that violate the diagnostic execution contract. */
export const DIAGNOSTIC_CONTRACT_KINDS: readonly DiagnosticAnomalyKindType[] = [
	'dirty-checkout',
	'process-failed',
	'restoration-failed',
	'retried',
	'timed-out',
	'unknown-tool',
	'unstructured-answer',
];

const CONTRACT_KINDS = new Set<DiagnosticAnomalyKindType>(DIAGNOSTIC_CONTRACT_KINDS);

/** One attributed anomaly from a diagnostic execution. */
export type DiagnosticAnomalyType = Readonly<{
	caseId: string;
	treatment: string;
	repetition: number;
	kind: DiagnosticAnomalyKindType;
	detail: string;
	attribution: DiagnosticAttributionType;
}>;

/** Attributed result of the three-repetition diagnostic phase. */
export type DiagnosticReportType = Readonly<{
	recordType: 'calibration-diagnostics';
	schemaVersion: 1;
	cases: readonly string[];
	repetitions: number;
	executions: number;
	validExecutions: number;
	anomalies: readonly DiagnosticAnomalyType[];
	/** True when no execution violates the diagnostic execution contract. */
	passed: boolean;
	blocking: readonly DiagnosticAnomalyType[];
}>;

/** Maximum diagnostic cases and repetitions required by the calibration contract. */
export const DIAGNOSTIC_CASE_IDS = ['impl-default-result-bytes', 'impact-schema-version-references'] as const;
export const DIAGNOSTIC_REPETITIONS = 3;

/**
 * Attributes every observed diagnostic anomaly to its owner.
 *
 * A retry, inherited edit, undeclared tool, or failed restoration is a harness
 * defect. A missing structured answer or wrong answer belongs to the model. A
 * failed index call belongs to CodeIndex. A non-zero process exit that is not a
 * model answer belongs to the client integration.
 *
 * @param run - One retained diagnostic execution.
 * @returns Every anomaly, in stable order.
 */
/** One anomaly rule: a detail when it fires, null otherwise. */
type AnomalyRuleType = Readonly<{
	kind: DiagnosticAnomalyKindType;
	attribution: DiagnosticAttributionType;
	detail: (run: RunResultType) => string | null;
}>;

const ANOMALY_RULES: readonly AnomalyRuleType[] = [
	{kind: 'retried', attribution: 'harness', detail: (run) => (run.attempts.length > 1 ? `${run.attempts.length - 1} retry attempt(s)` : null)},
	{
		kind: 'dirty-checkout',
		attribution: 'harness',
		detail: (run) => (run.isolation.checkoutClean ? null : 'execution did not start from the pinned clean checkout'),
	},
	{
		kind: 'dirty-checkout',
		attribution: 'harness',
		detail: (run) => (run.isolation.revisionMatch ? null : 'execution did not start at the pinned revision'),
	},
	{
		kind: 'restoration-failed',
		attribution: 'harness',
		detail: (run) => (run.isolation.restored ? null : (run.invalidReason ?? 'workspace was not restored')),
	},
	{
		kind: 'unknown-tool',
		attribution: 'harness',
		detail: (run) => (run.routing.unknownTools.length > 0 ? `undeclared tool(s): ${run.routing.unknownTools.join(', ')}` : null),
	},
	{
		kind: 'unknown-tool',
		attribution: 'harness',
		detail: (run) => (run.routing.executeCalls > 0 ? 'generic execute was called although it is absent from every treatment' : null),
	},
	{kind: 'timed-out', attribution: 'model', detail: (run) => (run.timedOut ? `execution exceeded ${run.timeoutMs} ms` : null)},
	{
		kind: 'process-failed',
		attribution: 'integration',
		detail: (run) => (!run.timedOut && run.outcome === 'failed' ? (run.invalidReason ?? 'execution failed') : null),
	},
	{
		kind: 'unstructured-answer',
		attribution: 'model',
		detail: (run) => (!run.grade.parsed ? run.grade.reason : null),
	},
	{
		kind: 'correctness-failed',
		attribution: 'model',
		detail: (run) => (run.grade.parsed && !run.grade.success ? run.grade.reason : null),
	},
	{
		kind: 'workflow-failed',
		attribution: 'model',
		detail: (run) => (run.workflow.result === 'fail' ? run.workflow.violations.join(', ') : null),
	},
];

const anomaliesOf = (run: RunResultType): readonly DiagnosticAnomalyType[] => {
	const anomalies = ANOMALY_RULES.flatMap((rule) => {
		const detail = rule.detail(run);

		return detail === null
			? []
			: [{caseId: run.caseId, treatment: run.treatment, repetition: run.repetition, kind: rule.kind, detail, attribution: rule.attribution}];
	});

	for (const call of run.toolCalls) {
		if (call.family !== 'index' || call.status !== 'error') {
			continue;
		}

		// An invalid argument is a model tool-input mistake, not an index defect.
		// The model may recover with a corrected call in the same execution.
		const invalidArgument = call.error?.includes('"code":"invalid_argument"') === true;

		anomalies.push({
			caseId: run.caseId,
			treatment: run.treatment,
			repetition: run.repetition,
			kind: invalidArgument ? 'invalid-tool-input' : 'codeindex-error',
			detail: `${call.tool}: ${call.error ?? 'index call failed'}`,
			attribution: invalidArgument ? 'model' : 'codeindex',
		});
	}

	return anomalies;
};

/**
 * Builds the diagnostic attribution record for one model's diagnostic phase.
 *
 * Model answer failures are recorded but do not block qualification. The
 * execution contract fails on any harness, integration, or CodeIndex anomaly,
 * and on any missing structured final answer.
 *
 * @param results - Retained diagnostic executions.
 * @param cases - Declared diagnostic case ids.
 * @param repetitions - Declared repetitions per case and treatment.
 * @returns The record, including every blocking anomaly.
 */
export const diagnosticReportOf = (
	results: readonly RunResultType[],
	cases: readonly string[] = DIAGNOSTIC_CASE_IDS,
	repetitions: number = DIAGNOSTIC_REPETITIONS,
): DiagnosticReportType => {
	const anomalies = results.flatMap((result) => anomaliesOf(result));
	const blocking = anomalies.filter((anomaly) => CONTRACT_KINDS.has(anomaly.kind));

	return {
		recordType: 'calibration-diagnostics',
		schemaVersion: 1,
		cases,
		repetitions,
		executions: results.length,
		validExecutions: results.filter((run) => run.valid).length,
		anomalies,
		passed: blocking.length === 0,
		blocking,
	};
};

/**
 * Describes the diagnostic anomalies in one bounded line.
 *
 * @param report - Diagnostic attribution record.
 * @returns A summary naming every blocking owner.
 */
export const diagnosticSummaryOf = (report: DiagnosticReportType): string => {
	if (report.passed) {
		return `${report.executions} diagnostic execution(s), no contract anomaly`;
	}

	return report.blocking
		.map((anomaly) => `${anomaly.kind} (${anomaly.attribution}) ${anomaly.caseId}/${anomaly.treatment}/rep-${anomaly.repetition}`)
		.join('; ');
};
