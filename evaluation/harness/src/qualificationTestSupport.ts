import {readFileSync} from 'node:fs';
import path from 'node:path';
import {loadCanonicalArtifact} from './canonicalArtifact.ts';
import {HARNESS_VERSION} from './cliSupport.ts';
import {EVALUATION_CONTRACT_PIN} from './economicContract.ts';
import {environmentManifestOf} from './environment.ts';
import {executionIdentityDigestOf, executionIdentityOf} from './identity.ts';
import {LOCAL_CLAIM_CLASS} from './localContract.ts';
import {runOf} from './localTestSupport.ts';
import {reconcileProviderMeterLedger, type ProviderMeterLedgerType, type ProviderMeterReconciliationType} from './providerMeterLedger.ts';
import {providerUsageOf} from './providerUsage.ts';
import {QUALIFICATION_REPETITIONS, QUALIFICATION_TREATMENT_IDS, type QualificationPreflightType} from './qualificationContract.ts';
import {type qualificationReportOf} from './qualification.ts';
import {type RunResultType} from './runTypes.ts';
import {loadSuite, planOf} from './suite.ts';
import {presentedToolsOf} from './surface.ts';
import {toolSurfaceOf} from './treatment.ts';

export const EVALUATION_ROOT = path.resolve(import.meta.dirname, '..', '..');

const SUITE_PATH = path.join(EVALUATION_ROOT, 'suites', 'qualification.json');
const CANONICAL_PATH = path.join(EVALUATION_ROOT, 'canonical-artifact.json');
const ENVIRONMENT_PATH = path.join(EVALUATION_ROOT, 'environments', 'ollama-qwen3.8-27b-calibration.json');

export const loaded = loadSuite(SUITE_PATH);
export const canonical = loadCanonicalArtifact(CANONICAL_PATH);
export const environment = environmentManifestOf(JSON.parse(readFileSync(ENVIRONMENT_PATH, 'utf8')) as unknown);
export const CONTENT_HASH = 'a'.repeat(64);
const CAMPAIGN_ID = 'campaign-qualification';

type OptionsType = Readonly<{
	noIndexBytes?: number;
	canonicalBytes?: number;
	failCanonicalCaseId?: string;
	timedOut?: boolean;
	unknownTools?: readonly string[];
	metering?: 'exact' | 'none' | 'pending';
	requestOneMismatch?: boolean;
	externalPath?: boolean;
	unrestored?: boolean;
}>;

type SlotType = Readonly<{caseId: string; treatment: (typeof QUALIFICATION_TREATMENT_IDS)[number]; repetition: number}>;

const invalidReasonOf = (timedOut: boolean, unknownTools: readonly string[]): string | null => {
	if (timedOut) {
		return 'timed out';
	}

	return unknownTools.length > 0 ? `unknown tool(s): ${unknownTools.join(', ')}` : null;
};

const armValuesOf = (
	canonicalArm: boolean,
	options: OptionsType,
): Readonly<{retrievalBytes: number; toolCalls: number; durationMs: number; indexCalls: number; loaded: RunResultType['artifacts']['loaded']}> =>
	canonicalArm
		? {
				retrievalBytes: options.canonicalBytes ?? 200,
				toolCalls: 1,
				durationMs: 100,
				indexCalls: 1,
				loaded: {id: canonical.id, digest: canonical.digest},
			}
		: {retrievalBytes: options.noIndexBytes ?? 400, toolCalls: 2, durationMs: 200, indexCalls: 0, loaded: null};

const usageOf = (): ReturnType<typeof providerUsageOf> =>
	providerUsageOf({usage: {prompt_tokens: 10, prompt_tokens_details: {cached_tokens: 2}, completion_tokens: 3, total_tokens: 13}});

const meterOf = (surface: RunResultType['surface'], options: OptionsType): ProviderMeterReconciliationType | null => {
	if (options.metering === 'none') {
		return null;
	}

	const usage = usageOf();

	if (usage === null) {
		throw new Error('test usage must be parseable');
	}

	const pending = options.metering === 'pending';
	const toolNames = options.requestOneMismatch === true ? [...presentedToolsOf(surface), 'mystery'] : presentedToolsOf(surface);
	const ledger: ProviderMeterLedgerType = {
		recordType: 'provider-meter',
		provider: 'ollama',
		requests: [
			{
				ordinal: 1,
				kind: 'agent',
				provider: 'ollama',
				model: environment.model.reference,
				startedAt: '2026-01-01T00:00:00.000Z',
				completedAt: pending ? null : '2026-01-01T00:00:01.000Z',
				toolNames,
				requestBytes: 128,
				responseBytes: pending ? null : 256,
				settlement: pending ? null : {status: 'completed', usage},
			},
		],
	};

	return reconcileProviderMeterLedger(ledger);
};

