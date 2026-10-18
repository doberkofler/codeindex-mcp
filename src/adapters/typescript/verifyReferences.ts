import {type ConfigType, loadConfig} from '../../core/config/config.ts';
import {type IndexedOccurrenceType, type IndexedSymbolType} from '../../core/model.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {extractSymbolFacts} from './extractSymbols.ts';
import {loadTypeScriptProject} from './loadProject.ts';
import {scanProject} from './scanProject.ts';
import {compareReferenceLocations, type ReferenceLocationType} from './referenceLocations.ts';
import {createReferenceConstructIndex} from './referenceConstructs.ts';
import {selectReferenceSample} from './referenceSampling.ts';
import {buildDefinitionIndex, createLanguageService, lookupReferences, type LocatedDeclarationType} from './referenceLookup.ts';
import {
	evaluateReferenceGate,
	type ReferenceAccuracyType,
	type ReferenceComparisonType,
	type ReferenceCoverageType,
	type ReferenceSkipReasonType,
	type ReferenceVerificationFactsType,
	type ReferenceVerificationReportType,
} from './referenceGate.ts';

const debug = debugFor('verify');

type ComparisonInputType = Readonly<{
	config: ConfigType;
	project: ReturnType<typeof loadTypeScriptProject>;
	service: ReturnType<typeof createLanguageService>;
	constructs: ReturnType<typeof createReferenceConstructIndex>;
	authoredPaths: ReadonlySet<string>;
	symbol: IndexedSymbolType;
	located: LocatedDeclarationType | null;
	tags: ReferenceComparisonType['tags'];
	occurrences: readonly IndexedOccurrenceType[];
}>;

const skippedComparison = (input: ComparisonInputType, reason: ReferenceSkipReasonType): ReferenceComparisonType => ({
	symbolId: input.symbol.id,
	name: input.symbol.name,
	kind: input.symbol.kind,
	path: input.symbol.path,
	tags: input.tags,
	expectedCount: 0,
	actualCount: input.occurrences.length,
	matchedCount: 0,
	expectedReferenceCount: 0,
	missing: [],
	extra: [],
	skip: reason,
});

const compareSymbol = (input: ComparisonInputType): ReferenceComparisonType => {
	if (input.located === null) {
		return skippedComparison(input, 'declaration_not_located');
	}

	const lookup = lookupReferences({
		config: input.config,
		checker: input.project.checker,
		service: input.service,
		constructs: input.constructs,
		symbol: input.symbol,
		located: input.located,
		authoredPaths: input.authoredPaths,
	});

	if ('skip' in lookup) {
		return skippedComparison(input, lookup.skip);
	}

	const occurrences = input.occurrences.map((occurrence): ReferenceLocationType => ({
		path: occurrence.path,
		startOffset: occurrence.startOffset,
		endOffset: occurrence.endOffset,
		role: occurrence.role,
	}));
	const comparison = compareReferenceLocations(lookup.locations, occurrences);

	return {
		symbolId: input.symbol.id,
		name: input.symbol.name,
		kind: input.symbol.kind,
		path: input.symbol.path,
		tags: input.tags,
		expectedCount: comparison.expectedCount,
		actualCount: comparison.actualCount,
		matchedCount: comparison.matchedCount,
		expectedReferenceCount: comparison.expected.filter((location) => location.role === 'reference').length,
		missing: comparison.missing,
		extra: comparison.extra,
		skip: null,
	};
};

const countBy = (values: readonly string[]): Readonly<Record<string, number>> => {
	const counts: Record<string, number> = {};

	for (const value of values) {
		counts[value] = (counts[value] ?? 0) + 1;
	}

	return counts;
};

const coverageOf = (
	facts: Readonly<{indexedSymbols: number; locatedSymbols: number}>,
	comparisons: readonly ReferenceComparisonType[],
): ReferenceCoverageType => {
	const verified = comparisons.filter((comparison) => comparison.skip === null);
	const skipped = comparisons.flatMap((comparison) =>
		comparison.skip === null
			? []
			: [
					{
						symbolId: comparison.symbolId,
						name: comparison.name,
						path: comparison.path,
						reason: comparison.skip,
					},
				],
	);

	return {
		indexedSymbols: facts.indexedSymbols,
		locatedSymbols: facts.locatedSymbols,
		unlocatedSymbols: facts.indexedSymbols - facts.locatedSymbols,
		sampledSymbols: comparisons.length,
		symbolsWithNonDefinitionReferences: verified.filter((comparison) => comparison.expectedReferenceCount > 0).length,
		skipped,
		byKind: countBy(comparisons.map((comparison) => comparison.kind)),
		byTag: countBy(comparisons.flatMap((comparison) => [...comparison.tags])),
		referencedByTag: countBy(verified.filter((comparison) => comparison.expectedReferenceCount > 0).flatMap((comparison) => [...comparison.tags])),
	};
};

