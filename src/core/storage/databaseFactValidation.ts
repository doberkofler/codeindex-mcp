import {type DatabaseSync} from 'node:sqlite';
import {adapterIdOf, type GenerationFactCountsType, type GenerationFactsInputType} from './databaseFactTypes.ts';
import {buildStatsOf} from './databaseFactStats.ts';
import {asNumber} from './databaseRows.ts';

const countOf = (reader: DatabaseSync, sql: string, ...parameters: readonly (string | number)[]): number => {
	const row = reader.prepare(sql).get(...parameters);

	if (row === undefined) {
		throw new Error('Expected one aggregate row');
	}

	return asNumber(row, 'total');
};

const countsOfTable = (reader: DatabaseSync, table: string, generationId: string, adapterId: string): number => {
	const relationships: Readonly<Record<string, string>> = {
		dependency_binding: 'join dependency_edge owner on owner.edge_key = row.edge_key',
		definition_site: 'join occurrence owner on owner.occurrence_key = row.occurrence_key',
		occurrence_context: 'join occurrence owner on owner.occurrence_key = row.occurrence_key',
		surface_binding_origin: 'join symbol_name owner on owner.symbol_name_key = row.symbol_name_key',
		symbol_name_context: 'join symbol_name owner on owner.symbol_name_key = row.symbol_name_key',
		symbol_name_site: 'join symbol_name owner on owner.symbol_name_key = row.symbol_name_key',
	};
	const relationship = relationships[table];
	const owner = relationship === undefined ? 'row' : 'owner';

	return countOf(
		reader,
		`select count(*) as total from ${table} row
		 ${relationship ?? ''}
		 join generation g on g.generation_key = ${owner}.generation_key
		 where g.id = ? and ${owner}.adapter_id = ?`,
		generationId,
		adapterId,
	);
};

const definitionSiteCountOf = (input: GenerationFactsInputType): number =>
	input.facts.occurrences.filter((occurrence) => occurrence.role === 'definition').length;

const occurrenceContextCountOf = (input: GenerationFactsInputType): number =>
	input.facts.occurrences.reduce((total, occurrence) => total + (occurrence.contexts ?? []).length, 0);

/**
 * Counts rows produced by one complete adapter input.
 *
 * @param input - Complete adapter fact set.
 * @returns Expected persisted counts.
 */
export const countsOfInput = (input: GenerationFactsInputType): GenerationFactCountsType => ({
	files: input.files.length,
	symbols: input.facts.symbols.length,
	bindings: input.facts.bindings.length,
	bindingContexts: input.facts.bindingContexts.length,
	bindingSites: input.facts.bindingSites.length,
	surfaceOrigins: input.facts.surfaceOrigins.length,
	occurrences: input.facts.occurrences.length,
	definitionSites: definitionSiteCountOf(input),
	dependencyEdges: input.dependencies.edges.length,
	dependencyBindings: input.dependencies.bindings.length,
	diagnostics: input.diagnostics.length,
	buildStats: buildStatsOf(input.facts, input.language).length,
});

const expectedCountsOf = (input: GenerationFactsInputType): ReadonlyMap<string, number> => {
	const counts = countsOfInput(input);

	return new Map([
		['file', counts.files],
		['symbol', counts.symbols],
		['symbol_name', counts.bindings],
		['symbol_name_context', counts.bindingContexts],
		['symbol_name_site', counts.bindingSites],
		['surface_binding_origin', counts.surfaceOrigins],
		['occurrence', counts.occurrences],
		['occurrence_context', occurrenceContextCountOf(input)],
		['definition_site', counts.definitionSites],
		['dependency_edge', counts.dependencyEdges],
		['dependency_binding', counts.dependencyBindings],
		['diagnostic', counts.diagnostics],
		['build_stats', counts.buildStats],
		['project_context', input.projects.length],
	]);
};

const countRowsMatch = (writer: DatabaseSync, generationId: string, adapterId: string, expected: ReadonlyMap<string, number>): void => {
	for (const [table, wanted] of expected) {
		const inserted = countsOfTable(writer, table, generationId, adapterId);

		if (inserted !== wanted) {
			throw new Error(`Index insertion count mismatch: ${table} ${String(inserted)}/${String(wanted)}`);
		}
	}
};

const validateCoverage = (writer: DatabaseSync, generationId: string, adapterId: string): void => {
	const uncoveredDefinitions = countOf(
		writer,
		`select count(*) as total
		 from occurrence o
		 join generation g on g.generation_key = o.generation_key
		 left join definition_site d on d.occurrence_key = o.occurrence_key
		 where g.id = ? and o.adapter_id = ? and o.role = 'definition' and d.site_id is null`,
		generationId,
		adapterId,
	);

	if (uncoveredDefinitions !== 0) {
		throw new Error('Every definition occurrence must have exactly one definition site');
	}

	const unmatchedBindingContexts = countOf(
		writer,
		`select count(*) as total
		 from symbol_name_context c
		 join symbol_name n on n.symbol_name_key = c.symbol_name_key
		 join generation g on g.generation_key = n.generation_key
		 where g.id = ? and n.adapter_id = ?
		 and not exists (
			select 1 from symbol_context s
			where s.symbol_key = n.symbol_key
			and s.context_key = c.context_key
		 )`,
		generationId,
		adapterId,
	);

	if (unmatchedBindingContexts !== 0) {
		throw new Error('Every binding context must have a matching symbol context');
	}

	const unpublishedRoots = countOf(
		writer,
		`select count(*) as total
		 from surface_binding_origin o
		 join symbol_name n on n.symbol_name_key = o.symbol_name_key
		 join generation g on g.generation_key = n.generation_key
		 join symbol_name_context c
		   on c.symbol_name_key = o.root_symbol_name_key
		  and c.context_key = o.context_key
		 where g.id = ? and n.adapter_id = ? and c.exposure <> 'published'`,
		generationId,
		adapterId,
	);

	if (unpublishedRoots !== 0) {
		throw new Error('Every surface origin root must be published in its context');
	}

	const projectedRoots = countOf(
		writer,
		`select count(*) as total
		 from surface_binding_origin o
		 join symbol_name n on n.symbol_name_key = o.symbol_name_key
		 join generation g on g.generation_key = n.generation_key
		 where g.id = ? and n.adapter_id = ?
		 and exists (
			select 1 from surface_binding_origin d
			where d.symbol_name_key = o.root_symbol_name_key
			and d.context_key = o.context_key
		 )`,
		generationId,
		adapterId,
	);

	if (projectedRoots !== 0) {
		throw new Error('A surface origin root must not itself be a projected surface binding');
	}
};

/**
 * Validates persisted counts for one changed adapter.
 *
 * @param writer - Writer connection inside the publication transaction.
 * @param input - Complete changed-adapter fact set.
 * @throws {@link Error} When any persisted count differs.
 */
export const validateGenerationFactCounts = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	countRowsMatch(writer, input.generationId, adapterIdOf(input), expectedCountsOf(input));
};

/**
 * Validates semantic invariants for one changed adapter.
 *
 * @param writer - Writer connection inside the publication transaction.
 * @param input - Complete changed-adapter fact set.
 * @throws {@link Error} When persisted facts violate a semantic invariant.
 */
export const validateGenerationSemantics = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	validateCoverage(writer, input.generationId, adapterIdOf(input));
};
