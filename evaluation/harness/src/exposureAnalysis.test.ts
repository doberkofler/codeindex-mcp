import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {TARIFF_SNAPSHOT} from './economicContract.ts';
import {exposureReportOf} from './exposureAnalysis.ts';
import {exposureDesignOf, type ExposureDesignType} from './exposureDesign.ts';
import {type ExposureCoreQueryType} from './exposureCore.ts';
import {exposurePlanOf} from './exposurePlan.ts';
import {hashOf} from './hash.ts';
import {type ExecutionIdentityType} from './identity.ts';
import {reconcileProviderMeterLedger, type ProviderMeterLedgerType} from './providerMeterLedger.ts';
import {type RunResultType} from './runTypes.ts';
import {presentedToolsOf} from './surface.ts';
import {type TaskCostVectorType, taskCostVectorOf} from './taskCost.ts';
import {toolSurfaceOf, treatmentOf} from './treatment.ts';

const designOf = (): ExposureDesignType => {
	const base = {
		recordType: 'exposure-comparison-design',
		schemaVersion: 1,
		id: 'direct-vs-code-mode-v1',
		status: 'frozen',
		frozenAt: '2026-10-25T00:00:00.000Z',
		contract: {id: 'evaluation-validity-v2', version: 2, digest: '179bb5df1bc96ee86c54da20f26034a59fe50671dfc9912d805ed4588204a22f'},
		suite: {id: 'codeindex-exposure', path: 'suites/exposure.json', version: 1, hash: 'a'.repeat(64), revision: 'abc1234'},
		exposure: {baseline: 'direct-mcp' as const, treatment: 'code-mode' as const, rationale: 'same artifact'},
		model: {
			provider: 'deepseek',
			modelId: 'deepseek-flash',
			reference: 'deepseek/deepseek-flash',
			runtime: '2.1.4',
			generation: {temperature: null, topP: null, topK: null, repeatPenalty: null, stop: []},
		},
		artifact: {id: 'candidate', digest: 'b'.repeat(64)},
		ordinaryTools: ['bash', 'glob', 'grep', 'read'],
		cases: [
			{id: 'case-a', class: 'impact' as const},
			{id: 'case-b', class: 'impact' as const},
		],
		repetitions: 1,
		seed: 'seed',
		tariff: {id: TARIFF_SNAPSHOT.id, source: TARIFF_SNAPSHOT.source, retrievedAt: TARIFF_SNAPSHOT.retrievedAt, digest: hashOf(TARIFF_SNAPSHOT)},
		route: {
			suiteId: 'codeindex-release',
			path: 'routes/codeindex-release.json',
			version: 1,
			hash: 'c'.repeat(64),
			plan: 'routes/codeindex-release.json',
			planHash: 'd'.repeat(64),
		},
		frozenProduction: {exposure: 'direct-mcp' as const, certification: 'reports/certification-eval-037.json', certificationDigest: 'e'.repeat(64)},
		budget: {maxExecutions: 8, maxWallClockMs: 60_000, maxProviderCostUsd: 1},
		thresholds: {confidence: 0.95 as const, minimumCostSaving: 0.05, nonInferiorityMargin: 0.02, falseAbsenceTolerance: 0 as const},
		decisionPolicy: {retainDirect: 'keep', adoptCodeMode: 'reopen', inconclusive: 'blocked'},
	};

	return exposureDesignOf({...base, digest: hashOf(base)});
};

const direct = treatmentOf({
	id: 'direct-mcp',
	kind: 'codeindex',
	ordinaryTools: ['bash', 'glob', 'grep', 'read'],
	codeMode: 'absent',
	artifact: {id: 'candidate', root: 'artifacts/candidate', entryPoint: 'mcp.mjs', digest: null},
	mcp: {server: 'codeindex', codemode: false},
});
const wrapped = treatmentOf({
	id: 'code-mode',
	kind: 'codeindex',
	ordinaryTools: ['bash', 'glob', 'grep', 'read'],
	codeMode: 'present',
	artifact: {id: 'candidate', root: 'artifacts/candidate', entryPoint: 'mcp.mjs', digest: null},
	mcp: {server: 'codeindex', codemode: true},
});

const identityOf = (): ExecutionIdentityType => ({
	harness: {schemaVersion: '1.0', version: 11},
	suite: {id: 'codeindex-exposure', version: 1, hash: 'a'.repeat(64)},
	case: {id: 'case-a', hash: '1'.repeat(64), promptHash: '2'.repeat(64), timeoutMs: 5000},
	model: {
		provider: 'deepseek',
		modelId: 'deepseek-flash',
		digest: '3'.repeat(64),
		quantization: null,
		runtime: 'hosted',
		runtimeVersion: '2.1.4',
		generationSettingsDigest: '4'.repeat(64),
	},
	agent: {
		id: 'evaluator',
		version: '11',
		instructionsHash: '5'.repeat(64),
		toolListHash: '6'.repeat(64),
		permissionsHash: '7'.repeat(64),
		contextBudgetTokens: 0,
	},
	treatment: {id: 'direct-mcp', kind: 'codeindex', definitionHash: '8'.repeat(64), mcpSurfaceHash: '9'.repeat(64)},
	subject: {
		revision: 'abc1234',
		isolationMode: 'detached-worktree',
		contentManifestHash: 'a'.repeat(64),
		projectFilesHash: 'b'.repeat(64),
		lockFileHash: null,
		externalFixtureHash: null,
	},
	artifacts: {accepted: null, candidate: {id: 'candidate', digest: 'b'.repeat(64)}},
	codeIndex: {configDigest: 'c'.repeat(64)},
	repetitionIndex: 1,
	randomizationSeed: 'd'.repeat(64),
});

