import {type DatabaseSync} from 'node:sqlite';
import {
	adapterIdOf,
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
import {scopeAdapterFacts} from './factIdentity.ts';
import {asNumber, asString} from './databaseRows.ts';
import {transaction} from './databaseTransaction.ts';
import {countsOfInput, validateGenerationFactCounts, validateGenerationSemantics} from './databaseFactValidation.ts';

export {syncGenerationFiles, syncProjectContexts} from './databaseFactFiles.ts';

export type {GenerationFactCountsType, GenerationFactWriteModeType, GenerationFactWriteType, GenerationFactsInputType} from './databaseFactTypes.ts';

type RowSinkType = Readonly<{write: (ownerPath: string, values: readonly CellType[]) => void}>;

type RowCounterType = {value: number};
type CancellationCheckType = (() => void) | undefined;
type GlobalWriteType = Readonly<{
	selectedRows: RowCounterType;
	writtenRows: RowCounterType;
	checkCancellation: CancellationCheckType;
}>;

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

const countOf = (reader: DatabaseSync, sql: string, ...parameters: readonly (string | number)[]): number => {
	const row = reader.prepare(sql).get(...parameters);

	if (row === undefined) {
		throw new Error('Expected one aggregate row');
	}

	return asNumber(row, 'total');
};

const storedDigests = (writer: DatabaseSync, generationId: string, adapterId: string): ReadonlyMap<string, string> =>
	new Map(
		writer
			.prepare(
				`select f.path, d.digest from generation_file_digest d
				 join file f on f.file_key = d.file_key
				 join generation g on g.generation_key = f.generation_key
				 where g.id = ? and f.adapter_id = ?`,
			)
			.all(generationId, adapterId)
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
	const changed = new Set(changedPathsOf(storedDigests(writer, input.generationId, adapterIdOf(input)), next));
	expandCascadePaths(input, changed);
	return {changed, selected: changed, next};
};

const insertRow = (statement: ReturnType<DatabaseSync['prepare']>, table: string, ownerPath: string, values: readonly CellType[]): number => {
	try {
		return Number(statement.run(...values).changes);
	} catch (error) {
		throw new Error(`${table} insert failed for ${ownerPath}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
	}
};

const batchedCancellationCheck = (checkCancellation: CancellationCheckType): (() => void) => {
	let remaining = 0;

	return (): void => {
		if (remaining === 0) {
			checkCancellation?.();
			remaining = 255;
			return;
		}

		remaining -= 1;
	};
};

const pathSinkOf = (
	table: TableWriteType,
	writer: DatabaseSync,
	selection: Readonly<{selected: ReadonlySet<string> | null; digests: DigestAccumulatorType | null; selectedRows: RowCounterType; writtenRows: RowCounterType}>,
	checkCancellation: CancellationCheckType,
): RowSinkType => {
	const statement = writer.prepare(table.insertSql);
	const checkpoint = batchedCancellationCheck(checkCancellation);

	return {
		write: (ownerPath, values): void => {
			checkpoint();
			if (selection.selected === null) {
				selection.digests?.add(ownerPath, values);
				selection.selectedRows.value += 1;
				selection.writtenRows.value += insertRow(statement, table.table, ownerPath, values);
				return;
			}

			if (selection.selected.has(ownerPath)) {
				selection.selectedRows.value += 1;
				selection.writtenRows.value += insertRow(statement, table.table, ownerPath, values);
			}
		},
	};
};

const globalSinkOf = (table: TableWriteType, writer: DatabaseSync, write: GlobalWriteType): RowSinkType => {
	const statement = writer.prepare(table.insertSql);
	const checkpoint = batchedCancellationCheck(write.checkCancellation);

	return {
		write: (ownerPath, values): void => {
			checkpoint();
			write.selectedRows.value += 1;
			write.writtenRows.value += insertRow(statement, table.table, ownerPath, values);
		},
	};
};

const writeTableRows = (
	writer: DatabaseSync,
	input: GenerationFactsInputType,
	selection: Readonly<{
		selected: ReadonlySet<string> | null;
		digests: DigestAccumulatorType | null;
		selectedRows: RowCounterType;
		writtenRows: RowCounterType;
	}>,
	checkCancellation: CancellationCheckType,
): void => {
	for (const table of PATH_TABLES) {
		checkCancellation?.();
		table.before?.(writer);
		const sink = pathSinkOf(table, writer, selection, checkCancellation);
		table.each(input, sink.write);
		table.after?.(writer, input, selection.selected, checkCancellation);
	}
};

const writeGlobalRows = (writer: DatabaseSync, input: GenerationFactsInputType, write: GlobalWriteType): void => {
	for (const table of GLOBAL_TABLES) {
		write.checkCancellation?.();
		const sink = globalSinkOf(table, writer, write);
		table.each(input, sink.write);
	}
};

const writeDigests = (
	input: Readonly<{
		writer: DatabaseSync;
		generationId: string;
		adapterId: string;
		digests: ReadonlyMap<string, string>;
		selectedRows: RowCounterType;
		writtenRows: RowCounterType;
		checkCancellation?: () => void;
	}>,
): void => {
	const statement = input.writer.prepare(
		`insert into generation_file_digest (file_key, adapter_id, digest)
		 select f.file_key, ?, ? from file f
		 join generation g on g.generation_key = f.generation_key
		 where g.id = ? and f.path = ?
		 on conflict(file_key) do update set adapter_id = excluded.adapter_id, digest = excluded.digest`,
	);

	for (const [path, digest] of input.digests) {
		input.checkCancellation?.();
		input.selectedRows.value += 1;
		input.writtenRows.value += insertRow(statement, 'generation_file_digest', path, [input.adapterId, digest, input.generationId, path]);
	}
};

const totalChanges = (writer: DatabaseSync): number => {
	const row = writer.prepare('select total_changes() as total').get();
	return row === undefined ? 0 : asNumber(row, 'total');
};

const deleteGenerationRows = (
	writer: DatabaseSync,
	input: GenerationFactsInputType,
	paths: ReadonlySet<string>,
	checkCancellation: CancellationCheckType,
): number => {
	const before = totalChanges(writer);
	const deleteFile = writer.prepare(
		`delete from file
		 where generation_key = (select generation_key from generation where id = ?) and path = ?`,
	);

	for (const path of paths) {
		checkCancellation?.();
		deleteFile.run(input.generationId, path);
	}

	for (const table of GLOBAL_TABLES) {
		checkCancellation?.();
		writer
			.prepare(`delete from ${table.table} where generation_key = (select generation_key from generation where id = ?) and adapter_id = ?`)
			.run(input.generationId, adapterIdOf(input));
	}

	return totalChanges(writer) - before;
};

/**
 * Writes one complete generation fact set, or only the changed path groups.
 *
 * A `revise` write keeps the published generation identifier and rewrites only
 * path groups whose persisted rows change; an `insert` write starts from an
 * empty building generation. The caller owns the surrounding transaction.
 *
 * @param writer - Writer connection inside an open transaction.
 * @param rawInput - Files, finalized facts, dependencies, diagnostics, and hashes.
 * @param mode - Building-generation insert or published-generation revision.
 * @param checkCancellation - Optional cooperative cancellation checkpoint.
 * @returns Persisted row counts, changed paths, and the number of written rows.
 * @throws {@link Error} When the generation state does not match the mode.
 */
export const writeGenerationFacts = (
	writer: DatabaseSync,
	rawInput: GenerationFactsInputType,
	mode: GenerationFactWriteModeType,
	checkCancellation?: () => void,
): GenerationFactWriteType => {
	checkCancellation?.();
	const input = scopeAdapterFacts(rawInput);
	assertState(writer, input.generationId, mode);
	const prepared = prepareWrite(writer, input, mode);
	const selectedRows: RowCounterType = {value: 0};
	const writtenRows: RowCounterType = {value: 0};
	const digests = mode === 'insert' ? createDigestAccumulator(input.files.map((file) => file.path)) : null;

	const deletedRows = deleteGenerationRows(writer, input, prepared.changed, checkCancellation);
	syncGenerationFiles({
		writer,
		generationId: input.generationId,
		files: input.files,
		adapterId: adapterIdOf(input),
		...(checkCancellation === undefined ? {} : {checkCancellation}),
	});
	const projectRows = syncProjectContexts(writer, {
		generationId: input.generationId,
		adapterId: adapterIdOf(input),
		projects: input.projects,
		...(checkCancellation === undefined ? {} : {checkCancellation}),
	});
	selectedRows.value += input.projects.length;
	writtenRows.value += projectRows;
	writeTableRows(writer, input, {selected: prepared.selected, digests, selectedRows, writtenRows}, checkCancellation);
	writeGlobalRows(writer, input, {selectedRows, writtenRows, checkCancellation});
	writeDigests({
		writer,
		generationId: input.generationId,
		adapterId: adapterIdOf(input),
		digests: prepared.next ?? digests?.digests() ?? new Map(),
		selectedRows,
		writtenRows,
		...(checkCancellation === undefined ? {} : {checkCancellation}),
	});
	checkCancellation?.();
	writer.prepare('update generation set source_hash = ? where id = ?').run(input.sourceHash, input.generationId);

	return {
		counts: countsOfInput(input),
		changedPaths: [...prepared.changed].sort(),
		selectedRows: selectedRows.value,
		deletedRows,
		writtenRows: writtenRows.value,
	};
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

	validateGenerationFactCounts(reader, input);
	validateGenerationSemantics(reader, input);
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
export const countGenerationRows = (reader: DatabaseSync, generationId: string, table: string): number => {
	const relationship = {
		dependency_binding: 'join dependency_edge owner on owner.edge_key = row.edge_key',
		surface_binding_origin: 'join symbol_name owner on owner.symbol_name_key = row.symbol_name_key',
		symbol_name_context: 'join symbol_name owner on owner.symbol_name_key = row.symbol_name_key',
		symbol_name_site: 'join symbol_name owner on owner.symbol_name_key = row.symbol_name_key',
	}[table];
	const owner = relationship === undefined ? 'row' : 'owner';

	return countOf(
		reader,
		`select count(*) as total from ${table} row
		 ${relationship ?? ''}
		 join generation g on g.generation_key = ${owner}.generation_key
		 where g.id = ?`,
		generationId,
	);
};
