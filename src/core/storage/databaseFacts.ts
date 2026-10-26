import {type DatabaseSync} from 'node:sqlite';
import {
	type GenerationFactsInputType,
	type GenerationFactCountsType,
	type GenerationFactWriteModeType,
	type GenerationFactWriteType,
} from './databaseFactTypes.ts';
import {syncGenerationFiles, syncProjectContexts} from './databaseFactFiles.ts';
import {
	createDigestAccumulator,
	GLOBAL_TABLES,
	ownerPathsOf,
	PATH_TABLES,
	type CellType,
	type DigestAccumulatorType,
	type RowVisitorType,
	type TableWriteType,
} from './databaseFactRows.ts';
import {buildStatsOf} from './databaseFactStats.ts';
import {asNumber, asString} from './databaseRows.ts';
import {transaction} from './databaseTransaction.ts';

export {syncGenerationFiles} from './databaseFactFiles.ts';

export type {GenerationFactCountsType, GenerationFactWriteModeType, GenerationFactWriteType, GenerationFactsInputType} from './databaseFactTypes.ts';

type RowSinkType = Readonly<{write: (ownerPath: string, values: readonly CellType[]) => void}>;

type RowCounterType = {value: number};

type PreparedWriteType = Readonly<{
	changed: Set<string>;
	selected: ReadonlySet<string> | null;
	next: ReadonlyMap<string, string> | null;
}>;

const assertState = (writer: DatabaseSync, generationId: string, mode: GenerationFactWriteModeType): void => {
	const row = writer.prepare('select state from generation where id = ?').get(generationId);
	const expected = mode === 'insert' ? 'building' : 'published';

	if (row === undefined || asString(row, 'state') !== expected) {
		throw new Error(`Generation facts may only be ${mode === 'insert' ? 'persisted while building' : 'revised while published'}`);
	}
};

const countOf = (reader: DatabaseSync, sql: string, generationId: string): number => {
	const row = reader.prepare(sql).get(generationId);

	if (row === undefined) {
		throw new Error('Expected one aggregate row');
	}

	return asNumber(row, 'total');
};

const countsOfTable = (reader: DatabaseSync, table: string, generationId: string): number =>
	countOf(reader, `select count(*) as total from ${table} where generation_id = ?`, generationId);

const definitionSiteCountOf = (input: GenerationFactsInputType): number =>
	input.facts.occurrences.filter((occurrence) => occurrence.role === 'definition').length;

const occurrenceContextCountOf = (input: GenerationFactsInputType): number =>
	input.facts.occurrences.reduce((total, occurrence) => total + (occurrence.contexts ?? []).length, 0);

