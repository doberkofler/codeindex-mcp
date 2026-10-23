import {type EconomicContractType, EVALUATION_CONTRACT} from './economicContract.ts';
import {type GenerationSettingsType} from './environment.ts';
import {hashOf} from './hash.ts';
import {type CaseClassType} from './schema.ts';
import {
	artifactsOf,
	assertPrimaryWeightsOf,
	authorizationOf,
	budgetOf,
	casesOf,
	contractOf,
	decisionPolicyOf,
	exposureOf,
	modelOf,
	positiveIntegerOf,
	recordOf,
	rejectUnknown,
	routeOf,
	sampleSizeOf,
	stringOf,
	subjectOf,
	suiteOf,
	tariffOf,
	thresholdsOf,
} from './certificationDesignFields.ts';

const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

/** Certification design schema understood by this harness. */
export const CERTIFICATION_DESIGN_SCHEMA_VERSION = 1 as const;

/** One frozen certification case and its preweighted share. */
export type CertificationCaseType = Readonly<{
	id: string;
	class: CaseClassType;
	weight: number;
}>;

/** Frozen suite identity for one certification block. */
export type CertificationSuitePinType = Readonly<{
	id: string;
	path: string;
	version: number;
	hash: string;
	revision: string;
}>;

/** One confirmatory or descriptive execution block. */
export type CertificationBlockType = Readonly<{
	id: 'primary' | 'holdout';
	role: 'confirmatory' | 'descriptive';
	suite: CertificationSuitePinType;
	cases: readonly CertificationCaseType[];
	repetitions: number;
}>;

/** Exact staged artifact the campaign may load. */
export type CertificationArtifactPinType = Readonly<{
	id: string;
	digest: string;
}>;

/** Upstream evidence that authorized this campaign before it ran. */
export type CertificationAuthorizationType = Readonly<{
	pilot: Readonly<{
		id: string;
		digest: string;
		decision: 'narrow-scope';
		scope: 'impact-class';
		report: string;
		reportDigest: string;
	}>;
	exposure: Readonly<{
		selected: 'direct-mcp';
		codeMode: 'absent';
		issue: '#50';
		record: string;
		recordDigest: string;
		status: 'selected-before-certification';
	}>;
}>;

/** Frozen budget and stop ceilings for one certification campaign. */
export type CertificationBudgetType = Readonly<{
	maxExecutions: number;
	maxWallClockMs: number;
	maxProviderCostUsd: number;
}>;

/** Frozen decision thresholds bound to the accepted contract. */
export type CertificationThresholdsType = Readonly<{
	costRatioTarget: number;
	confidence: 0.95;
	upperBoundBelow: 1;
	nonInferiorityMargin: number;
	falseAbsenceTolerance: 0;
	timeoutCeilingMs: number;
}>;

/** Sample-size decision recorded before the first hosted call. */
export type CertificationSampleSizeType = Readonly<{
	method: EconomicContractType['sampleSize']['method'];
	caseCount: number;
	repetitions: number;
	desiredPower: number;
	oneSidedAlpha: number;
	simulations: number;
	designAlternative: number;
	assumedEffectLogRatio: number;
	betweenCaseVariance: number;
	withinCaseVariance: number;
	power: number;
	reason: string | null;
	source: string;
}>;

/** Route gate pinned to the release suite and its model-free plan. */
export type CertificationRoutePinType = Readonly<{
	suiteId: string;
	suiteVersion: number;
	suiteHash: string;
	plan: string;
	planHash: string;
}>;

/** Complete frozen final-certification design. */
export type CertificationDesignType = Readonly<{
	recordType: 'certification-design';
	schemaVersion: typeof CERTIFICATION_DESIGN_SCHEMA_VERSION;
	id: string;
	status: 'frozen';
	frozenAt: string;
	authorization: CertificationAuthorizationType;
	contract: Readonly<{id: string; version: number; digest: string}>;
	model: Readonly<{
		provider: string;
		modelId: string;
		reference: string;
		runtime: string;
		generation: GenerationSettingsType;
	}>;
	exposure: Readonly<{selected: 'direct-mcp'; codeMode: 'absent'; rationale: string}>;
	artifacts: Readonly<{
		accepted: CertificationArtifactPinType;
		candidate: CertificationArtifactPinType;
	}>;
	subject: Readonly<{revision: string; contentManifestHash: string}>;
	tariff: Readonly<{
		id: string;
		source: string;
		retrievedAt: string;
		digest: string;
	}>;
	route: CertificationRoutePinType;
	blocks: readonly CertificationBlockType[];
	seed: string;
	budget: CertificationBudgetType;
	thresholds: CertificationThresholdsType;
	sampleSize: CertificationSampleSizeType;
	decisionPolicy: Readonly<{release: string; notRelease: string}>;
	digest: string;
}>;

const DESIGN_KEYS = new Set([
	'recordType',
	'schemaVersion',
	'id',
	'status',
	'frozenAt',
	'authorization',
	'contract',
	'model',
	'exposure',
	'artifacts',
	'subject',
	'tariff',
	'route',
	'blocks',
	'seed',
	'budget',
	'thresholds',
	'sampleSize',
	'decisionPolicy',
	'digest',
]);

