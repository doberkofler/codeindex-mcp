import {createHash} from 'node:crypto';
import {createFactId} from '../facts/canonical.ts';
import {buildStatsOf} from './databaseFactStats.ts';
import {type GenerationFactsInputType} from './databaseFactTypes.ts';

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
		]);
	}
};

const eachSymbolContextRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const symbol of input.facts.symbols) {
		for (const context of symbol.contexts ?? []) {
			visit(symbol.path, [input.generationId, symbol.id, context]);
		}
	}
};

const eachBindingRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const {symbolPath} = ownerPathsOf(input);

	for (const binding of input.facts.bindings) {
		visit(symbolPath.get(binding.symbolId) ?? binding.symbolId, [
			input.generationId,
			binding.bindingId,
			binding.symbolId,
			binding.bindingKey,
			binding.container,
			binding.name,
			binding.qualifiedName,
			binding.exposure,
			binding.hasDeclaredSite ? 1 : 0,
		]);
	}
};

const eachBindingContextRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const {bindingPath} = ownerPathsOf(input);

	for (const context of input.facts.bindingContexts) {
		visit(bindingPath.get(context.bindingId) ?? context.bindingId, [input.generationId, context.bindingId, context.context, context.exposure]);
	}
};

const eachBindingSiteRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const {bindingPath} = ownerPathsOf(input);

	for (const site of input.facts.bindingSites) {
		visit(bindingPath.get(site.bindingId) ?? site.path, [
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
		]);
	}
};

const eachSurfaceOriginRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const {bindingPath} = ownerPathsOf(input);

	for (const origin of input.facts.surfaceOrigins) {
		visit(bindingPath.get(origin.bindingId) ?? origin.bindingId, [
			input.generationId,
			origin.bindingId,
			origin.context,
			origin.rootBindingId,
			origin.relativeKey,
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
		]);
	}
};

const eachOccurrenceContextRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const occurrence of input.facts.occurrences) {
		for (const context of occurrence.contexts ?? []) {
			visit(occurrence.path, [input.generationId, occurrence.symbolId, occurrence.path, occurrence.startOffset, occurrence.role, context]);
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
			input.generationId,
			definitionSiteIdOf(occurrence.symbolId, occurrence.path, occurrence.startOffset),
			occurrence.symbolId,
			occurrence.path,
			occurrence.startOffset,
			occurrence.role,
			firstInSymbol ? 1 : 0,
		]);
	}
};

const eachDependencyEdgeRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const edge of input.dependencies.edges) {
		visit(edge.sourcePath, [
			input.generationId,
			edge.id,
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
		]);
	}
};

const eachDependencyBindingRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	const edgePath = new Map(input.dependencies.edges.map((edge) => [edge.id, edge.sourcePath]));

	for (const binding of input.dependencies.bindings) {
		visit(edgePath.get(binding.edgeId) ?? '', [
			input.generationId,
			binding.edgeId,
			binding.position,
			binding.kind,
			binding.importedName,
			binding.exportedName,
			binding.localName,
			binding.compileTimeOnly ? 1 : 0,
		]);
	}
};

const eachDiagnosticRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const [index, diagnostic] of input.diagnostics.entries()) {
		visit(diagnostic.path ?? '', [
			input.generationId,
			index,
			diagnostic.category,
			diagnostic.code,
			diagnostic.message,
			diagnostic.path,
			diagnostic.startLine,
			diagnostic.startColumn,
		]);
	}
};

const eachBuildStatRow = (input: GenerationFactsInputType, visit: RowVisitorType): void => {
	for (const row of buildStatsOf(input.facts, input.language)) {
		visit('', [input.generationId, row.language, row.metric, row.dim1, row.dim2, row.dim3, row.value]);
	}
};

export type TableWriteType = Readonly<{table: string; insertSql: string; each: (input: GenerationFactsInputType, visit: RowVisitorType) => void}>;

export const PATH_TABLES: readonly TableWriteType[] = [
	{
		table: 'symbol',
		insertSql: `insert into symbol (generation_id, id, name, qualified_name, kind, path, start_line, start_column, end_line, end_column,
		 start_offset, end_offset, enclosing_id, external_target, external_name, exposure)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		each: eachSymbolRow,
	},
	{
		table: 'symbol_context',
		insertSql: 'insert or ignore into symbol_context (generation_id, symbol_id, context_name) values (?, ?, ?)',
		each: eachSymbolContextRow,
	},
	{
		table: 'symbol_name',
		insertSql: `insert into symbol_name (generation_id, binding_id, symbol_id, binding_key, container, name, qualified_name, exposure, has_declared_site)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		each: eachBindingRow,
	},
	{
		table: 'symbol_name_context',
		insertSql: 'insert into symbol_name_context (generation_id, binding_id, context_name, exposure) values (?, ?, ?, ?)',
		each: eachBindingContextRow,
	},
	{
		table: 'symbol_name_site',
		insertSql: `insert into symbol_name_site (generation_id, binding_id, kind, path, start_line, start_column, end_line, end_column, start_offset, end_offset)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		each: eachBindingSiteRow,
	},
	{
		table: 'surface_binding_origin',
		insertSql: `insert into surface_binding_origin (generation_id, binding_id, context_name, root_binding_id, relative_key)
		 values (?, ?, ?, ?, ?)`,
		each: eachSurfaceOriginRow,
	},
	{
		table: 'occurrence',
		insertSql: `insert into occurrence (generation_id, symbol_id, path, start_line, start_column, end_line, end_column, start_offset, end_offset,
		 role, enclosing_id, declaration_kind, forward_definition, usage, extent_start, extent_end, anchor_rank, primary_rank)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		each: eachOccurrenceRow,
	},
	{
		table: 'occurrence_context',
		insertSql: `insert or ignore into occurrence_context (generation_id, symbol_id, path, start_offset, role, context_name)
		 values (?, ?, ?, ?, ?, ?)`,
		each: eachOccurrenceContextRow,
	},
	{
		table: 'definition_site',
		insertSql: 'insert into definition_site (generation_id, site_id, symbol_id, path, start_offset, role, first_in_symbol) values (?, ?, ?, ?, ?, ?, ?)',
		each: eachDefinitionSiteRow,
	},
	{
		table: 'dependency_edge',
		insertSql: `insert into dependency_edge (generation_id, id, context_name, source_path, target_path, raw_target, target_identifier, kind, compile_time_only,
		 start_line, start_column, end_line, end_column, start_offset, end_offset)
		 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		each: eachDependencyEdgeRow,
	},
	{
		table: 'dependency_binding',
		insertSql: `insert into dependency_binding (generation_id, edge_id, position, kind, imported_name, exported_name, local_name, compile_time_only)
		 values (?, ?, ?, ?, ?, ?, ?, ?)`,
		each: eachDependencyBindingRow,
	},
];

export const GLOBAL_TABLES: readonly TableWriteType[] = [
	{
		table: 'diagnostic',
		insertSql: 'insert into diagnostic (generation_id, position, category, code, message, path, start_line, start_column) values (?, ?, ?, ?, ?, ?, ?, ?)',
		each: eachDiagnosticRow,
	},
	{
		table: 'build_stats',
		insertSql: `insert into build_stats (generation_id, language, metric, dim1, dim2, dim3, value)
		 values (?, ?, ?, ?, ?, ?, ?)`,
		each: eachBuildStatRow,
	},
];
