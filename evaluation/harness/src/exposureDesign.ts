import {type EconomicContractType, EVALUATION_CONTRACT, EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {generationOf} from './environmentFields.ts';
import {type GenerationSettingsType} from './environment.ts';
import {hashOf} from './hash.ts';
import {CASE_CLASSES, type CaseClassType} from './schema.ts';

/** Exposure-comparison design schema understood by this harness. */
export const EXPOSURE_DESIGN_SCHEMA_VERSION = 1 as const;

/** One frozen exposure-comparison case. Both arms run the same case. */
export type ExposureCaseType = Readonly<{
	id: string;
	class: CaseClassType;
}>;

/** Frozen budget and stop ceilings for one exposure comparison. */
export type ExposureBudgetType = Readonly<{
	maxExecutions: number;
	maxWallClockMs: number;
	maxProviderCostUsd: number;
}>;

/** Predeclared decision thresholds for the exposure comparison. */
export type ExposureThresholdsType = Readonly<{
	confidence: 0.95;
	/** The wrapped arm must beat direct cost by at least this share. */
	minimumCostSaving: number;
	/** Correctness degradation tolerated by the wrapped arm. */
	nonInferiorityMargin: number;
	falseAbsenceTolerance: 0;
}>;

/** Closed decision vocabulary for the exposure comparison. */
export type ExposureDecisionPolicyType = Readonly<{
	retainDirect: string;
	adoptCodeMode: string;
	inconclusive: string;
}>;

/**
 * Complete frozen exposure-comparison design.
 *
 * It pins one artifact presented two ways, the same ordinary tools, the same
 * fixed cases, the same hosted model and client runtime, the same tariff, and a
 * model-free route record for separated core query time. It never re-grades the
 * frozen EVAL-037 certification.
 */
export type ExposureDesignType = Readonly<{
	recordType: 'exposure-comparison-design';
	schemaVersion: typeof EXPOSURE_DESIGN_SCHEMA_VERSION;
	id: string;
	status: 'frozen';
	frozenAt: string;
	contract: Readonly<{id: string; version: number; digest: string}>;
	suite: Readonly<{id: string; path: string; version: number; hash: string; revision: string}>;
	exposure: Readonly<{
		baseline: 'direct-mcp';
		treatment: 'code-mode';
		rationale: string;
	}>;
	model: Readonly<{
		provider: string;
		modelId: string;
		reference: string;
		runtime: string;
		generation: GenerationSettingsType;
	}>;
	artifact: Readonly<{id: string; digest: string}>;
	ordinaryTools: readonly string[];
	cases: readonly ExposureCaseType[];
	repetitions: number;
	seed: string;
	tariff: Readonly<{id: string; source: string; retrievedAt: string; digest: string}>;
	route: Readonly<{
		suiteId: string;
		path: string;
		version: number;
		hash: string;
		plan: string;
		planHash: string;
	}>;
	frozenProduction: Readonly<{
		exposure: 'direct-mcp';
		certification: string;
		certificationDigest: string;
	}>;
	budget: ExposureBudgetType;
	thresholds: ExposureThresholdsType;
	decisionPolicy: ExposureDecisionPolicyType;
	digest: string;
}>;

const DESIGN_KEYS = new Set([
	'recordType',
	'schemaVersion',
	'id',
	'status',
	'frozenAt',
	'contract',
	'suite',
	'exposure',
	'model',
	'artifact',
	'ordinaryTools',
	'cases',
	'repetitions',
	'seed',
	'tariff',
	'route',
	'frozenProduction',
	'budget',
	'thresholds',
	'decisionPolicy',
	'digest',
]);

const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const TOOL_NAME = /^\w[\w.:-]*$/iu;

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
		throw new TypeError(`exposure design field "${field}" must be a non-empty string`);
	}

	return value;
};

const timestampOf = (value: unknown, field: string): string => {
	const text = stringOf(value, field);

	if (Number.isNaN(Date.parse(text))) {
		throw new TypeError(`exposure design field "${field}" must be an ISO 8601 timestamp`);
	}

	return text;
};

const digestOf = (value: unknown, field: string): string => {
	const text = stringOf(value, field);

	if (!HEX_DIGEST.test(text)) {
		throw new TypeError(`exposure design field "${field}" must be a 64-character lowercase hex digest`);
	}

	return text;
};

const positiveIntegerOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new TypeError(`exposure design field "${field}" must be a positive integer`);
	}

	return value;
};

const positiveNumberOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`exposure design field "${field}" must be a positive number`);
	}

	return value;
};

const classOf = (value: unknown, field: string): CaseClassType => {
	const text = stringOf(value, field);
	const found = CASE_CLASSES.find((candidate) => candidate === text);

	if (found === undefined) {
		throw new Error(`exposure design field "${field}" must be one of ${CASE_CLASSES.join(', ')}`);
	}

	return found;
};

