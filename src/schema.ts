import {hashOf} from './hash.ts';
import {canonicalTreatmentsOf, treatmentOf, treatmentSetHashOf, validateTreatmentSet, type TreatmentDefinitionType} from './treatment.ts';

export {canonicalJson, hashOf} from './hash.ts';

/** Version of the case document schema understood by this harness. */
export const CASE_SCHEMA_VERSION = 1 as const;

/** Version of the suite document schema understood by this harness. */
export const SUITE_SCHEMA_VERSION = 2 as const;

/** Test classes required by the Q2 acceptance thresholds. */
export const CASE_CLASSES = ['locate', 'impact', 'implementation'] as const;

export type CaseClassType = (typeof CASE_CLASSES)[number];

export type WorkflowType = Readonly<{
	/** Maximum number of tool calls a run may make. */
	maxTotalCalls: number;
	/** Tool name that must be the first retrieval tool, when set. */
	requiredFirstTool: string | null;
	/** Maximum summed tool-output characters. */
	maxOutputBytes: number;
}>;

export type CaseType = Readonly<{
	schemaVersion: typeof CASE_SCHEMA_VERSION;
	id: string;
	title: string;
	class: CaseClassType;
	tags: readonly string[];
	prompt: string;
	scope: readonly string[];
	expectedFiles: readonly string[];
	contextFiles: readonly string[];
	forbiddenFiles: readonly string[];
	workflow: WorkflowType;
	timeoutMs: number;
}>;

export type SuiteFieldsType = Readonly<{
	schemaVersion: typeof SUITE_SCHEMA_VERSION;
	id: string;
	version: number;
	status: 'draft' | 'frozen';
	revision: string;
	model: string;
	repetitions: number;
	/** The accepted three-treatment definitions. */
	treatments: readonly TreatmentDefinitionType[];
	cases: readonly string[];
	/** Case hashes pinned by a frozen suite, or null for an unpinned draft. */
	caseHashes: Readonly<Record<string, string>> | null;
}>;

export type SuiteType = SuiteFieldsType &
	Readonly<{
		/** Canonical hash over suite metadata plus the loaded case hashes. */
		hash: string;
	}>;

const CASE_KEYS = new Set([
	'schemaVersion',
	'id',
	'title',
	'class',
	'tags',
	'prompt',
	'scope',
	'expectedFiles',
	'contextFiles',
	'forbiddenFiles',
	'workflow',
	'timeoutMs',
]);

const WORKFLOW_KEYS = new Set(['maxTotalCalls', 'requiredFirstTool', 'maxOutputBytes']);

const SUITE_KEYS = new Set([
	'schemaVersion',
	'id',
	'version',
	'status',
	'revision',
	'model',
	'repetitions',
	'treatments',
	'cases',
	'caseHashes',
]);

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Rejects fields that are not part of the declared schema.
 *
 * @param value - Parsed object.
 * @param allowed - Exact field names permitted at this level.
 * @param context - Document and field scope used in the error message.
 */
const rejectUnknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void => {
	const unknown = Object.keys(value)
		.filter((key) => !allowed.has(key))
		.sort();

	if (unknown.length > 0) {
		throw new Error(`${context} has unknown field(s): ${unknown.join(', ')}`);
	}
};

const requireObject = (value: unknown, context: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new Error(`${context} must be a JSON object`);
	}

	return value;
};

const requireSchemaVersion = (value: unknown, context: string, supported: number): void => {
	if (value === undefined) {
		throw new Error(`${context} field "schemaVersion" is required`);
	}

	if (typeof value !== 'number' || !Number.isInteger(value) || value !== supported) {
		throw new Error(`${context} field "schemaVersion" must be ${supported}; supported version(s): ${supported}`);
	}
};

const requireString = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${context} field "${field}" must be a non-empty string`);
	}

	return value;
};

const requireStableId = (value: unknown, field: string, context: string): string => {
	const id = requireString(value, field, context);

	if (!STABLE_ID.test(id)) {
		throw new Error(`${context} field "${field}" must match ${STABLE_ID}`);
	}

	return id;
};

const requireStringArray = (value: unknown, field: string, context: string): readonly string[] => {
	if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)) {
		throw new Error(`${context} field "${field}" must be an array of non-empty strings`);
	}

	if (new Set(value).size !== value.length) {
		throw new Error(`${context} field "${field}" must not contain duplicates`);
	}

	return value;
};

const requirePositiveInteger = (value: unknown, field: string, context: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${context} field "${field}" must be a positive integer`);
	}

	return value;
};

const requireHexDigest = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || !HEX_DIGEST.test(value)) {
		throw new Error(`${context} field "${field}" must be a 64-character lowercase hex digest`);
	}

	return value;
};

/**
 * Validates one case document.
 *
 * @param value - Parsed JSON value.
 * @returns The validated, normalized case.
 */
