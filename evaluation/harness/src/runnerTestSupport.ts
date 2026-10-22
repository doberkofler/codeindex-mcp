import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {type TestContext} from 'vitest';
import {executionIdentityDigestOf, type ExecutionIdentityType} from './identity.ts';
import {clientStoreOf, type ClientStoreType} from './isolation.ts';
import {runOnce} from './runner.ts';
import {type RunResultType} from './runTypes.ts';
import {caseOf, type CaseType} from './schema.ts';
import {toolSurfaceOf, treatmentOf, type TreatmentDefinitionType} from './treatment.ts';

export const NO_RETRY = {maxAttempts: 1, backoffMs: (): number => 0};

export const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-runner-'));
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

export const quote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

export const scriptOf = (root: string, name: string, body: string): string => {
	const file = path.join(root, `${name}.sh`);
	writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, 'utf8');
	chmodSync(file, 0o755);

	return file;
};

export const testCaseOf = (overrides: Record<string, unknown> = {}): CaseType =>
	caseOf({
		schemaVersion: 1,
		id: 'case-a',
		title: 'Case A',
		class: 'locate',
		tags: ['locate'],
		prompt: 'Which file defines A?',
		scope: ['src/**'],
		expectedFiles: ['src/a.ts'],
		contextFiles: [],
		forbiddenFiles: [],
		workflow: {maxTotalCalls: 12, requiredFirstTool: null, maxOutputBytes: 1000},
		timeoutMs: 5000,
		...overrides,
	});

export const treatment: TreatmentDefinitionType = treatmentOf({
	id: 'no-index',
	kind: 'no-index',
	ordinaryTools: ['bash', 'glob', 'grep', 'list', 'read'],
	codeMode: 'absent',
	artifact: null,
	mcp: null,
});

export const identity: ExecutionIdentityType = {
	harness: {schemaVersion: '1.0', version: 1},
	suite: {id: 'suite', version: 1, hash: 'a'.repeat(64)},
	case: {id: 'case-a', hash: 'b'.repeat(64), promptHash: 'c'.repeat(64), timeoutMs: 5000},
	model: {
		provider: 'provider',
		modelId: 'model',
		digest: 'd'.repeat(64),
		quantization: null,
		runtime: null,
		runtimeVersion: null,
		generationSettingsDigest: 'e'.repeat(64),
	},
	agent: {
		id: 'evaluator',
		version: '1',
		instructionsHash: 'f'.repeat(64),
		toolListHash: '1'.repeat(64),
		permissionsHash: '2'.repeat(64),
		contextBudgetTokens: 0,
	},
	treatment: {id: 'no-index', kind: 'no-index', definitionHash: '3'.repeat(64), mcpSurfaceHash: '4'.repeat(64)},
	subject: {
		revision: 'abc1234',
		isolationMode: 'detached-worktree',
		contentManifestHash: '5'.repeat(64),
		projectFilesHash: '5'.repeat(64),
		lockFileHash: null,
		externalFixtureHash: null,
	},
	artifacts: {accepted: null, candidate: null},
	codeIndex: {configDigest: '6'.repeat(64)},
	repetitionIndex: 1,
	randomizationSeed: '7'.repeat(64),
};

export const clientStore = (root: string): ClientStoreType =>
	clientStoreOf({
		campaignStore: null,
		campaignDir: path.join(root, 'campaign'),
		environment: {XDG_DATA_HOME: path.join(root, 'data')},
		homeDirectory: path.join(root, 'home'),
	});

export type ExecuteOptionsType = Readonly<{
	store?: ClientStoreType;
	retry?: {maxAttempts: number; backoffMs: () => number};
	prepareRetry?: () => {restored: boolean; reason: string | null};
}>;

export const execute = async (root: string, command: string, testCase: CaseType, options: ExecuteOptionsType = {}): Promise<RunResultType> => {
	const store = options.store ?? clientStore(root);
	const result = await runOnce({
		cwd: root,
		testCase,
		treatment,
		surface: toolSurfaceOf(treatment),
		repetition: 1,
		model: 'provider/model',
		revision: 'abc1234',
		campaignId: 'campaign',
		identity,
		identityDigest: executionIdentityDigestOf(identity),
		clientStore: store,
		isolation: {
			mode: 'detached-worktree',
			clientStore: store.mode,
			checkoutClean: true,
			revisionMatch: true,
		},
		artifacts: {accepted: null, candidate: null, loaded: null},
		rawBase: path.join(root, 'raw', 'case-a'),
		command,
		retry: options.retry ?? NO_RETRY,
		...(options.prepareRetry === undefined ? {} : {prepareRetry: options.prepareRetry}),
	});

	return result;
};
