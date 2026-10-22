import {hashOf} from './hash.ts';
import {
	RELEASE_CASE_COUNT,
	RELEASE_CLAIM_CLASS,
	RELEASE_TREATMENT_IDS,
	type ReleaseArtifactType,
	type ReleaseArtifactsType,
	type ReleaseExpectationType,
	type ReleasePreconditionType,
} from './releaseContract.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown, context: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new TypeError(`${context} must be a JSON object`);
	}

	return value;
};

const requireString = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`${context} field "${field}" must be a non-empty string`);
	}

	return value;
};

const requireNumber = (value: unknown, field: string, context: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new TypeError(`${context} field "${field}" must be a number`);
	}

	return value;
};

const requireBoolean = (value: unknown, field: string, context: string): boolean => {
	if (typeof value !== 'boolean') {
		throw new TypeError(`${context} field "${field}" must be a boolean`);
	}

	return value;
};

const requireArray = (value: unknown, field: string, context: string): readonly unknown[] => {
	if (!Array.isArray(value)) {
		throw new TypeError(`${context} field "${field}" must be an array`);
	}

	return value;
};

const requireStringArray = (value: unknown, field: string, context: string): readonly string[] =>
	requireArray(value, field, context).map((item, index) => requireString(item, `${field}[${index}]`, context));

const suiteOf = (value: unknown, context: string): Readonly<{id: string; version: number; hash: string}> => {
	const record = requireRecord(value, `${context} field "suite"`);

	return {
		id: requireString(record['id'], 'suite.id', context),
		version: requireNumber(record['version'], 'suite.version', context),
		hash: requireString(record['hash'], 'suite.hash', context),
	};
};

const artifactOf = (value: unknown, context: string): ReleaseArtifactType | null => {
	if (value === null) {
		return null;
	}

	const record = requireRecord(value, context);

	return {
		id: requireString(record['id'], 'id', context),
		digest: requireString(record['digest'], 'digest', context),
	};
};

const artifactsOf = (value: unknown, context: string): ReleaseArtifactsType => {
	const record = requireRecord(value, `${context} field "artifacts"`);

	return {
		accepted: artifactOf(record['accepted'], `${context} field "artifacts.accepted"`),
		candidate: artifactOf(record['candidate'], `${context} field "artifacts.candidate"`),
	};
};

const sameArtifacts = (left: ReleaseArtifactsType, right: ReleaseArtifactsType): boolean => JSON.stringify(left) === JSON.stringify(right);

// The suite hash is model-bound: local evidence runs the same cases under the
// local model, while release evidence binds the hosted reference. Stage lineage is
// therefore the suite id and version plus the frozen case hashes below; the
// model-bound hash is recorded with each stage but is never compared across models.
const assertSuiteMatches = (
	actual: Readonly<{id: string; version: number; hash: string}>,
	expected: ReleaseExpectationType['suite'],
	context: string,
): void => {
	if (actual.id !== expected.id || actual.version !== expected.version) {
		throw new Error(`${context} covers suite ${actual.id}@${actual.version}, but the release suite is ${expected.id}@${expected.version}`);
	}
};

const assertCasesMatch = (actual: readonly Readonly<{id: string; hash: string}>[], expected: ReleaseExpectationType['cases'], context: string): void => {
	const actualById = new Map(actual.map((testCase) => [testCase.id, testCase.hash]));
	const mismatched = expected.filter((testCase) => actualById.get(testCase.id) !== testCase.hash);

	if (actualById.size !== expected.length || mismatched.length > 0) {
		throw new Error(`${context} does not cover the frozen ${expected.length}-case suite`);
	}
};

const assertArtifactsMatch = (actual: ReleaseArtifactsType, expected: ReleaseArtifactsType, context: string): void => {
	if (!sameArtifacts(actual, expected)) {
		throw new Error(`${context} covers different artifacts than the staged release artifacts`);
	}
};

/**
 * Validates the model-free E1 report required before a release campaign.
 *
 * The report must be a passing complete-route comparison for exactly the frozen
 * release suite and the staged accepted and candidate artifacts. No model call
 * is involved, so this stage is always required before release repetitions.
 *
 * @param value - Parsed route report.
 * @param expected - Frozen suite, target metric, and staged artifacts.
 * @returns The pinned model-free precondition.
 */
