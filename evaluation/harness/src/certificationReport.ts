import {type CertificationBlockReportType, certificationBlockReportOf, type CertificationBlockInputType} from './certificationBlock.ts';
import {type CertificationBlockType, type CertificationDesignType} from './certificationDesign.ts';

/** Closed final-certification decisions. */
export const CERTIFICATION_DECISIONS = ['release', 'not-release'] as const;

export type CertificationDecisionType = (typeof CERTIFICATION_DECISIONS)[number];

/** Sanitized model-free route and contract evidence for the frozen suite. */
export type CertificationRouteEvidenceType = Readonly<{
	reportDigest: string;
	generatedAt: string;
	suite: Readonly<{id: string; version: number; hash: string; revision: string}>;
	plan: Readonly<{id: string; hash: string}>;
	artifacts: Readonly<{
		accepted: Readonly<{id: string; digest: string}> | null;
		candidate: Readonly<{id: string; digest: string}> | null;
	}>;
	gates: readonly Readonly<{id: string; result: string; detail: string}>[];
	presentedGates: number;
	contractProbes: Readonly<{accepted: number; candidate: number}>;
	passed: boolean;
}>;

/** One executable certification gate. */
export type CertificationGateType = Readonly<{
	id: string;
	passed: boolean;
	detail: string;
}>;

/** Closed release or not-release decision for the exact configuration. */
export type CertificationDecisionRecordType = Readonly<{
	decision: CertificationDecisionType;
	scope: string;
	reason: string;
	evidence: readonly string[];
	blocking: readonly string[];
}>;

/** Complete sanitized final-certification record. */
export type CertificationReportType = Readonly<{
	recordType: 'frontier-certification-report';
	schemaVersion: 1;
	claimClass: 'hosted-model-scoped';
	releaseAuthority: boolean;
	generatedAt: string;
	design: Readonly<{id: string; digest: string; frozenAt: string}>;
	contract: Readonly<{id: string; version: number; digest: string}>;
	model: CertificationDesignType['model'];
	exposure: CertificationDesignType['exposure'];
	authorization: CertificationDesignType['authorization'];
	artifacts: CertificationDesignType['artifacts'];
	subject: CertificationDesignType['subject'];
	tariff: CertificationDesignType['tariff'];
	route: CertificationRouteEvidenceType | null;
	blocks: readonly CertificationBlockReportType[];
	primary: CertificationBlockReportType | null;
	holdout: CertificationBlockReportType | null;
	gates: readonly CertificationGateType[];
	decision: CertificationDecisionRecordType;
	limitations: readonly string[];
}>;

const routeGateOf = (route: CertificationRouteEvidenceType | null, design: CertificationDesignType): CertificationGateType => {
	if (route === null) {
		return {id: 'model-free-route', passed: false, detail: 'no model-free route and contract evidence was produced'};
	}

	const exact =
		route.passed &&
		route.suite.id === design.route.suiteId &&
		route.suite.version === design.route.suiteVersion &&
		route.suite.hash === design.route.suiteHash &&
		route.plan.hash === design.route.planHash &&
		route.artifacts.accepted?.digest === design.artifacts.accepted.digest &&
		route.artifacts.candidate?.digest === design.artifacts.candidate.digest &&
		route.contractProbes.accepted > 0 &&
		route.contractProbes.candidate > 0;

	return {
		id: 'model-free-route',
		passed: exact,
		detail: exact
			? `${route.presentedGates}/3 gates passed; ${route.contractProbes.accepted} accepted and ${route.contractProbes.candidate} candidate contract probe(s)`
			: `route evidence does not match the frozen suite, plan, artifacts, or contract probes (gates=${route.presentedGates}/3)`,
	};
};

const blockGatesOf = (block: CertificationBlockReportType | null, id: CertificationBlockType['id']): readonly CertificationGateType[] => {
	if (block === null) {
		return [{id, passed: false, detail: 'block has no stored evidence'}];
	}

	const exactMetering =
		block.reliability.exactMetering === block.reliability.storedExecutions && block.reliability.storedExecutions === block.reliability.plannedExecutions;
	const valid = block.reliability.validExecutions === block.reliability.plannedExecutions && block.reliability.invalidExecutions === 0;
	const falseAbsence = block.economic.correctness.falseAbsenceCount === 0;
	const costGate =
		id === 'primary'
			? {passed: block.economic.cost.gate.passed, detail: block.economic.cost.gate.detail}
			: {passed: true, detail: `${block.economic.cost.gate.detail} (descriptive holdout; not a release gate)`};

	return [
		{
			id: `${id}-execution-validity`,
			passed: valid,
			detail: `${block.reliability.validExecutions}/${block.reliability.plannedExecutions} planned execution(s) valid`,
		},
		{
			id: `${id}-exact-metering`,
			passed: exactMetering,
			detail: `${block.reliability.exactMetering}/${block.reliability.storedExecutions} exact provider cost vector(s)`,
		},
		{
			id: `${id}-request-1-surface`,
			passed: block.reliability.requestOnePresent === block.reliability.storedExecutions,
			detail: `${block.reliability.requestOnePresent}/${block.reliability.storedExecutions} request-1 surface(s) exact`,
		},
		{id: `${id}-correctness`, passed: block.economic.correctness.gate.passed, detail: block.economic.correctness.gate.detail},
		{id: `${id}-false-absence`, passed: falseAbsence, detail: `${block.economic.correctness.falseAbsenceCount} candidate false absence(s)`},
		{id: `${id}-cost`, passed: costGate.passed, detail: costGate.detail},
	];
};

