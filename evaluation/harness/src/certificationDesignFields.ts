import {type EconomicContractType, EVALUATION_CONTRACT_PIN, TARIFF_SNAPSHOT} from './economicContract.ts';
import {generationOf} from './environmentFields.ts';
import {hashOf} from './hash.ts';
import {CASE_CLASSES, type CaseClassType} from './schema.ts';
import {
	type CertificationArtifactPinType,
	type CertificationAuthorizationType,
	type CertificationBlockType,
	type CertificationBudgetType,
	type CertificationCaseType,
	type CertificationDesignType,
	type CertificationRoutePinType,
	type CertificationSampleSizeType,
	type CertificationSuitePinType,
	type CertificationThresholdsType,
} from './certificationDesign.ts';

const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const recordOf = (value: unknown, context: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new TypeError(`${context} must be a JSON object`);
	}

	return value;
};

export const rejectUnknown = (value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void => {
	const unknown = Object.keys(value)
		.filter((key) => !allowed.has(key))
		.sort();

	if (unknown.length > 0) {
		throw new Error(`${context} has unknown field(s): ${unknown.join(', ')}`);
	}
};

export const stringOf = (value: unknown, field: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`certification field "${field}" must be a non-empty string`);
	}

	return value;
};

const digestOf = (value: unknown, field: string): string => {
	const text = stringOf(value, field);

	if (!HEX_DIGEST.test(text)) {
		throw new Error(`certification field "${field}" must be a lowercase SHA-256 digest`);
	}

	return text;
};

export const positiveIntegerOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new TypeError(`certification field "${field}" must be a positive integer`);
	}

	return value;
};

const nonNegativeIntegerOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new TypeError(`certification field "${field}" must be a non-negative integer`);
	}

	return value;
};

const positiveNumberOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`certification field "${field}" must be a positive number`);
	}

	return value;
};

const nonNegativeNumberOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`certification field "${field}" must be a non-negative number`);
	}

	return value;
};

const finiteNumberOf = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new TypeError(`certification field "${field}" must be a finite number`);
	}

	return value;
};

const classOf = (value: unknown, field: string): CaseClassType => {
	const text = stringOf(value, field);
	const found = CASE_CLASSES.find((candidate) => candidate === text);

	if (found === undefined) {
		throw new Error(`certification field "${field}" must be one of ${CASE_CLASSES.join(', ')}`);
	}

	return found;
};

export const authorizationOf = (value: unknown): CertificationAuthorizationType => {
	const record = recordOf(value, 'certification field "authorization"');
	rejectUnknown(record, new Set(['pilot', 'exposure']), 'certification field "authorization"');
	const pilot = recordOf(record['pilot'], 'certification field "authorization.pilot"');
	rejectUnknown(pilot, new Set(['id', 'digest', 'decision', 'scope', 'report', 'reportDigest']), 'certification field "authorization.pilot"');

	if (pilot['decision'] !== 'narrow-scope' || pilot['scope'] !== 'impact-class') {
		throw new Error('certification requires the development pilot narrow-scope decision for the impact class');
	}

	const exposure = recordOf(record['exposure'], 'certification field "authorization.exposure"');
	rejectUnknown(exposure, new Set(['selected', 'codeMode', 'issue', 'record', 'recordDigest', 'status']), 'certification field "authorization.exposure"');

	if (
		exposure['selected'] !== 'direct-mcp' ||
		exposure['codeMode'] !== 'absent' ||
		exposure['issue'] !== '#50' ||
		exposure['status'] !== 'selected-before-certification'
	) {
		throw new Error('certification requires the explicit direct-MCP exposure selection with Code Mode absent');
	}

	return {
		pilot: {
			id: stringOf(pilot['id'], 'authorization.pilot.id'),
			digest: digestOf(pilot['digest'], 'authorization.pilot.digest'),
			decision: 'narrow-scope',
			scope: 'impact-class',
			report: stringOf(pilot['report'], 'authorization.pilot.report'),
			reportDigest: digestOf(pilot['reportDigest'], 'authorization.pilot.reportDigest'),
		},
		exposure: {
			selected: 'direct-mcp',
			codeMode: 'absent',
			issue: '#50',
			record: stringOf(exposure['record'], 'authorization.exposure.record'),
			recordDigest: digestOf(exposure['recordDigest'], 'authorization.exposure.recordDigest'),
			status: 'selected-before-certification',
		},
	};
};

export const contractOf = (value: unknown, contract: EconomicContractType): CertificationDesignType['contract'] => {
	const record = recordOf(value, 'certification field "contract"');
	rejectUnknown(record, new Set(['id', 'version', 'digest']), 'certification field "contract"');

	const id = stringOf(record['id'], 'contract.id');
	const version = positiveIntegerOf(record['version'], 'contract.version');
	const digest = digestOf(record['digest'], 'contract.digest');

	if (id !== contract.id || version !== contract.version || digest !== EVALUATION_CONTRACT_PIN.digest) {
		throw new Error('certification design is not bound to the accepted validity-v2 contract');
	}

	return {id, version, digest};
};