export const modelFreePreconditionOf = (value: unknown, expected: ReleaseExpectationType): ReleasePreconditionType => {
	const record = requireRecord(value, 'model-free report');
	const recordType = requireString(record['recordType'], 'recordType', 'model-free report');

	if (recordType !== 'route-report') {
		throw new Error(`model-free evidence must be a route-report, found "${recordType}"`);
	}

	if (requireNumber(record['schemaVersion'], 'schemaVersion', 'model-free report') !== 1) {
		throw new Error('model-free report schemaVersion must be 1');
	}

	const suite = suiteOf(record['suite'], 'model-free report');
	const suiteRecord = requireRecord(record['suite'], 'model-free report field "suite"');
	const revision = requireString(suiteRecord['revision'], 'suite.revision', 'model-free report');
	const artifacts = artifactsOf(record['artifacts'], 'model-free report');
	const caseIds = requireArray(record['cases'], 'cases', 'model-free report').map((item, index) =>
		requireString(requireRecord(item, `model-free report case ${index}`)['caseId'], 'caseId', 'model-free report'),
	);
	assertCasesMatch(
		caseIds.map((id) => ({id, hash: expected.cases.find((testCase) => testCase.id === id)?.hash ?? ''})),
		expected.cases,
		'model-free report',
	);
	const gates = requireArray(record['gates'], 'gates', 'model-free report').map((gate) => requireRecord(gate, 'model-free report gate'));
	const required = ['G-E1a', 'G-E1b', 'G-E1c'];
	const failed = required.filter((id) => {
		const gate = gates.find((item) => item['id'] === id);

		return gate === undefined || gate['result'] !== 'pass';
	});

	if (failed.length > 0) {
		throw new Error(`model-free gate did not pass: ${failed.join(', ')}`);
	}

	if (!requireBoolean(record['passed'], 'passed', 'model-free report')) {
		throw new Error('model-free report did not pass');
	}

	assertSuiteMatches(suite, expected.suite, 'model-free report');
	assertArtifactsMatch(artifacts, expected.artifacts, 'model-free report');

	if (revision !== expected.suite.revision) {
		throw new Error(`model-free report covers revision ${revision}, but the release suite pins ${expected.suite.revision}`);
	}

	return {
		kind: 'model-free',
		recordType,
		id: `${suite.id}@${suite.version}`,
		digest: hashOf(record),
		suite,
		artifacts,
		model: null,
		environment: null,
	};
};

const localManifestOf = (
	value: unknown,
): Readonly<{
	campaignId: string;
	suite: Readonly<{id: string; version: number; hash: string}>;
	revision: string;
	artifacts: ReleaseArtifactsType;
	cases: readonly Readonly<{id: string; hash: string}>[];
}> => {
	const record = requireRecord(value, 'local regression manifest');
	const cases = requireArray(record['cases'], 'cases', 'local regression manifest').map((item, index) => {
		const testCase = requireRecord(item, `local regression manifest case ${index}`);

		return {
			id: requireString(testCase['id'], 'case.id', 'local regression manifest'),
			hash: requireString(testCase['hash'], 'case.hash', 'local regression manifest'),
		};
	});

	return {
		campaignId: requireString(record['campaignId'], 'campaignId', 'local regression manifest'),
		suite: suiteOf(record['suite'], 'local regression manifest'),
		revision: requireString(record['revision'], 'revision', 'local regression manifest'),
		artifacts: artifactsOf(record['artifacts'], 'local regression manifest'),
		cases,
	};
};

/**
 * Validates the passing local regression required before a release campaign.
 *
 * A local record is local-model-scoped by construction. It may gate the release
 * campaign but can never be promoted to hosted evidence, so a record carrying
 * release authority or a hosted claim class is rejected rather than reused.
 *
 * @param recordValue - Parsed local-regression record.
 * @param manifestValue - Parsed campaign manifest from the same result directory.
 * @param expected - Frozen suite, target metric, and staged artifacts.
 * @returns The pinned local precondition.
 */
type LocalFactsType = Readonly<{
	recordType: string;
	suite: Readonly<{id: string; version: number; hash: string}>;
	campaignId: string;
	model: string;
	environment: Readonly<{id: string; hash: string}>;
}>;

const assertLocalHeaderOf = (record: Record<string, unknown>, expected: ReleaseExpectationType): LocalFactsType => {
	const recordType = requireString(record['recordType'], 'recordType', 'local regression record');

	if (recordType !== 'local-regression') {
		throw new Error(`local evidence must be a local-regression record, found "${recordType}"`);
	}

	if (requireNumber(record['schemaVersion'], 'schemaVersion', 'local regression record') !== 1) {
		throw new Error('local regression record schemaVersion must be 1');
	}

	const claimClass = requireString(record['claimClass'], 'claimClass', 'local regression record');

	if (claimClass !== 'local-model-scoped') {
		throw new Error(`local regression record must carry claimClass local-model-scoped, found "${claimClass}"`);
	}

	if (requireBoolean(record['releaseAuthority'], 'releaseAuthority', 'local regression record')) {
		throw new Error('local regression record must not carry release authority');
	}

	if (!requireBoolean(record['passed'], 'passed', 'local regression record')) {
		throw new Error('local regression did not pass');
	}

	if (requireBoolean(record['diagnosisRequired'], 'diagnosisRequired', 'local regression record')) {
		throw new Error('local regression requires targeted diagnosis');
	}

	const suite = suiteOf(record['suite'], 'local regression record');
	const targetMetric = requireString(record['targetMetric'], 'targetMetric', 'local regression record');

	if (targetMetric !== expected.targetMetric) {
		throw new Error(`local regression target metric ${targetMetric} differs from release target ${expected.targetMetric}`);
	}

	const report = requireRecord(record['report'], 'local regression record field "report"');
	const environment = requireRecord(record['environment'], 'local regression record field "environment"');

	return {
		recordType,
		suite,
		campaignId: requireString(report['campaignId'], 'report.campaignId', 'local regression record'),
		model: requireString(record['model'], 'model', 'local regression record'),
		environment: {
			id: requireString(environment['id'], 'environment.id', 'local regression record'),
			hash: requireString(environment['hash'], 'environment.hash', 'local regression record'),
		},
	};
};