export const caseOf = (value: unknown): CaseType => {
	const record = requireObject(value, 'case');
	rejectUnknownKeys(record, CASE_KEYS, 'case');
	requireSchemaVersion(record['schemaVersion'], 'case', CASE_SCHEMA_VERSION);

	const caseClass = CASE_CLASSES.find((item) => item === record['class']);

	if (caseClass === undefined) {
		throw new Error(`case field "class" must be one of ${CASE_CLASSES.join(', ')}`);
	}

	const workflow = requireObject(record['workflow'], 'case field "workflow"');
	rejectUnknownKeys(workflow, WORKFLOW_KEYS, 'case field "workflow"');

	const requiredFirstTool = workflow['requiredFirstTool'];

	if (requiredFirstTool !== null && (typeof requiredFirstTool !== 'string' || requiredFirstTool.trim().length === 0)) {
		throw new Error('case field "workflow.requiredFirstTool" must be a non-empty string or null');
	}

	const contextFiles = record['contextFiles'] ?? [];
	const forbiddenFiles = record['forbiddenFiles'] ?? [];

	return {
		schemaVersion: CASE_SCHEMA_VERSION,
		id: requireStableId(record['id'], 'id', 'case'),
		title: requireString(record['title'], 'title', 'case'),
		class: caseClass,
		tags: requireStringArray(record['tags'], 'tags', 'case'),
		prompt: requireString(record['prompt'], 'prompt', 'case'),
		scope: requireStringArray(record['scope'], 'scope', 'case'),
		expectedFiles: requireStringArray(record['expectedFiles'], 'expectedFiles', 'case'),
		contextFiles: requireStringArray(contextFiles, 'contextFiles', 'case'),
		forbiddenFiles: requireStringArray(forbiddenFiles, 'forbiddenFiles', 'case'),
		workflow: {
			maxTotalCalls: requirePositiveInteger(workflow['maxTotalCalls'], 'workflow.maxTotalCalls', 'case'),
			requiredFirstTool,
			maxOutputBytes: requirePositiveInteger(workflow['maxOutputBytes'], 'workflow.maxOutputBytes', 'case'),
		},
		timeoutMs: requirePositiveInteger(record['timeoutMs'], 'timeoutMs', 'case'),
	};
};

/**
 * Validates a suite document without loading referenced cases.
 *
 * @param value - Parsed JSON value.
 * @returns The validated suite fields.
 */
export const suiteFieldsOf = (value: unknown): SuiteFieldsType => {
	const record = requireObject(value, 'suite');
	rejectUnknownKeys(record, SUITE_KEYS, 'suite');
	requireSchemaVersion(record['schemaVersion'], 'suite', SUITE_SCHEMA_VERSION);

	const status = requireString(record['status'], 'status', 'suite');

	if (status !== 'draft' && status !== 'frozen') {
		throw new Error('suite field "status" must be "draft" or "frozen"');
	}

	const rawTreatments = record['treatments'];

	if (!Array.isArray(rawTreatments) || rawTreatments.length === 0) {
		throw new Error('suite field "treatments" must be a non-empty array');
	}

	const treatments = validateTreatmentSet(
		canonicalTreatmentsOf(rawTreatments.map((value, index) => treatmentOf(value, `suite treatment[${index}]`))),
	);
	const cases = requireStringArray(record['cases'], 'cases', 'suite');

	if (cases.length === 0) {
		throw new Error('suite field "cases" must not be empty');
	}

	const rawHashes = record['caseHashes'];

	if (status === 'frozen' && rawHashes === undefined) {
		throw new Error('frozen suite field "caseHashes" is required');
	}

	let caseHashes: Readonly<Record<string, string>> | null = null;

	if (rawHashes !== undefined) {
		const hashRecord = requireObject(rawHashes, 'suite field "caseHashes"');
		const declared = Object.keys(hashRecord).sort();
		const expected = [...cases].sort();

		if (declared.length !== expected.length || declared.some((id, index) => id !== expected[index])) {
			throw new Error('suite field "caseHashes" must contain exactly one entry per listed case');
		}

		caseHashes = Object.fromEntries(
			cases.map((id) => [id, requireHexDigest(hashRecord[id], `caseHashes.${id}`, 'suite')]),
		);
	}

	return {
		schemaVersion: SUITE_SCHEMA_VERSION,
		id: requireStableId(record['id'], 'id', 'suite'),
		version: requirePositiveInteger(record['version'], 'version', 'suite'),
		status,
		revision: requireString(record['revision'], 'revision', 'suite'),
		model: requireString(record['model'], 'model', 'suite'),
		repetitions: requirePositiveInteger(record['repetitions'], 'repetitions', 'suite'),
		treatments,
		cases,
		caseHashes,
	};
};

/**
 * Hashes one normalized case document.
 *
 * @param testCase - Validated case.
 * @returns Hex digest of the case's semantic content.
 */
export const caseHashOf = (testCase: CaseType): string => hashOf(testCase);

/**
 * Hashes suite metadata and the loaded case content.
 *
 * The suite hash is computed rather than stored so an in-place change cannot
 * leave a valid-looking manifest behind.
 *
 * @param fields - Validated suite fields.
 * @param cases - Loaded cases in manifest order.
 * @returns Hex digest of the suite.
 */
export const suiteHashOf = (fields: SuiteFieldsType, cases: readonly CaseType[]): string =>
	hashOf({
		schemaVersion: fields.schemaVersion,
		id: fields.id,
		version: fields.version,
		status: fields.status,
		revision: fields.revision,
		model: fields.model,
		repetitions: fields.repetitions,
		treatments: treatmentSetHashOf(fields.treatments),
		cases: cases.map((testCase) => ({id: testCase.id, hash: caseHashOf(testCase)})),
	});
