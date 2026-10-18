import {describe, expect, it} from 'vitest';
import {type IndexedSymbolType} from '../src/core/model.ts';
import {REFERENCE_CONSTRUCT_QUOTA, REFERENCE_CONSTRUCT_TAGS, type ReferenceConstructTagType} from '../src/adapters/typescript/referenceConstructs.ts';
import {
	compareReferenceLocations,
	filterAuthoredLocations,
	normalizeReferenceLocations,
	type ReferenceLocationType,
} from '../src/adapters/typescript/referenceLocations.ts';
import {REFERENCE_SAMPLE_TARGET, selectReferenceSample, type ReferenceSampleCandidateType} from '../src/adapters/typescript/referenceSampling.ts';
import {
	evaluateReferenceGate,
	type ReferenceAccuracyType,
	type ReferenceComparisonType,
	type ReferenceCoverageType,
	type ReferenceVerificationFactsType,
} from '../src/adapters/typescript/referenceGate.ts';
import {verifyTypeScriptReferences} from '../src/adapters/typescript/verifyReferences.ts';
import {createFixtureConfig} from './helpers/fixture.ts';
import {REFERENCE_CORPUS_MANIFEST} from './helpers/referenceCorpus.ts';

const location = (value: Partial<ReferenceLocationType> = {}): ReferenceLocationType => ({
	path: 'src/a.ts',
	startOffset: 10,
	endOffset: 20,
	role: 'reference',
	...value,
});

const symbol = (index: number, kind = 'variable'): IndexedSymbolType => ({
	id: `symbol-${String(index)}`,
	name: `symbol${String(index)}`,
	qualifiedName: `Symbol${String(index)}`,
	kind,
	path: `src/${kind}.ts`,
	startLine: 1,
	startColumn: 1,
	endLine: 1,
	endColumn: 2,
	startOffset: index,
	endOffset: index + 1,
	enclosingId: null,
});

const candidate = (index: number, tags: readonly ReferenceConstructTagType[] = ['direct-reference'], kind = 'variable'): ReferenceSampleCandidateType => ({
	symbol: symbol(index, kind),
	tags,
});

const completeTagCounts = (): Readonly<Record<string, number>> => Object.fromEntries(REFERENCE_CONSTRUCT_TAGS.map((tag) => [tag, REFERENCE_CONSTRUCT_QUOTA]));

const coverage = (
	input: Readonly<{
		sampledSymbols?: number;
		unlocatedSymbols?: number;
		skipped?: ReferenceCoverageType['skipped'];
	}> = {},
): ReferenceCoverageType => ({
	indexedSymbols: 200,
	locatedSymbols: 200,
	unlocatedSymbols: input.unlocatedSymbols ?? 0,
	sampledSymbols: input.sampledSymbols ?? REFERENCE_SAMPLE_TARGET,
	symbolsWithNonDefinitionReferences: 200,
	skipped: input.skipped ?? [],
	byKind: {variable: 200},
	byTag: completeTagCounts(),
	referencedByTag: completeTagCounts(),
});

const accuracy = (input: Partial<ReferenceAccuracyType> = {}): ReferenceAccuracyType => ({
	expected: 1000,
	actual: 1000,
	matched: 1000,
	missing: 0,
	extra: 0,
	recall: 1,
	precision: 1,
	...input,
});

const facts = (
	input: Readonly<{
		coverage?: ReferenceCoverageType;
		accuracy?: ReferenceAccuracyType;
		comparisons?: readonly ReferenceComparisonType[];
	}> = {},
): ReferenceVerificationFactsType => ({
	coverage: input.coverage ?? coverage(),
	accuracy: input.accuracy ?? accuracy(),
	comparisons: input.comparisons ?? [],
});

