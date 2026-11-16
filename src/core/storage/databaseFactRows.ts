import {createHash} from 'node:crypto';
import {type DatabaseSync} from 'node:sqlite';
import {createFactId} from '@codeindex/adapter-sdk/facts';
import {prepareDefinitionSiteStage, prepareOccurrenceContextStage, publishDefinitionSiteStage, publishOccurrenceContextStage} from './databaseFactStages.ts';
import {buildStatsOf} from './databaseFactStats.ts';
import {adapterIdOf, type GenerationFactsInputType} from './databaseFactTypes.ts';

export type CellType = string | number | null;

export type RowVisitorType = (ownerPath: string, values: readonly CellType[]) => void;

export type DigestAccumulatorType = Readonly<{
	add: (ownerPath: string, values: readonly CellType[]) => void;
	digests: () => ReadonlyMap<string, string>;
}>;

const appendRow = (hash: ReturnType<typeof createHash>, values: readonly CellType[]): void => {
	for (const value of values) {
		hash.update(value === null ? '\u0000\u0002' : String(value));
		hash.update('\u0000\u0001');
	}

	hash.update('\u0000\u0003');
};

export const createDigestAccumulator = (paths: readonly string[]): DigestAccumulatorType => {
	const hashes = new Map<string, ReturnType<typeof createHash>>();

	for (const path of paths) {
		hashes.set(path, createHash('sha256'));
	}

	return {
		add: (ownerPath, values): void => {
			let hash = hashes.get(ownerPath);

			if (hash === undefined) {
				hash = createHash('sha256');
				hashes.set(ownerPath, hash);
			}

			appendRow(hash, values);
		},
		digests: (): ReadonlyMap<string, string> => new Map([...hashes].map(([path, hash]) => [path, hash.digest('hex')])),
	};
};

export const ownerPathsOf = (
	input: GenerationFactsInputType,
): Readonly<{symbolPath: ReadonlyMap<string, string>; bindingPath: ReadonlyMap<string, string>}> => {
	const symbolPath = new Map<string, string>();

	for (const symbol of input.facts.symbols) {
		symbolPath.set(symbol.id, symbol.path);
	}

	const bindingPath = new Map<string, string>();

	for (const binding of input.facts.bindings) {
		const ownerPath = symbolPath.get(binding.symbolId);

		if (ownerPath === undefined) {
			throw new Error(`Binding ${binding.bindingId} has no owning symbol`);
		}

		bindingPath.set(binding.bindingId, ownerPath);
	}

	return {symbolPath, bindingPath};
};

const eachSymbolRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const symbol of input.facts.symbols) {
		visit(symbol.path, [
			adapterIdOf(input),
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
			input.generationId,
		]);
	}
};

const eachSymbolContextRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const symbol of input.facts.symbols) {
		for (const context of symbol.contexts ?? []) {
			visit(symbol.path, [symbol.id, adapterIdOf(input), context, input.generationId]);
		}
	}
};

const eachBindingRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const {symbolPath} = ownerPathsOf(input);

	for (const binding of input.facts.bindings) {
		visit(symbolPath.get(binding.symbolId) ?? binding.symbolId, [
			adapterIdOf(input),
			binding.bindingId,
			binding.symbolId,
			binding.bindingKey,
			binding.container,
			binding.name,
			binding.qualifiedName,
			binding.exposure,
			binding.hasDeclaredSite ? 1 : 0,
			input.generationId,
		]);
	}
};

const eachBindingContextRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const {bindingPath} = ownerPathsOf(input);

	for (const context of input.facts.bindingContexts) {
		visit(bindingPath.get(context.bindingId) ?? context.bindingId, [
			context.bindingId,
			adapterIdOf(input),
			context.context,
			context.exposure,
			input.generationId,
		]);
	}
};

const eachBindingSiteRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const {bindingPath} = ownerPathsOf(input);

	for (const site of input.facts.bindingSites) {
		visit(bindingPath.get(site.bindingId) ?? site.path, [
			site.bindingId,
			site.path,
			site.kind,
			site.range.startLine,
			site.range.startColumn,
			site.range.endLine,
			site.range.endColumn,
			site.range.startOffset,
			site.range.endOffset,
			input.generationId,
		]);
	}
};

const eachSurfaceOriginRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const {bindingPath} = ownerPathsOf(input);

	for (const origin of input.facts.surfaceOrigins) {
		visit(bindingPath.get(origin.bindingId) ?? origin.bindingId, [
			origin.bindingId,
			adapterIdOf(input),
			origin.context,
			origin.rootBindingId,
			origin.relativeKey,
			input.generationId,
		]);
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

const eachOccurrenceRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const occurrence of input.facts.occurrences) {
		const columns = occurrenceColumnsOf(occurrence);

		visit(occurrence.path, [
			adapterIdOf(input),
			occurrence.symbolId,
			occurrence.path,
			occurrence.path,
			occurrence.symbolId,
			occurrence.startLine,
			occurrence.startColumn,
			occurrence.endLine,
			occurrence.endColumn,
			occurrence.startOffset,
			occurrence.endOffset,
			occurrence.role,
			occurrence.enclosingId,
			occurrence.enclosingId,
			columns.declarationKind,
			columns.forwardDefinition,
			occurrence.usage ?? 0,
			columns.extentStart,
			columns.extentEnd,
			columns.anchorRank,
			columns.primaryRank,
			input.generationId,
		]);
	}
};

const eachOccurrenceContextRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const occurrence of input.facts.occurrences) {
		for (const context of occurrence.contexts ?? []) {
			visit(occurrence.path, [occurrence.symbolId, occurrence.path, occurrence.startOffset, occurrence.role, adapterIdOf(input), context, input.generationId]);
		}
	}
};

const definitionSiteIdOf = (symbolId: string, path: string, startOffset: number): string =>
	createFactId('o_', [symbolId, path, String(startOffset), 'definition']);

const eachDefinitionSiteRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const seen = new Set<string>();

	// Finalized occurrences are ordered by path and start offset, so the first
	// site seen for one symbol and path is its smallest offset in that path.
	for (const occurrence of input.facts.occurrences) {
		if (occurrence.role !== 'definition') {
			continue;
		}

		const key = `${occurrence.symbolId}\u0000${occurrence.path}`;
		const firstInSymbol = !seen.has(key);
		seen.add(key);
		visit(occurrence.path, [
			definitionSiteIdOf(occurrence.symbolId, occurrence.path, occurrence.startOffset),
			occurrence.symbolId,
			firstInSymbol ? 1 : 0,
			occurrence.symbolId,
			occurrence.path,
			occurrence.startOffset,
			input.generationId,
		]);
	}
};

const eachDependencyEdgeRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const edge of input.dependencies.edges) {
		visit(edge.sourcePath, [
			adapterIdOf(input),
			edge.id,
			edge.context ?? null,
			adapterIdOf(input),
			edge.context ?? null,
			edge.sourcePath,
			edge.targetPath,
			edge.rawTarget,
			edge.targetIdentifier,
			edge.kind,
			edge.compileTimeOnly ? 1 : 0,
			edge.startLine,
			edge.startColumn,
			edge.endLine,
			edge.endColumn,
			edge.startOffset,
			edge.endOffset,
			input.generationId,
		]);
	}
};

const eachDependencyBindingRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const edgePath = new Map(input.dependencies.edges.map((edge) => [edge.id, edge.sourcePath]));

	for (const binding of input.dependencies.bindings) {
		visit(edgePath.get(binding.edgeId) ?? '', [
			binding.edgeId,
			binding.position,
			binding.kind,
			binding.importedName,
			binding.exportedName,
			binding.localName,
			binding.compileTimeOnly ? 1 : 0,
			input.generationId,
		]);
	}
};

const eachDiagnosticRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const [index, diagnostic] of input.diagnostics.entries()) {
		visit(diagnostic.path ?? '', [
			adapterIdOf(input),
			index,
			diagnostic.category,
			diagnostic.code,
			diagnostic.message,
			diagnostic.path,
			diagnostic.startLine,
			diagnostic.startColumn,
			diagnostic.path,
			input.generationId,
		]);
	}
};

const eachBuildStatRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const row of buildStatsOf(input.facts, input.language)) {
		visit('', [adapterIdOf(input), row.language, row.metric, row.dim1, row.dim2, row.dim3, row.value, input.generationId]);
	}
};

export type TableWriteType = Readonly<{
	table: string;
	insertSql: string;
	each: (input: GenerationFactsInputType, visit: RowVisitorType) => void;
	before?: (writer: DatabaseSync) => void;
	after?: (writer: DatabaseSync, input: GenerationFactsInputType, selected: ReadonlySet<string> | null, checkCancellation: (() => void) | undefined) => void;
}>;

const resolveSymbolParents = (
	writer: DatabaseSync,
	input: GenerationFactsInputType,
	selected: ReadonlySet<string> | null,
	checkCancellation: (() => void) | undefined,
): void => {
	const update = writer.prepare(
		`update symbol
		 set enclosing_symbol_key = coalesce(
			(select parent.symbol_key from symbol parent
			 where parent.generation_key = symbol.generation_key and parent.id = ?),
			-1)
		 where generation_key = (select generation_key from generation where id = ?) and id = ?`,
	);

	for (const symbol of input.facts.symbols) {
		if (symbol.enclosingId !== null && (selected === null || selected.has(symbol.path))) {
			checkCancellation?.();
			update.run(symbol.enclosingId, input.generationId, symbol.id);
		}
	}
};

