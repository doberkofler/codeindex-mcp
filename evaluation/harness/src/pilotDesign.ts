import {type EconomicContractType, EVALUATION_CONTRACT, EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {hashOf} from './hash.ts';
import {CASE_CLASSES, type CaseClassType} from './schema.ts';

/** Development pilot design schema understood by this harness. */
export const PILOT_DESIGN_SCHEMA_VERSION = 1 as const;

/** One frozen development case and its preweighted share. */
export type PilotCaseType = Readonly<{
	id: string;
	class: CaseClassType;
	weight: number;
}>;

/** Frozen budget and stop ceiling for one development pilot. */
export type PilotBudgetType = Readonly<{
	maxExecutions: number;
	maxWallClockMs: number;
	maxProviderCostUsd: number;
}>;

/** Frozen case-selection and exposure decisions recorded before execution. */
export type PilotHoldoutType = Readonly<{
	suite: string;
	caseIds: readonly string[];
	execution: 'not-run';
	rationale: string;
}>;

export type PilotBreadthType = Readonly<{
	record: string;
	selectedCorpusIds: readonly string[];
	rationale: string;
}>;

export type PilotExposureType = Readonly<{
	selected: 'direct-mcp';
	codeMode: 'absent';
	comparison: 'explicit-selection';
	rationale: string;
}>;

export type PilotDecisionPolicyType = Readonly<{
	continue: string;
	redesign: string;
	narrowScope: string;
	stop: string;
}>;

/** Complete frozen development-pilot design. */
export type PilotDesignType = Readonly<{
	recordType: 'development-pilot-design';
	schemaVersion: typeof PILOT_DESIGN_SCHEMA_VERSION;
	id: string;
	status: 'frozen';
	frozenAt: string;
	contract: Readonly<{id: string; version: number; digest: string}>;
	suite: Readonly<{id: string; path: string; version: number; hash: string}>;
	model: Readonly<{provider: string; modelId: string; reference: string; runtime: string}>;
	exposure: PilotExposureType;
	treatments: readonly ['no-index', 'candidate'];
	cases: readonly PilotCaseType[];
	repetitions: number;
	seed: string;
	budget: PilotBudgetType;
	thresholds: Readonly<{
		costRatioTarget: number;
		confidence: number;
		nonInferiorityMargin: number;
		falseAbsenceTolerance: number;
	}>;
	holdout: PilotHoldoutType;
	breadth: PilotBreadthType;
	decisionPolicy: PilotDecisionPolicyType;
	digest: string;
}>;

const PILOT_KEYS = new Set([
	'recordType',
	'schemaVersion',
	'id',
	'status',
	'frozenAt',
	'contract',
	'suite',
	'model',
	'exposure',
	'treatments',
	'cases',
	'repetitions',
	'seed',
	'budget',
	'thresholds',
	'holdout',
	'breadth',
	'decisionPolicy',
	'digest',
]);

const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const recordOf = (value: unknown, context: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new TypeError(`${context} must be a JSON object`);
	}

	return value;
};

const rejectUnknown = (value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void => {
	const unknown = Object.keys(value)
		.filter((key) => !allowed.has(key))
		.sort();

	if (unknown.length > 0) {
		throw new Error(`${context} has unknown field(s): ${unknown.join(', ')}`);
	}
};

const stringOf = (value: unknown, field: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`pilot field "${field}" must be a non-empty string`);
	}

	return value;
};

const positiveIntegerOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new TypeError(`pilot field "${field}" must be a positive integer`);
	}

	return value;
};

const positiveNumberOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`pilot field "${field}" must be a positive number`);
	}

	return value;
};

const nonNegativeIntegerOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new TypeError(`pilot field "${field}" must be a non-negative integer`);
	}

	return value;
};

const classOf = (value: unknown, field: string): CaseClassType => {
	const text = stringOf(value, field);
	const found = CASE_CLASSES.find((candidate) => candidate === text);

	if (found === undefined) {
		throw new Error(`pilot field "${field}" must be one of ${CASE_CLASSES.join(', ')}`);
	}

	return found;
};

const stringArrayOf = (value: unknown, field: string): readonly string[] => {
	if (!Array.isArray(value) || value.length === 0 || !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)) {
		throw new TypeError(`pilot field "${field}" must be a non-empty string array`);
	}

	if (new Set(value).size !== value.length) {
		throw new Error(`pilot field "${field}" must not contain duplicates`);
	}

	return value;
};

/**
 * Validates that pilot weights reproduce the frozen contract weighting.
 *
 * The selected cases are a strict subset of the frozen suite. Their weights are
 * the contract weights renormalized to one, so the pilot cannot change the
 * relative class balance after treatment results are observed.
 *
 * @param cases - Declared pilot cases.
 * @param contract - Accepted economic contract.
 */
