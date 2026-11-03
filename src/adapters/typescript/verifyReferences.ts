import {type AdapterConfigType} from '@codeindex/adapter-sdk';
import {loadConfig} from '../../core/config/config.ts';
import {type IndexedOccurrenceType, type IndexedSymbolType, type SourceFileType} from '../../core/model.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {scanProject} from './scanProject.ts';
import {buildTypeScriptFacts} from './index.ts';
import {compareReferenceLocations, referenceLocationKey, type ReferenceLocationType} from './referenceLocations.ts';
import {type ReferenceConstructTagType} from './referenceConstructs.ts';
import {selectReferenceSample} from './referenceSampling.ts';
import {
	createReferenceSyntaxClassifier,
	createReferenceUnion,
	lookupUnionReferences,
	type ReferenceUnionContextType,
	type ReferenceUnionType,
} from './referenceUnion.ts';
import {classifyUnmatchedLocations, createStoredLocationIndex, type StoredLocationIndexType} from './referenceClassification.ts';
import {type LocatedDeclarationType} from './referenceLookup.ts';
import {withPersistedReferenceIndex} from './referencePersistence.ts';
import {
	evaluateReferenceGate,
	type ReferenceAccuracyType,
	type ReferenceComparisonType,
	type ReferenceCoverageType,
	type ReferenceSkipReasonType,
	type ReferenceUnmatchedClassType,
	type ReferenceAliasGroupVerificationType,
	type ReferenceUnmatchedLocationType,
	type ReferenceVerificationFactsType,
	type ReferenceVerificationReportType,
} from './referenceGate.ts';

const debug = debugFor('verify');

type ComparisonInputType = Readonly<{
	symbol: IndexedSymbolType;
	tags: readonly ReferenceConstructTagType[];
	actual: readonly ReferenceLocationType[];
	union: ReferenceUnionType;
	config: AdapterConfigType;
	stored: StoredLocationIndexType;
	syntaxClassOf: (location: ReferenceLocationType) => 'direct_external' | 'namespace_import' | null;
}>;

const skippedComparison = (input: ComparisonInputType, reason: ReferenceSkipReasonType): ReferenceComparisonType => ({
	symbolId: input.symbol.id,
	name: input.symbol.name,
	kind: input.symbol.kind,
	path: input.symbol.path,
	tags: input.tags,
	expectedCount: 0,
	actualCount: input.actual.length,
	matchedCount: 0,
	expectedReferenceCount: 0,
	expectedLocations: [],
	actualLocations: input.actual,
	missing: [],
	extra: [],
	unmatched: [],
	skip: reason,
});

