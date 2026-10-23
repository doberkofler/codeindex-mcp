import {hashOf} from './hash.ts';
import {
	RELEASE_CLAIM_CLASS,
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

// The suite hash is model-bound because release evidence binds the hosted
// reference. Stage lineage is therefore the suite id and version plus the frozen
// case hashes below; the model-bound hash is recorded with the stage but is never
// compared across model bindings.
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
