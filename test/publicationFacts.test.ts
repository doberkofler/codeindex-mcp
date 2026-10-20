import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {oracleExtractor} from '../src/adapters/oracle/index.ts';
import {typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {collectBindings} from '../src/core/facts/bindings.ts';
import {
	finalizeFacts,
	type ExtractedBindingContextType,
	type ExtractedBindingSiteType,
	type ExtractedBindingType,
	type ExtractedFactSetType,
	type ExtractedOccurrenceType,
	type ExtractedSurfaceOriginType,
	type FactAddressType,
	type FactExposureType,
	type FinalizationPolicyType,
} from '../src/core/facts/index.ts';
import {type FactIssueType} from '../src/core/facts/types.ts';
import {type IndexedSymbolType} from '../src/core/model.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const REPORT_POLICY: FinalizationPolicyType = {mode: 'report', maxBindingsPerRoot: 100};

const range = (startOffset: number, endOffset: number): ExtractedOccurrenceType['extent'] => ({
	startLine: 1,
	startColumn: startOffset + 1,
	endLine: 1,
	endColumn: endOffset + 1,
	startOffset,
	endOffset,
});

const symbol = (input: Readonly<{id: string; name: string; kind?: string; path?: string; enclosingId?: string | null}>): IndexedSymbolType => ({
	id: input.id,
	name: input.name,
	qualifiedName: input.name,
	kind: input.kind ?? 'variable',
	path: input.path ?? 'src/a.ts',
	startLine: 1,
	startColumn: 1,
	endLine: 1,
	endColumn: 2,
	startOffset: 0,
	endOffset: 1,
	enclosingId: input.enclosingId ?? null,
	contexts: ['app'],
});

const occurrence = (
	input: Readonly<{symbolId: string; startOffset?: number; primaryRank?: number; anchorRank?: number; kind?: string}>,
): ExtractedOccurrenceType => ({
	symbolId: input.symbolId,
	path: 'src/a.ts',
	startLine: 1,
	startColumn: (input.startOffset ?? 0) + 1,
	endLine: 1,
	endColumn: (input.startOffset ?? 0) + 2,
	startOffset: input.startOffset ?? 0,
	endOffset: (input.startOffset ?? 0) + 1,
	role: 'definition',
	enclosingId: null,
	contexts: ['app'],
	declarationKind: input.kind ?? 'variable',
	forwardDefinition: false,
	extent: range(input.startOffset ?? 0, (input.startOffset ?? 0) + 10),
	primaryRank: input.primaryRank ?? 0,
	anchorRank: input.anchorRank ?? 0,
});

const binding = (symbolId: string, segments: FactAddressType): ExtractedBindingType => ({symbolId, segments});

const context = (symbolId: string, segments: FactAddressType, exposure: FactExposureType): ExtractedBindingContextType => ({
	symbolId,
	segments,
	context: 'app',
	exposure,
});

const site = (symbolId: string, segments: FactAddressType, startOffset = 0): ExtractedBindingSiteType => ({
	symbolId,
	segments,
	kind: 'declared',
	path: 'src/a.ts',
	range: {
		startLine: 1,
		startColumn: startOffset + 1,
		endLine: 1,
		endColumn: startOffset + 2,
		startOffset,
		endOffset: startOffset + 1,
	},
});

const facts = (overrides: Partial<ExtractedFactSetType> = {}): ExtractedFactSetType => ({
	files: [],
	symbols: [symbol({id: 's1', name: 'api'})],
	bindings: [
		binding('s1', [
			['module', 'src/a.ts'],
			['member', 'api'],
		]),
	],
	bindingContexts: [
		context(
			's1',
			[
				['module', 'src/a.ts'],
				['member', 'api'],
			],
			'published',
		),
	],
	bindingSites: [
		site('s1', [
			['module', 'src/a.ts'],
			['member', 'api'],
		]),
	],
	surfaceOrigins: [],
	occurrences: [occurrence({symbolId: 's1'})],
	dependencies: {edges: [], bindings: []},
	adapterStats: [],
	diagnostics: [],
	compilerMs: 0,
	extractionMs: 0,
	...overrides,
});

const reversedOf = <ItemType>(items: readonly ItemType[]): readonly ItemType[] => {
	const reversed: ItemType[] = [];

	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];

		if (item !== undefined) {
			reversed.push(item);
		}
	}

	return reversed;
};

const firstOf = <ItemType>(items: readonly ItemType[]): ItemType => {
	const [first] = items;

	if (first === undefined) {
		throw new Error('expected at least one item');
	}

	return first;
};