export const PATH_TABLES: readonly TableWriteType[] = [
	{
		table: 'symbol',
		insertSql: `insert into symbol (generation_key, adapter_id, id, name, qualified_name, kind, file_key, start_line, start_column, end_line, end_column,
		 start_offset, end_offset, enclosing_symbol_key, external_target, external_name, exposure)
		 select g.generation_key, ?, ?, ?, ?, ?,
			(select file_key from file where generation_key = g.generation_key and path = ?),
			?, ?, ?, ?, ?, ?, case when ? is null then null else -1 end, ?, ?, ?
		 from generation g where g.id = ?`,
		each: eachSymbolRow,
		after: resolveSymbolParents,
	},
	{
		table: 'symbol_context',
		insertSql: `insert or ignore into symbol_context (symbol_key, context_key)
		 select
			(select symbol_key from symbol where generation_key = g.generation_key and id = ?),
			(select context_key from project_context where generation_key = g.generation_key and adapter_id = ? and name = ?)
		 from generation g where g.id = ?`,
		each: eachSymbolContextRow,
	},
	{
		table: 'symbol_name',
		insertSql: `insert into symbol_name (generation_key, adapter_id, binding_id, symbol_key, binding_key, container, name, qualified_name, exposure, has_declared_site)
		 select g.generation_key, ?, ?,
			(select symbol_key from symbol where generation_key = g.generation_key and id = ?),
			?, ?, ?, ?, ?, ?
		 from generation g where g.id = ?`,
		each: eachBindingRow,
	},
	{
		table: 'symbol_name_context',
		insertSql: `insert into symbol_name_context (symbol_name_key, context_key, exposure)
		 select
			(select symbol_name_key from symbol_name where generation_key = g.generation_key and binding_id = ?),
			(select context_key from project_context where generation_key = g.generation_key and adapter_id = ? and name = ?),
			?
		 from generation g where g.id = ?`,
		each: eachBindingContextRow,
	},
	{
		table: 'symbol_name_site',
		insertSql: `insert into symbol_name_site (symbol_name_key, file_key, kind, start_line, start_column, end_line, end_column, start_offset, end_offset)
		 select
			(select symbol_name_key from symbol_name where generation_key = g.generation_key and binding_id = ?),
			(select file_key from file where generation_key = g.generation_key and path = ?),
			?, ?, ?, ?, ?, ?, ?
		 from generation g where g.id = ?`,
		each: eachBindingSiteRow,
	},
	{
		table: 'surface_binding_origin',
		insertSql: `insert into surface_binding_origin (symbol_name_key, context_key, root_symbol_name_key, relative_key)
		 select
			(select symbol_name_key from symbol_name where generation_key = g.generation_key and binding_id = ?),
			(select context_key from project_context where generation_key = g.generation_key and adapter_id = ? and name = ?),
			(select symbol_name_key from symbol_name where generation_key = g.generation_key and binding_id = ?),
			?
		 from generation g where g.id = ?`,
		each: eachSurfaceOriginRow,
	},
	{
		table: 'occurrence',
		insertSql: `insert into occurrence (generation_key, adapter_id, symbol_key, file_key, path_order, symbol_id_order, start_line, start_column, end_line, end_column,
		 start_offset, end_offset, role, enclosing_symbol_key, declaration_kind, forward_definition, usage, extent_start, extent_end, anchor_rank, primary_rank)
		 select g.generation_key, ?,
			(select symbol_key from symbol where generation_key = g.generation_key and id = ?),
			(select file_key from file where generation_key = g.generation_key and path = ?),
			?, ?, ?, ?, ?, ?, ?, ?, ?,
			case when ? is null then null else coalesce(
				(select symbol_key from symbol where generation_key = g.generation_key and id = ?), -1)
			end,
			?, ?, ?, ?, ?, ?, ?
		 from generation g where g.id = ?`,
		each: eachOccurrenceRow,
	},
	{
		table: 'occurrence_context',
		insertSql: `insert into temp.occurrence_context_stage
			(symbol_id, path, start_offset, role, adapter_id, context_name, generation_id)
		 values (?, ?, ?, ?, ?, ?, ?)`,
		each: eachOccurrenceContextRow,
		before: prepareOccurrenceContextStage,
		after: publishOccurrenceContextStage,
	},
	{
		table: 'definition_site',
		insertSql: `insert into temp.definition_site_stage
			(site_id, symbol_id_order, first_in_symbol, symbol_id, path, start_offset, generation_id)
		 values (?, ?, ?, ?, ?, ?, ?)`,
		each: eachDefinitionSiteRow,
		before: prepareDefinitionSiteStage,
		after: publishDefinitionSiteStage,
	},
	{
		table: 'dependency_edge',
		insertSql: `insert into dependency_edge (generation_key, adapter_id, id, context_key, source_file_key, target_file_key, raw_target, target_identifier, kind, compile_time_only,
		 start_line, start_column, end_line, end_column, start_offset, end_offset)
		 select g.generation_key, ?, ?,
			case when ? is null then null else coalesce(
				(select context_key from project_context where generation_key = g.generation_key and adapter_id = ? and name = ?),
				-1)
			end,
			(select file_key from file where generation_key = g.generation_key and path = ?),
			(select file_key from file where generation_key = g.generation_key and path = ?),
			?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		 from generation g where g.id = ?`,
		each: eachDependencyEdgeRow,
	},
	{
		table: 'dependency_binding',
		insertSql: `insert into dependency_binding (edge_key, position, kind, imported_name, exported_name, local_name, compile_time_only)
		 select
			(select edge_key from dependency_edge where generation_key = g.generation_key and id = ?),
			?, ?, ?, ?, ?, ?
		 from generation g where g.id = ?`,
		each: eachDependencyBindingRow,
	},
];

export const GLOBAL_TABLES: readonly TableWriteType[] = [
	{
		table: 'diagnostic',
		insertSql: `insert into diagnostic
		 (generation_key, adapter_id, position, category, code, message, file_key, fallback_path, start_line, start_column)
		 select g.generation_key, ?, ?, ?, ?, ?, matched.file_key,
			case when matched.file_key is null then ? else null end,
			?, ?
		 from generation g
		 left join file matched on matched.generation_key = g.generation_key and matched.path = ?
		 where g.id = ?`,
		each: eachDiagnosticRow,
	},
	{
		table: 'build_stats',
		insertSql: `insert into build_stats (generation_key, adapter_id, language, metric, dim1, dim2, dim3, value)
		 select generation_key, ?, ?, ?, ?, ?, ?, ? from generation where id = ?`,
		each: eachBuildStatRow,
	},
];