export const modelOf = (value: unknown): CertificationDesignType['model'] => {
	const record = recordOf(value, 'certification field "model"');
	rejectUnknown(record, new Set(['provider', 'modelId', 'reference', 'runtime', 'generation']), 'certification field "model"');

	return {
		provider: stringOf(record['provider'], 'model.provider'),
		modelId: stringOf(record['modelId'], 'model.modelId'),
		reference: stringOf(record['reference'], 'model.reference'),
		runtime: stringOf(record['runtime'], 'model.runtime'),
		generation: generationOf(record['generation'], 'certification field "model.generation"'),
	};
};

export const exposureOf = (value: unknown): CertificationDesignType['exposure'] => {
	const record = recordOf(value, 'certification field "exposure"');
	rejectUnknown(record, new Set(['selected', 'codeMode', 'rationale']), 'certification field "exposure"');

	if (record['selected'] !== 'direct-mcp' || record['codeMode'] !== 'absent') {
		throw new Error('certification design must explicitly select direct MCP with Code Mode absent');
	}

	return {selected: 'direct-mcp', codeMode: 'absent', rationale: stringOf(record['rationale'], 'exposure.rationale')};
};

const artifactOf = (value: unknown, field: string): CertificationArtifactPinType => {
	const record = recordOf(value, `certification field "${field}"`);
	rejectUnknown(record, new Set(['id', 'digest']), `certification field "${field}"`);

	return {
		id: stringOf(record['id'], `${field}.id`),
		digest: digestOf(record['digest'], `${field}.digest`),
	};
};

export const artifactsOf = (value: unknown): CertificationDesignType['artifacts'] => {
	const record = recordOf(value, 'certification field "artifacts"');
	rejectUnknown(record, new Set(['accepted', 'candidate']), 'certification field "artifacts"');

	return {
		accepted: artifactOf(record['accepted'], 'artifacts.accepted'),
		candidate: artifactOf(record['candidate'], 'artifacts.candidate'),
	};
};

export const subjectOf = (value: unknown): CertificationDesignType['subject'] => {
	const record = recordOf(value, 'certification field "subject"');
	rejectUnknown(record, new Set(['revision', 'contentManifestHash']), 'certification field "subject"');

	return {
		revision: stringOf(record['revision'], 'subject.revision'),
		contentManifestHash: digestOf(record['contentManifestHash'], 'subject.contentManifestHash'),
	};
};

export const tariffOf = (value: unknown): CertificationDesignType['tariff'] => {
	const record = recordOf(value, 'certification field "tariff"');
	rejectUnknown(record, new Set(['id', 'source', 'retrievedAt', 'digest']), 'certification field "tariff"');
	const tariff = {
		id: stringOf(record['id'], 'tariff.id'),
		source: stringOf(record['source'], 'tariff.source'),
		retrievedAt: stringOf(record['retrievedAt'], 'tariff.retrievedAt'),
		digest: digestOf(record['digest'], 'tariff.digest'),
	};

	if (tariff.id !== TARIFF_SNAPSHOT.id || tariff.source !== TARIFF_SNAPSHOT.source || tariff.retrievedAt !== TARIFF_SNAPSHOT.retrievedAt) {
		throw new Error('certification design tariff does not match the frozen contract tariff snapshot');
	}

	if (hashOf(TARIFF_SNAPSHOT) !== tariff.digest) {
		throw new Error('certification design tariff digest does not match the frozen contract tariff snapshot');
	}

	return tariff;
};

export const routeOf = (value: unknown): CertificationRoutePinType => {
	const record = recordOf(value, 'certification field "route"');
	rejectUnknown(record, new Set(['suiteId', 'suiteVersion', 'suiteHash', 'plan', 'planHash']), 'certification field "route"');

	return {
		suiteId: stringOf(record['suiteId'], 'route.suiteId'),
		suiteVersion: positiveIntegerOf(record['suiteVersion'], 'route.suiteVersion'),
		suiteHash: digestOf(record['suiteHash'], 'route.suiteHash'),
		plan: stringOf(record['plan'], 'route.plan'),
		planHash: digestOf(record['planHash'], 'route.planHash'),
	};
};