const assertWeightsOf = (cases: readonly PilotCaseType[], contract: EconomicContractType): void => {
	const total = cases.reduce((sum, testCase) => sum + testCase.weight, 0);

	if (Math.abs(total - 1) > 1e-9) {
		throw new Error(`pilot case weights must sum to 1; observed ${total}`);
	}

	const declared = new Map(cases.map((testCase) => [testCase.id, testCase.weight]));
	const frozenTotal = cases.reduce((sum, testCase) => sum + (contract.suite.caseWeights[testCase.id] ?? 0), 0);

	for (const testCase of cases) {
		const frozen = contract.suite.caseWeights[testCase.id];

		if (frozen === undefined || frozen <= 0) {
			throw new Error(`pilot case ${testCase.id} has no positive frozen contract weight`);
		}

		const expected = frozen / frozenTotal;
		const observed = declared.get(testCase.id) ?? 0;

		if (Math.abs(expected - observed) > 1e-9) {
			throw new Error(`pilot case ${testCase.id} weight ${observed} does not match the frozen contract weight ${expected}`);
		}
	}
};

const contractOf = (value: unknown, contract: EconomicContractType): PilotDesignType['contract'] => {
	const record = recordOf(value, 'pilot design field "contract"');
	const id = stringOf(record['id'], 'contract.id');
	const version = positiveIntegerOf(record['version'], 'contract.version');
	const digest = stringOf(record['digest'], 'contract.digest');

	if (id !== contract.id || version !== contract.version || digest !== EVALUATION_CONTRACT_PIN.digest) {
		throw new Error('pilot design is not bound to the accepted validity-v2 contract');
	}

	return {id, version, digest};
};

const suiteOf = (value: unknown): PilotDesignType['suite'] => {
	const record = recordOf(value, 'pilot design field "suite"');

	return {
		id: stringOf(record['id'], 'suite.id'),
		path: stringOf(record['path'], 'suite.path'),
		version: positiveIntegerOf(record['version'], 'suite.version'),
		hash: stringOf(record['hash'], 'suite.hash'),
	};
};

const modelOf = (value: unknown): PilotDesignType['model'] => {
	const record = recordOf(value, 'pilot design field "model"');

	return {
		provider: stringOf(record['provider'], 'model.provider'),
		modelId: stringOf(record['modelId'], 'model.modelId'),
		reference: stringOf(record['reference'], 'model.reference'),
		runtime: stringOf(record['runtime'], 'model.runtime'),
	};
};

const exposureOf = (value: unknown): PilotExposureType => {
	const record = recordOf(value, 'pilot design field "exposure"');

	if (record['selected'] !== 'direct-mcp' || record['codeMode'] !== 'absent' || record['comparison'] !== 'explicit-selection') {
		throw new Error('pilot design must explicitly select the direct MCP exposure with Code Mode absent');
	}

	return {
		selected: 'direct-mcp',
		codeMode: 'absent',
		comparison: 'explicit-selection',
		rationale: stringOf(record['rationale'], 'exposure.rationale'),
	};
};

const casesOf = (value: unknown, contract: EconomicContractType): readonly PilotCaseType[] => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('pilot design must declare at least one case');
	}

	const cases = value.map((rawCase, index): PilotCaseType => {
		const item = recordOf(rawCase, `pilot case ${index + 1}`);
		rejectUnknown(item, new Set(['id', 'class', 'weight']), `pilot case ${index + 1}`);
		const id = stringOf(item['id'], `cases[${index}].id`);

		if (!STABLE_ID.test(id)) {
			throw new Error(`pilot case id "${id}" must match ${STABLE_ID}`);
		}

		return {
			id,
			class: classOf(item['class'], `cases[${index}].class`),
			weight: positiveNumberOf(item['weight'], `cases[${index}].weight`),
		};
	});

	if (new Set(cases.map((testCase) => testCase.id)).size !== cases.length) {
		throw new Error('pilot design cases must be unique');
	}

	assertWeightsOf(cases, contract);

	return cases;
};

const budgetOf = (value: unknown): PilotBudgetType => {
	const record = recordOf(value, 'pilot design field "budget"');

	return {
		maxExecutions: positiveIntegerOf(record['maxExecutions'], 'budget.maxExecutions'),
		maxWallClockMs: positiveIntegerOf(record['maxWallClockMs'], 'budget.maxWallClockMs'),
		maxProviderCostUsd: positiveNumberOf(record['maxProviderCostUsd'], 'budget.maxProviderCostUsd'),
	};
};

const thresholdsOf = (value: unknown): PilotDesignType['thresholds'] => {
	const record = recordOf(value, 'pilot design field "thresholds"');

	return {
		costRatioTarget: positiveNumberOf(record['costRatioTarget'], 'thresholds.costRatioTarget'),
		confidence: positiveNumberOf(record['confidence'], 'thresholds.confidence'),
		nonInferiorityMargin: positiveNumberOf(record['nonInferiorityMargin'], 'thresholds.nonInferiorityMargin'),
		falseAbsenceTolerance: nonNegativeIntegerOf(record['falseAbsenceTolerance'], 'thresholds.falseAbsenceTolerance'),
	};
};