describe('reference location comparison', () => {
	it('does not match different end offsets', () => {
		const comparison = compareReferenceLocations([location()], [location({endOffset: 21})]);

		expect(comparison.matchedCount).toBe(0);
		expect(comparison.missing).toHaveLength(1);
		expect(comparison.extra).toHaveLength(1);
		expect(comparison.recall).toBe(0);
		expect(comparison.precision).toBe(0);
	});

	it('does not match a definition against a reference', () => {
		const comparison = compareReferenceLocations([location({role: 'definition'})], [location({role: 'reference'})]);

		expect(comparison.matchedCount).toBe(0);
		expect(comparison.missing[0]?.role).toBe('definition');
		expect(comparison.extra[0]?.role).toBe('reference');
	});

	it('normalizes duplicate locations deterministically', () => {
		const first = location({startOffset: 30});
		const second = location({startOffset: 10});

		expect(normalizeReferenceLocations([first, second, first])).toStrictEqual([second, first]);
	});

	it('never treats an empty expected set as perfect recall', () => {
		const comparison = compareReferenceLocations([], [location()]);

		expect(comparison.recall).toBe(0);
		expect(comparison.precision).toBe(0);
	});

	it('keeps only authored locations', () => {
		const filtered = filterAuthoredLocations([location({path: 'src/a.ts'}), location({path: 'node_modules/typescript/lib.d.ts'})], new Set(['src/a.ts']));

		expect(filtered).toStrictEqual([location({path: 'src/a.ts'})]);
	});
});

describe('reference sampling', () => {
	it('is independent of input order', () => {
		const candidates = Array.from({length: 250}, (_, index) => candidate(index));
		const reversedInput = Array.from({length: 250}, (_, index) => candidate(249 - index));
		const forward = selectReferenceSample(candidates, 200);
		const reversed = selectReferenceSample(reversedInput, 200);

		expect(reversed.map((item) => item.symbol.id)).toStrictEqual(forward.map((item) => item.symbol.id));
	});

	it('fulfils every mandatory construct quota', () => {
		const candidates: ReferenceSampleCandidateType[] = [];
		let index = 0;

		for (const tag of REFERENCE_CONSTRUCT_TAGS) {
			for (let offset = 0; offset < REFERENCE_CONSTRUCT_QUOTA; offset += 1) {
				candidates.push(candidate(index, [tag]));
				index += 1;
			}
		}

		const selected = selectReferenceSample(candidates, 200);

		for (const tag of REFERENCE_CONSTRUCT_TAGS) {
			expect(selected.filter((item) => item.tags.includes(tag))).toHaveLength(REFERENCE_CONSTRUCT_QUOTA);
		}
	});

	it('does not let one symbol kind monopolize the sample', () => {
		const candidates = [...Array.from({length: 1000}, (_, index) => candidate(index)), candidate(2000, ['direct-reference'], 'class')];
		const selected = selectReferenceSample(candidates, 200);

		expect(selected.some((item) => item.symbol.kind === 'class')).toBe(true);
		expect(selected.filter((item) => item.symbol.kind === 'variable').length).toBeLessThan(200);
	});

	it('cannot produce the required sample from an insufficient corpus', () => {
		const selected = selectReferenceSample(
			Array.from({length: 10}, (_, index) => candidate(index)),
			200,
		);

		expect(selected).toHaveLength(10);
		expect(evaluateReferenceGate(facts({coverage: coverage({sampledSymbols: selected.length})})).ok).toBe(false);
	});
});

