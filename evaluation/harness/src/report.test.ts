import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {type AssertionType} from './assertions.ts';
import {hashOf} from './hash.ts';
import {type ExecutionIdentityType} from './identity.ts';
import {compare, type ReportMetadataType, REPORT_CLASSES} from './report.ts';
import {writeJsonAtomic, writeResult} from './result.ts';
import {type RunResultType} from './runTypes.ts';
import {type CaseClassType} from './schema.ts';
import {type TreatmentIdType} from './treatment.ts';

const CLI = path.join(import.meta.dirname, 'cli.ts');

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-report-'));
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

type RunOverridesType = Readonly<{
	caseId?: string;
	caseClass?: CaseClassType;
	treatment?: TreatmentIdType;
	repetition?: number;
	success?: boolean;
	valid?: boolean;
	outcome?: RunResultType['outcome'];
	retrievalBytes?: number;
	outputBytes?: number;
	toolCalls?: number;
	durationMs?: number;
	tokens?: Readonly<{input: number; output: number; reasoning: number}>;
	model?: string;
	identityDigestSeed?: string;
}>;

const assertion = (id: string): AssertionType => ({id, kind: 'test', expected: true, observed: true, result: 'pass'});

const identityOfRun = (input: Required<Pick<RunOverridesType, 'caseId' | 'treatment' | 'repetition'>> & RunOverridesType): ExecutionIdentityType => ({
	harness: {schemaVersion: '1.0', version: 11},
	suite: {id: 'suite-a', version: 1, hash: 'a'.repeat(64)},
	case: {id: input.caseId, hash: hashOf(input.caseId), promptHash: hashOf(`prompt-${input.caseId}`), timeoutMs: 5000},
	model: {
		provider: 'provider',
		modelId: input.model ?? 'model',
		digest: hashOf(input.model ?? 'model'),
		quantization: null,
		runtime: null,
		runtimeVersion: null,
		generationSettingsDigest: hashOf({model: input.model ?? 'model'}),
	},
	agent: {
		id: 'evaluator',
		version: '11',
		instructionsHash: 'b'.repeat(64),
		toolListHash: 'c'.repeat(64),
		permissionsHash: 'd'.repeat(64),
		contextBudgetTokens: 0,
	},
	treatment: {
		id: input.treatment,
		kind: input.treatment === 'no-index' ? 'no-index' : 'codeindex',
		definitionHash: hashOf(input.treatment),
		mcpSurfaceHash: hashOf({surface: input.treatment}),
	},
	subject: {
		revision: 'abc1234',
		isolationMode: 'detached-worktree',
		contentManifestHash: 'e'.repeat(64),
		projectFilesHash: 'e'.repeat(64),
		lockFileHash: null,
		externalFixtureHash: null,
	},
	artifacts: {
		accepted: {id: 'accepted', digest: 'f'.repeat(64)},
		candidate: input.treatment === 'no-index' ? null : {id: 'candidate', digest: hashOf(input.identityDigestSeed ?? 'candidate')},
	},
	codeIndex: {configDigest: '1'.repeat(64)},
	repetitionIndex: input.repetition,
	randomizationSeed: '2'.repeat(64),
});

type TokenEntryType = Readonly<{value: number; state: 'exact'; unit: 'tokens'; source: string}>;

const tokenEntry = (value: number): TokenEntryType => ({value, state: 'exact', unit: 'tokens', source: 'test'});

const callsOf = (callCount: number, retrievalBytes: number): RunResultType['toolCalls'] =>
	Array.from({length: callCount}, (_, index) => ({
		index: index + 1,
		rawIndex: index + 1,
		parentIndex: null,
		id: null,
		tool: 'read',
		family: 'read' as const,
		status: 'completed' as const,
		input: null,
		inputValid: false,
		inputText: '',
		outputBytes: index === 0 ? retrievalBytes : 0,
		authoritative: null,
		durationMs: 10,
		error: null,
	}));

const surfaceOf = (treatment: TreatmentIdType): RunResultType['surface'] => {
	const ordinary = ['bash', 'glob', 'grep', 'list', 'read'];
	const codeIndex = treatment === 'no-index' ? [] : ['codeindex_find_symbol'];

	return {
		treatmentId: treatment,
		ordinary,
		codeIndex,
		execute: 'absent',
		tools: [...ordinary, ...codeIndex],
		callable: [...ordinary, ...codeIndex],
		native: true,
		digest: hashOf({surface: treatment}),
	};
};

const routingOf = (treatment: TreatmentIdType, callCount: number): RunResultType['routing'] => ({
	ordinaryCalls: treatment === 'no-index' ? callCount : callCount - 1,
	codeIndexCalls: treatment === 'no-index' ? 0 : 1,
	executeCalls: 0,
	unknownTools: [],
	native: true,
});