const toolNamesOf = (value: unknown): readonly string[] => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new TypeError('exposure design field "ordinaryTools" must be a non-empty string array');
	}

	const names = value.map((item) => stringOf(item, 'ordinaryTools'));

	for (const name of names) {
		if (!TOOL_NAME.test(name)) {
			throw new Error(`exposure design ordinary tool "${name}" is invalid`);
		}
	}

	if (new Set(names).size !== names.length) {
		throw new Error('exposure design ordinary tools must be unique');
	}

	return [...names].sort();
};

const contractOf = (value: unknown, contract: EconomicContractType): ExposureDesignType['contract'] => {
	const record = recordOf(value, 'exposure design field "contract"');
	const id = stringOf(record['id'], 'contract.id');
	const version = positiveIntegerOf(record['version'], 'contract.version');
	const digest = digestOf(record['digest'], 'contract.digest');

	if (id !== contract.id || version !== contract.version || digest !== EVALUATION_CONTRACT_PIN.digest) {
		throw new Error('exposure design is not bound to the accepted validity-v2 contract');
	}

	return {id, version, digest};
};

const suiteOf = (value: unknown): ExposureDesignType['suite'] => {
	const record = recordOf(value, 'exposure design field "suite"');

	return {
		id: stringOf(record['id'], 'suite.id'),
		path: stringOf(record['path'], 'suite.path'),
		version: positiveIntegerOf(record['version'], 'suite.version'),
		hash: digestOf(record['hash'], 'suite.hash'),
		revision: stringOf(record['revision'], 'suite.revision'),
	};
};

const exposureOf = (value: unknown): ExposureDesignType['exposure'] => {
	const record = recordOf(value, 'exposure design field "exposure"');

	if (record['baseline'] !== 'direct-mcp' || record['treatment'] !== 'code-mode') {
		throw new Error('exposure design must compare direct-mcp with code-mode exactly once');
	}

	return {
		baseline: 'direct-mcp',
		treatment: 'code-mode',
		rationale: stringOf(record['rationale'], 'exposure.rationale'),
	};
};

const modelOf = (value: unknown): ExposureDesignType['model'] => {
	const record = recordOf(value, 'exposure design field "model"');

	return {
		provider: stringOf(record['provider'], 'model.provider'),
		modelId: stringOf(record['modelId'], 'model.modelId'),
		reference: stringOf(record['reference'], 'model.reference'),
		runtime: stringOf(record['runtime'], 'model.runtime'),
		generation: generationOf(record['generation'], 'exposure design'),
	};
};

const artifactOf = (value: unknown): ExposureDesignType['artifact'] => {
	const record = recordOf(value, 'exposure design field "artifact"');

	return {
		id: stringOf(record['id'], 'artifact.id'),
		digest: digestOf(record['digest'], 'artifact.digest'),
	};
};

const casesOf = (value: unknown): readonly ExposureCaseType[] => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('exposure design must declare at least one case');
	}

	const cases = value.map((rawCase, index): ExposureCaseType => {
		const item = recordOf(rawCase, `exposure case ${index + 1}`);
		rejectUnknown(item, new Set(['id', 'class']), `exposure case ${index + 1}`);
		const id = stringOf(item['id'], `cases[${index}].id`);

		if (!STABLE_ID.test(id)) {
			throw new Error(`exposure case id "${id}" must match ${STABLE_ID}`);
		}

		return {id, class: classOf(item['class'], `cases[${index}].class`)};
	});

	if (new Set(cases.map((testCase) => testCase.id)).size !== cases.length) {
		throw new Error('exposure design cases must be unique');
	}

	return cases;
};

const tariffOf = (value: unknown): ExposureDesignType['tariff'] => {
	const record = recordOf(value, 'exposure design field "tariff"');

	return {
		id: stringOf(record['id'], 'tariff.id'),
		source: stringOf(record['source'], 'tariff.source'),
		retrievedAt: timestampOf(record['retrievedAt'], 'tariff.retrievedAt'),
		digest: digestOf(record['digest'], 'tariff.digest'),
	};
};

const routeOf = (value: unknown): ExposureDesignType['route'] => {
	const record = recordOf(value, 'exposure design field "route"');

	return {
		suiteId: stringOf(record['suiteId'], 'route.suiteId'),
		path: stringOf(record['path'], 'route.path'),
		version: positiveIntegerOf(record['version'], 'route.version'),
		hash: digestOf(record['hash'], 'route.hash'),
		plan: stringOf(record['plan'], 'route.plan'),
		planHash: digestOf(record['planHash'], 'route.planHash'),
	};
};

const frozenProductionOf = (value: unknown): ExposureDesignType['frozenProduction'] => {
	const record = recordOf(value, 'exposure design field "frozenProduction"');

	if (record['exposure'] !== 'direct-mcp') {
		throw new Error('frozen production exposure must remain direct-mcp');
	}

	return {
		exposure: 'direct-mcp',
		certification: stringOf(record['certification'], 'frozenProduction.certification'),
		certificationDigest: digestOf(record['certificationDigest'], 'frozenProduction.certificationDigest'),
	};
};

