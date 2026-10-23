import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {assertCorpusPreflight, corpusPreflightOf, projectForCaseOf} from './corpusPreflight.ts';
import {caseOf, type CaseType} from './schema.ts';
import {type McpSessionType} from './routeClient.ts';
import {treatmentOf} from './treatment.ts';
import {subjectIdentityOf, workspaceContextOf, type WorkspaceContextType} from './workspace.ts';

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-corpus-preflight-'));
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

const caseOfFixture = (id: string, expected: string, scope: string): CaseType =>
	caseOf({
		schemaVersion: 1,
		id,
		title: id,
		class: id.startsWith('semantic') ? 'semantic' : 'locate',
		tags: ['test'],
		prompt: 'Which file?',
		scope: [scope],
		expectedFiles: [expected],
		workflow: {maxTotalCalls: 4, maxOutputBytes: 1000},
		timeoutMs: 10_000,
	});

const subjectCase = caseOfFixture('locate-a', 'src/a.ts', 'src/**');
const semanticCase = caseOfFixture(
	'semantic-barrel-chain',
	'evaluation/fixtures/controlled-typescript/src/barrels/consumer.ts',
	'evaluation/fixtures/controlled-typescript/src/**',
);

const fixtureFiles = [
	'src/a.ts',
	'evaluation/fixtures/controlled-typescript/src/barrels/consumer.ts',
	'evaluation/fixtures/controlled-typescript/src/barrels/deep/value.ts',
];

const writeFixture = (root: string): void => {
	for (const file of fixtureFiles) {
		const absolute = path.join(root, file);

		mkdirSync(path.dirname(absolute), {recursive: true});
		writeFileSync(absolute, file.endsWith('value.ts') ? 'export const pipelineLimit = 3;\n' : 'export const value = 1;\n', 'utf8');
	}

	for (const file of ['tsconfig.json', 'evaluation/fixtures/controlled-typescript/tsconfig.json']) {
		const absolute = path.join(root, file);

		mkdirSync(path.dirname(absolute), {recursive: true});
		writeFileSync(absolute, '{"compilerOptions":{},"include":["src/**/*"]}\n', 'utf8');
	}
};

const contextOf = (root: string): WorkspaceContextType => {
	const subjectRepo = path.join(root, 'subject');

	writeFixture(subjectRepo);
	const subject = subjectIdentityOf(subjectRepo, 'fixture');
	const context = workspaceContextOf(path.join(root, 'state'), {subjectRepo, subject});

	mkdirSync(context.workspacePath('accepted'), {recursive: true});
	writeFixture(context.workspacePath('accepted'));

	return context;
};

const accepted = treatmentOf({
	id: 'accepted',
	kind: 'codeindex',
	ordinaryTools: ['bash', 'glob', 'grep', 'read'],
	codeMode: 'absent',
	artifact: {id: 'accepted', root: 'artifacts/accepted', entryPoint: 'mcp.mjs'},
	mcp: {server: 'codeindex', codemode: false},
});

type ScenarioType = Readonly<{missingProject?: boolean; unindexed?: string; missingSymbol?: boolean}>;

