import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {executionIdentityDigestOf, executionIdentityOf, type ExecutionIdentityInputType} from './identity.ts';
import {caseOf, suiteFieldsOf, type CaseType, type SuiteType} from './schema.ts';
import {toolSurfaceOf, treatmentOf, type TreatmentDefinitionType} from './treatment.ts';

const ordinaryTools = ['bash', 'glob', 'grep', 'list', 'read'];

const suite = (): SuiteType => {
	const fields = suiteFieldsOf({
		schemaVersion: 2,
		id: 'suite-a',
		version: 1,
		status: 'draft',
		revision: 'abc1234',
		model: 'provider/model',
		repetitions: 1,
		treatments: [
			{id: 'no-index', kind: 'no-index', ordinaryTools, codeMode: 'absent', artifact: null, mcp: null},
			{
				id: 'accepted',
				kind: 'codeindex',
				ordinaryTools,
				codeMode: 'absent',
				artifact: {id: 'accepted', root: 'artifacts/accepted', entryPoint: 'mcp.mjs'},
				mcp: {server: 'codeindex', codemode: false},
			},
			{
				id: 'candidate',
				kind: 'codeindex',
				ordinaryTools,
				codeMode: 'absent',
				artifact: {id: 'candidate', root: 'artifacts/candidate', entryPoint: 'mcp.mjs'},
				mcp: {server: 'codeindex', codemode: false},
			},
		],
		cases: ['case-a'],
	});

	return {...fields, hash: 'a'.repeat(64)};
};

const testCase = (): CaseType =>
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
	});

const treatment = (): TreatmentDefinitionType =>
	treatmentOf({
		id: 'no-index',
		kind: 'no-index',
		ordinaryTools,
		codeMode: 'absent',
		artifact: null,
		mcp: null,
	});

const input = (overrides: Partial<ExecutionIdentityInputType> = {}): ExecutionIdentityInputType => {
	const currentTreatment = treatment();

	return {
		suite: suite(),
		testCase: testCase(),
		model: 'provider/model',
		treatment: currentTreatment,
		surface: toolSurfaceOf(currentTreatment),
		subject: {
			mode: 'detached-worktree',
			revision: 'abc1234',
			contentManifestHash: 'b'.repeat(64),
			lockFileHash: 'c'.repeat(64),
		},
		artifacts: {accepted: null, candidate: null},
		configDigest: 'd'.repeat(64),
		repetitionIndex: 1,
		randomizationSeed: 'e'.repeat(64),
		harnessVersion: 1,
		...overrides,
	};
};

describe('identity', () => {
	it('complete execution identity is stable and every field participates', () => {
		const base = executionIdentityDigestOf(executionIdentityOf(input()));
		const changed = (overrides: Partial<ExecutionIdentityInputType>): string => executionIdentityDigestOf(executionIdentityOf(input(overrides)));

		assert.equal(executionIdentityDigestOf(executionIdentityOf(input())), base);
		assert.notEqual(changed({model: 'provider/other'}), base);
		assert.notEqual(changed({model: 'other/provider'}), base);
		assert.notEqual(changed({testCase: caseOf({...testCase(), prompt: 'Different prompt'})}), base);
		assert.notEqual(changed({testCase: caseOf({...testCase(), timeoutMs: 6000})}), base);
		assert.notEqual(changed({configDigest: 'f'.repeat(64)}), base);
		assert.notEqual(changed({repetitionIndex: 2}), base);
		assert.notEqual(changed({randomizationSeed: '0'.repeat(64)}), base);
		assert.notEqual(changed({harnessVersion: 2}), base);
		assert.notEqual(
			changed({
				subject: {mode: 'detached-worktree', revision: 'def5678', contentManifestHash: 'b'.repeat(64), lockFileHash: 'c'.repeat(64)},
			}),
			base,
		);
		assert.notEqual(
			changed({
				artifacts: {accepted: {id: 'accepted', digest: '1'.repeat(64)}, candidate: null},
			}),
			base,
		);

		const indexed = treatmentOf({
			id: 'candidate',
			kind: 'codeindex',
			ordinaryTools,
			codeMode: 'absent',
			artifact: {id: 'candidate', root: 'artifacts/candidate', entryPoint: 'mcp.mjs'},
			mcp: {server: 'codeindex', codemode: false},
		});
		assert.notEqual(changed({treatment: indexed, surface: toolSurfaceOf(indexed, ['find_symbol'])}), base);
	});
});
