import {
	type GenerationRowType,
	type GenerationStateType,
	type IndexedDependencyBindingType,
	type ReferenceType,
	type StoredDependencyEdgeType,
	type SymbolSummaryType,
} from '../model.ts';

export type SqlRowType = Readonly<Record<string, unknown>>;

export const asString = (row: SqlRowType, key: string): string => {
	const value = row[key];

	if (typeof value !== 'string') {
		throw new TypeError(`Expected string column ${key}`);
	}

	return value;
};

const asNullableString = (row: SqlRowType, key: string): string | null => {
	const value = row[key];
	return typeof value === 'string' ? value : null;
};

export const asNumber = (row: SqlRowType, key: string): number => {
	const value = row[key];

	if (typeof value !== 'number') {
		throw new TypeError(`Expected numeric column ${key}`);
	}

	return value;
};

const toGenerationState = (value: string): GenerationStateType => {
	if (value === 'building' || value === 'published' || value === 'superseded' || value === 'failed') {
		return value;
	}

	throw new TypeError(`Expected generation state, received ${value}`);
};

const asNullableNumber = (row: SqlRowType, key: string): number | null => {
	const value = row[key];
	return typeof value === 'number' ? value : null;
};

const stagesOf = (row: SqlRowType): GenerationRowType['stages'] => {
	const scanMs = asNullableNumber(row, 'scan_ms');

	if (scanMs === null) {
		return null;
	}

	return {
		scanMs,
		compilerMs: asNullableNumber(row, 'compiler_ms') ?? 0,
		extractionMs: asNullableNumber(row, 'extraction_ms') ?? 0,
		insertionMs: asNullableNumber(row, 'insertion_ms') ?? 0,
		verificationMs: asNullableNumber(row, 'verification_ms') ?? 0,
		publicationMs: asNullableNumber(row, 'publication_ms') ?? 0,
	};
};

export const toGeneration = (row: SqlRowType): GenerationRowType => ({
	id: asString(row, 'id'),
	state: toGenerationState(asString(row, 'state')),
	extractorId: asString(row, 'extractor_id'),
	extractorVersion: asString(row, 'extractor_version'),
	compilerVersion: asString(row, 'compiler_version'),
	sourceHash: asString(row, 'source_hash'),
	configHash: asString(row, 'config_hash'),
	startedAt: asString(row, 'started_at'),
	completedAt: asNullableString(row, 'completed_at'),
	fileCount: asNumber(row, 'file_count'),
	symbolCount: asNumber(row, 'symbol_count'),
	occurrenceCount: asNumber(row, 'occurrence_count'),
	dependencyEdgeCount: asNumber(row, 'dependency_edge_count'),
	dependencyBindingCount: asNumber(row, 'dependency_binding_count'),
	diagnosticCount: asNumber(row, 'diagnostic_count'),
	stages: stagesOf(row),
	error: asNullableString(row, 'error'),
});

export const toSymbolSummary = (row: SqlRowType, contexts: readonly string[] = []): SymbolSummaryType => ({
	id: asString(row, 'id'),
	name: asString(row, 'name'),
	qualifiedName: asString(row, 'qualified_name'),
	kind: asString(row, 'kind'),
	path: asString(row, 'path'),
	startLine: asNumber(row, 'start_line'),
	startColumn: asNumber(row, 'start_column'),
	endLine: asNumber(row, 'end_line'),
	endColumn: asNumber(row, 'end_column'),
	enclosingId: asNullableString(row, 'enclosing_id'),
	contexts,
});

export const toReference = (row: SqlRowType, contexts: readonly string[] = []): ReferenceType => ({
	path: asString(row, 'path'),
	startLine: asNumber(row, 'start_line'),
	startColumn: asNumber(row, 'start_column'),
	endLine: asNumber(row, 'end_line'),
	endColumn: asNumber(row, 'end_column'),
	role: asString(row, 'role') === 'definition' ? 'definition' : 'reference',
	enclosingId: asNullableString(row, 'enclosing_id'),
	contexts,
});

const BOUNDED_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

/**
 * Validates one adapter-defined dependency kind read from storage.
 *
 * Kinds are opaque to the core. The bound keeps persisted or queried values from
 * becoming an unbounded diagnostic or SQL surface.
 *
 * @param value - Persisted kind value.
 * @returns The validated kind.
 * @throws {@link TypeError} When the value is not a bounded adapter identifier.
 */
const boundedKindOf = (value: string): string => {
	if (!BOUNDED_KIND_PATTERN.test(value)) {
		throw new TypeError(`Expected bounded dependency kind, received ${value}`);
	}

	return value;
};

export const toDependencyEdge = (row: SqlRowType, generationId: string): StoredDependencyEdgeType => ({
	generationId,
	id: asString(row, 'id'),
	context: asNullableString(row, 'context_name') ?? undefined,
	sourcePath: asString(row, 'source_path'),
	targetPath: asNullableString(row, 'target_path'),
	rawTarget: asString(row, 'raw_target'),
	targetIdentifier: asNullableString(row, 'target_identifier'),
	kind: boundedKindOf(asString(row, 'kind')),
	compileTimeOnly: asNumber(row, 'compile_time_only') === 1,
	startLine: asNumber(row, 'start_line'),
	startColumn: asNumber(row, 'start_column'),
	endLine: asNumber(row, 'end_line'),
	endColumn: asNumber(row, 'end_column'),
	startOffset: asNumber(row, 'start_offset'),
	endOffset: asNumber(row, 'end_offset'),
});

export const toDependencyBinding = (row: SqlRowType): IndexedDependencyBindingType => ({
	edgeId: asString(row, 'edge_id'),
	position: asNumber(row, 'position'),
	kind: boundedKindOf(asString(row, 'kind')),
	importedName: asNullableString(row, 'imported_name'),
	exportedName: asNullableString(row, 'exported_name'),
	localName: asNullableString(row, 'local_name'),
	compileTimeOnly: asNumber(row, 'compile_time_only') === 1,
});

export const DEPENDENCY_EDGE_COLUMNS =
	'id, context_name, source_path, target_path, raw_target, target_identifier, kind, compile_time_only, start_line, start_column, end_line, end_column, start_offset, end_offset';

export const DEPENDENCY_BINDING_COLUMNS = 'edge_id, position, kind, imported_name, exported_name, local_name, compile_time_only';

export const SYMBOL_COLUMNS = 'id, name, qualified_name, kind, path, start_line, start_column, end_line, end_column, enclosing_id';

export const placeholders = (count: number): string => Array.from({length: count}, () => '?').join(', ');
