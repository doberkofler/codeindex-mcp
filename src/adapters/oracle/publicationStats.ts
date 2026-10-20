import {type AdapterStatType} from '../../core/facts/index.ts';
import {type DiagnosticType} from '../../core/model.ts';
import {type OracleFileAnalysisType} from './extractSymbols.ts';
import {ORACLE_DIAGNOSTIC} from './diagnostics.ts';
import {type OracleDeclarationKindType} from './syntax.ts';

const ROUTINE_KINDS = new Set<OracleDeclarationKindType>(['procedure', 'function', 'cursor']);

export type OraclePublicationStatsType = Readonly<{
	readonly stats: readonly AdapterStatType[];
}>;

type RoutineEntryType = Readonly<{
	readonly analysis: OracleFileAnalysisType;
	readonly declarationIndex: number;
	readonly declaration: OracleFileAnalysisType['parse']['declarations'][number];
	readonly binding: OracleFileAnalysisType['bindings'][number];
}>;

type RoutineIndexType = {
	readonly specRoutines: Map<string, RoutineEntryType>;
	readonly bodyRoutines: Map<string, RoutineEntryType[]>;
	readonly overloads: Map<string, RoutineEntryType[]>;
	bodyForwards: number;
};

type PairSummaryType = {
	routinePairs: number;
	cursorPairs: number;
	callSpecs: number;
	polymorphicTableFunctions: number;
	bodyLess: number;
};

const routineKey = (entry: RoutineEntryType): string => `${entry.declaration.kind}\u0000${entry.binding.canonical}\u0000${entry.binding.signature}`;

const overloadKey = (entry: RoutineEntryType): string => `${entry.declaration.kind}\u0000${entry.binding.canonical}`;

const unitKindOf = (entry: RoutineEntryType): string => entry.analysis.parse.units[entry.declaration.unit]?.kind ?? 'unknown';

const isSpecUnit = (entry: RoutineEntryType): boolean => {
	const kind = unitKindOf(entry);

	return kind === 'package-spec' || kind === 'procedure' || kind === 'function';
};

const isBodyUnit = (entry: RoutineEntryType): boolean => unitKindOf(entry) === 'package-body';