const framedId = (prefix: string, parts: readonly string[]): string =>
	`${prefix}${createHash('sha256')
		.update(parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part};`).join(''))
		.digest('hex')
		.slice(0, 24)}`;

describe('publication fact finalization', () => {
	it('derives canonical binding keys, display fields, and UTF-8 framed identifiers', () => {
		const segments: FactAddressType = [
			['module', 'src/ünïcode.ts'],
			['member', 'api'],
		];
		const report = finalizeFacts(
			facts({
				bindings: [binding('s1', segments)],
				bindingContexts: [context('s1', segments, 'published')],
				bindingSites: [site('s1', segments)],
			}),
			REPORT_POLICY,
		);
		const derived = firstOf(report.bindings);

		expect(derived.bindingKey).toBe(JSON.stringify(segments));
		expect(derived.qualifiedName).toBe('module["src/ünïcode.ts"]::api');
		expect(derived.container).toBe('module["src/ünïcode.ts"]');
		expect(derived.name).toBe('api');
		expect(derived.bindingId).toBe(framedId('b_', ['s1', JSON.stringify(segments)]));
		expect(firstOf(report.bindingSites).siteId).toBe(framedId('o_', ['s1', 'src/a.ts', '0', 'definition']));
	});

	it('is deterministic and orders derived records independently of input order', () => {
		const moduleSegments: FactAddressType = [['module', 'src/a.ts']];
		const first = facts({
			symbols: [symbol({id: 's2', name: 'second'}), symbol({id: 's1', name: 'first'})],
			bindings: [binding('s2', [...moduleSegments, ['member', 'second']]), binding('s1', [...moduleSegments, ['member', 'first']])],
			bindingContexts: [
				context('s2', [...moduleSegments, ['member', 'second']], 'internal'),
				context('s1', [...moduleSegments, ['member', 'first']], 'published'),
			],
			bindingSites: [site('s2', [...moduleSegments, ['member', 'second']]), site('s1', [...moduleSegments, ['member', 'first']])],
			occurrences: [occurrence({symbolId: 's2'}), occurrence({symbolId: 's1'})],
		});
		const reordered = facts({
			...first,
			symbols: reversedOf(first.symbols),
			bindings: reversedOf(first.bindings),
			bindingContexts: reversedOf(first.bindingContexts),
			bindingSites: reversedOf(first.bindingSites),
			occurrences: reversedOf(first.occurrences),
		});

		const left = finalizeFacts(first, REPORT_POLICY);
		const right = finalizeFacts(reordered, REPORT_POLICY);

		expect(right).toStrictEqual(left);
	});

	it('derives symbol exposure from the strongest binding context', () => {
		const publishedSegments: FactAddressType = [
			['module', 'src/a.ts'],
			['member', 'api'],
		];
		const reachableSegments: FactAddressType = [
			['module', 'src/a.ts'],
			['member', 'hidden'],
		];
		const internalSegments: FactAddressType = [
			['module', 'src/a.ts'],
			['member', 'local'],
		];
		const report = finalizeFacts(
			facts({
				symbols: [symbol({id: 's1', name: 'api'}), symbol({id: 's2', name: 'hidden'}), symbol({id: 's3', name: 'local'})],
				bindings: [binding('s3', internalSegments), binding('s1', publishedSegments), binding('s2', reachableSegments)],
				bindingContexts: [
					context('s3', internalSegments, 'internal'),
					context('s1', publishedSegments, 'published'),
					context('s2', reachableSegments, 'reachable'),
				],
				bindingSites: [site('s1', publishedSegments), site('s2', reachableSegments), site('s3', internalSegments)],
				occurrences: [occurrence({symbolId: 's1'}), occurrence({symbolId: 's2'}), occurrence({symbolId: 's3'})],
			}),
			REPORT_POLICY,
		);

		expect(report.stats.publishedSymbols).toBe(1);
		expect(report.stats.reachableSymbols).toBe(1);
		expect(report.stats.internalOnlySymbols).toBe(1);
		expect(report.symbols.find((entry) => entry.id === 's1')?.exposure).toBe('published');
		expect(report.symbols.find((entry) => entry.id === 's2')?.exposure).toBe('reachable');
		expect(report.symbols.find((entry) => entry.id === 's3')?.exposure).toBe('internal_only');
	});
});

describe('publication fact invariants', () => {
	it('selects identity anchor and primary definition independently', () => {
		const report = finalizeFacts(
			facts({
				occurrences: [
					occurrence({symbolId: 's1', startOffset: 20, primaryRank: 0, anchorRank: 1, kind: 'function'}),
					occurrence({symbolId: 's1', startOffset: 40, primaryRank: 1, anchorRank: 0, kind: 'namespace'}),
				],
			}),
			REPORT_POLICY,
		);
		const derived = firstOf(report.symbols);

		expect(derived.kind).toBe('namespace');
		expect(derived.startOffset).toBe(20);
		expect(derived.primaryDefinitionSiteId).toBe(framedId('o_', ['s1', 'src/a.ts', '20', 'definition']));
	});

	it('fails a synthetic 96-bit identifier collision instead of merging bindings', () => {
		const moduleSegments: FactAddressType = [['module', 'src/a.ts']];
		const candidate = facts({
			symbols: [symbol({id: 's1', name: 'first'}), symbol({id: 's2', name: 'second'})],
			bindings: [binding('s1', [...moduleSegments, ['member', 'first']]), binding('s2', [...moduleSegments, ['member', 'second']])],
		});
		const issues: FactIssueType[] = [];
		const entries = collectBindings(candidate, new Map(candidate.symbols.map((entry) => [entry.id, entry])), issues, {
			binding: () => 'b_000000000000000000000000',
			site: () => 'o_000000000000000000000000',
		});

		expect(entries.size).toBe(1);
		expect(issues.map((issue) => issue.code)).toContain('binding_id_collision');
	});

	it('reports duplicate bindings and fails them in enforce mode', () => {
		const segments: FactAddressType = [
			['module', 'src/a.ts'],
			['member', 'api'],
		];
		const duplicate = facts({
			bindings: [binding('s1', segments), binding('s1', segments)],
			bindingContexts: [context('s1', segments, 'published')],
			bindingSites: [site('s1', segments)],
		});
		const report = finalizeFacts(duplicate, REPORT_POLICY);

		expect(report.issues.map((issue) => issue.code)).toContain('duplicate_binding');
		expect(() => finalizeFacts(duplicate, {...REPORT_POLICY, mode: 'enforce'})).toThrow(/duplicate_binding/u);
	});

	it('rejects invalid addresses, orphan references, and missing rows', () => {
		const segments: FactAddressType = [
			['module', 'src/a.ts'],
			['member', 'api'],
		];
		const invalid = [['module']] as unknown as FactAddressType;
		const report = finalizeFacts(
			facts({
				bindings: [binding('s1', invalid), binding('missing', segments)],
				bindingContexts: [context('s1', segments, 'published')],
				bindingSites: [site('s1', segments)],
			}),
			REPORT_POLICY,
		);
		const codes = report.issues.map((issue) => issue.code);

		expect(codes).toContain('invalid_address');
		expect(codes).toContain('unknown_symbol');
		expect(codes).toContain('orphan_binding_context');
		expect(codes).toContain('orphan_binding_site');
	});

	it('aborts report-only finalization when a surface ceiling is exceeded', () => {
		const rootSegments: FactAddressType = [
			['module', 'src/a.ts'],
			['member', 'api'],
		];
		const firstSegments: FactAddressType = [...rootSegments, ['member', 'run']];
		const secondSegments: FactAddressType = [...rootSegments, ['member', 'stop']];
		const origins: ExtractedSurfaceOriginType[] = [
			{
				symbolId: 's1',
				segments: firstSegments,
				context: 'app',
				rootSymbolId: 's1',
				rootSegments,
				relativeSegments: [['member', 'run']],
			},
			{
				symbolId: 's1',
				segments: secondSegments,
				context: 'app',
				rootSymbolId: 's1',
				rootSegments,
				relativeSegments: [['member', 'stop']],
			},
		];
		const overCeiling = facts({
			bindings: [binding('s1', rootSegments), binding('s1', firstSegments), binding('s1', secondSegments)],
			surfaceOrigins: origins,
		});

		expect(() => finalizeFacts(overCeiling, {...REPORT_POLICY, maxBindingsPerRoot: 1})).toThrow(/incomplete/u);
	});
});

describe('publication adapter seam', () => {
	it('accepts the TypeScript adapter bundle without crossing the compiler seam', () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			const scan = typeScriptExtractor.scan(config, []);
			const extracted = typeScriptExtractor.build(config, scan);
			const report = finalizeFacts(extracted, REPORT_POLICY);

			expect(extracted.bindings).toHaveLength(extracted.symbols.length);
			expect(report.bindings).toHaveLength(extracted.symbols.length);
			expect(report.bindingContexts).toHaveLength(extracted.symbols.length);
			expect(report.issues).toStrictEqual([]);
		} finally {
			cleanup();
		}
	});

	it('accepts the Oracle adapter bundle without crossing the parser seam', () => {
		const {config, cleanup} = createFixtureConfig('oracle-project', [{name: 'root', project: 'oracle-index.json'}], 'oracle');

		try {
			const scan = oracleExtractor.scan(config, []);
			const extracted = oracleExtractor.build(config, scan);
			const report = finalizeFacts(extracted, REPORT_POLICY);

			expect(extracted.bindings).toHaveLength(extracted.symbols.length);
			expect(report.bindings).toHaveLength(extracted.symbols.length);
			expect(report.bindingContexts).toHaveLength(extracted.symbols.length);
			expect(report.stats.publishedSymbols).toBeGreaterThan(0);
			expect(report.stats.internalOnlySymbols).toBeGreaterThan(0);
			expect(report.issues).toStrictEqual([]);
		} finally {
			cleanup();
		}
	});
});