const gradedAnswerOf = (caseId: string, success: boolean): RunResultType['grade'] => ({
	parsed: true,
	files: [caseId],
	absent: false,
	success,
	missing: [],
	forbidden: [],
	extra: [],
	falseAbsence: false,
	reason: success ? 'ok' : 'failed',
	result: success ? 'pass' : 'fail',
	assertions: [assertion('answer.file-set')],
});

const attemptsOf = (valid: boolean, durationMs: number): RunResultType['attempts'] => [
	{
		attempt: 1,
		startedAt: '2026-01-01T00:00:00.000Z',
		durationMs,
		exitCode: valid ? 0 : 1,
		signal: null,
		timedOut: false,
		rateLimited: false,
		invalidReason: valid ? null : 'agent exited with 1',
		rawFile: null,
	},
];

const outcomeValueOf = (declared: RunResultType['outcome'] | undefined, valid: boolean): RunResultType['outcome'] =>
	declared ?? (valid ? 'completed' : 'failed');

const loadedArtifactOf = (treatment: TreatmentIdType, identity: ExecutionIdentityType): ExecutionIdentityType['artifacts']['candidate'] =>
	treatment === 'no-index' ? null : identity.artifacts.candidate;

const indexCallCountOf = (treatment: TreatmentIdType): number => (treatment === 'no-index' ? 0 : 1);

const runOf = (overrides: RunOverridesType = {}): RunResultType => {
	const {
		caseId = 'case-a',
		caseClass = 'locate',
		treatment = 'no-index',
		repetition = 1,
		success = true,
		valid = true,
		retrievalBytes = 100,
		outputBytes = retrievalBytes,
		toolCalls: callCount = 2,
		durationMs = 1000,
		tokens = {input: 10, output: 5, reasoning: 1},
	} = overrides;
	const identity = identityOfRun({...overrides, caseId, treatment, repetition});
	const exitCode = valid ? 0 : 1;
	const invalidReason = valid ? null : 'agent exited with 1';

	return {
		recordType: 'result',
		schemaVersion: '1.0',
		campaignId: 'campaign-a',
		identity,
		identityDigest: hashOf(identity),
		attempt: 1,
		caseId,
		caseClass,
		treatment,
		treatmentDefinitionHash: identity.treatment.definitionHash,
		repetition,
		model: 'provider/model',
		revision: 'abc1234',
		startedAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:01.000Z',
		durationMs,
		exitCode,
		signal: null,
		timedOut: false,
		timeoutMs: 5000,
		outcome: outcomeValueOf(overrides.outcome, valid),
		defects: [],
		isolation: {mode: 'detached-worktree', clientStore: 'ephemeral', checkoutClean: true, revisionMatch: true, restored: true},
		artifacts: {
			accepted: identity.artifacts.accepted,
			candidate: identity.artifacts.candidate,
			loaded: loadedArtifactOf(treatment, identity),
		},
		usage: {
			input: tokens.input,
			output: tokens.output,
			reasoning: tokens.reasoning,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.001,
			available: true,
		},
		telemetry: {
			inputTokens: tokenEntry(tokens.input),
			outputTokens: tokenEntry(tokens.output),
			reasoningTokens: tokenEntry(tokens.reasoning),
			cacheReadTokens: {value: 0, state: 'exact', unit: 'tokens', source: 'test'},
			cacheWriteTokens: {value: 0, state: 'exact', unit: 'tokens', source: 'test'},
			reportedCost: {value: 0.001, state: 'exact', unit: 'usd', source: 'test'},
		},
		toolCalls: callsOf(callCount, retrievalBytes),
		outputBytes,
		familyBytes: {index: 0, search: 0, read: retrievalBytes, list: 0, write: 0, execute: 0, task: 0, other: 0},
		rawEventCount: 4,
		malformedEventCount: 0,
		streamTruncated: false,
		indexCalls: indexCallCountOf(treatment),
		surface: surfaceOf(treatment),
		routing: routingOf(treatment, callCount),
		errors: [],
		grade: gradedAnswerOf(caseId, success),
		workflow: {
			result: 'pass',
			compliant: true,
			violations: [],
			assertions: [assertion('workflow.calls')],
			broadSearches: [],
			duplicateReads: 0,
			fallbacksAfterAuthoritative: 0,
			firstRetrievalTool: 'read',
		},
		postRun: null,
		valid,
		invalidReason,
		rateLimited: false,
		attempts: attemptsOf(valid, durationMs),
		finalText: '{"files":["case-a"],"absent":false}',
		stderrTail: '',
	};
};

const metadata: ReportMetadataType = {
	campaignId: 'campaign-a',
	schemaVersion: '1.0',
	suite: {id: 'suite-a', version: 1, hash: 'a'.repeat(64), status: 'draft'},
	components: {harnessVersion: 11, graderVersion: 11},
	claimClass: 'none',
};