export const suiteOf = (value: unknown, field: string): CertificationSuitePinType => {
	const record = recordOf(value, `certification field "${field}"`);
	rejectUnknown(record, new Set(['id', 'path', 'version', 'hash', 'revision']), `certification field "${field}"`);

	return {
		id: stringOf(record['id'], `${field}.id`),
		path: stringOf(record['path'], `${field}.path`),
		version: positiveIntegerOf(record['version'], `${field}.version`),
		hash: digestOf(record['hash'], `${field}.hash`),
		revision: stringOf(record['revision'], `${field}.revision`),
	};
};

export const casesOf = (value: unknown, field: string): readonly CertificationCaseType[] => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`certification field "${field}" must declare at least one case`);
	}

	const cases = value.map((rawCase, index): CertificationCaseType => {
		const item = recordOf(rawCase, `certification field "${field}[${index}]"`);
		rejectUnknown(item, new Set(['id', 'class', 'weight']), `certification field "${field}[${index}]"`);
		const id = stringOf(item['id'], `${field}[${index}].id`);

		if (!STABLE_ID.test(id)) {
			throw new Error(`certification case id "${id}" must match ${STABLE_ID}`);
		}

		return {
			id,
			class: classOf(item['class'], `${field}[${index}].class`),
			weight: positiveNumberOf(item['weight'], `${field}[${index}].weight`),
		};
	});

	if (new Set(cases.map((testCase) => testCase.id)).size !== cases.length) {
		throw new Error(`certification field "${field}" must contain unique cases`);
	}

	const total = cases.reduce((sum, testCase) => sum + testCase.weight, 0);

	if (Math.abs(total - 1) > 1e-9) {
		throw new Error(`certification field "${field}" weights must sum to 1; observed ${total}`);
	}

	return cases;
};

export const assertPrimaryWeightsOf = (cases: readonly CertificationCaseType[], contract: EconomicContractType): void => {
	const frozenTotal = cases.reduce((sum, testCase) => sum + (contract.suite.caseWeights[testCase.id] ?? 0), 0);

	for (const testCase of cases) {
		const frozen = contract.suite.caseWeights[testCase.id];

		if (frozen === undefined || frozen <= 0) {
			throw new Error(`certification case ${testCase.id} has no positive frozen contract weight`);
		}

		const expected = frozen / frozenTotal;

		if (Math.abs(expected - testCase.weight) > 1e-9) {
			throw new Error(`certification case ${testCase.id} weight ${testCase.weight} does not match the frozen contract weight ${expected}`);
		}
	}
};

export const budgetOf = (value: unknown): CertificationBudgetType => {
	const record = recordOf(value, 'certification field "budget"');
	rejectUnknown(record, new Set(['maxExecutions', 'maxWallClockMs', 'maxProviderCostUsd']), 'certification field "budget"');

	return {
		maxExecutions: positiveIntegerOf(record['maxExecutions'], 'budget.maxExecutions'),
		maxWallClockMs: positiveIntegerOf(record['maxWallClockMs'], 'budget.maxWallClockMs'),
		maxProviderCostUsd: positiveNumberOf(record['maxProviderCostUsd'], 'budget.maxProviderCostUsd'),
	};
};

export const thresholdsOf = (value: unknown, contract: EconomicContractType): CertificationThresholdsType => {
	const record = recordOf(value, 'certification field "thresholds"');
	rejectUnknown(
		record,
		new Set(['costRatioTarget', 'confidence', 'upperBoundBelow', 'nonInferiorityMargin', 'falseAbsenceTolerance', 'timeoutCeilingMs']),
		'certification field "thresholds"',
	);
	const thresholds = {
		costRatioTarget: positiveNumberOf(record['costRatioTarget'], 'thresholds.costRatioTarget'),
		confidence: positiveNumberOf(record['confidence'], 'thresholds.confidence'),
		upperBoundBelow: positiveNumberOf(record['upperBoundBelow'], 'thresholds.upperBoundBelow'),
		nonInferiorityMargin: nonNegativeNumberOf(record['nonInferiorityMargin'], 'thresholds.nonInferiorityMargin'),
		falseAbsenceTolerance: nonNegativeIntegerOf(record['falseAbsenceTolerance'], 'thresholds.falseAbsenceTolerance'),
		timeoutCeilingMs: positiveIntegerOf(record['timeoutCeilingMs'], 'thresholds.timeoutCeilingMs'),
	};

	if (thresholds.costRatioTarget !== contract.cost.targetRatio) {
		throw new Error(`certification cost target ${thresholds.costRatioTarget} differs from the frozen contract ${contract.cost.targetRatio}`);
	}

	if (thresholds.confidence !== contract.cost.confidence || thresholds.upperBoundBelow !== contract.cost.upperBoundBelow) {
		throw new Error('certification cost confidence or upper bound differs from the frozen contract');
	}

	if (
		thresholds.nonInferiorityMargin !== contract.correctness.nonInferiorityMargin ||
		thresholds.falseAbsenceTolerance !== contract.correctness.falseAbsenceTolerance
	) {
		throw new Error('certification correctness threshold differs from the frozen contract');
	}

	if (thresholds.timeoutCeilingMs !== contract.latency.timeoutCeilingMs) {
		throw new Error('certification timeout ceiling differs from the frozen contract');
	}

	return {
		costRatioTarget: thresholds.costRatioTarget,
		confidence: 0.95,
		upperBoundBelow: 1,
		nonInferiorityMargin: thresholds.nonInferiorityMargin,
		falseAbsenceTolerance: 0,
		timeoutCeilingMs: thresholds.timeoutCeilingMs,
	};
};

