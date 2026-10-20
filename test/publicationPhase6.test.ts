import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {summarizeAnalytics} from '../src/core/analytics/report.ts';
import {finalizeFacts, type ExtractedFactSetType} from '../src/core/facts/index.ts';
import {findSymbols, type QueryContextType} from '../src/core/query/queryService.ts';
import {FindSymbolInputSchema} from '../src/transports/mcp/toolSchemas.ts';
import {createFixtureConfig, createFixtureIndex} from './helpers/fixture.ts';

const buildExtracted = (): Readonly<{extracted: ExtractedFactSetType; cleanup: () => void}> => {
	const {config, cleanup} = createFixtureConfig('publication-project');
	const scan = typeScriptExtractor.scan(config, []);
	const extracted = typeScriptExtractor.build(config, scan);

	return {extracted, cleanup};
};

const duplicateFunctionDefinition = (extracted: ExtractedFactSetType): ExtractedFactSetType => {
	const definition = extracted.occurrences.find((occurrence) => occurrence.role === 'definition' && occurrence.declarationKind === 'function');

	if (definition === undefined) {
		throw new Error('Fixture has no function definition');
	}

	return {...extracted, occurrences: [...extracted.occurrences, {...definition}]};
};

const eventLine = (id: string, presence: string): string =>
	JSON.stringify({
		schema: 1,
		id,
		timestamp: new Date().toISOString(),
		program: 'code-index',
		programVersion: '0.1.0',
		projectId: 'project',
		workingCopyId: null,
		event: 'find_symbol_outcome',
		presence,
	});

describe('Phase 6 defaults', () => {
	it('defaults find_symbol to visible exposure', () => {
		expect(FindSymbolInputSchema.parse({query: 'api'}).exposure).toBe('visible');

		const fixture = createFixtureIndex('publication-project');

		try {
			const supporting = fixture.index.findSymbols({query: 'Supporting', limit: 10});
			const internal = fixture.index.findSymbols({query: 'internalOnly', limit: 10});

			expect(supporting.exposure).toBe('visible');
			expect(supporting.items.map((item) => item.symbolExposure)).toStrictEqual(['reachable']);
			expect(internal.items).toHaveLength(0);
			expect(fixture.index.findSymbols({query: 'internalOnly', exposure: 'any', limit: 10}).items).toHaveLength(1);
		} finally {
			fixture.cleanup();
		}
	});

	it('records exact-name presence outcomes for local analytics', () => {
		const fixture = createFixtureIndex('publication-project');

		try {
			const {generationId} = fixture.index.getStatus();

			if (generationId === null) {
				throw new Error('Fixture index is not published');
			}
			const outcomes: string[] = [];
			const context: QueryContextType = {
				database: fixture.database,
				generationId,
				freshness: fixture.index.getFreshness(),
				exactNameTelemetry: (presence) => {
					outcomes.push(presence);
				},
			};

			findSymbols(context, {query: 'Supporting', limit: 10}, 32_768);
			findSymbols(context, {query: 'internalOnly', limit: 10}, 32_768);
			findSymbols(context, {query: 'missing-name', limit: 10}, 32_768);
			findSymbols(context, {query: 'api', match: 'qualified', limit: 10}, 32_768);
			expect(() => findSymbols(context, {query: 'api', limit: 10, cursor: 'not-a-cursor'}, 32_768)).toThrow(/malformed/u);

			expect(outcomes).toStrictEqual(['R', 'I', 'none']);
		} finally {
			fixture.cleanup();
		}
	});

	it('aggregates exact-name presence counters in analytics summaries', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'code-index-phase6-'));

		try {
			const analyticsPath = path.join(directory, 'events.jsonl');
			mkdirSync(directory, {recursive: true});
			writeFileSync(analyticsPath, [eventLine('e1', 'P'), eventLine('e2', 'I'), eventLine('e3', 'PRI'), eventLine('e4', 'invalid')].join('\n'), {
				encoding: 'utf8',
			});

			expect(summarizeAnalytics(analyticsPath).exactNamePresence).toStrictEqual({P: 1, I: 1, PRI: 1});
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});
});

describe('Phase 6 enforced invariants', () => {
	it('measures resolved invariants during finalization when an extractor is present', () => {
		const {extracted, cleanup} = buildExtracted();

		try {
			const report = finalizeFacts(extracted, {mode: 'report', maxBindingsPerRoot: 2000, extractorId: 'typescript'});

			expect(report.issues.filter((issue) => issue.code.startsWith('invariant_'))).toStrictEqual([]);
		} finally {
			cleanup();
		}
	});

	it('fails an enforced candidate on a measured invariant violation', () => {
		const {extracted, cleanup} = buildExtracted();

		try {
			const violating = duplicateFunctionDefinition(extracted);
			const report = finalizeFacts(violating, {mode: 'report', maxBindingsPerRoot: 2000, extractorId: 'typescript'});
			const codes = report.issues.map((issue) => issue.code);

			expect(codes).toContain('invariant_f1');
			expect(() => finalizeFacts(violating, {mode: 'enforce', maxBindingsPerRoot: 2000, extractorId: 'typescript'})).toThrow(/invariant_/u);
			expect(finalizeFacts(violating, {mode: 'report', maxBindingsPerRoot: 2000}).issues.some((issue) => issue.code.startsWith('invariant_'))).toBe(false);
		} finally {
			cleanup();
		}
	});
});
