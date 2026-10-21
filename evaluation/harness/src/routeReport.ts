import {type ContractProbeType} from './routeContract.ts';
import {type RouteMetricsType, type RouteRunType, type RouteTreatmentType, ROUTE_TREATMENTS} from './route.ts';

/** Version of the model-free route report schema. */
export const ROUTE_REPORT_SCHEMA_VERSION = 1 as const;

/** One treatment's complete-route result set. */
export type RouteTreatmentSummaryType = Readonly<{
	caseCount: number;
	exactCount: number;
	medianCallCount: number;
	medianResponseBytes: number;
	medianElapsedMs: number;
	coreMs: Readonly<{value: number | null; state: 'exact' | 'unavailable'}>;
}>;

/** One case compared across every selected treatment. */
export type RouteCaseReportType = Readonly<{
	caseId: string;
	class: string;
	expectedFiles: readonly string[];
	treatments: Readonly<Partial<Record<RouteTreatmentType, RouteRunType>>>;
	answerEquality: boolean;
}>;

/** One executable E1 gate result. */
export type RouteGateType = Readonly<{
	id: 'G-E1a' | 'G-E1b' | 'G-E1c';
	result: 'fail' | 'invalid' | 'pass';
	detail: string;
}>;

/** Complete model-free route report. */
export type RouteReportType = Readonly<{
	recordType: 'route-report';
	schemaVersion: typeof ROUTE_REPORT_SCHEMA_VERSION;
	generatedAt: string;
	suite: Readonly<{id: string; version: number; status: string; hash: string; revision: string}>;
	plan: Readonly<{id: string; hash: string}>;
	subject: Readonly<{mode: string; revision: string | null; contentManifestHash: string}>;
	artifacts: Readonly<Record<'accepted' | 'candidate', Readonly<{id: string; digest: string}> | null>>;
	cases: readonly RouteCaseReportType[];
	summaries: Readonly<Partial<Record<RouteTreatmentType, RouteTreatmentSummaryType>>>;
	contract: Readonly<Partial<Record<'accepted' | 'candidate', readonly ContractProbeType[]>>>;
	gates: readonly RouteGateType[];
	passed: boolean;
}>;

const medianOf = (values: readonly number[]): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	if (sorted.length % 2 === 1) {
		return sorted[middle] ?? 0;
	}

	return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const metricsOfRuns = (runs: readonly RouteRunType[]): readonly RouteMetricsType[] => runs.map((run) => run.metrics);

/**
 * Summarizes one treatment from per-case complete-route metrics.
 *
 * @param runs - Complete route results for one treatment.
 * @returns Medians, exact counts, and the separated core-time state.
 */
export const summarizeRouteTreatment = (runs: readonly RouteRunType[]): RouteTreatmentSummaryType => {
	const metrics = metricsOfRuns(runs);
	const unavailable = metrics.some((item) => item.coreMs.state === 'unavailable');

	return {
		caseCount: runs.length,
		exactCount: runs.filter((run) => run.exact && run.valid).length,
		medianCallCount: medianOf(metrics.map((item) => item.callCount)),
		medianResponseBytes: medianOf(metrics.map((item) => item.responseBytes)),
		medianElapsedMs: medianOf(metrics.map((item) => item.elapsedMs)),
		coreMs: unavailable
			? {value: null, state: 'unavailable'}
			: {value: medianOf(metrics.flatMap((item) => (item.coreMs.value === null ? [] : [item.coreMs.value]))), state: 'exact'},
	};
};

const equalityGateOf = (cases: readonly RouteCaseReportType[], treatments: readonly RouteTreatmentType[]): RouteGateType => {
	const failed = cases.filter((item) =>
		treatments.some((treatment) => item.treatments[treatment]?.valid !== true || item.treatments[treatment]?.exact !== true),
	);

	if (failed.length === 0) {
		return {id: 'G-E1a', result: 'pass', detail: `exact complete-route answers for ${cases.length} case(s)`};
	}

	return {
		id: 'G-E1a',
		result: 'fail',
		detail: `${failed.length} case(s) missed exact complete-route equality: ${failed.map((item) => item.caseId).join(', ')}`,
	};
};

const measurementGateOf = (cases: readonly RouteCaseReportType[], treatments: readonly RouteTreatmentType[]): RouteGateType => {
	const runs = cases.flatMap((item) => treatments.flatMap((treatment) => (item.treatments[treatment] === undefined ? [] : [item.treatments[treatment]])));
	const missing = runs.filter((run) => run.metrics.coreMs.state !== 'exact' || run.metrics.callCount === 0);

	if (runs.length === 0) {
		return {id: 'G-E1b', result: 'invalid', detail: 'no complete route was observed'};
	}

	if (missing.length > 0) {
		return {
			id: 'G-E1b',
			result: 'invalid',
			detail: `${missing.length} route(s) lack separated core query time or a complete call record`,
		};
	}

	return {
		id: 'G-E1b',
		result: 'pass',
		detail: `call count, response bytes, elapsed time, and core query time recorded for ${runs.length} route(s)`,
	};
};

const contractGateOf = (contract: Readonly<Partial<Record<'accepted' | 'candidate', readonly ContractProbeType[]>>>): RouteGateType => {
	const probes = [...(contract.accepted ?? []), ...(contract.candidate ?? [])];
	const invalid = probes.filter((probe) => probe.result === 'invalid');
	const failed = probes.filter((probe) => probe.result === 'fail');

	if (probes.length === 0) {
		return {id: 'G-E1c', result: 'invalid', detail: 'no contract probe was recorded'};
	}

	if (invalid.length > 0) {
		return {id: 'G-E1c', result: 'invalid', detail: `${invalid.length} contract probe(s) could not be evaluated`};
	}

	if (failed.length > 0) {
		return {
			id: 'G-E1c',
			result: 'fail',
			detail: `${failed.length} contract probe(s) failed: ${failed.map((probe) => probe.kind).join(', ')}`,
		};
	}

	return {id: 'G-E1c', result: 'pass', detail: `${probes.length} contract probe(s) passed`};
};

/**
 * Builds the model-free complete-route report and its executable E1 gates.
 *
 * @param input - Suite, plan, subject, artifacts, cases, runs, and contract probes.
 * @returns A deterministic report derived only from retained observations.
 */
export const routeReportOf = (
	input: Readonly<{
		generatedAt: string;
		suite: RouteReportType['suite'];
		plan: RouteReportType['plan'];
		subject: RouteReportType['subject'];
		artifacts: RouteReportType['artifacts'];
		cases: readonly RouteCaseReportType[];
		runs: readonly RouteRunType[];
		contract: RouteReportType['contract'];
		treatments: readonly RouteTreatmentType[];
	}>,
): RouteReportType => {
	const summaries = Object.fromEntries(
		ROUTE_TREATMENTS.filter((treatment) => input.treatments.includes(treatment)).map((treatment) => [
			treatment,
			summarizeRouteTreatment(input.runs.filter((run) => run.treatment === treatment)),
		]),
	) as Partial<Record<RouteTreatmentType, RouteTreatmentSummaryType>>;
	const gates = [equalityGateOf(input.cases, input.treatments), measurementGateOf(input.cases, input.treatments), contractGateOf(input.contract)];

	return {
		recordType: 'route-report',
		schemaVersion: ROUTE_REPORT_SCHEMA_VERSION,
		generatedAt: input.generatedAt,
		suite: input.suite,
		plan: input.plan,
		subject: input.subject,
		artifacts: input.artifacts,
		cases: input.cases,
		summaries,
		contract: input.contract,
		gates,
		passed: gates.every((gate) => gate.result === 'pass'),
	};
};