const assertLocalPlanOf = (record: Record<string, unknown>): void => {
	const plan = requireRecord(record['plan'], 'local regression record field "plan"');
	const expectedExecutions = requireNumber(plan['expectedExecutions'], 'plan.expectedExecutions', 'local regression record');
	const executions = requireNumber(plan['executions'], 'plan.executions', 'local regression record');
	const validExecutions = requireNumber(plan['validExecutions'], 'plan.validExecutions', 'local regression record');
	const caseCount = requireNumber(plan['caseCount'], 'plan.caseCount', 'local regression record');
	const repetitions = requireNumber(plan['repetitions'], 'plan.repetitions', 'local regression record');
	const treatments = requireStringArray(plan['treatments'], 'plan.treatments', 'local regression record');

	if (expectedExecutions !== 162 || executions !== 162 || validExecutions !== 162) {
		throw new Error(`local regression plan is incomplete: ${executions}/${expectedExecutions} executions, ${validExecutions} valid`);
	}

	if (caseCount !== RELEASE_CASE_COUNT || repetitions !== 3 || [...treatments].sort().join(',') !== [...RELEASE_TREATMENT_IDS].sort().join(',')) {
		throw new Error('local regression plan does not cover the 18-case, three-treatment, three-repetition stage');
	}
};

const assertLocalDiagnosticOf = (record: Record<string, unknown>): void => {
	const diagnostic = requireRecord(record['diagnostic'], 'local regression record field "diagnostic"');

	if (!requireBoolean(diagnostic['passed'], 'diagnostic.passed', 'local regression record')) {
		throw new Error('local regression diagnostic did not pass');
	}

	if (!requireBoolean(diagnostic['targetImproved'], 'diagnostic.targetImproved', 'local regression record')) {
		throw new Error('local regression diagnostic did not improve the target metric');
	}
};

const assertLocalManifestOf = (manifest: ReturnType<typeof localManifestOf>, facts: LocalFactsType, expected: ReleaseExpectationType): void => {
	if (manifest.campaignId !== facts.campaignId) {
		throw new Error(`local regression manifest ${manifest.campaignId} differs from its record ${facts.campaignId}`);
	}

	assertSuiteMatches(facts.suite, expected.suite, 'local regression record');
	assertSuiteMatches(manifest.suite, expected.suite, 'local regression manifest');
	assertCasesMatch(manifest.cases, expected.cases, 'local regression manifest');
	assertArtifactsMatch(manifest.artifacts, expected.artifacts, 'local regression manifest');

	if (manifest.revision !== expected.suite.revision) {
		throw new Error(`local regression manifest covers revision ${manifest.revision}, but the release suite pins ${expected.suite.revision}`);
	}
};

export const localRegressionPreconditionOf = (recordValue: unknown, manifestValue: unknown, expected: ReleaseExpectationType): ReleasePreconditionType => {
	const record = requireRecord(recordValue, 'local regression record');
	const facts = assertLocalHeaderOf(record, expected);

	assertLocalPlanOf(record);
	assertLocalDiagnosticOf(record);

	const manifest = localManifestOf(manifestValue);

	assertLocalManifestOf(manifest, facts, expected);

	return {
		kind: 'local-regression',
		recordType: facts.recordType,
		id: facts.campaignId,
		digest: hashOf(record),
		suite: facts.suite,
		artifacts: manifest.artifacts,
		model: facts.model,
		environment: facts.environment,
	};
};

/**
 * Rejects evidence that is not hosted release authority.
 *
 * @param claimClass - Claim class read from the campaign manifest or report.
 */
export const assertReleaseClaimClass = (claimClass: string): void => {
	if (claimClass !== RELEASE_CLAIM_CLASS) {
		throw new Error(`expected ${RELEASE_CLAIM_CLASS} evidence, found "${claimClass}"`);
	}
};