const campaignRuns = (
	values: Readonly<{
		noIndex: readonly number[];
		accepted: readonly number[];
		candidate: readonly number[];
	}>,
	caseId = 'case-a',
	caseClass: CaseClassType = 'locate',
): readonly RunResultType[] =>
	(
		[
			['no-index', values.noIndex],
			['accepted', values.accepted],
			['candidate', values.candidate],
		] as const
	).flatMap(([treatment, treatmentValues]) =>
		treatmentValues.map((retrievalBytes, index) =>
			runOf({
				caseId,
				caseClass,
				treatment,
				repetition: index + 1,
				retrievalBytes,
				outputBytes: retrievalBytes + 10,
				toolCalls: index + 1,
				durationMs: 1000 + retrievalBytes,
			}),
		),
	);

const simpleMedian = (values: readonly number[]): number => {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);

	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
};

describe('report', () => {
	it('a report retains per-run values and recomputable summary statistics', () => {
		const runs = campaignRuns({noIndex: [400, 500, 600], accepted: [200, 300, 400], candidate: [100, 200, 300]});
		const report = compare(runs, metadata);
		const candidateBytes = report.runs
			.filter((run) => run.treatment === 'candidate' && run.evidence && run.correctness === 'pass')
			.map((run) => run.retrievalBytes);

		assert.equal(report.recordType, 'report');
		assert.equal(report.campaign.campaignId, 'campaign-a');
		assert.equal(report.sources.resultCount, 9);
		assert.equal(report.sources.identityDigests.length, 9);
		assert.deepEqual(report.sources.schemaVersions, ['1.0']);
		assert.equal(report.runs.length, 9);

		assert.equal(report.candidate.statistics.retrievalBytes.sampleCount, 3);
		assert.equal(report.candidate.statistics.retrievalBytes.median, 200);
		assert.equal(report.candidate.statistics.retrievalBytes.p95, 300);
		assert.equal(report.candidate.statistics.retrievalBytes.min, 100);
		assert.equal(report.candidate.statistics.retrievalBytes.max, 300);
		assert.equal(report.candidate.statistics.toolCalls.median, 2);
		assert.equal(report.candidate.statistics.wallTimeMs.sampleCount, 3);
		assert.equal(report.candidate.statistics.tokens.sampleCount, 3);
		assert.equal(report.candidate.statistics.tokens.complete, true);
		assert.equal(simpleMedian(candidateBytes), report.candidate.statistics.retrievalBytes.median);
	});

	it('a campaign aggregates treatments whose tool and CodeIndex identities differ by design', () => {
		const runs = campaignRuns({noIndex: [400], accepted: [200], candidate: [100]}).map((run) => {
			if (run.treatment === 'no-index') {
				return run;
			}

			const identity = {
				...run.identity,
				agent: {
					...run.identity.agent,
					toolListHash: hashOf({surface: run.treatment}),
					permissionsHash: hashOf({config: run.treatment}),
				},
				codeIndex: {configDigest: hashOf({config: run.treatment})},
			};

			return {...run, identity, identityDigest: hashOf(identity)};
		});

		const report = compare(runs, metadata);

		assert.equal(report.runs.length, 3);
		assert.equal(report.sources.identityDigests.length, 3);
	});

	it('a campaign rejects tool or CodeIndex drift within one treatment', () => {
		const runs = campaignRuns({noIndex: [400, 500], accepted: [200], candidate: [100]}).map((run, index) => {
			if (run.treatment !== 'no-index' || index !== 1) {
				return run;
			}

			const identity = {...run.identity, codeIndex: {configDigest: hashOf('drifted')}};

			return {...run, identity, identityDigest: hashOf(identity)};
		});

		assert.throws(() => compare(runs, metadata), /tool or CodeIndex configuration/u);
	});

	it('a percentile from one observation still carries its sample count', () => {
		const runs = campaignRuns({noIndex: [400], accepted: [200], candidate: [100]});
		const report = compare(runs, metadata);
		const paired = report.paired.candidateVsNoIndex.metrics.retrievalBytes;

		assert.equal(report.noIndex.statistics.wallTimeMs.sampleCount, 1);
		assert.equal(report.candidate.statistics.wallTimeMs.sampleCount, 1);
		assert.equal(paired.pairCount, 1);
		assert.equal(paired.deltaInterval95, null);
		assert.equal(paired.ratioInterval95, null);
		assert.equal(paired.medianRatio, 0.25);
	});

	it('paired deltas use complete per-case pairs and deterministic bootstrap intervals', () => {
		const runs = [
			...campaignRuns({noIndex: [400, 500, 600], accepted: [350, 450, 550], candidate: [100, 200, 300]}, 'case-a', 'locate'),
			...campaignRuns({noIndex: [200, 300, 400], accepted: [180, 280, 380], candidate: [80, 120, 160]}, 'case-b', 'impact'),
			...campaignRuns({noIndex: [800, 900, 1000], accepted: [700, 800, 900], candidate: [400, 500, 600]}, 'case-c', 'implementation'),
		];
		const first = compare(runs, metadata);
		const second = compare(runs, metadata);
		const paired = first.paired.candidateVsNoIndex.metrics.retrievalBytes;

		assert.equal(paired.pairCount, 3);
		assert.equal(paired.baselineMedian, 500);
		assert.equal(paired.treatmentMedian, 200);
		assert.equal(paired.medianDelta, -300);
		assert.equal(paired.medianRatio, 0.4);
		assert.notEqual(paired.deltaInterval95, null);
		assert.equal((paired.deltaInterval95?.sampleCount ?? 0) > 0, true);
		assert.equal(paired.deltaInterval95?.confidence, 0.95);
		assert.deepEqual(first.paired.candidateVsNoIndex, second.paired.candidateVsNoIndex);
		assert.deepEqual(first.sources.comparisonDigest, second.sources.comparisonDigest);

		const caseA = first.caseDeltas.find((delta) => delta.caseId === 'case-a');

		assert.notEqual(caseA, undefined);
		assert.equal(caseA?.candidateVersusNoIndex.retrievalBytes.delta, -300);
		assert.equal(caseA.candidateVersusNoIndex.retrievalBytes.sampleCount, 3);
	});

	it('locate, impact, implementation, and semantic classes are reported beside the overall verdict', () => {
		const runs = REPORT_CLASSES.flatMap((caseClass) =>
			campaignRuns({noIndex: [400, 500, 600], accepted: [300, 400, 500], candidate: [100, 200, 300]}, `case-${caseClass}`, caseClass),
		);
		const report = compare(runs, metadata);

		assert.deepEqual(
			report.classes.map((item) => item.class),
			[...REPORT_CLASSES],
		);

		for (const item of report.classes) {
			assert.equal(item.caseIds.length, 1);
			assert.equal(item.candidate.statistics.retrievalBytes.median, 200);
			assert.equal(item.paired.candidateVsNoIndex.pairCount, 1);
		}
	});

	it('a report rejects pooled, duplicate, and incompatible result sets', () => {
		assert.throws(() => compare([], metadata), /at least one result/u);

		const undeclared = runOf({treatment: 'used-index' as TreatmentIdType});
		assert.throws(() => compare([undeclared], metadata), /undeclared treatment/u);

		const first = runOf({caseId: 'case-a', treatment: 'no-index', repetition: 1});
		const duplicate = runOf({caseId: 'case-a', treatment: 'no-index', repetition: 1});
		assert.throws(() => compare([first, duplicate], metadata), /duplicate slot/u);

		const otherModel = runOf({caseId: 'case-a', treatment: 'candidate', repetition: 1, model: 'other-model'});
		assert.throws(() => compare([first, otherModel], metadata), /incompatible campaign identities/u);

		const otherCaseIdentity = runOf({caseId: 'case-a', treatment: 'accepted', repetition: 1, identityDigestSeed: 'other-candidate'});
		const incompatible = {...otherCaseIdentity, identity: {...otherCaseIdentity.identity, case: {...otherCaseIdentity.identity.case, timeoutMs: 9000}}};

		assert.throws(() => compare([first, incompatible], metadata), /incompatible comparison identities/u);
	});

	it('the report command reads the manifest and prints the class verdict', (testContext: TestContext) => {
		const root = temporaryRoot(testContext);
		const campaignDir = path.join(root, 'results', 'campaign-a');
		const runs = campaignRuns({noIndex: [400, 500, 600], accepted: [300, 400, 500], candidate: [100, 200, 300]});

		for (const run of runs) {
			writeResult(path.join(campaignDir, run.caseId, run.treatment, `rep-${run.repetition}`, 'attempt-1.json'), run);
		}

		writeJsonAtomic(path.join(campaignDir, 'manifest.json'), {
			recordType: 'manifest',
			schemaVersion: '1.0',
			campaignId: 'campaign-a',
			suite: {id: 'suite-a', version: 1, hash: 'a'.repeat(64), status: 'draft'},
			components: {harnessVersion: 11},
			claimClass: 'none',
		});

		const executed = spawnSync(process.execPath, [CLI, 'report', '--run', 'campaign-a'], {
			encoding: 'utf8',
			env: {...process.env, EVALUATION_ROOT: root},
		});

		assert.equal(executed.status, 0, executed.stderr);
		assert.match(executed.stdout, /report campaign-a schema=1\.0/u);
		assert.match(executed.stdout, /class locate\s+cases 1/u);
		assert.match(executed.stdout, /Q2 (?<verdict>PASSED|NOT PASSED)/u);
	});
});