export const sampleSizeOf = (value: unknown, primary: CertificationBlockType, contract: EconomicContractType): CertificationSampleSizeType => {
	const record = recordOf(value, 'certification field "sampleSize"');
	rejectUnknown(
		record,
		new Set([
			'method',
			'caseCount',
			'repetitions',
			'desiredPower',
			'oneSidedAlpha',
			'simulations',
			'designAlternative',
			'assumedEffectLogRatio',
			'betweenCaseVariance',
			'withinCaseVariance',
			'power',
			'reason',
			'source',
		]),
		'certification field "sampleSize"',
	);

	if (record['method'] !== contract.sampleSize.method) {
		throw new Error(`certification sample-size method must be ${contract.sampleSize.method}`);
	}

	const caseCount = positiveIntegerOf(record['caseCount'], 'sampleSize.caseCount');
	const repetitions = positiveIntegerOf(record['repetitions'], 'sampleSize.repetitions');
	const desiredPower = positiveNumberOf(record['desiredPower'], 'sampleSize.desiredPower');
	const oneSidedAlpha = positiveNumberOf(record['oneSidedAlpha'], 'sampleSize.oneSidedAlpha');
	const simulations = positiveIntegerOf(record['simulations'], 'sampleSize.simulations');
	const power = nonNegativeNumberOf(record['power'], 'sampleSize.power');
	const reasonValue = record['reason'];
	const reason = reasonValue === null ? null : stringOf(reasonValue, 'sampleSize.reason');

	if (caseCount !== primary.cases.length || repetitions !== primary.repetitions) {
		throw new Error('certification sample size must match the primary block case count and repetitions');
	}

	if (
		desiredPower !== contract.sampleSize.desiredPower ||
		oneSidedAlpha !== contract.sampleSize.oneSidedAlpha ||
		simulations !== contract.sampleSize.simulations
	) {
		throw new Error('certification sample-size settings differ from the frozen contract');
	}

	if (repetitions > contract.sampleSize.maxRepetitions) {
		throw new Error(`certification repetitions ${repetitions} exceed the frozen maximum ${contract.sampleSize.maxRepetitions}`);
	}

	if (power > 1) {
		throw new Error('certification sample-size power must be at most 1');
	}

	if (power < desiredPower && reason === null) {
		throw new Error('an underpowered certification sample size must record its closed reason');
	}

	return {
		method: contract.sampleSize.method,
		caseCount,
		repetitions,
		desiredPower,
		oneSidedAlpha,
		simulations,
		designAlternative: positiveNumberOf(record['designAlternative'], 'sampleSize.designAlternative'),
		assumedEffectLogRatio: finiteNumberOf(record['assumedEffectLogRatio'], 'sampleSize.assumedEffectLogRatio'),
		betweenCaseVariance: nonNegativeNumberOf(record['betweenCaseVariance'], 'sampleSize.betweenCaseVariance'),
		withinCaseVariance: nonNegativeNumberOf(record['withinCaseVariance'], 'sampleSize.withinCaseVariance'),
		power,
		reason,
		source: stringOf(record['source'], 'sampleSize.source'),
	};
};

export const decisionPolicyOf = (value: unknown): CertificationDesignType['decisionPolicy'] => {
	const record = recordOf(value, 'certification field "decisionPolicy"');
	rejectUnknown(record, new Set(['release', 'notRelease']), 'certification field "decisionPolicy"');

	return {
		release: stringOf(record['release'], 'decisionPolicy.release'),
		notRelease: stringOf(record['notRelease'], 'decisionPolicy.notRelease'),
	};
};

/**
 * Parses and validates the frozen final-certification design.
 *
 * The design pins both artifacts, the subject revision and content manifest,
 * suites and case weights, provider/model/runtime/generation settings, exposure,
 * tariff snapshot, route gate, thresholds, timeout, budget, and sample size
 * before any hosted call. The digest covers all of it, so a post-result change
 * to any of them is rejected.
 *
 * @param value - Parsed JSON value.
 * @param contract - Accepted economic contract the design must reproduce.
 * @returns The validated design with its content digest.
 */