const sessionOf = (context: WorkspaceContextType, scenario: ScenarioType): McpSessionType => {
	const workspace = path.resolve(context.workspacePath('accepted'));
	const projects = [
		{name: 'root', projectFile: path.join(workspace, 'tsconfig.json')},
		...(scenario.missingProject === true
			? []
			: [{name: 'controlled-typescript', projectFile: path.join(workspace, 'evaluation/fixtures/controlled-typescript/tsconfig.json')}]),
	];
	const status = {
		ready: true,
		generationId: 'generation-a',
		scope: {root: workspace, projects},
		counts: {files: fixtureFiles.length},
	};

	return {
		serverName: 'codeindex',
		serverVersion: 'test',
		startupMs: 1,
		callTool: (tool, args) => {
			if (tool === 'index_status') {
				return {
					tool,
					status: 'ok',
					elapsedMs: 1,
					coreMs: 1,
					responseBytes: 1,
					text: '',
					structured: args['detail'] === 'full' ? status : {ready: true, state: 'published', refresh: 'current', building: false},
					errorCode: null,
					errorMessage: null,
				};
			}

			if (tool === 'outline') {
				const file = typeof args['path'] === 'string' ? args['path'] : '';
				const failed = file === scenario.unindexed;

				return {
					tool,
					status: failed ? 'error' : 'ok',
					elapsedMs: 1,
					coreMs: 1,
					responseBytes: 1,
					text: '',
					structured: failed ? null : {items: [{path: file}]},
					errorCode: failed ? 'file_not_indexed' : null,
					errorMessage: null,
				};
			}

			const pathName = scenario.missingSymbol === true ? 'elsewhere.ts' : 'evaluation/fixtures/controlled-typescript/src/barrels/deep/value.ts';

			return {
				tool,
				status: 'ok',
				elapsedMs: 1,
				coreMs: 1,
				responseBytes: 1,
				text: '',
				structured: {items: [{path: pathName, name: 'pipelineLimit'}]},
				errorCode: null,
				errorMessage: null,
			};
		},
		close: () => undefined,
	};
};

const preflightOf = async (context: WorkspaceContextType, scenario: ScenarioType): Promise<Awaited<ReturnType<typeof corpusPreflightOf>>> => {
	const report = await corpusPreflightOf({
		context,
		cases: [subjectCase, semanticCase],
		treatments: [accepted],
		openSession: async () => {
			await Promise.resolve();

			return sessionOf(context, scenario);
		},
		readyTimeoutMs: 1000,
		pollMs: 1,
	});

	return report;
};

describe('corpus preflight', () => {
	it('maps the fixture case to the controlled project and the repository case to root', () => {
		assert.equal(projectForCaseOf(subjectCase).name, 'root');
		assert.equal(projectForCaseOf(semanticCase).name, 'controlled-typescript');
	});

	it('passes only when index_status lists both projects and every path and symbol is stored', async (testContext: TestContext) => {
		const context = contextOf(temporaryRoot(testContext));
		const report = await preflightOf(context, {});

		assert.equal(report.result, 'pass', report.failures.join('; '));
		assert.equal(report.treatments[0]?.contexts.includes('controlled-typescript'), true);
		assert.equal(
			report.treatments.every((treatment) => treatment.unindexedPaths.length === 0),
			true,
		);
		assert.equal(report.cases.find((item) => item.caseId === 'semantic-barrel-chain')?.symbolProbe?.ok, true);
		assert.doesNotThrow(() => {
			assertCorpusPreflight(report);
		});
	});

	it('fails when the semantic project is not configured', async (testContext: TestContext) => {
		const context = contextOf(temporaryRoot(testContext));
		const report = await preflightOf(context, {missingProject: true});

		assert.equal(report.result, 'fail');
		assert.match(report.failures.join('\n'), /missing configured project.*controlled-typescript/u);
		assert.throws(() => {
			assertCorpusPreflight(report);
		}, /corpus preflight failed/u);
	});

	it('fails when an expected file or known semantic symbol is not indexed', async (testContext: TestContext) => {
		const context = contextOf(temporaryRoot(testContext));
		const missingFile = await preflightOf(context, {
			unindexed: 'evaluation/fixtures/controlled-typescript/src/barrels/consumer.ts',
		});
		const missingSymbol = await preflightOf(context, {missingSymbol: true});

		assert.equal(missingFile.result, 'fail');
		assert.equal(missingFile.treatments[0]?.unindexedPaths.includes('evaluation/fixtures/controlled-typescript/src/barrels/consumer.ts'), true);
		assert.equal(missingSymbol.result, 'fail');
		assert.equal(missingSymbol.cases.find((item) => item.caseId === 'semantic-barrel-chain')?.symbolProbe?.ok, false);
	});
});
