import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {certificationDesignOf, type CertificationBlockType, type CertificationDesignType} from './certificationDesign.ts';
import {certificationPlanOf} from './certificationPlan.ts';
import {certificationReportOf, type CertificationGateType} from './certificationReport.ts';
import {runCertificationCampaignOf} from './certificationCampaign.ts';
import {preflightGatesOf, readJson, writeCertificationRecordOf} from './certificationGates.ts';
import {evaluationRoot, evaluationStateRoot, flagOf, manifestPathOf, primaryCheckout} from './cliSupport.ts';
import {type ExecutionProviderMeterType} from './executionMeter.ts';
import {hashOf} from './hash.ts';
import {loadHostedReference, type HostedReferenceType} from './hostedReference.ts';
import {loadSuite, suiteWithModelOf} from './suite.ts';
import {type CaseType, type SuiteType} from './schema.ts';

/** Executable whose version is pinned by the hosted reference. */
const OPENCODE_COMMAND = 'opencode';

/** Upstream endpoints for providers the certification command knows. */
const PROVIDER_UPSTREAMS: Readonly<Record<string, string>> = {deepseek: 'https://api.deepseek.com'};

type LoadedBlockType = Readonly<{
	block: CertificationBlockType;
	suite: SuiteType;
	cases: readonly CaseType[];
}>;

type CertificationInputsType = Readonly<{
	flags: Map<string, string[]>;
	design: CertificationDesignType;
	hosted: HostedReferenceType;
	blocks: readonly LoadedBlockType[];
}>;

const requiredFlagOf = (flags: Map<string, string[]>, name: string): string => {
	const value = flagOf(flags, name);

	if (value === undefined || value === 'true') {
		throw new Error(`--${name} is required`);
	}

	return value;
};

const providerMeterOf = (flags: Map<string, string[]>, provider: string, modelId: string): ExecutionProviderMeterType => {
	const upstream = flagOf(flags, 'provider-upstream') ?? PROVIDER_UPSTREAMS[provider];

	if (upstream === undefined || upstream === 'true') {
		throw new Error(`--provider-upstream is required for provider "${provider}"`);
	}

	const authName = requiredFlagOf(flags, 'provider-auth-env');
	const auth = process.env[authName];

	if (auth === undefined) {
		throw new Error(`--provider-auth-env names ${authName}, but that environment variable is not set`);
	}

	return {
		upstreamBaseUrl: upstream,
		provider,
		modelId,
		forbiddenPaths: [primaryCheckout],
		upstreamHeaders: {authorization: `Bearer ${auth}`},
	};
};