const declarationForm = (entry: RoutineEntryType, sources: ReadonlyMap<string, string>): 'call_spec' | 'polymorphic_table_function' | 'unclassified' => {
	const source = sources.get(entry.analysis.path);

	if (source === undefined) {
		return 'unclassified';
	}

	const text = source.slice(entry.declaration.range.startOffset, entry.declaration.range.endOffset);

	if (/\bpolymorphic\s+table\s+function\b|\bpragma\s+interface\s*\(\s*ptf\b/iu.test(text)) {
		return 'polymorphic_table_function';
	}

	if (/\b(?:is|as)\s+(?:language|external)\b|\blanguage\s+(?:c|java)\b|\bexternal\s+name\b/iu.test(text)) {
		return 'call_spec';
	}

	return 'unclassified';
};

const add = (stats: Map<string, AdapterStatType>, metric: string, value: number, dimensions: readonly string[] = []): void => {
	if (value === 0) {
		return;
	}

	const key = `${metric}\u0000${dimensions.join('\u0000')}`;
	const existing = stats.get(key);

	stats.set(key, {metric, value: (existing?.value ?? 0) + value, ...(dimensions.length === 0 ? {} : {dimensions})});
};

const indexDeclaration = (stats: Map<string, AdapterStatType>, index: RoutineIndexType, analysis: OracleFileAnalysisType, declarationIndex: number): void => {
	const declaration = analysis.parse.declarations[declarationIndex];
	const binding = analysis.bindings[declarationIndex];

	if (declaration === undefined || binding === undefined) {
		return;
	}

	add(stats, 'oracle_units', 1, [analysis.parse.units[declaration.unit]?.kind ?? 'unknown']);
	add(stats, 'oracle_declarations', 1, [declaration.kind]);

	if (!ROUTINE_KINDS.has(declaration.kind)) {
		return;
	}

	const entry: RoutineEntryType = {analysis, declarationIndex, declaration, binding};

	if (isSpecUnit(entry)) {
		index.specRoutines.set(routineKey(entry), entry);
		const group = index.overloads.get(overloadKey(entry)) ?? [];
		group.push(entry);
		index.overloads.set(overloadKey(entry), group);
		return;
	}

	if (!isBodyUnit(entry)) {
		return;
	}

	const group = index.bodyRoutines.get(routineKey(entry)) ?? [];
	group.push(entry);
	index.bodyRoutines.set(routineKey(entry), group);

	if (binding.definitionOnly && !binding.mapped) {
		index.bodyForwards += 1;
	}
};

const collectRoutines = (stats: Map<string, AdapterStatType>, analyses: readonly OracleFileAnalysisType[]): RoutineIndexType => {
	const index: RoutineIndexType = {specRoutines: new Map(), bodyRoutines: new Map(), overloads: new Map(), bodyForwards: 0};

	for (const analysis of analyses) {
		for (let declarationIndex = 0; declarationIndex < analysis.parse.declarations.length; declarationIndex += 1) {
			indexDeclaration(stats, index, analysis, declarationIndex);
		}
	}

	return index;
};

const summaryOfPairs = (index: RoutineIndexType, sources: ReadonlyMap<string, string>, stats: Map<string, AdapterStatType>): PairSummaryType => {
	const summary: PairSummaryType = {routinePairs: 0, cursorPairs: 0, callSpecs: 0, polymorphicTableFunctions: 0, bodyLess: 0};

	for (const [key, spec] of index.specRoutines) {
		const body = index.bodyRoutines.get(key);

		if (body !== undefined && body.length > 0) {
			if (spec.declaration.kind === 'cursor') {
				summary.cursorPairs += 1;
			} else {
				summary.routinePairs += 1;
			}

			continue;
		}

		summary.bodyLess += 1;
		const form = declarationForm(spec, sources);

		if (form === 'call_spec') {
			summary.callSpecs += 1;
		} else if (form === 'polymorphic_table_function') {
			summary.polymorphicTableFunctions += 1;
		}

		add(stats, 'oracle_body_less_spec', 1, [form]);
	}

	return summary;
};

const addPairMetrics = (
	stats: Map<string, AdapterStatType>,
	index: RoutineIndexType,
	summary: PairSummaryType,
	diagnostics: readonly DiagnosticType[],
): void => {
	add(stats, 'oracle_routine_pairs', summary.routinePairs);
	add(stats, 'oracle_cursor_pairs', summary.cursorPairs);
	add(stats, 'oracle_call_specs', summary.callSpecs);
	add(stats, 'oracle_polymorphic_table_functions', summary.polymorphicTableFunctions);
	add(stats, 'oracle_body_forwards', index.bodyForwards);

	for (const group of index.overloads.values()) {
		if (new Set(group.map((entry) => entry.binding.signature)).size > 1) {
			add(stats, 'oracle_overload_groups', 1);
		}
	}

	const ambiguityCount = diagnostics.filter((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.ambiguousOverload).length;

	add(stats, 'oracle_pairing_diagnostics', ambiguityCount, ['ambiguous_candidate']);
	add(stats, 'oracle_ambiguity_rate_ppm', index.specRoutines.size === 0 ? 0 : Math.round((ambiguityCount / index.specRoutines.size) * 1_000_000));
};

const sortedStats = (stats: ReadonlyMap<string, AdapterStatType>): readonly AdapterStatType[] =>
	[...stats.values()].sort(
		(left, right) => left.metric.localeCompare(right.metric) || (left.dimensions ?? []).join('\u0000').localeCompare((right.dimensions ?? []).join('\u0000')),
	);

/**
 * Computes Oracle publication measurements that need parser-internal pairing
 * state and authored source context.
 *
 * These values remain report-only. They are aggregate counts and never contain
 * paths, names, source text, or SQL text.
 *
 * @param input - Parsed analyses, authored source by relative path, and diagnostics.
 * @returns Aggregate adapter statistics keyed by metric and dimensions.
 */
export const oraclePublicationStats = (
	input: Readonly<{
		analyses: readonly OracleFileAnalysisType[];
		sources: ReadonlyMap<string, string>;
		diagnostics: readonly DiagnosticType[];
	}>,
): OraclePublicationStatsType => {
	const stats = new Map<string, AdapterStatType>();
	const index = collectRoutines(stats, input.analyses);
	const pairs = summaryOfPairs(index, input.sources, stats);
	addPairMetrics(stats, index, pairs, input.diagnostics);

	return {stats: sortedStats(stats)};
};

/**
 * Merges aggregate adapter statistics across project contexts.
 *
 * @param groups - Per-context aggregate statistics.
 * @returns One deterministic aggregate list.
 */
export const mergeAdapterStats = (groups: readonly (readonly AdapterStatType[])[]): readonly AdapterStatType[] => {
	const merged = new Map<string, AdapterStatType>();

	for (const stat of groups.flat()) {
		const dimensions = stat.dimensions ?? [];
		const key = `${stat.metric}\u0000${dimensions.join('\u0000')}`;
		const existing = merged.get(key);

		merged.set(key, {
			metric: stat.metric,
			value: (existing?.value ?? 0) + stat.value,
			...(dimensions.length === 0 ? {} : {dimensions}),
		});
	}

	return sortedStats(merged);
};