const metersOf = (
	input: Readonly<{surface: ReturnType<typeof toolSurfaceOf>; requestBytes: number; responseBytes: number; inputTokens: number}>,
): Readonly<{ledger: ProviderMeterLedgerType; cost: TaskCostVectorType}> => {
	const ledger: ProviderMeterLedgerType = {
		recordType: 'provider-meter',
		provider: 'deepseek',
		requests: [
			{
				ordinal: 1,
				kind: 'agent',
				provider: 'deepseek',
				model: 'deepseek-flash',
				startedAt: '2026-10-25T06:00:00.000Z',
				completedAt: '2026-10-25T06:00:01.000Z',
				toolNames: presentedToolsOf(input.surface),
				requestBytes: input.requestBytes,
				responseBytes: input.responseBytes,
				settlement: {
					status: 'completed',
					usage: {
						nonCachedInputTokens: input.inputTokens,
						cacheReadTokens: 0,
						cacheWriteTokens: {},
						visibleOutputTokens: 10,
						reasoningTokens: 0,
						reportedCostUsd: null,
						missingFields: [],
						invalidFields: [],
						complete: true,
					},
				},
			},
		],
	};

	return {ledger, cost: taskCostVectorOf(ledger, TARIFF_SNAPSHOT)};
};

const runOf = (
	input: Readonly<{
		caseId: string;
		treatment: 'direct-mcp' | 'code-mode';
		requestBytes: number;
		responseBytes: number;
		toolCalls: number;
		durationMs: number;
		inputTokens: number;
		valid?: boolean;
	}>,
): RunResultType => {
	const definition = input.treatment === 'direct-mcp' ? direct : wrapped;
	const surface = toolSurfaceOf(definition, ['find_symbol']);
	const {ledger, cost} = metersOf({surface, requestBytes: input.requestBytes, responseBytes: input.responseBytes, inputTokens: input.inputTokens});
	const valid = input.valid ?? true;

	return {
		recordType: 'result',
		schemaVersion: '1.0',
		campaignId: 'campaign-a',
		identity: identityOf(),
		identityDigest: 'e'.repeat(64),
		attempt: 1,
		caseId: input.caseId,
		caseClass: 'impact',
		treatment: input.treatment,
		treatmentDefinitionHash: definition.definitionHash,
		repetition: 1,
		model: 'deepseek/deepseek-flash',
		revision: 'abc1234',
		startedAt: '2026-10-25T06:00:00.000Z',
		completedAt: '2026-10-25T06:00:01.000Z',
		durationMs: input.durationMs,
		exitCode: valid ? 0 : 1,
		signal: null,
		timedOut: false,
		timeoutMs: 5000,
		outcome: valid ? 'completed' : 'failed',
		defects: [],
		isolation: {mode: 'detached-worktree', clientStore: 'ephemeral', checkoutClean: true, revisionMatch: true, restored: true},
		artifacts: {accepted: null, candidate: {id: 'candidate', digest: 'b'.repeat(64)}, loaded: {id: 'candidate', digest: 'b'.repeat(64)}},
		usage: {input: input.inputTokens, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001, available: true},
		telemetry: {
			inputTokens: {value: input.inputTokens, state: 'exact', unit: 'tokens', source: 'test'},
			outputTokens: {value: 10, state: 'exact', unit: 'tokens', source: 'test'},
			reasoningTokens: {value: 0, state: 'exact', unit: 'tokens', source: 'test'},
			cacheReadTokens: {value: 0, state: 'exact', unit: 'tokens', source: 'test'},
			cacheWriteTokens: {value: 0, state: 'exact', unit: 'tokens', source: 'test'},
			reportedCost: {value: 0.001, state: 'exact', unit: 'usd', source: 'test'},
		},
		providerCost: cost,
		providerMeter: reconcileProviderMeterLedger(ledger),
		toolCalls: Array.from({length: input.toolCalls}, (_, index) => ({
			index: index + 1,
			rawIndex: index + 1,
			parentIndex: null,
			id: null,
			tool: input.treatment === 'code-mode' ? 'execute' : 'codeindex_find_symbol',
			family: input.treatment === 'code-mode' ? ('execute' as const) : ('index' as const),
			status: 'completed' as const,
			input: null,
			inputValid: false,
			inputText: '',
			outputBytes: input.responseBytes,
			authoritative: null,
			durationMs: 10,
			error: null,
		})),
		outputBytes: input.responseBytes,
		familyBytes: {index: 0, search: 0, read: 0, list: 0, write: 0, execute: input.responseBytes, task: 0, other: 0},
		rawEventCount: 2,
		malformedEventCount: 0,
		streamTruncated: false,
		indexCalls: input.treatment === 'direct-mcp' ? input.toolCalls : 0,
		surface,
		routing: {
			ordinaryCalls: 0,
			codeIndexCalls: input.treatment === 'direct-mcp' ? input.toolCalls : 0,
			executeCalls: input.treatment === 'code-mode' ? input.toolCalls : 0,
			unknownTools: [],
			native: input.treatment === 'direct-mcp',
		},
		errors: [],
		grade: {
			parsed: true,
			files: [input.caseId],
			absent: false,
			success: valid,
			missing: [],
			forbidden: [],
			extra: [],
			falseAbsence: false,
			reason: valid ? 'ok' : 'failed',
			result: valid ? 'pass' : 'fail',
			assertions: [],
		},
		workflow: {
			result: 'pass',
			compliant: true,
			violations: [],
			assertions: [],
			broadSearches: [],
			duplicateReads: 0,
			fallbacksAfterAuthoritative: 0,
			firstRetrievalTool: null,
		},
		postRun: null,
		valid,
		invalidReason: valid ? null : 'failed',
		rateLimited: false,
		attempts: [
			{
				attempt: 1,
				startedAt: '2026-10-25T06:00:00.000Z',
				durationMs: input.durationMs,
				exitCode: valid ? 0 : 1,
				signal: null,
				timedOut: false,
				rateLimited: false,
				invalidReason: valid ? null : 'failed',
				rawFile: null,
			},
		],
		finalText: '{"files":["case-a"],"absent":false}',
		stderrTail: '',
	};
};