const budgetOf = (value: unknown): ExposureBudgetType => {
	const record = recordOf(value, 'exposure design field "budget"');

	return {
		maxExecutions: positiveIntegerOf(record['maxExecutions'], 'budget.maxExecutions'),
		maxWallClockMs: positiveIntegerOf(record['maxWallClockMs'], 'budget.maxWallClockMs'),
		maxProviderCostUsd: positiveNumberOf(record['maxProviderCostUsd'], 'budget.maxProviderCostUsd'),
	};
};

const thresholdsOf = (value: unknown, contract: EconomicContractType): ExposureThresholdsType => {
	const record = recordOf(value, 'exposure design field "thresholds"');
	const confidence = positiveNumberOf(record['confidence'], 'thresholds.confidence');
	const minimumCostSaving = positiveNumberOf(record['minimumCostSaving'], 'thresholds.minimumCostSaving');
	const nonInferiorityMargin = positiveNumberOf(record['nonInferiorityMargin'], 'thresholds.nonInferiorityMargin');

	if (confidence !== contract.cost.confidence) {
		throw new Error(`exposure design confidence must equal the frozen contract ${contract.cost.confidence}`);
	}

	if (minimumCostSaving >= 1) {
		throw new Error('exposure design minimumCostSaving must be below 1');
	}

	if (nonInferiorityMargin !== contract.correctness.nonInferiorityMargin) {
		throw new Error(`exposure design non-inferiority margin must equal the frozen contract ${contract.correctness.nonInferiorityMargin}`);
	}

	if (record['falseAbsenceTolerance'] !== contract.correctness.falseAbsenceTolerance) {
		throw new Error('exposure design false-absence tolerance must equal the frozen contract');
	}

	return {confidence: 0.95, minimumCostSaving, nonInferiorityMargin, falseAbsenceTolerance: 0};
};

const decisionPolicyOf = (value: unknown): ExposureDecisionPolicyType => {
	const record = recordOf(value, 'exposure design field "decisionPolicy"');

	return {
		retainDirect: stringOf(record['retainDirect'], 'decisionPolicy.retainDirect'),
		adoptCodeMode: stringOf(record['adoptCodeMode'], 'decisionPolicy.adoptCodeMode'),
		inconclusive: stringOf(record['inconclusive'], 'decisionPolicy.inconclusive'),
	};
};

/**
 * Parses and validates a frozen exposure-comparison design.
 *
 * @param value - Parsed JSON value.
 * @param contract - Accepted economic contract the design must reproduce.
 * @returns The validated design with its content digest.
 */
export const exposureDesignOf = (value: unknown, contract: EconomicContractType = EVALUATION_CONTRACT): ExposureDesignType => {
	const record = recordOf(value, 'exposure design');
	rejectUnknown(record, DESIGN_KEYS, 'exposure design');

	if (record['recordType'] !== 'exposure-comparison-design') {
		throw new Error('exposure design recordType must be "exposure-comparison-design"');
	}

	if (record['schemaVersion'] !== EXPOSURE_DESIGN_SCHEMA_VERSION) {
		throw new Error(`exposure design schemaVersion must be ${EXPOSURE_DESIGN_SCHEMA_VERSION}`);
	}

	const id = stringOf(record['id'], 'id');

	if (!STABLE_ID.test(id)) {
		throw new Error(`exposure design id must match ${STABLE_ID}`);
	}

	if (record['status'] !== 'frozen') {
		throw new Error('exposure design must be frozen before execution');
	}

	const normalized: Omit<ExposureDesignType, 'digest'> = {
		recordType: 'exposure-comparison-design',
		schemaVersion: EXPOSURE_DESIGN_SCHEMA_VERSION,
		id,
		status: 'frozen',
		frozenAt: timestampOf(record['frozenAt'], 'frozenAt'),
		contract: contractOf(record['contract'], contract),
		suite: suiteOf(record['suite']),
		exposure: exposureOf(record['exposure']),
		model: modelOf(record['model']),
		artifact: artifactOf(record['artifact']),
		ordinaryTools: toolNamesOf(record['ordinaryTools']),
		cases: casesOf(record['cases']),
		repetitions: positiveIntegerOf(record['repetitions'], 'repetitions'),
		seed: stringOf(record['seed'], 'seed'),
		tariff: tariffOf(record['tariff']),
		route: routeOf(record['route']),
		frozenProduction: frozenProductionOf(record['frozenProduction']),
		budget: budgetOf(record['budget']),
		thresholds: thresholdsOf(record['thresholds'], contract),
		decisionPolicy: decisionPolicyOf(record['decisionPolicy']),
	};
	const digest = hashOf(normalized);
	const declaredDigest = record['digest'];

	if (typeof declaredDigest !== 'string' || !HEX_DIGEST.test(declaredDigest) || declaredDigest !== digest) {
		throw new Error('exposure design digest does not match its content; cases, artifact, model, or thresholds changed after the freeze');
	}

	return {...normalized, digest};
};
