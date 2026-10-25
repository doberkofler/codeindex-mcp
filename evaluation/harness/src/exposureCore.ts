import {readFileSync} from 'node:fs';
import {hashOf} from './hash.ts';
import {type ExposureDesignType} from './exposureDesign.ts';

/** Separated core query time for one fixed case. */
export type ExposureCoreCaseType = Readonly<{
	caseId: string;
	/** Artifact-reported handler duration, or null when the route lacked it. */
	coreMs: number | null;
	state: 'exact' | 'unavailable';
	calls: number;
	responseBytes: number;
	elapsedMs: number;
}>;

/** Pinned model-free route evidence used for separated core query time. */
export type ExposureCoreQueryType = Readonly<{
	state: 'exact' | 'unavailable';
	/** Digest of the retained route report. */
	reportDigest: string;
	suite: Readonly<{id: string; version: number; hash: string}>;
	plan: Readonly<{id: string; hash: string}>;
	artifact: Readonly<{id: string; digest: string}>;
	cases: readonly ExposureCoreCaseType[];
	reason: string | null;
}>;

type CoreBaseType = Omit<ExposureCoreQueryType, 'state' | 'cases' | 'reason'>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const recordOf = (value: unknown): Readonly<Record<string, unknown>> => (isRecord(value) ? value : {});

const recordsOf = (value: unknown): readonly Readonly<Record<string, unknown>>[] => (Array.isArray(value) ? value.filter((item) => isRecord(item)) : []);

const numberAt = (record: Readonly<Record<string, unknown>>, key: string): number | null => {
	const value = record[key];

	return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const stringAt = (record: Readonly<Record<string, unknown>>, key: string): string | null => {
	const value = record[key];

	return typeof value === 'string' ? value : null;
};

const baseOf = (parsed: unknown): CoreBaseType => {
	const report = recordOf(parsed);
	const suite = recordOf(report['suite']);
	const plan = recordOf(report['plan']);
	const artifact = recordOf(recordOf(report['artifacts'])['candidate']);

	return {
		reportDigest: hashOf(parsed),
		suite: {
			id: stringAt(suite, 'id') ?? 'unknown',
			version: numberAt(suite, 'version') ?? 0,
			hash: stringAt(suite, 'hash') ?? '',
		},
		plan: {id: stringAt(plan, 'id') ?? 'unknown', hash: stringAt(plan, 'hash') ?? ''},
		artifact: {id: stringAt(artifact, 'id') ?? 'unknown', digest: stringAt(artifact, 'digest') ?? ''},
	};
};

const mismatchesOf = (base: CoreBaseType, design: ExposureDesignType): readonly string[] =>
	[
		base.suite.id === design.route.suiteId ? null : `suite ${base.suite.id}`,
		base.suite.version === design.route.version ? null : `suite version ${String(base.suite.version)}`,
		base.suite.hash === design.route.hash ? null : 'suite hash',
		base.plan.hash === design.route.planHash ? null : 'plan hash',
		base.artifact.id === design.artifact.id ? null : `artifact ${base.artifact.id}`,
		base.artifact.digest === design.artifact.digest ? null : 'artifact digest',
	].filter((item): item is string => item !== null);

const coreCaseOf = (testCase: Readonly<Record<string, unknown>>): ExposureCoreCaseType => {
	const caseId = stringAt(testCase, 'caseId') ?? 'unknown';
	const candidate = recordOf(recordOf(testCase['treatments'])['candidate']);
	const metrics = recordOf(candidate['metrics']);
	const core = recordOf(metrics['coreMs']);
	const coreMs = core['state'] === 'exact' ? numberAt(core, 'value') : null;

	return {
		caseId,
		coreMs,
		state: coreMs === null ? 'unavailable' : 'exact',
		calls: numberAt(metrics, 'callCount') ?? 0,
		responseBytes: numberAt(metrics, 'responseBytes') ?? 0,
		elapsedMs: numberAt(metrics, 'elapsedMs') ?? 0,
	};
};

const unavailableCaseOf = (caseId: string): ExposureCoreCaseType => ({caseId, coreMs: null, state: 'unavailable', calls: 0, responseBytes: 0, elapsedMs: 0});

/**
 * Reads a retained model-free route report and extracts separated core query
 * time for the exposure cases.
 *
 * The report must be the exact suite, plan, and artifact pinned by the design.
 * A missing or mismatched record yields an unavailable result; it is never
 * silently replaced with task wall time.
 *
 * @param input - Report path and frozen exposure design.
 * @returns Per-case core query time and its pin evidence.
 */
export const coreQueryEvidenceOf = (input: Readonly<{reportPath: string; design: ExposureDesignType}>): ExposureCoreQueryType => {
	const parsed: unknown = JSON.parse(readFileSync(input.reportPath, 'utf8'));
	const report = recordOf(parsed);
	const base = baseOf(parsed);

	if (report['recordType'] !== 'route-report') {
		return {...base, state: 'unavailable', cases: [], reason: 'route evidence is not a route-report'};
	}

	const mismatches = mismatchesOf(base, input.design);

	if (mismatches.length > 0) {
		return {...base, state: 'unavailable', cases: [], reason: `route evidence does not match the design: ${mismatches.join(', ')}`};
	}

	const byCase = new Map(recordsOf(report['cases']).map((testCase) => [stringAt(testCase, 'caseId') ?? 'unknown', coreCaseOf(testCase)]));
	const cases = input.design.cases.map((testCase) => byCase.get(testCase.id) ?? unavailableCaseOf(testCase.id));
	const missing = cases.filter((testCase) => testCase.state !== 'exact').map((testCase) => testCase.caseId);

	if (missing.length > 0) {
		return {...base, state: 'unavailable', cases, reason: `route report lacks separated core query time for ${missing.join(', ')}`};
	}

	return {...base, state: 'exact', cases, reason: null};
};
