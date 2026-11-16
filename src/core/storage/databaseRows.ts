import {type GenerationRowType, type GenerationStateType, type IndexedDependencyBindingType, type StoredDependencyEdgeType} from '../model.ts';

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
	sourceHash: asString(row, 'source_hash'),
	configHash: asString(row, 'config_hash'),
	inputHash: asNullableString(row, 'input_hash') ?? asString(row, 'config_hash'),
	startedAt: asString(row, 'started_at'),
	completedAt: asNullableString(row, 'completed_at'),
	revision: asNumber(row, 'revision'),
	fileCount: asNumber(row, 'file_count'),
	symbolCount: asNumber(row, 'symbol_count'),
	occurrenceCount: asNumber(row, 'occurrence_count'),
	dependencyEdgeCount: asNumber(row, 'dependency_edge_count'),
	dependencyBindingCount: asNumber(row, 'dependency_binding_count'),
	diagnosticCount: asNumber(row, 'diagnostic_count'),
	stages: stagesOf(row),
	error: asNullableString(row, 'error'),
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
	adapterId: asString(row, 'adapter_id'),
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
	'e.adapter_id, e.id, pc.name as context_name, source.path as source_path, target.path as target_path, e.raw_target, e.target_identifier, e.kind, e.compile_time_only, e.start_line, e.start_column, e.end_line, e.end_column, e.start_offset, e.end_offset';

export const DEPENDENCY_BINDING_COLUMNS = 'e.id as edge_id, b.position, b.kind, b.imported_name, b.exported_name, b.local_name, b.compile_time_only';

export const placeholders = (count: number): string => Array.from({length: count}, () => '?').join(', ');
