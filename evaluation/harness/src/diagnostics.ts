import {type RunResultType} from './runner.ts';

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
const anomaliesOf = (run: RunResultType): readonly DiagnosticAnomalyType[] => {
	const anomalies: DiagnosticAnomalyType[] = [];
	const add = (kind: DiagnosticAnomalyKindType, detail: string, attribution: DiagnosticAttributionType): void => {
		anomalies.push({caseId: run.caseId, treatment: run.treatment, repetition: run.repetition, kind, detail, attribution});
	};

	if (run.attempts.length > 1) {
		add('retried', `${run.attempts.length - 1} retry attempt(s)`, 'harness');
	}

	if (!run.isolation.checkoutClean) {
		add('dirty-checkout', 'execution did not start from the pinned clean checkout', 'harness');
	}

	if (!run.isolation.revisionMatch) {
		add('dirty-checkout', 'execution did not start at the pinned revision', 'harness');
	}

	if (!run.isolation.restored) {
		add('restoration-failed', run.invalidReason ?? 'workspace was not restored', 'harness');
	}

	if (run.routing.unknownTools.length > 0) {
		add('unknown-tool', `undeclared tool(s): ${run.routing.unknownTools.join(', ')}`, 'harness');
	}

	if (run.routing.executeCalls > 0) {
		add('unknown-tool', 'generic execute was called although it is absent from every treatment', 'harness');
	}

	if (run.timedOut) {
		add('timed-out', `execution exceeded ${run.timeoutMs} ms`, 'model');
	}

	if (!run.timedOut && run.outcome === 'failed') {
		add('process-failed', run.invalidReason ?? 'execution failed', 'integration');
	}

	if (!run.grade.parsed) {
		add('unstructured-answer', run.grade.reason, 'model');
	} else if (!run.grade.success) {
		add('correctness-failed', run.grade.reason, 'model');
	}

	if (run.workflow.result === 'fail') {
		add('workflow-failed', run.workflow.violations.join(', '), 'model');
	}

	for (const call of run.toolCalls) {
		if (call.family !== 'index' || call.status !== 'error') {
			continue;
		}

		// An invalid argument is a model tool-input mistake, not an index defect.
		// The model may recover with a corrected call in the same execution.
		if (call.error?.includes('"code":"invalid_argument"') === true) {
			add('invalid-tool-input', `${call.tool}: ${call.error}`, 'model');

			continue;
		}

		add('codeindex-error', `${call.tool}: ${call.error ?? 'index call failed'}`, 'codeindex');
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
	const anomalies = results.flatMap(anomaliesOf);
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
