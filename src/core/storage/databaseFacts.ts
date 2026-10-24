import {type DatabaseSync} from 'node:sqlite';
import {createFactId} from '../facts/canonical.ts';
import {type FinalizedFactSetType} from '../facts/types.ts';
import {
	type DiagnosticType,
	type IndexedDependencyBindingType,
	type IndexedDependencyEdgeType,
	type ScanProjectResultType,
	type SourceFileType,
} from '../model.ts';
import {insertProjectContexts, insertOccurrenceContexts, insertSymbolContexts} from './databaseContextQueries.ts';
import {insertDependencyBindingRows, insertDependencyEdgeRows} from './databaseDependency.ts';
import {buildStatsOf, type BuildStatRowType} from './databaseFactStats.ts';
import {asNumber, asString} from './databaseRows.ts';
import {transaction} from './databaseTransaction.ts';

/** Complete serializable fact set stored by one generation persistence call. */
export type GenerationFactsInputType = Readonly<{
	readonly generationId: string;
	/** Adapter identifier used as the closed `build_stats.language` value. */
	readonly language: string;
	readonly files: readonly SourceFileType[];
	readonly projects: readonly ScanProjectResultType[];
	readonly facts: FinalizedFactSetType;
	readonly dependencies: Readonly<{
		readonly edges: readonly IndexedDependencyEdgeType[];
		readonly bindings: readonly IndexedDependencyBindingType[];
	}>;
	readonly diagnostics: readonly DiagnosticType[];
	readonly sourceHash: string;
}>;

/** Rows persisted by one generation fact insertion. */
export type GenerationFactCountsType = Readonly<{
	readonly files: number;
	readonly symbols: number;
	readonly bindings: number;
	readonly bindingContexts: number;
	readonly bindingSites: number;
	readonly surfaceOrigins: number;
	readonly occurrences: number;
	readonly definitionSites: number;
	readonly dependencyEdges: number;
	readonly dependencyBindings: number;
	readonly diagnostics: number;
	readonly buildStats: number;
}>;

const assertBuilding = (writer: DatabaseSync, generationId: string): void => {
	const row = writer.prepare('select state from generation where id = ?').get(generationId);

	if (row === undefined || asString(row, 'state') !== 'building') {
		throw new Error('Generation facts may only be persisted while the generation is building');
	}
};

const insertFileRows = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	const statement = writer.prepare(
		`insert into file (generation_id, path, sha256, content_sha256, line_count)
		 values (?, ?, ?, (select sha256 from content where sha256 = ?), ?)`,
	);

	for (const file of input.files) {
		statement.run(input.generationId, file.path, file.sha256, file.sha256, file.lineCount);
	}
};

const insertSymbolRows = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	const statement = writer.prepare(
		`insert into symbol (generation_id, id, name, qualified_name, kind, path, start_line, start_column, end_line, end_column,
		 start_offset, end_offset, enclosing_id, external_target, external_name, exposure)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const symbol of input.facts.symbols) {
		statement.run(
			input.generationId,
			symbol.id,
			symbol.name,
			symbol.qualifiedName,
			symbol.kind,
			symbol.path,
			symbol.startLine,
			symbol.startColumn,
			symbol.endLine,
			symbol.endColumn,
			symbol.startOffset,
			symbol.endOffset,
			symbol.enclosingId,
			symbol.externalTarget ?? null,
			symbol.externalName ?? null,
			symbol.exposure,
		);
	}
};

const insertBindingRows = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	const statement = writer.prepare(
		`insert into symbol_name (generation_id, binding_id, symbol_id, binding_key, container, name, qualified_name, exposure, has_declared_site)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const binding of input.facts.bindings) {
		statement.run(
			input.generationId,
			binding.bindingId,
			binding.symbolId,
			binding.bindingKey,
			binding.container,
			binding.name,
			binding.qualifiedName,
			binding.exposure,
			binding.hasDeclaredSite ? 1 : 0,
		);
	}
};

const insertBindingContextRows = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	const statement = writer.prepare('insert into symbol_name_context (generation_id, binding_id, context_name, exposure) values (?, ?, ?, ?)');

	for (const context of input.facts.bindingContexts) {
		statement.run(input.generationId, context.bindingId, context.context, context.exposure);
	}
};