const blockOf = (value: unknown, id: 'primary' | 'holdout', role: 'confirmatory' | 'descriptive'): CertificationBlockType => {
	const record = recordOf(value, `certification field "blocks.${id}"`);
	rejectUnknown(record, new Set(['id', 'role', 'suite', 'cases', 'repetitions']), `certification field "blocks.${id}"`);

	if (record['id'] !== id || record['role'] !== role) {
		throw new Error(`certification block "${id}" must declare id "${id}" and role "${role}"`);
	}

	return {
		id,
		role,
		suite: suiteOf(record['suite'], `blocks.${id}.suite`),
		cases: casesOf(record['cases'], `blocks.${id}.cases`),
		repetitions: positiveIntegerOf(record['repetitions'], `blocks.${id}.repetitions`),
	};
};

const blocksOf = (
	value: unknown,
	design: Pick<CertificationDesignType, 'subject' | 'route'>,
	contract: EconomicContractType,
): readonly CertificationBlockType[] => {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error('certification design must declare exactly one primary and one holdout block');
	}

	const entries: readonly unknown[] = value;
	const [rawPrimary, rawHoldout] = entries;
	const primary = blockOf(rawPrimary, 'primary', 'confirmatory');
	const holdout = blockOf(rawHoldout, 'holdout', 'descriptive');

	if (primary.suite.id !== 'codeindex-release') {
		throw new Error('certification primary block must use the frozen codeindex-release suite');
	}

	if (primary.cases.some((testCase) => testCase.class !== 'impact')) {
		throw new Error('certification primary block may contain only impact-class cases');
	}

	assertPrimaryWeightsOf(primary.cases, contract);

	if (holdout.suite.id !== 'codeindex-holdout') {
		throw new Error('certification holdout block must use the frozen codeindex-holdout suite');
	}

	const uniform = 1 / holdout.cases.length;

	if (holdout.cases.some((testCase) => Math.abs(testCase.weight - uniform) > 1e-9)) {
		throw new Error('certification holdout block weights must be uniform so the held-out population is fixed before execution');
	}

	const primaryIds = new Set(primary.cases.map((testCase) => testCase.id));

	if (holdout.cases.some((testCase) => primaryIds.has(testCase.id))) {
		throw new Error('certification holdout cases must be disjoint from the primary cases');
	}

	if (primary.suite.revision !== holdout.suite.revision || primary.suite.revision !== design.subject.revision) {
		throw new Error('certification suites and subject must share one frozen revision');
	}

	if (design.route.suiteId !== primary.suite.id || design.route.suiteVersion !== primary.suite.version || design.route.suiteHash !== primary.suite.hash) {
		throw new Error('certification route gate must cover the frozen primary suite');
	}

	return [primary, holdout];
};

export const certificationDesignOf = (value: unknown, contract: EconomicContractType = EVALUATION_CONTRACT): CertificationDesignType => {
	const record = recordOf(value, 'certification design');
	rejectUnknown(record, DESIGN_KEYS, 'certification design');

	if (record['recordType'] !== 'certification-design') {
		throw new Error('certification design recordType must be "certification-design"');
	}

	if (record['schemaVersion'] !== CERTIFICATION_DESIGN_SCHEMA_VERSION) {
		throw new Error(`certification design schemaVersion must be ${CERTIFICATION_DESIGN_SCHEMA_VERSION}`);
	}

	const id = stringOf(record['id'], 'id');

	if (!STABLE_ID.test(id)) {
		throw new Error(`certification design id must match ${STABLE_ID}`);
	}

	if (record['status'] !== 'frozen') {
		throw new Error('certification design must be frozen before execution');
	}

	const partial = {
		recordType: 'certification-design' as const,
		schemaVersion: CERTIFICATION_DESIGN_SCHEMA_VERSION,
		id,
		status: 'frozen' as const,
		frozenAt: stringOf(record['frozenAt'], 'frozenAt'),
		authorization: authorizationOf(record['authorization']),
		contract: contractOf(record['contract'], contract),
		model: modelOf(record['model']),
		exposure: exposureOf(record['exposure']),
		artifacts: artifactsOf(record['artifacts']),
		subject: subjectOf(record['subject']),
		tariff: tariffOf(record['tariff']),
		route: routeOf(record['route']),
		seed: stringOf(record['seed'], 'seed'),
		budget: budgetOf(record['budget']),
		thresholds: thresholdsOf(record['thresholds'], contract),
		decisionPolicy: decisionPolicyOf(record['decisionPolicy']),
	};
	const blocks = blocksOf(record['blocks'], partial, contract);
	const [primary] = blocks;

	if (primary === undefined) {
		throw new Error('certification design requires a primary block');
	}

	const sampleSize = sampleSizeOf(record['sampleSize'], primary, contract);
	const plannedExecutions = blocks.reduce((total, block) => total + block.cases.length * block.repetitions * 2, 0);

	if (plannedExecutions > partial.budget.maxExecutions) {
		throw new Error(`certification plan plans ${plannedExecutions} executions, above the frozen budget of ${partial.budget.maxExecutions}`);
	}

	const normalized: Omit<CertificationDesignType, 'digest'> = {...partial, blocks, sampleSize};
	const digest = hashOf(normalized);
	const declaredDigest = record['digest'];

	if (typeof declaredDigest !== 'string' || !HEX_DIGEST.test(declaredDigest) || declaredDigest !== digest) {
		throw new Error('certification design digest does not match its content; artifacts, weights, budget, sample size, or thresholds changed after the freeze');
	}

	return {...normalized, digest};
};