const accuracyOf = (comparisons: readonly ReferenceComparisonType[]): ReferenceAccuracyType => {
	const verified = comparisons.filter((comparison) => comparison.skip === null);
	const expected = verified.reduce((total, comparison) => total + comparison.expectedCount, 0);
	const actual = verified.reduce((total, comparison) => total + comparison.actualCount, 0);
	const matched = verified.reduce((total, comparison) => total + comparison.matchedCount, 0);

	return {
		expected,
		actual,
		matched,
		missing: verified.reduce((total, comparison) => total + comparison.missing.length, 0),
		extra: verified.reduce((total, comparison) => total + comparison.extra.length, 0),
		recall: expected === 0 ? 0 : matched / expected,
		precision: actual === 0 ? 0 : matched / actual,
	};
};

/**
 * Compares indexed occurrences with language-service references for a
 * deterministic, stratified sample of symbols.
 *
 * The sample covers required language constructs, not only symbol kinds. Every
 * comparison uses exact byte ranges, definition/reference roles, and symbol
 * identity. Symbols whose declaration cannot be located or whose references
 * cannot be retrieved are reported as skips rather than silently scoring as
 * correct.
 *
 * @param config - Resolved project configuration.
 * @returns Coverage, accuracy, per-symbol comparisons, and the production gate.
 */
export const verifyTypeScriptReferences = (config: ConfigType): ReferenceVerificationReportType => {
	const scan = scanProject(config);
	const project = loadTypeScriptProject(config);
	const facts = extractSymbolFacts({project, files: scan.files, projectId: config.projectId, rootDir: config.rootDir});
	const service = createLanguageService(config, project.program);
	const authoredPaths = new Set(scan.files.map((file) => file.path));
	const authoredAbsolutePaths = new Set(scan.files.map((file) => file.absolutePath));
	const locatedBySymbol = buildDefinitionIndex(project.program, facts.symbols, scan.files);
	const constructs = createReferenceConstructIndex(project.program, config.rootDir, authoredAbsolutePaths);
	const occurrencesBySymbol = new Map<string, IndexedOccurrenceType[]>();

	for (const occurrence of facts.occurrences) {
		const group = occurrencesBySymbol.get(occurrence.symbolId) ?? [];
		group.push(occurrence);
		occurrencesBySymbol.set(occurrence.symbolId, group);
	}

	const locatedSymbols = facts.symbols.filter((symbol) => locatedBySymbol.get(symbol.id) !== null);
	const candidates = locatedSymbols.map((symbol) => {
		const located = locatedBySymbol.get(symbol.id) ?? null;

		return {
			symbol,
			tags:
				located === null
					? []
					: constructs.infer({
							symbol,
							declarationNode: located.declarationNode,
							occurrences: occurrencesBySymbol.get(symbol.id) ?? [],
						}),
		};
	});
	const comparisons = selectReferenceSample(candidates).map((sample) =>
		compareSymbol({
			config,
			project,
			service,
			constructs,
			authoredPaths,
			symbol: sample.symbol,
			located: locatedBySymbol.get(sample.symbol.id) ?? null,
			tags: sample.tags,
			occurrences: occurrencesBySymbol.get(sample.symbol.id) ?? [],
		}),
	);
	const verification: ReferenceVerificationFactsType = {
		coverage: coverageOf({indexedSymbols: facts.symbols.length, locatedSymbols: locatedSymbols.length}, comparisons),
		accuracy: accuracyOf(comparisons),
		comparisons,
	};
	const gate = evaluateReferenceGate(verification);

	debug('reference verification complete', {
		indexedSymbols: verification.coverage.indexedSymbols,
		sampledSymbols: verification.coverage.sampledSymbols,
		skipped: verification.coverage.skipped.length,
		expected: verification.accuracy.expected,
		actual: verification.accuracy.actual,
		matched: verification.accuracy.matched,
		gate: gate.ok,
	});

	return {...verification, gate};
};

const serializableComparison = (comparison: ReferenceComparisonType): Readonly<Record<string, unknown>> => ({
	name: comparison.name,
	kind: comparison.kind,
	path: comparison.path,
	tags: comparison.tags,
	expected: comparison.expectedCount,
	actual: comparison.actualCount,
	matched: comparison.matchedCount,
	expectedReferences: comparison.expectedReferenceCount,
	missing: comparison.missing,
	extra: comparison.extra,
	...(comparison.skip === null ? {} : {skip: comparison.skip}),
});

/**
 * Runs reference verification and writes its JSON report to stdout.
 *
 * @param environment - Environment source validated by `loadConfig`.
 * @returns Process exit code: 0 only when the production gate passes.
 */
export const runVerification = (environment: NodeJS.ProcessEnv): number => {
	const config = loadConfig(environment);
	debug('verification start', {rootDir: config.rootDir, projectFile: config.projectFilePath});
	const report = verifyTypeScriptReferences(config);

	process.stdout.write(
		`${JSON.stringify(
			{
				coverage: report.coverage,
				accuracy: report.accuracy,
				gate: report.gate,
				comparisons: report.comparisons
					.filter((comparison) => comparison.skip !== null || comparison.missing.length > 0 || comparison.extra.length > 0)
					.map((comparison) => serializableComparison(comparison)),
			},
			null,
			2,
		)}\n`,
	);

	return report.gate.ok ? 0 : 1;
};