const insertBindingSiteRows = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	const statement = writer.prepare(
		`insert into symbol_name_site (generation_id, binding_id, kind, path, start_line, start_column, end_line, end_column, start_offset, end_offset)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const site of input.facts.bindingSites) {
		statement.run(
			input.generationId,
			site.bindingId,
			site.kind,
			site.path,
			site.range.startLine,
			site.range.startColumn,
			site.range.endLine,
			site.range.endColumn,
			site.range.startOffset,
			site.range.endOffset,
		);
	}
};

const insertSurfaceOriginRows = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	const statement = writer.prepare(
		`insert into surface_binding_origin (generation_id, binding_id, context_name, root_binding_id, relative_key)
		 values (?, ?, ?, ?, ?)`,
	);

	for (const origin of input.facts.surfaceOrigins) {
		statement.run(input.generationId, origin.bindingId, origin.context, origin.rootBindingId, origin.relativeKey);
	}
};

type OccurrenceColumnsType = Readonly<{
	readonly declarationKind: string | null;
	readonly forwardDefinition: number;
	readonly extentStart: number | null;
	readonly extentEnd: number | null;
	readonly anchorRank: number | null;
	readonly primaryRank: number | null;
}>;

const occurrenceColumnsOf = (occurrence: GenerationFactsInputType['facts']['occurrences'][number]): OccurrenceColumnsType =>
	occurrence.role === 'definition'
		? {
				declarationKind: occurrence.declarationKind ?? null,
				forwardDefinition: occurrence.forwardDefinition === true ? 1 : 0,
				extentStart: occurrence.extent?.startOffset ?? null,
				extentEnd: occurrence.extent?.endOffset ?? null,
				anchorRank: occurrence.anchorRank ?? null,
				primaryRank: occurrence.primaryRank ?? null,
			}
		: {declarationKind: null, forwardDefinition: 0, extentStart: null, extentEnd: null, anchorRank: null, primaryRank: null};

const insertOccurrenceRows = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	const statement = writer.prepare(
		`insert into occurrence (generation_id, symbol_id, path, start_line, start_column, end_line, end_column, start_offset, end_offset,
		 role, enclosing_id, declaration_kind, forward_definition, usage, extent_start, extent_end, anchor_rank, primary_rank)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const occurrence of input.facts.occurrences) {
		const columns = occurrenceColumnsOf(occurrence);

		try {
			statement.run(
				input.generationId,
				occurrence.symbolId,
				occurrence.path,
				occurrence.startLine,
				occurrence.startColumn,
				occurrence.endLine,
				occurrence.endColumn,
				occurrence.startOffset,
				occurrence.endOffset,
				occurrence.role,
				occurrence.enclosingId,
				columns.declarationKind,
				columns.forwardDefinition,
				occurrence.usage ?? 0,
				columns.extentStart,
				columns.extentEnd,
				columns.anchorRank,
				columns.primaryRank,
			);
		} catch (error) {
			throw new Error(
				`Occurrence insert failed for ${occurrence.symbolId} ${occurrence.path} ${String(occurrence.startOffset)} ${occurrence.role}: ${error instanceof Error ? error.message : String(error)}`,
				{cause: error},
			);
		}
	}
};

const definitionSiteIdOf = (symbolId: string, path: string, startOffset: number): string =>
	createFactId('o_', [symbolId, path, String(startOffset), 'definition']);

const insertDefinitionSiteRows = (writer: DatabaseSync, input: GenerationFactsInputType): number => {
	const statement = writer.prepare(
		'insert into definition_site (generation_id, site_id, symbol_id, path, start_offset, role, first_in_symbol) values (?, ?, ?, ?, ?, ?, ?)',
	);
	const seen = new Set<string>();
	let count = 0;

	// Finalized occurrences are ordered by path and start offset, so the first
	// site seen for one symbol and path is its smallest offset in that path.
	for (const occurrence of input.facts.occurrences) {
		if (occurrence.role !== 'definition') {
			continue;
		}

		const key = `${occurrence.symbolId}\u0000${occurrence.path}`;
		const firstInSymbol = !seen.has(key);
		seen.add(key);
		statement.run(
			input.generationId,
			definitionSiteIdOf(occurrence.symbolId, occurrence.path, occurrence.startOffset),
			occurrence.symbolId,
			occurrence.path,
			occurrence.startOffset,
			occurrence.role,
			firstInSymbol ? 1 : 0,
		);
		count += 1;
	}

	return count;
};