const coreOf = (design: ExposureDesignType): ExposureCoreQueryType => ({
	state: 'exact',
	reportDigest: 'f'.repeat(64),
	suite: {id: design.route.suiteId, version: design.route.version, hash: design.route.hash},
	plan: {id: 'route', hash: design.route.planHash},
	artifact: design.artifact,
	cases: design.cases.map((testCase) => ({caseId: testCase.id, coreMs: 5, state: 'exact', calls: 1, responseBytes: 100, elapsedMs: 10})),
	reason: null,
});

describe('exposure analysis', () => {
	it('recommends Code Mode only when the paired saving clears the frozen threshold', () => {
		const design = designOf();
		const plan = exposurePlanOf(design.cases, design.repetitions, design.seed);
		const runs = design.cases.flatMap((testCase) => [
			runOf({caseId: testCase.id, treatment: 'direct-mcp', requestBytes: 1000, responseBytes: 1000, toolCalls: 2, durationMs: 2000, inputTokens: 1000}),
			runOf({caseId: testCase.id, treatment: 'code-mode', requestBytes: 500, responseBytes: 500, toolCalls: 1, durationMs: 1000, inputTokens: 500}),
		]);
		const report = exposureReportOf({design, plan, runs, coreQuery: coreOf(design)});

		assert.equal(report.reliability.storedExecutions, 4);
		assert.equal(report.reliability.validExecutions, 4);
		assert.equal(report.surfaces.direct.exact, 2);
		assert.equal(report.surfaces.codeMode.exact, 2);
		assert.ok((report.metrics.totalTaskCostUsd.ratio.value ?? 1) < 0.6);
		assert.equal(report.decision.recommendation, 'code-mode');
		assert.equal(report.decision.changesCertification, false);
	});

	it('blocks the comparison when a required execution is invalid', () => {
		const design = designOf();
		const plan = exposurePlanOf(design.cases, design.repetitions, design.seed);
		const runs = [
			runOf({caseId: 'case-a', treatment: 'direct-mcp', requestBytes: 1000, responseBytes: 1000, toolCalls: 2, durationMs: 2000, inputTokens: 1000}),
			runOf({caseId: 'case-a', treatment: 'code-mode', requestBytes: 500, responseBytes: 500, toolCalls: 1, durationMs: 1000, inputTokens: 500, valid: false}),
			runOf({caseId: 'case-b', treatment: 'direct-mcp', requestBytes: 1000, responseBytes: 1000, toolCalls: 2, durationMs: 2000, inputTokens: 1000}),
			runOf({caseId: 'case-b', treatment: 'code-mode', requestBytes: 500, responseBytes: 500, toolCalls: 1, durationMs: 1000, inputTokens: 500}),
		];
		const report = exposureReportOf({design, plan, runs, coreQuery: coreOf(design)});

		assert.equal(report.decision.recommendation, 'inconclusive');
		assert.equal(report.decision.action, 'blocked');
	});
});
