import {type AssertionType} from './assertions.ts';
import {hashOf} from './hash.ts';
import {type ExecutionIdentityType} from './identity.ts';
import {LOCAL_CLAIM_CLASS, TARGETED_DIAGNOSTIC_CASE_IDS} from './localContract.ts';
import {targetedDiagnosticReportOf} from './localDiagnostic.ts';
import {type ReportMetadataType} from './report.ts';
import {type RunResultType} from './runTypes.ts';
import {type CaseClassType} from './schema.ts';
import {type TreatmentIdType} from './treatment.ts';

export type RunOverridesType = Readonly<{
	caseId?: string;
	caseClass?: CaseClassType;
	treatment?: TreatmentIdType;
	repetition?: number;
	success?: boolean;
	retrievalBytes?: number;
	toolCalls?: number;
	durationMs?: number;
	tokens?: Readonly<{input: number; output: number; reasoning: number}>;
}>;

export const assertion = (id: string): AssertionType => ({id, kind: 'test', expected: true, observed: true, result: 'pass'});

export const identityOfRun = (input: Required<Pick<RunOverridesType, 'caseId' | 'treatment' | 'repetition'>> & RunOverridesType): ExecutionIdentityType => ({
	harness: {schemaVersion: '1.0', version: 11},
	suite: {id: 'suite-a', version: 1, hash: 'a'.repeat(64)},
	case: {id: input.caseId, hash: hashOf(input.caseId), promptHash: hashOf(`prompt-${input.caseId}`), timeoutMs: 5000},
	model: {
		provider: 'ollama',
		modelId: 'model',
		digest: 'b'.repeat(64),
		quantization: 'Q4',
		runtime: 'ollama',
		runtimeVersion: '1.0.0',
		generationSettingsDigest: 'c'.repeat(64),
	},
	agent: {
		id: 'evaluator',
		version: '11',
		instructionsHash: 'd'.repeat(64),
		toolListHash: 'e'.repeat(64),
		permissionsHash: 'f'.repeat(64),
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
		contentManifestHash: '1'.repeat(64),
		projectFilesHash: '1'.repeat(64),
		lockFileHash: null,
		externalFixtureHash: null,
	},
	artifacts: {
		accepted: {id: 'accepted', digest: '2'.repeat(64)},
		candidate: input.treatment === 'no-index' ? null : {id: 'candidate', digest: '3'.repeat(64)},
	},
	codeIndex: {configDigest: '4'.repeat(64)},
	repetitionIndex: input.repetition,
	randomizationSeed: '5'.repeat(64),
});

export type TokenEntryType = Readonly<{value: number; state: 'exact'; unit: 'tokens'; source: string}>;

export const tokenEntry = (value: number): TokenEntryType => ({value, state: 'exact', unit: 'tokens', source: 'test'});

export const callsOf = (callCount: number, retrievalBytes: number): RunResultType['toolCalls'] =>
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