const insertDiagnosticRows = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	const statement = writer.prepare(
		'insert into diagnostic (generation_id, position, category, code, message, path, start_line, start_column) values (?, ?, ?, ?, ?, ?, ?, ?)',
	);

	for (const [index, diagnostic] of input.diagnostics.entries()) {
		statement.run(
			input.generationId,
			index,
			diagnostic.category,
			diagnostic.code,
			diagnostic.message,
			diagnostic.path,
			diagnostic.startLine,
			diagnostic.startColumn,
		);
	}
};

const insertBuildStatRows = (writer: DatabaseSync, generationId: string, rows: readonly BuildStatRowType[]): void => {
	const statement = writer.prepare(
		`insert into build_stats (generation_id, language, metric, dim1, dim2, dim3, value)
		 values (?, ?, ?, ?, ?, ?, ?)`,
	);

	for (const row of rows) {
		statement.run(generationId, row.language, row.metric, row.dim1, row.dim2, row.dim3, row.value);
	}
};

const countOf = (reader: DatabaseSync, sql: string, generationId: string): number => {
	const row = reader.prepare(sql).get(generationId);

	if (row === undefined) {
		throw new Error('Expected one aggregate row');
	}

	return asNumber(row, 'total');
};

/**
 * Validates the persisted candidate generation before atomic publication.
 *
 * Validation runs while the generation remains `building`; readers never see
 * these rows. The checks cover insertion completeness, foreign keys, definition
 * site coverage, binding/symbol context agreement, and surface-root exposure.
 *
 * @param reader - Reader connection.
 * @param input - Complete fact set written for the generation.
 * @param counts - Rows written by the insertion.
 * @throws {@link Error} When the persisted generation violates an invariant.
 */
const validateGenerationFacts = (reader: DatabaseSync, input: GenerationFactsInputType, counts: GenerationFactCountsType): void => {
	const state = reader.prepare('select state from generation where id = ?').get(input.generationId);

	if (state === undefined || asString(state, 'state') !== 'building') {
		throw new Error('Generation facts may only be validated while the generation is building');
	}

	const checks: readonly (readonly [string, number, number])[] = [
		['file', counts.files, input.files.length],
		['symbol', counts.symbols, input.facts.symbols.length],
		['symbol_name', counts.bindings, input.facts.bindings.length],
		['symbol_name_context', counts.bindingContexts, input.facts.bindingContexts.length],
		['symbol_name_site', counts.bindingSites, input.facts.bindingSites.length],
		['surface_binding_origin', counts.surfaceOrigins, input.facts.surfaceOrigins.length],
		['occurrence', counts.occurrences, input.facts.occurrences.length],
		['definition_site', counts.definitionSites, input.facts.occurrences.filter((occurrence) => occurrence.role === 'definition').length],
		['dependency_edge', counts.dependencyEdges, input.dependencies.edges.length],
		['dependency_binding', counts.dependencyBindings, input.dependencies.bindings.length],
		['diagnostic', counts.diagnostics, input.diagnostics.length],
		['build_stats', counts.buildStats, buildStatsOf(input.facts, input.language).length],
	];

	for (const [table, inserted, expected] of checks) {
		if (inserted !== expected) {
			throw new Error(`Index insertion count mismatch: ${table} ${String(inserted)}/${String(expected)}`);
		}
	}

	const foreignKeyFailures = reader.prepare('pragma foreign_key_check').all();

	if (foreignKeyFailures.length > 0) {
		throw new Error('SQLite foreign-key check failed for the candidate generation');
	}

	const uncoveredDefinitions = countOf(
		reader,
		`select count(*) as total
		 from occurrence o
		 left join definition_site d
		   on d.generation_id = o.generation_id
		  and d.symbol_id = o.symbol_id
		  and d.path = o.path
		  and d.start_offset = o.start_offset
		  and d.role = o.role
		 where o.generation_id = ? and o.role = 'definition' and d.site_id is null`,
		input.generationId,
	);

	if (uncoveredDefinitions !== 0) {
		throw new Error('Every definition occurrence must have exactly one definition site');
	}

	const unmatchedBindingContexts = countOf(
		reader,
		`select count(*) as total
		 from symbol_name_context c
		 join symbol_name n on n.generation_id = c.generation_id and n.binding_id = c.binding_id
		 where c.generation_id = ?
		 and not exists (
			select 1 from symbol_context s
			where s.generation_id = c.generation_id and s.symbol_id = n.symbol_id and s.context_name = c.context_name
		 )`,
		input.generationId,
	);

	if (unmatchedBindingContexts !== 0) {
		throw new Error('Every binding context must have a matching symbol context');
	}

	const unpublishedRoots = countOf(
		reader,
		`select count(*) as total
		 from surface_binding_origin o
		 join symbol_name_context c
		   on c.generation_id = o.generation_id
		  and c.binding_id = o.root_binding_id
		  and c.context_name = o.context_name
		 where o.generation_id = ? and c.exposure <> 'published'`,
		input.generationId,
	);

	if (unpublishedRoots !== 0) {
		throw new Error('Every surface origin root must be published in its context');
	}

	const projectedRoots = countOf(
		reader,
		`select count(*) as total
		 from surface_binding_origin o
		 where o.generation_id = ?
		 and exists (
			select 1 from surface_binding_origin d
			where d.generation_id = o.generation_id
			and d.binding_id = o.root_binding_id
			and d.context_name = o.context_name
		 )`,
		input.generationId,
	);

	if (projectedRoots !== 0) {
		throw new Error('A surface origin root must not itself be a projected surface binding');
	}
};