const scopeOf = (design: CertificationDesignType): string => {
	const [primaryBlock, holdoutBlock] = design.blocks;

	if (primaryBlock === undefined || holdoutBlock === undefined) {
		throw new Error('certification design requires a primary and a holdout block');
	}

	return `candidate ${design.artifacts.candidate.id}@${design.artifacts.candidate.digest} against no-index under ${design.model.reference} (${design.model.runtime}) with ${design.exposure.selected} exposure and Code Mode ${design.exposure.codeMode}, subject ${design.subject.revision}, frozen ${primaryBlock.suite.id} impact-class corpus plus the disjoint ${holdoutBlock.suite.id} block`;
};

const limitationsOf = (design: CertificationDesignType): readonly string[] => [
	...(design.sampleSize.power < design.sampleSize.desiredPower
		? [
				`The impact-class sample size is underpowered at the frozen ${design.sampleSize.designAlternative} design alternative: simulated power ${design.sampleSize.power.toFixed(4)} for ${design.sampleSize.desiredPower}. A wide interval or a non-significant result is not evidence of no effect.`,
			]
		: []),
	'The claim is scoped to the exact hosted model, adapter, corpus, artifact, exposure, and runtime pinned by the design.',
	'The frozen primary population is the impact-class subset of codeindex-release; the holdout block is descriptive and does not enlarge the claimed fixed-suite population.',
	'Direct native MCP is selected; this record does not compare Code Mode and makes no exposure-overhead claim.',
	'Fixed-suite inference and the paired-case-uniform case-generalization interval are reported separately and carry different authority.',
	'Provider cost is static-tariff arithmetic over retained provider components, not invoice-time cost.',
];

const evidenceOf = (
	design: CertificationDesignType,
	primary: CertificationBlockReportType | null,
	holdout: CertificationBlockReportType | null,
): readonly string[] => [
	`candidate=${design.artifacts.candidate.id}@${design.artifacts.candidate.digest}`,
	`accepted=${design.artifacts.accepted.id}@${design.artifacts.accepted.digest}`,
	`subject=${design.subject.revision}`,
	`contract=${design.contract.id}@${design.contract.version}:${design.contract.digest}`,
	`sample=${design.sampleSize.caseCount}x${design.sampleSize.repetitions} power=${design.sampleSize.power}`,
	primary === null
		? 'primary=none'
		: `primary-cost=${String(primary.economic.cost.ratio.value)} upper=${String(primary.economic.cost.oneSidedUpper95)} correctness=${String(primary.economic.correctness.pairedDifference)}`,
	holdout === null
		? 'holdout=none'
		: `holdout-cost=${String(holdout.economic.cost.ratio.value)} valid=${holdout.reliability.validExecutions}/${holdout.reliability.plannedExecutions}`,
];

/**
 * Builds the sanitized final-certification record and its single decision.
 *
 * A release is recorded only when the model-free route gate, every planned
 * execution, exact metering, request-1 surface, the frozen cost gate,
 * correctness non-inferiority, and zero false absence all pass for the exact
 * frozen configuration. Every other outcome is a closed `not-release` record.
 *
 * @param input - Frozen design, zero-spend gates, route evidence, and executed blocks.
 * @returns The complete sanitized record and one explicit decision.
 */
export const certificationReportOf = (
	input: Readonly<{
		design: CertificationDesignType;
		preflightGates: readonly CertificationGateType[];
		route: CertificationRouteEvidenceType | null;
		blocks: readonly CertificationBlockInputType[];
		generatedAt?: string;
	}>,
): CertificationReportType => {
	const reports = input.blocks.map((block) => certificationBlockReportOf({...block, design: input.design}));
	const primary = reports.find((report) => report.id === 'primary') ?? null;
	const holdout = reports.find((report) => report.id === 'holdout') ?? null;
	const gates: CertificationGateType[] = [
		...input.preflightGates,
		routeGateOf(input.route, input.design),
		...blockGatesOf(primary, 'primary'),
		...blockGatesOf(holdout, 'holdout'),
	];
	const blocking = gates.filter((gate) => !gate.passed).map((gate) => `${gate.id}: ${gate.detail}`);
	const released = blocking.length === 0 && primary !== null && holdout !== null && primary.passed && holdout.passed;
	const reason = released
		? `the candidate met every frozen gate for the pinned impact-class population: ${primary.economic.cost.gate.detail}`
		: blocking.length === 0
			? 'the campaign is incomplete; no release claim is supported'
			: `the exact frozen configuration did not meet every gate: ${blocking.join('; ')}`;

	return {
		recordType: 'frontier-certification-report',
		schemaVersion: 1,
		claimClass: 'hosted-model-scoped',
		releaseAuthority: released,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		design: {id: input.design.id, digest: input.design.digest, frozenAt: input.design.frozenAt},
		contract: input.design.contract,
		model: input.design.model,
		exposure: input.design.exposure,
		authorization: input.design.authorization,
		artifacts: input.design.artifacts,
		subject: input.design.subject,
		tariff: input.design.tariff,
		route: input.route,
		blocks: reports,
		primary,
		holdout,
		gates,
		decision: {
			decision: released ? 'release' : 'not-release',
			scope: scopeOf(input.design),
			reason,
			evidence: evidenceOf(input.design, primary, holdout),
			blocking,
		},
		limitations: limitationsOf(input.design),
	};
};