export const preflightOf = (overrides: Readonly<Record<string, unknown>> = {}): QualificationPreflightType => ({
	result: 'pass',
	cases: loaded.cases.map((testCase) => ({
		caseId: testCase.id,
		pathsPresent: true,
		symbolProbe: testCase.class === 'semantic' ? {symbol: testCase.id, path: 'evaluation/fixtures/controlled-typescript/src/model.ts', ok: true} : null,
	})),
	treatments: QUALIFICATION_TREATMENT_IDS.map((treatmentId) => ({
		treatmentId,
		ready: true,
		filesIndexed: true,
		rootMatches: true,
		projectsConfigured: true,
		missingPaths: [],
		unindexedPaths: [],
		failures: [],
	})),
	failures: [],
	...overrides,
});

const resultOf = (slot: SlotType, options: OptionsType = {}): RunResultType => {
	const testCase = loaded.cases.find((item) => item.id === slot.caseId);
	const treatment = loaded.suite.treatments.find((item) => item.id === slot.treatment);

	if (testCase === undefined || treatment === undefined) {
		throw new Error(`missing case or treatment for ${slot.caseId}/${slot.treatment}`);
	}

	const canonicalArm = slot.treatment === 'canonical';
	const arm = armValuesOf(canonicalArm, options);
	const surface = toolSurfaceOf(treatment, canonicalArm ? ['find_symbol'] : []);
	const identity = executionIdentityOf({
		suite: loaded.suite,
		testCase,
		model: environment.model.reference,
		treatment,
		surface,
		subject: {mode: 'detached-worktree', revision: loaded.suite.revision, contentManifestHash: CONTENT_HASH, lockFileHash: null},
		artifacts: {accepted: null, candidate: null},
		configDigest: 'b'.repeat(64),
		repetitionIndex: slot.repetition,
		randomizationSeed: 'c'.repeat(64),
		harnessVersion: HARNESS_VERSION,
		environment,
	});
	const timedOut = options.timedOut === true;
	const unknownTools = options.unknownTools ?? [];
	const success = !(canonicalArm && slot.caseId === options.failCanonicalCaseId);
	const invalidReason = invalidReasonOf(timedOut, unknownTools);
	const base = runOf({
		caseId: slot.caseId,
		caseClass: testCase.class,
		treatment: slot.treatment,
		repetition: slot.repetition,
		success,
		retrievalBytes: arm.retrievalBytes,
		toolCalls: arm.toolCalls,
		durationMs: arm.durationMs,
	});

	return {
		...base,
		campaignId: CAMPAIGN_ID,
		identity,
		identityDigest: executionIdentityDigestOf(identity),
		model: environment.model.reference,
		revision: loaded.suite.revision,
		timedOut,
		exitCode: timedOut ? null : 0,
		outcome: timedOut ? 'timed-out' : 'completed',
		valid: invalidReason === null,
		invalidReason,
		externalPathAttemptCount: options.externalPath === true ? 1 : 0,
		isolation: {...base.isolation, restored: options.unrestored !== true},
		artifacts: {accepted: null, candidate: null, loaded: arm.loaded},
		providerMeter: meterOf(surface, options),
		surface,
		indexCalls: arm.indexCalls,
		routing: {...base.routing, codeIndexCalls: arm.indexCalls, unknownTools},
	};
};

export const slotsOf = (): ReturnType<typeof planOf<(typeof QUALIFICATION_TREATMENT_IDS)[number]>> =>
	planOf(loaded.cases, QUALIFICATION_TREATMENT_IDS, QUALIFICATION_REPETITIONS);

export const resultsOf = (options: OptionsType = {}): readonly RunResultType[] => slotsOf().map((slot) => resultOf(slot, options));

export const inputOf = (results: readonly RunResultType[], overrides: Record<string, unknown> = {}): Parameters<typeof qualificationReportOf>[0] => ({
	suite: {id: loaded.suite.id, version: loaded.suite.version, hash: loaded.suite.hash},
	loadedSuite: loaded.suite,
	caseList: loaded.cases,
	canonical,
	stagedCanonical: {id: canonical.id, digest: canonical.digest},
	environment,
	subject: {revision: loaded.suite.revision, contentManifestHash: CONTENT_HASH},
	harnessVersion: HARNESS_VERSION,
	campaignId: CAMPAIGN_ID,
	claimClass: LOCAL_CLAIM_CLASS,
	contract: EVALUATION_CONTRACT_PIN,
	preflight: preflightOf(),
	stateRootOutsideCheckout: true,
	expectedSlots: slotsOf(),
	results,
	...overrides,
});