/**
 * Persists one complete finalized fact set for a building generation.
 *
 * All generation rows are written in one transaction. Validation runs after the
 * transaction commits and still before publication, so a failed candidate is
 * isolated from the published generation.
 *
 * @param writer - Writer connection.
 * @param reader - Reader connection.
 * @param input - Files, finalized facts, dependencies, diagnostics, and hashes.
 * @returns Persisted row counts.
 * @throws {@link Error} When the generation is not building or validation fails.
 */
export const insertGenerationFacts = (writer: DatabaseSync, reader: DatabaseSync, input: GenerationFactsInputType): GenerationFactCountsType => {
	assertBuilding(writer, input.generationId);

	const buildStats = buildStatsOf(input.facts, input.language);
	const counts = {
		files: input.files.length,
		symbols: input.facts.symbols.length,
		bindings: input.facts.bindings.length,
		bindingContexts: input.facts.bindingContexts.length,
		bindingSites: input.facts.bindingSites.length,
		surfaceOrigins: input.facts.surfaceOrigins.length,
		occurrences: input.facts.occurrences.length,
		definitionSites: input.facts.occurrences.filter((occurrence) => occurrence.role === 'definition').length,
		dependencyEdges: input.dependencies.edges.length,
		dependencyBindings: input.dependencies.bindings.length,
		diagnostics: input.diagnostics.length,
		buildStats: buildStats.length,
	};

	transaction(writer, () => {
		insertProjectContexts(writer, input.generationId, input.projects);
		insertFileRows(writer, input);
		insertSymbolRows(writer, input);
		insertSymbolContexts(writer, input.generationId, input.facts.symbols);
		insertBindingRows(writer, input);
		insertBindingContextRows(writer, input);
		insertBindingSiteRows(writer, input);
		insertOccurrenceRows(writer, input);
		insertOccurrenceContexts(writer, input.generationId, input.facts.occurrences);
		insertDefinitionSiteRows(writer, input);
		insertSurfaceOriginRows(writer, input);
		insertDependencyEdgeRows(writer, input.generationId, input.dependencies.edges);
		insertDependencyBindingRows(writer, input.generationId, input.dependencies.bindings);
		insertDiagnosticRows(writer, input);
		insertBuildStatRows(writer, input.generationId, buildStats);
		writer.prepare("update generation set source_hash = ? where id = ? and state = 'building'").run(input.sourceHash, input.generationId);
	});

	validateGenerationFacts(reader, input, counts);
	return counts;
};

/**
 * Reads the persisted row count of one generation-owned table.
 *
 * @param reader - Reader connection.
 * @param generationId - Candidate or published generation.
 * @param table - Fixed table name owned by the generation.
 * @returns Row count for that generation.
 */
export const countGenerationRows = (reader: DatabaseSync, generationId: string, table: string): number =>
	countOf(reader, `select count(*) as total from ${table} where generation_id = ?`, generationId);