const holdoutOf = (value: unknown, cases: readonly PilotCaseType[]): PilotHoldoutType => {
	const record = recordOf(value, 'pilot design field "holdout"');
	const caseIds = stringArrayOf(record['caseIds'], 'holdout.caseIds');

	if (cases.some((testCase) => caseIds.includes(testCase.id))) {
		throw new Error('pilot holdout cases must be disjoint from development cases');
	}

	if (record['execution'] !== 'not-run') {
		throw new Error('pilot holdout evidence must stay unexecuted so it is not reused as certification evidence');
	}

	return {
		suite: stringOf(record['suite'], 'holdout.suite'),
		caseIds,
		execution: 'not-run',
		rationale: stringOf(record['rationale'], 'holdout.rationale'),
	};
};

const breadthOf = (value: unknown): PilotBreadthType => {
	const record = recordOf(value, 'pilot design field "breadth"');

	return {
		record: stringOf(record['record'], 'breadth.record'),
		selectedCorpusIds: stringArrayOf(record['selectedCorpusIds'], 'breadth.selectedCorpusIds'),
		rationale: stringOf(record['rationale'], 'breadth.rationale'),
	};
};

const decisionPolicyOf = (value: unknown): PilotDecisionPolicyType => {
	const record = recordOf(value, 'pilot design field "decisionPolicy"');

	return {
		continue: stringOf(record['continue'], 'decisionPolicy.continue'),
		redesign: stringOf(record['redesign'], 'decisionPolicy.redesign'),
		narrowScope: stringOf(record['narrowScope'], 'decisionPolicy.narrowScope'),
		stop: stringOf(record['stop'], 'decisionPolicy.stop'),
	};
};

/**
 * Parses and validates a frozen development-pilot design.
 *
 * The design pins cases, weights, model, exposure, repetitions, budget,
 * thresholds, holdout reservation, breadth record, and the closed decision
 * vocabulary before any treatment execution.
 *
 * @param value - Parsed JSON value.
 * @param contract - Accepted economic contract the design must reproduce.
 * @returns The validated design with its content digest.
 */
export const pilotDesignOf = (value: unknown, contract: EconomicContractType = EVALUATION_CONTRACT): PilotDesignType => {
	const record = recordOf(value, 'pilot design');
	rejectUnknown(record, PILOT_KEYS, 'pilot design');

	if (record['recordType'] !== 'development-pilot-design') {
		throw new Error('pilot design recordType must be "development-pilot-design"');
	}

	if (record['schemaVersion'] !== PILOT_DESIGN_SCHEMA_VERSION) {
		throw new Error(`pilot design schemaVersion must be ${PILOT_DESIGN_SCHEMA_VERSION}`);
	}

	const id = stringOf(record['id'], 'id');

	if (!STABLE_ID.test(id)) {
		throw new Error(`pilot design id must match ${STABLE_ID}`);
	}

	if (record['status'] !== 'frozen') {
		throw new Error('pilot design must be frozen before execution');
	}

	const declaredTreatments = record['treatments'];

	if (!Array.isArray(declaredTreatments) || declaredTreatments.length !== 2 || declaredTreatments[0] !== 'no-index' || declaredTreatments[1] !== 'candidate') {
		throw new Error('pilot design treatments must be exactly ["no-index", "candidate"]');
	}

	const cases = casesOf(record['cases'], contract);
	const normalized: Omit<PilotDesignType, 'digest'> = {
		recordType: 'development-pilot-design',
		schemaVersion: PILOT_DESIGN_SCHEMA_VERSION,
		id,
		status: 'frozen',
		frozenAt: stringOf(record['frozenAt'], 'frozenAt'),
		contract: contractOf(record['contract'], contract),
		suite: suiteOf(record['suite']),
		model: modelOf(record['model']),
		exposure: exposureOf(record['exposure']),
		treatments: ['no-index', 'candidate'],
		cases,
		repetitions: positiveIntegerOf(record['repetitions'], 'repetitions'),
		seed: stringOf(record['seed'], 'seed'),
		budget: budgetOf(record['budget']),
		thresholds: thresholdsOf(record['thresholds']),
		holdout: holdoutOf(record['holdout'], cases),
		breadth: breadthOf(record['breadth']),
		decisionPolicy: decisionPolicyOf(record['decisionPolicy']),
	};
	const digest = hashOf(normalized);
	const declaredDigest = record['digest'];

	if (typeof declaredDigest !== 'string' || !HEX_DIGEST.test(declaredDigest) || declaredDigest !== digest) {
		throw new Error('pilot design digest does not match its content; cases, weights, budget, or thresholds changed after the freeze');
	}

	return {...normalized, digest};
};
