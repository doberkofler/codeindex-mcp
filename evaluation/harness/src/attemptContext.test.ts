import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {attemptContextOf} from './attemptContext.ts';
import {surfaceOf} from './localTestSupport.ts';
import {reconcileProviderMeterLedger, type ProviderRequestLedgerEntryType} from './providerMeterLedger.ts';
import {type AttemptContextType} from './runTypes.ts';
import {caseOf, type CaseType} from './schema.ts';
import {presentedToolsOf} from './surface.ts';

const testCaseOf = (): CaseType =>
	caseOf({
		schemaVersion: 1,
		id: 'surface-case',
		title: 'Surface case',
		class: 'locate',
		tags: ['locate'],
		prompt: 'Which file defines a?',
		scope: ['src/**'],
		expectedFiles: ['src/a.ts'],
		contextFiles: [],
		forbiddenFiles: [],
		workflow: {maxTotalCalls: 12, requiredFirstTool: null, maxOutputBytes: 1000},
		timeoutMs: 20_000,
	});

const requestOf = (toolNames: readonly string[]): ProviderRequestLedgerEntryType => ({
	ordinal: 1,
	kind: 'agent',
	provider: 'deepseek',
	model: 'deepseek-flash',
	startedAt: '2026-10-23T12:00:00.000Z',
	completedAt: '2026-10-23T12:00:01.000Z',
	toolNames,
	requestBytes: 100,
	responseBytes: 100,
	settlement: {
		status: 'completed',
		usage: {
			nonCachedInputTokens: 10,
			cacheReadTokens: 0,
			cacheWriteTokens: {},
			visibleOutputTokens: 2,
			reasoningTokens: 0,
			reportedCostUsd: null,
			missingFields: [],
			invalidFields: [],
			complete: true,
		},
	},
});

const contextOf = async (root: string, toolNames: readonly string[]): Promise<AttemptContextType> => {
	const ledger = {recordType: 'provider-meter' as const, provider: 'deepseek', requests: [requestOf(toolNames)]};

	const context = await attemptContextOf({
		attempt: 1,
		startedAt: '2026-10-23T12:00:00.000Z',
		startedMs: Date.now(),
		timeoutMs: 20_000,
		testCase: testCaseOf(),
		cwd: root,
		surface: surfaceOf('candidate'),
		stdout: '',
		stderr: '',
		timedOut: false,
		exitCode: 0,
		signal: null,
		rawBase: null,
		providerCost: null,
		providerMeter: reconcileProviderMeterLedger(ledger),
	});

	return context;
};

describe('attempt context request-1 surface', () => {
	it('invalidates an admitted attempt whose first request omits declared tools', async (testContext: TestContext) => {
		const root = mkdtempSync(path.join(tmpdir(), 'codeindex-attempt-context-'));
		testContext.onTestFinished(() => {
			rmSync(root, {recursive: true, force: true});
		});
		const context = await contextOf(root, ['grep']);

		assert.match(context.invalidReason ?? '', /request-1 surface is incomplete-surface/u);
		assert.equal(context.outcome, 'failed');
	});

	it('keeps a complete first request valid', async (testContext: TestContext) => {
		const root = mkdtempSync(path.join(tmpdir(), 'codeindex-attempt-context-'));
		testContext.onTestFinished(() => {
			rmSync(root, {recursive: true, force: true});
		});
		const context = await contextOf(root, presentedToolsOf(surfaceOf('candidate')));

		assert.equal(context.invalidReason, null);
		assert.equal(context.outcome, 'completed');
	});
});