const compareSymbol = (input: ComparisonInputType): ReferenceComparisonType => {
	const lookup = lookupUnionReferences({config: input.config, union: input.union, symbol: input.symbol});

	if ('skip' in lookup) {
		return skippedComparison(input, lookup.skip);
	}

	const comparison = compareReferenceLocations(lookup.locations, input.actual);
	const unmatched: readonly ReferenceUnmatchedLocationType[] = classifyUnmatchedLocations({
		missing: comparison.missing,
		symbolId: input.symbol.id,
		stored: input.stored,
		syntaxClassOf: input.syntaxClassOf,
	});

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
		expectedLocations: comparison.expected,
		actualLocations: comparison.actual,
		missing: comparison.missing,
		extra: comparison.extra,
		unmatched,
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

const classificationCountsOf = (comparisons: readonly ReferenceComparisonType[]): Readonly<Record<ReferenceUnmatchedClassType, number>> => {
	const counts: Record<ReferenceUnmatchedClassType, number> = {
		stored_reference: 0,
		stored_definition: 0,
		direct_external: 0,
		namespace_import: 0,
		unexplained: 0,
	};

	for (const comparison of comparisons) {
		for (const entry of comparison.unmatched) {
			counts[entry.classification] += 1;
		}
	}

	return counts;
};

const accuracyOf = (comparisons: readonly ReferenceComparisonType[]): ReferenceAccuracyType => {
	const verified = comparisons.filter((comparison) => comparison.skip === null);
	const expected = verified.reduce((total, comparison) => total + comparison.expectedCount, 0);
	const actual = verified.reduce((total, comparison) => total + comparison.actualCount, 0);
	const matched = verified.reduce((total, comparison) => total + comparison.matchedCount, 0);
	const classifications = classificationCountsOf(verified);
	const withTruth = verified.filter((comparison) => comparison.expectedCount > 0);
	const macroRecall =
		withTruth.length === 0 ? 0 : withTruth.reduce((total, comparison) => total + comparison.matchedCount / comparison.expectedCount, 0) / withTruth.length;

	return {
		expected,
		actual,
		matched,
		missing: verified.reduce((total, comparison) => total + comparison.missing.length, 0),
		extra: verified.reduce((total, comparison) => total + comparison.extra.length, 0),
		recall: expected === 0 ? 0 : matched / expected,
		microRecall: expected === 0 ? 0 : matched / expected,
		macroRecall,
		precision: actual === 0 ? 0 : matched / actual,
		unexplained: classifications.unexplained,
		storedReference: classifications.stored_reference,
		storedDefinition: classifications.stored_definition,
		directExternal: classifications.direct_external,
		namespaceImport: classifications.namespace_import,
		aliasGroupCoverage: {
			expected,
			matched,
			sibling: classifications.stored_reference + classifications.stored_definition,
			directExternal: classifications.direct_external,
			namespaceImport: classifications.namespace_import,
			unexplained: classifications.unexplained,
			ratio: expected === 0 ? 0 : (matched + classifications.stored_reference + classifications.stored_definition) / expected,
		},
	};
};

const MIN_ALIAS_GROUP_MEMBERS = 2;

type AliasGroupInputType = Readonly<{
	readonly externalTarget: string;
	readonly externalName: string;
	readonly members: readonly IndexedSymbolType[];
}>;

const aliasGroupsOf = (symbols: readonly IndexedSymbolType[]): readonly AliasGroupInputType[] => {
	const groups = new Map<string, {externalTarget: string; externalName: string; members: IndexedSymbolType[]}>();

	for (const symbol of symbols) {
		const externalTarget = symbol.externalTarget ?? null;
		const externalName = symbol.externalName ?? null;

		if (externalTarget === null || externalName === null) {
			continue;
		}

		const key = `${externalTarget}\u0000${externalName}`;
		const group = groups.get(key) ?? {externalTarget, externalName, members: []};
		group.members.push(symbol);
		groups.set(key, group);
	}

	return [...groups.values()]
		.filter((group) => group.members.length >= MIN_ALIAS_GROUP_MEMBERS)
		.map((group) => ({
			...group,
			members: [...group.members].sort(
				(left, right) => left.path.localeCompare(right.path) || left.startOffset - right.startOffset || left.id.localeCompare(right.id),
			),
		}))
		.sort((left, right) => left.externalTarget.localeCompare(right.externalTarget) || left.externalName.localeCompare(right.externalName));
};

const sameLocationMultiset = (left: readonly ReferenceLocationType[], right: readonly ReferenceLocationType[]): boolean =>
	left
		.map((location) => referenceLocationKey(location))
		.sort()
		.join('\n') ===
	right
		.map((location) => referenceLocationKey(location))
		.sort()
		.join('\n');

const verifyAliasGroup = (
	group: AliasGroupInputType,
	reader: Parameters<Parameters<typeof withPersistedReferenceIndex>[1]>[0],
	comparisons: readonly ReferenceComparisonType[],
): ReferenceAliasGroupVerificationType => {
	const perMember = group.members.map((member) => ({member, locations: reader.readAll(member.id, 'partition')}));
	const [seed] = group.members;

	if (seed === undefined) {
		throw new Error('Alias group has no member');
	}

	const groupLocations = reader.readAll(seed.id, 'external_alias_group');
	const memberLocations = perMember.flatMap((entry) => entry.locations);
	const definitions = groupLocations.filter((location) => location.role === 'definition').length;
	const memberIds = new Set(group.members.map((member) => member.id));
	const memberComparisons = comparisons.filter((comparison) => comparison.skip === null && memberIds.has(comparison.symbolId));
	const directExternalSites = memberComparisons.reduce(
		(total, comparison) => total + comparison.unmatched.filter((entry) => entry.classification === 'direct_external').length,
		0,
	);

	return {
		externalTarget: group.externalTarget,
		externalName: group.externalName,
		memberSymbols: group.members.length,
		siblingSymbols: group.members.length - 1,
		definitions,
		references: groupLocations.length - definitions,
		completeness: perMember.every((entry) => entry.locations.some((location) => location.role === 'definition')) ? 'complete' : 'bounded',
		matches: sameLocationMultiset(groupLocations, memberLocations),
		sampledMembers: new Set(memberComparisons.map((comparison) => comparison.symbolId)).size,
		directExternalSites,
	};
};

const firstLocated = (
	contexts: readonly ReferenceUnionContextType[],
	symbolId: string,
): Readonly<{context: ReferenceUnionContextType; declaration: LocatedDeclarationType}> | null => {
	for (const context of contexts) {
		const located = context.locatedBySymbol.get(symbolId) ?? null;

		if (located !== null) {
			return {context, declaration: located};
		}
	}

	return null;
};

const unionFilesMatch = (factsFiles: readonly SourceFileType[], unionFiles: readonly SourceFileType[]): boolean => {
	if (factsFiles.length !== unionFiles.length) {
		return false;
	}

	const byPath = new Map(unionFiles.map((file) => [file.path, file.sha256]));

	return factsFiles.every((file) => byPath.get(file.path) === file.sha256);
};

const groupOccurrences = (occurrences: readonly IndexedOccurrenceType[]): ReadonlyMap<string, readonly IndexedOccurrenceType[]> => {
	const grouped = new Map<string, IndexedOccurrenceType[]>();

	for (const occurrence of occurrences) {
		const group = grouped.get(occurrence.symbolId) ?? [];
		group.push(occurrence);
		grouped.set(occurrence.symbolId, group);
	}

	return grouped;
};

/**
 * Compares persisted occurrences with language-service references over every
 * configured production context.
 *
 * Truth is loaded from a fresh `typescript@6.0.3` program per context, with the
 * same imported authored files the production extractor merges. The actual side
 * is read back from an isolated persisted generation through paginated
 * `find_references`, never from the adapter's in-memory facts. Every unmatched
 * truth location is conserved into a closure class; only `unexplained` fails.
 *
 * @param config - Resolved project configuration.
 * @returns Coverage, micro/macro recall, alias-group coverage, persistence
 * metadata, raw comparisons, and the production gate.
 * @throws {@link Error} When a project cannot load, the language service throws,
 * a truth file is absent from its Program, or captured inputs drift.
 */
export const verifyTypeScriptReferences = (config: AdapterConfigType): ReferenceVerificationReportType => {
	if (config.projects.length === 0) {
		throw new Error('Reference verification requires at least one configured TypeScript project');
	}

	const scan = scanProject(config);
	const facts = buildTypeScriptFacts(config, scan);
	// The truth programs below read the current filesystem. Reject drift before
	// comparing offsets, and again after all language-service queries finish.
	facts.validate?.();
	const union = createReferenceUnion(config, scan, facts.symbols);

	if (!unionFilesMatch(facts.files, union.files)) {
		throw new Error('Reference verification contexts do not reproduce the production authored file union');
	}

	const stored = createStoredLocationIndex(facts.occurrences);
	const syntaxClassifier = createReferenceSyntaxClassifier(union);
	const occurrencesBySymbol = groupOccurrences(facts.occurrences);
	const locatedSymbols = facts.symbols.filter((symbol) => union.contexts.some((context) => (context.locatedBySymbol.get(symbol.id) ?? null) !== null));
	const candidates = locatedSymbols.flatMap((symbol) => {
		const located = firstLocated(union.contexts, symbol.id);

		if (located === null) {
			return [];
		}

		return [
			{
				symbol,
				tags: located.context.constructs.infer({
					symbol,
					declarationNode: located.declaration.declarationNode,
					occurrences: occurrencesBySymbol.get(symbol.id) ?? [],
				}),
			},
		];
	});
	const sample = selectReferenceSample(candidates);
	const groups = aliasGroupsOf(facts.symbols);
	const {value, persistence} = withPersistedReferenceIndex({config, scan, facts}, (reader) => {
		const comparisons = sample.map((candidate) =>
			compareSymbol({
				symbol: candidate.symbol,
				tags: candidate.tags,
				actual: reader.readAll(candidate.symbol.id),
				union,
				config,
				stored,
				syntaxClassOf: (location) => syntaxClassifier(location.path, location.startOffset, location.endOffset),
			}),
		);
		const aliasGroups = groups.map((group) => verifyAliasGroup(group, reader, comparisons));

		return {comparisons, aliasGroups};
	});
	const {comparisons, aliasGroups} = value;

	facts.validate?.();

	const verification: ReferenceVerificationFactsType = {
		coverage: coverageOf({indexedSymbols: facts.symbols.length, locatedSymbols: locatedSymbols.length}, comparisons),
		accuracy: accuracyOf(comparisons),
		persistence,
		aliasGroups,
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
		unexplained: verification.accuracy.unexplained,
		aliasGroups: verification.aliasGroups.length,
		pages: verification.persistence.pages,
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
	expectedLocations: comparison.expectedLocations,
	actualLocations: comparison.actualLocations,
	missing: comparison.missing,
	extra: comparison.extra,
	unmatched: comparison.unmatched,
	...(comparison.skip === null ? {} : {skip: comparison.skip}),
});

const boundedMessage = (error: unknown, rootDir: string): string => {
	const message = error instanceof Error ? error.message : String(error);

	return message.split(rootDir).join('<root>').slice(0, 500);
};

/**
 * Runs reference verification and writes its JSON report to the supplied sink.
 *
 * @param environment - Environment source validated by `loadConfig`.
 * @param io - Output sinks.
 * @returns Process exit code: 0 only when the production gate passes.
 */
export const runVerification = (environment: NodeJS.ProcessEnv, io: Readonly<{stdout: (line: string) => void}>): number => {
	const config = loadConfig(environment);
	debug('verification start', {rootDir: config.rootDir, projectFiles: config.projects.map((project) => project.projectFilePath)});

	let report: ReferenceVerificationReportType;

	try {
		report = verifyTypeScriptReferences(config);
	} catch (error) {
		io.stdout(
			JSON.stringify(
				{
					gate: {
						ok: false,
						failures: [{kind: 'verifier_exception', detail: boundedMessage(error, config.rootDir)}],
					},
				},
				null,
				2,
			),
		);

		return 1;
	}

	io.stdout(
		JSON.stringify(
			{
				coverage: report.coverage,
				accuracy: report.accuracy,
				persistence: report.persistence,
				aliasGroups: report.aliasGroups,
				gate: report.gate,
				comparisons: report.comparisons
					.filter((comparison) => comparison.skip !== null || comparison.missing.length > 0 || comparison.extra.length > 0)
					.map((comparison) => serializableComparison(comparison)),
			},
			null,
			2,
		),
	);

	return report.gate.ok ? 0 : 1;
};