// Counts the rows this input produces, independent of the write mode.
const countsOfInput = (input: GenerationFactsInputType): GenerationFactCountsType => ({
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

const storedDigests = (writer: DatabaseSync, generationId: string): ReadonlyMap<string, string> =>
	new Map(
		writer
			.prepare('select path, digest from generation_file_digest where generation_id = ?')
			.all(generationId)
			.map((row) => [asString(row, 'path'), asString(row, 'digest')]),
	);

const digestFacts = (input: GenerationFactsInputType): ReadonlyMap<string, string> => {
	const digests = createDigestAccumulator(input.files.map((file) => file.path));
	const visitor: RowVisitorType = (ownerPath, values): void => {
		digests.add(ownerPath, values);
	};

	for (const table of PATH_TABLES) {
		table.each(input, visitor);
	}

	return digests.digests();
};

const changedPathsOf = (previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): ReadonlySet<string> => {
	const changed = new Set<string>();

	for (const [path, digest] of next) {
		if (previous.get(path) !== digest) {
			changed.add(path);
		}
	}

	for (const path of previous.keys()) {
		if (!next.has(path)) {
			changed.add(path);
		}
	}

	return changed;
};

/**
 * Expands a rewrite set to every path that a file-row cascade can disturb.
 *
 * Removing one file row cascades its symbols, occurrences, and bindings. Rows in
 * other paths that reference those identities are removed as well, so their
 * owning paths must be rewritten in the same transaction.
 *
 * @param input - Fact set being persisted.
 * @param changed - Mutable rewrite set, seeded with changed digest paths.
 */
const expandCascadePaths = (input: GenerationFactsInputType, changed: Set<string>): void => {
	const {symbolPath: symbolsByPath, bindingPath: bindingsByPath} = ownerPathsOf(input);
	const pending = [...changed];

	while (pending.length > 0) {
		const path = pending.pop();

		if (path === undefined) {
			continue;
		}

		for (const occurrence of input.facts.occurrences) {
			const owner = symbolsByPath.get(occurrence.symbolId);

			if (owner === path && !changed.has(occurrence.path)) {
				changed.add(occurrence.path);
				pending.push(occurrence.path);
			}
		}

		for (const site of input.facts.bindingSites) {
			const owner = bindingsByPath.get(site.bindingId);

			if (site.path === path && owner !== undefined && !changed.has(owner)) {
				changed.add(owner);
				pending.push(owner);
			}
		}

		for (const origin of input.facts.surfaceOrigins) {
			const owner = bindingsByPath.get(origin.bindingId);

			if (bindingsByPath.get(origin.rootBindingId) === path && owner !== undefined && !changed.has(owner)) {
				changed.add(owner);
				pending.push(owner);
			}
		}
	}
};

const prepareWrite = (writer: DatabaseSync, input: GenerationFactsInputType, mode: GenerationFactWriteModeType): PreparedWriteType => {
	if (mode === 'insert') {
		return {changed: new Set(input.files.map((file) => file.path)), selected: null, next: null};
	}

	const next = digestFacts(input);
	const changed = new Set(changedPathsOf(storedDigests(writer, input.generationId), next));
	expandCascadePaths(input, changed);
	return {changed, selected: changed, next};
};

const insertRow = (statement: ReturnType<DatabaseSync['prepare']>, table: string, ownerPath: string, values: readonly CellType[]): void => {
	try {
		statement.run(...values);
	} catch (error) {
		throw new Error(`${table} insert failed for ${ownerPath}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
	}
};

const pathSinkOf = (
	table: TableWriteType,
	writer: DatabaseSync,
	selection: Readonly<{selected: ReadonlySet<string> | null; digests: DigestAccumulatorType | null; counter: RowCounterType}>,
): RowSinkType => {
	const statement = writer.prepare(table.insertSql);

	return {
		write: (ownerPath, values): void => {
			if (selection.selected === null) {
				selection.digests?.add(ownerPath, values);
				insertRow(statement, table.table, ownerPath, values);
				selection.counter.value += 1;
				return;
			}

			if (selection.selected.has(ownerPath)) {
				insertRow(statement, table.table, ownerPath, values);
				selection.counter.value += 1;
			}
		},
	};
};

const globalSinkOf = (table: TableWriteType, writer: DatabaseSync, counter: RowCounterType): RowSinkType => {
	const statement = writer.prepare(table.insertSql);

	return {
		write: (ownerPath, values): void => {
			insertRow(statement, table.table, ownerPath, values);
			counter.value += 1;
		},
	};
};

const writeTableRows = (
	writer: DatabaseSync,
	input: GenerationFactsInputType,
	selection: Readonly<{selected: ReadonlySet<string> | null; digests: DigestAccumulatorType | null; counter: RowCounterType}>,
): void => {
	for (const table of PATH_TABLES) {
		const sink = pathSinkOf(table, writer, selection);
		table.each(input, sink.write);
	}
};

const writeGlobalRows = (writer: DatabaseSync, input: GenerationFactsInputType, counter: RowCounterType): void => {
	for (const table of GLOBAL_TABLES) {
		const sink = globalSinkOf(table, writer, counter);
		table.each(input, sink.write);
	}
};

const writeDigests = (writer: DatabaseSync, generationId: string, digests: ReadonlyMap<string, string>): void => {
	const statement = writer.prepare(
		'insert into generation_file_digest (generation_id, path, digest) values (?, ?, ?) on conflict(generation_id, path) do update set digest = excluded.digest',
	);

	for (const [path, digest] of digests) {
		insertRow(statement, 'generation_file_digest', path, [generationId, path, digest]);
	}
};

const deleteGenerationRows = (writer: DatabaseSync, generationId: string, paths: ReadonlySet<string>): void => {
	const deleteFile = writer.prepare('delete from file where generation_id = ? and path = ?');

	for (const path of paths) {
		deleteFile.run(generationId, path);
	}

	for (const table of GLOBAL_TABLES) {
		writer.prepare(`delete from ${table.table} where generation_id = ?`).run(generationId);
	}
};

/**
 * Writes one complete generation fact set, or only the changed path groups.
 *
 * A `revise` write keeps the published generation identifier and rewrites only
 * path groups whose persisted rows change; an `insert` write starts from an
 * empty building generation. The caller owns the surrounding transaction.
 *
 * @param writer - Writer connection inside an open transaction.
 * @param input - Files, finalized facts, dependencies, diagnostics, and hashes.
 * @param mode - Building-generation insert or published-generation revision.
 * @returns Persisted row counts, changed paths, and the number of written rows.
 * @throws {@link Error} When the generation state does not match the mode.
 */
export const writeGenerationFacts = (writer: DatabaseSync, input: GenerationFactsInputType, mode: GenerationFactWriteModeType): GenerationFactWriteType => {
	assertState(writer, input.generationId, mode);
	const prepared = prepareWrite(writer, input, mode);
	const counter: RowCounterType = {value: 0};
	const digests = mode === 'insert' ? createDigestAccumulator(input.files.map((file) => file.path)) : null;

	deleteGenerationRows(writer, input.generationId, prepared.changed);
	syncGenerationFiles(writer, input.generationId, input.files);
	counter.value += syncProjectContexts(writer, input);
	writeTableRows(writer, input, {selected: prepared.selected, digests, counter});
	writeGlobalRows(writer, input, counter);
	writeDigests(writer, input.generationId, prepared.next ?? digests?.digests() ?? new Map());
	writer.prepare('update generation set source_hash = ? where id = ?').run(input.sourceHash, input.generationId);

	return {counts: countsOfInput(input), changedPaths: [...prepared.changed].sort(), writtenRows: counter.value};
};

const countRowsMatch = (writer: DatabaseSync, generationId: string, expected: ReadonlyMap<string, number>): void => {
	for (const [table, wanted] of expected) {
		const inserted = countsOfTable(writer, table, generationId);

		if (inserted !== wanted) {
			throw new Error(`Index insertion count mismatch: ${table} ${String(inserted)}/${String(wanted)}`);
		}
	}
};

const validateCoverage = (writer: DatabaseSync, generationId: string): void => {
	const uncoveredDefinitions = countOf(
		writer,
		`select count(*) as total
		 from occurrence o
		 left join definition_site d
		   on d.generation_id = o.generation_id
		  and d.symbol_id = o.symbol_id
		  and d.path = o.path
		  and d.start_offset = o.start_offset
		  and d.role = o.role
		 where o.generation_id = ? and o.role = 'definition' and d.site_id is null`,
		generationId,
	);

	if (uncoveredDefinitions !== 0) {
		throw new Error('Every definition occurrence must have exactly one definition site');
	}

	const unmatchedBindingContexts = countOf(
		writer,
		`select count(*) as total
		 from symbol_name_context c
		 join symbol_name n on n.generation_id = c.generation_id and n.binding_id = c.binding_id
		 where c.generation_id = ?
		 and not exists (
			select 1 from symbol_context s
			where s.generation_id = c.generation_id and s.symbol_id = n.symbol_id and s.context_name = c.context_name
		 )`,
		generationId,
	);

	if (unmatchedBindingContexts !== 0) {
		throw new Error('Every binding context must have a matching symbol context');
	}

	const unpublishedRoots = countOf(
		writer,
		`select count(*) as total
		 from surface_binding_origin o
		 join symbol_name_context c
		   on c.generation_id = o.generation_id
		  and c.binding_id = o.root_binding_id
		  and c.context_name = o.context_name
		 where o.generation_id = ? and c.exposure <> 'published'`,
		generationId,
	);

	if (unpublishedRoots !== 0) {
		throw new Error('Every surface origin root must be published in its context');
	}

	const projectedRoots = countOf(
		writer,
		`select count(*) as total
		 from surface_binding_origin o
		 where o.generation_id = ?
		 and exists (
			select 1 from surface_binding_origin d
			where d.generation_id = o.generation_id
			and d.binding_id = o.root_binding_id
			and d.context_name = o.context_name
		 )`,
		generationId,
	);

	if (projectedRoots !== 0) {
		throw new Error('A surface origin root must not itself be a projected surface binding');
	}
};

/**
 * Validates the persisted candidate generation before atomic publication.
 *
 * Validation runs inside the writer transaction that applied the rows, so a
 * failure rolls the generation back to its previous published state.
 *
 * @param writer - Writer connection inside the open transaction.
 * @param input - Complete fact set written for the generation.
 * @throws {@link Error} When the persisted generation violates an invariant.
 */
export const validateGenerationFacts = (writer: DatabaseSync, input: GenerationFactsInputType): void => {
	countRowsMatch(writer, input.generationId, expectedCountsOf(input));

	if (writer.prepare('pragma foreign_key_check').all().length > 0) {
		throw new Error('SQLite foreign-key check failed for the candidate generation');
	}

	validateCoverage(writer, input.generationId);
};

const applyInsideTransaction = (writer: DatabaseSync, input: GenerationFactsInputType): GenerationFactWriteType => {
	const outcome: {value: GenerationFactWriteType | null} = {value: null};

	transaction(writer, () => {
		outcome.value = writeGenerationFacts(writer, input, 'insert');
	});

	if (outcome.value === null) {
		throw new Error('Generation fact write did not complete');
	}

	return outcome.value;
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
	const write = applyInsideTransaction(writer, input);

	validateGenerationFacts(reader, input);
	return write.counts;
};

/**
 * Reads the persisted row count of one generation-owned table.
 *
 * @param reader - Reader connection.
 * @param generationId - Candidate or published generation.
 * @param table - Fixed table name owned by the generation.
 * @returns Row count for that generation.
 */
export const countGenerationRows = (reader: DatabaseSync, generationId: string, table: string): number => countsOfTable(reader, table, generationId);