describe('reference gate', () => {
	it('fails when symbols cannot be located or resolved', () => {
		const result = evaluateReferenceGate(
			facts({
				coverage: coverage({
					unlocatedSymbols: 1,
					skipped: [{symbolId: 'symbol-1', name: 'symbol1', path: 'src/a.ts', reason: 'declaration_not_located'}],
				}),
			}),
		);

		expect(result.ok).toBe(false);
		expect(result.failures.map((failure) => failure.kind)).toContain('unlocated_symbols');
		expect(result.failures.map((failure) => failure.kind)).toContain('skipped_symbols');
	});

	it('fails on an unclassified mismatch even when recall clears the threshold', () => {
		const result = evaluateReferenceGate(
			facts({
				accuracy: accuracy({matched: 999, missing: 1, recall: 0.999}),
				comparisons: [
					{
						symbolId: 'symbol-1',
						name: 'symbol1',
						kind: 'variable',
						path: 'src/a.ts',
						tags: ['direct-reference'],
						expectedCount: 2,
						actualCount: 1,
						matchedCount: 1,
						expectedReferenceCount: 1,
						missing: [location()],
						extra: [],
						skip: null,
					},
				],
			}),
		);

		expect(result.failures.map((failure) => failure.kind)).toContain('unclassified_mismatch');
	});

	it('uses raw recall, not a rounded value', () => {
		const justBelow = evaluateReferenceGate(facts({accuracy: accuracy({recall: 0.995 - Number.EPSILON})}));
		const atThreshold = evaluateReferenceGate(facts({accuracy: accuracy({recall: 0.995})}));

		expect(justBelow.failures.map((failure) => failure.kind)).toContain('recall_below_target');
		expect(atThreshold.ok).toBe(true);
	});

	it('requires exact precision', () => {
		const result = evaluateReferenceGate(facts({accuracy: accuracy({precision: 1 - Number.EPSILON})}));

		expect(result.failures.map((failure) => failure.kind)).toContain('precision_below_target');
	});
});

describe('reference edge cases', () => {
	it('matches merged, override, destructuring, transient-property, and JSX attribute cases', () => {
		const fixture = createFixtureConfig('reference-edges');

		try {
			const report = verifyTypeScriptReferences(fixture.config);
			const required: readonly ReferenceConstructTagType[] = [
				'override',
				'destructuring',
				'jsx-component',
				'inheritance',
				'declaration-merging',
				'shorthand-property',
			];
			const tags = new Set(report.comparisons.flatMap((comparison) => [...comparison.tags]));

			expect(report.coverage.sampledSymbols).toBe(report.coverage.locatedSymbols);
			expect(report.coverage.unlocatedSymbols).toBe(0);
			expect(report.coverage.skipped).toStrictEqual([]);
			expect(report.accuracy.missing).toBe(0);
			expect(report.accuracy.extra).toBe(0);
			expect(report.accuracy.recall).toBe(1);
			expect(report.accuracy.precision).toBe(1);

			for (const tag of required) {
				expect([...tags]).toContain(tag);
			}
		} finally {
			fixture.cleanup();
		}
	});
});

describe('reference corpus', () => {
	it('passes the production gate with full construct coverage', () => {
		const fixture = createFixtureConfig('reference-corpus');

		try {
			const report = verifyTypeScriptReferences(fixture.config);

			expect(report.coverage.indexedSymbols).toBeGreaterThanOrEqual(REFERENCE_SAMPLE_TARGET);
			expect(report.coverage.sampledSymbols).toBe(REFERENCE_SAMPLE_TARGET);
			expect(report.coverage.symbolsWithNonDefinitionReferences).toBe(REFERENCE_SAMPLE_TARGET);
			expect(report.coverage.unlocatedSymbols).toBe(0);
			expect(report.coverage.skipped).toStrictEqual([]);
			expect(report.accuracy.recall).toBeGreaterThanOrEqual(0.995);
			expect(report.accuracy.precision).toBe(1);
			expect(report.accuracy.missing).toBe(0);
			expect(report.accuracy.extra).toBe(0);
			expect(report.gate.ok).toBe(true);

			for (const tag of REFERENCE_CORPUS_MANIFEST.requiredTags) {
				expect(report.coverage.byTag[tag] ?? 0).toBeGreaterThanOrEqual(REFERENCE_CONSTRUCT_QUOTA);
				expect(report.coverage.referencedByTag[tag] ?? 0).toBeGreaterThanOrEqual(REFERENCE_CONSTRUCT_QUOTA);
			}

			for (const representative of REFERENCE_CORPUS_MANIFEST.representatives) {
				if (!representative.mustSample) {
					continue;
				}

				const sampled = report.comparisons.some(
					(comparison) =>
						comparison.path === representative.selector.path &&
						comparison.name === representative.selector.name &&
						comparison.kind === representative.selector.kind,
				);

				expect(sampled).toBe(true);
			}
		} finally {
			fixture.cleanup();
		}
	});
});