export const surfaceOf = (treatment: TreatmentIdType): RunResultType['surface'] => {
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

export const gradedAnswerOf = (caseId: string, success: boolean): RunResultType['grade'] => ({
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

export const outcomeOf = (success: boolean): RunResultType['outcome'] => (success ? 'completed' : 'failed');

export const attemptsOf = (success: boolean, durationMs: number): RunResultType['attempts'] => [
	{
		attempt: 1,
		startedAt: '2026-01-01T00:00:00.000Z',
		durationMs,
		exitCode: success ? 0 : 1,
		signal: null,
		timedOut: false,
		rateLimited: false,
		invalidReason: null,
		rawFile: null,
	},
];

export const loadedArtifactOf = (treatment: TreatmentIdType, identity: ExecutionIdentityType): ExecutionIdentityType['artifacts']['candidate'] =>
	treatment === 'no-index' ? null : identity.artifacts.candidate;

export const indexCallCountOf = (treatment: TreatmentIdType): number => (treatment === 'no-index' ? 0 : 1);

export const routingOf = (treatment: TreatmentIdType, callCount: number): RunResultType['routing'] => ({
	ordinaryCalls: treatment === 'no-index' ? callCount : callCount - 1,
	codeIndexCalls: indexCallCountOf(treatment),
	executeCalls: 0,
	unknownTools: [],
	native: true,
});

export const runOf = (overrides: RunOverridesType = {}): RunResultType => {
	const {
		caseId = 'case-a',
		caseClass = 'locate',
		treatment = 'no-index',
		repetition = 1,
		success = true,
		retrievalBytes = 100,
		toolCalls: callCount = 2,
		durationMs = 1000,
		tokens = {input: 10, output: 5, reasoning: 1},
	} = overrides;
	const identity = identityOfRun({...overrides, caseId, treatment, repetition});

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
		model: 'ollama/model',
		revision: 'abc1234',
		startedAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:01.000Z',
		durationMs,
		exitCode: success ? 0 : 1,
		signal: null,
		timedOut: false,
		timeoutMs: 5000,
		outcome: outcomeOf(success),
		defects: [],
		isolation: {mode: 'detached-worktree', clientStore: 'ephemeral', checkoutClean: true, revisionMatch: true, restored: true},
		artifacts: {accepted: identity.artifacts.accepted, candidate: identity.artifacts.candidate, loaded: loadedArtifactOf(treatment, identity)},
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
			cacheReadTokens: tokenEntry(0),
			cacheWriteTokens: tokenEntry(0),
			reportedCost: {value: 0.001, state: 'exact', unit: 'usd', source: 'test'},
		},
		toolCalls: callsOf(callCount, retrievalBytes),
		outputBytes: retrievalBytes + 10,
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
		valid: true,
		invalidReason: null,
		rateLimited: false,
		attempts: attemptsOf(success, durationMs),
		finalText: '{"files":["case-a"],"absent":false}',
		stderrTail: '',
	};
};

export const metadata: ReportMetadataType = {
	campaignId: 'campaign-a',
	schemaVersion: '1.0',
	suite: {id: 'suite-a', version: 1, hash: 'a'.repeat(64), status: 'frozen'},
	components: {harnessVersion: 11},
	claimClass: LOCAL_CLAIM_CLASS,
};

export const diagnosticRunsOf = (
	values: Readonly<{accepted: readonly number[]; candidate: readonly number[]; candidateSuccess?: boolean}>,
): readonly RunResultType[] =>
	(
		[
			['accepted', values.accepted],
			['candidate', values.candidate],
		] as const
	).flatMap(([treatment, treatmentValues]) =>
		treatmentValues.map((retrievalBytes, index) =>
			runOf({
				caseId: TARGETED_DIAGNOSTIC_CASE_IDS[index] ?? `case-${index}`,
				caseClass: 'impact',
				treatment,
				retrievalBytes,
				success: treatment === 'candidate' ? values.candidateSuccess !== false : true,
			}),
		),
	);

export const diagnosticOf = (
	values: Readonly<{accepted: readonly number[]; candidate: readonly number[]; candidateSuccess?: boolean}>,
): ReturnType<typeof targetedDiagnosticReportOf> =>
	targetedDiagnosticReportOf({
		results: diagnosticRunsOf(values),
		suite: {id: 'suite-a', version: 1, hash: 'a'.repeat(64)},
		model: 'ollama/model',
		environment: {id: 'environment-a', hash: '6'.repeat(64)},
		targetMetric: 'retrievalBytes',
	});

export const CASE_LAYOUT: readonly Readonly<{id: string; caseClass: CaseClassType}>[] = [
	{id: 'case-locate-1', caseClass: 'locate'},
	{id: 'case-locate-2', caseClass: 'locate'},
	{id: 'case-locate-3', caseClass: 'locate'},
	{id: 'case-locate-4', caseClass: 'locate'},
	{id: 'case-impact-1', caseClass: 'impact'},
	{id: 'case-impact-2', caseClass: 'impact'},
	{id: 'case-impact-3', caseClass: 'impact'},
	{id: 'case-impact-4', caseClass: 'impact'},
	{id: 'case-impact-5', caseClass: 'impact'},
	{id: 'case-impact-6', caseClass: 'impact'},
	{id: 'case-semantic-1', caseClass: 'semantic'},
	{id: 'case-semantic-2', caseClass: 'semantic'},
	{id: 'case-semantic-3', caseClass: 'semantic'},
	{id: 'case-semantic-4', caseClass: 'semantic'},
	{id: 'case-semantic-5', caseClass: 'semantic'},
	{id: 'case-semantic-6', caseClass: 'semantic'},
	{id: 'case-implementation-1', caseClass: 'implementation'},
	{id: 'case-implementation-2', caseClass: 'implementation'},
];

export const caseRunsOf = (
	caseId: string,
	caseClass: CaseClassType,
	values: Readonly<{noIndex: number; accepted: number; candidate: number}>,
	repetitions = 3,
): readonly RunResultType[] =>
	(
		[
			['no-index', values.noIndex],
			['accepted', values.accepted],
			['candidate', values.candidate],
		] as const
	).flatMap(([treatment, retrievalBytes]) =>
		Array.from({length: repetitions}, (_, index) => index + 1).map((repetition) =>
			runOf({
				caseId,
				caseClass,
				treatment,
				repetition,
				retrievalBytes,
				toolCalls: treatment === 'candidate' ? 1 : 2,
				durationMs: treatment === 'candidate' ? 100 : 200,
				tokens: treatment === 'candidate' ? {input: 5, output: 1, reasoning: 0} : {input: 10, output: 2, reasoning: 0},
			}),
		),
	);

export const campaignRunsOf = (
	values: Readonly<{noIndex: number; accepted: number; candidate: number}>,
	override?: (testCase: Readonly<{id: string; caseClass: CaseClassType}>) => Readonly<{noIndex: number; accepted: number; candidate: number}>,
	repetitions = 3,
): readonly RunResultType[] => CASE_LAYOUT.flatMap((testCase) => caseRunsOf(testCase.id, testCase.caseClass, override?.(testCase) ?? values, repetitions));