const observedRuntimeOf = (): string => {
	const version = execFileSync(OPENCODE_COMMAND, ['--version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});

	return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u.exec(version)?.[0] ?? 'unknown';
};

const blockSuiteOf = (design: CertificationDesignType, block: CertificationBlockType): Readonly<{suite: SuiteType; cases: readonly CaseType[]}> => {
	const loaded = loadSuite(path.resolve(evaluationRoot, block.suite.path));
	const suite = suiteWithModelOf(loaded.suite, loaded.cases, design.model.reference);

	if (loaded.suite.id !== block.suite.id || loaded.suite.version !== block.suite.version) {
		throw new Error(
			`certification block ${block.id} names ${block.suite.id}@${block.suite.version}, but ${block.suite.path} declares ${loaded.suite.id}@${loaded.suite.version}`,
		);
	}

	if (loaded.suite.revision !== block.suite.revision) {
		throw new Error(`certification block ${block.id} pins revision ${block.suite.revision}, but the suite pins ${loaded.suite.revision}`);
	}

	if (suite.hash !== block.suite.hash) {
		throw new Error(`certification block ${block.id} pins suite hash ${block.suite.hash}, but the loaded suite hashes to ${suite.hash}`);
	}

	const declaredIds = block.cases.map((testCase) => testCase.id);
	const selected = loaded.cases.filter((testCase) => declaredIds.includes(testCase.id));

	if (selected.length !== declaredIds.length || selected.map((testCase) => testCase.id).join('\u0000') !== declaredIds.join('\u0000')) {
		throw new Error(`certification block ${block.id} cases must equal the frozen suite cases in order`);
	}

	for (const [index, testCase] of selected.entries()) {
		const declared = block.cases[index];

		if (declared === undefined || declared.class !== testCase.class) {
			throw new Error(`certification case ${testCase.id} class does not match the frozen suite`);
		}
	}

	return {suite, cases: selected};
};

const inputsOf = (flags: Map<string, string[]>): CertificationInputsType => {
	const designPath = requiredFlagOf(flags, 'design');
	const design = certificationDesignOf(readJson(path.resolve(evaluationRoot, designPath)));
	const hosted = loadHostedReference(manifestPathOf(flags, 'hosted-reference'));

	if (hosted.provider !== design.model.provider || hosted.modelId !== design.model.modelId || hosted.reference !== design.model.reference) {
		throw new Error('certification design model does not match the hosted reference');
	}

	if (hosted.runtime.opencode !== design.model.runtime) {
		throw new Error(`certification design pins OpenCode ${design.model.runtime}, but the hosted reference pins ${hosted.runtime.opencode}`);
	}

	if (hashOf(hosted.generation) !== hashOf(design.model.generation)) {
		throw new Error('certification design generation settings do not match the hosted reference');
	}

	return {flags, design, hosted, blocks: design.blocks.map((block) => ({block, ...blockSuiteOf(design, block)}))};
};

const printDryRunOf = (inputs: CertificationInputsType, gates: readonly CertificationGateType[]): void => {
	const planned = inputs.design.blocks.reduce((total, block) => total + block.cases.length * block.repetitions * 2, 0);

	process.stderr.write(
		`certification ${inputs.design.id}: budget ${inputs.design.budget.maxExecutions} execution(s) / ${inputs.design.budget.maxProviderCostUsd} USD / ${inputs.design.budget.maxWallClockMs} ms; planned ${planned}\n`,
	);
	process.stderr.write(
		`sample size ${inputs.design.sampleSize.caseCount} case(s) x ${inputs.design.sampleSize.repetitions} pair(s), simulated power ${inputs.design.sampleSize.power} (target ${inputs.design.sampleSize.desiredPower})\n`,
	);

	for (const gate of gates) {
		process.stderr.write(`${gate.passed ? 'PASS' : 'FAIL'} ${gate.id} (${gate.detail})\n`);
	}

	for (const {block} of inputs.blocks) {
		const plan = certificationPlanOf(block, inputs.design.digest);

		process.stderr.write(
			`  ${block.id} ${block.suite.id} ${block.cases.length} case(s) x ${block.repetitions} pair(s) x 2 arms = ${plan.plan.length} execution(s)\n`,
		);
	}
};

const runtimeGateOf = (design: CertificationDesignType, observedRuntime: string): CertificationGateType => ({
	id: 'runtime',
	passed: observedRuntime === design.model.runtime,
	detail:
		observedRuntime === design.model.runtime ? `OpenCode ${observedRuntime}` : `design pins OpenCode ${design.model.runtime}, measured ${observedRuntime}`,
});

/**
 * Runs the frozen final frontier certification campaign.
 *
 * The command verifies every frozen identity before spend, re-runs the
 * model-free complete route and contract probes for the exact staged artifacts,
 * then executes the predeclared randomized paired primary and holdout blocks
 * without reusing any historical execution. It writes one sanitized record and
 * one explicit release or not-release decision.
 *
 * @param flags - Parsed CLI flags.
 */
export const certifyCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const inputs = inputsOf(flags);
	const {design} = inputs;
	const preflight = preflightGatesOf(
		design,
		inputs.blocks.map(({block, suite}) => ({block, suite})),
		inputs.hosted,
	);

	if (flags.has('dry-run')) {
		printDryRunOf(inputs, preflight);

		return;
	}

	const gates: readonly CertificationGateType[] = [...preflight, runtimeGateOf(design, observedRuntimeOf())];
	const recordDir = path.join(evaluationStateRoot, 'results', 'certification', `${design.id}-${design.digest.slice(0, 16)}`);
	const campaign = gates.every((gate) => gate.passed)
		? await runCertificationCampaignOf({
				flags,
				design,
				hosted: inputs.hosted,
				blocks: inputs.blocks.map(({block}) => ({block})),
				providerMeter: providerMeterOf(flags, inputs.hosted.provider, inputs.hosted.modelId),
			})
		: {
				route: null,
				blocks: [],
				gates: [{id: 'campaign-completeness', passed: false, detail: 'a zero-spend gate failed before execution'}],
				failure: null,
				spentUsd: 0,
			};
	const report = certificationReportOf({
		design,
		preflightGates: [...gates, ...campaign.gates],
		route: campaign.route,
		blocks: campaign.blocks,
	});

	writeCertificationRecordOf(recordDir, report);

	process.stdout.write(
		`certification ${report.decision.decision.toUpperCase()} release-authority=${String(report.releaseAuthority)} primary=${String(report.primary?.economic.cost.ratio.value ?? 'n/a')} upper=${String(report.primary?.economic.cost.oneSidedUpper95 ?? 'n/a')} correctness=${report.primary?.economic.correctness.gate.passed === true ? 'pass' : 'fail'}\n`,
	);
	process.stdout.write(`reason ${report.decision.reason}\n`);
	process.stdout.write(`record ${path.join(recordDir, 'certification.json')}\n`);

	if (campaign.failure !== null) {
		throw new Error(campaign.failure);
	}
};
