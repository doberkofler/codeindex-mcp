import {
	type DependencyBindingKindType,
	type DependencyKindType,
	type GenerationRowType,
	type GenerationStateType,
	type IndexedDependencyBindingType,
	type ReferenceType,
	type StoredDependencyEdgeType,
	type SymbolSummaryType,
} from '../index/model.ts';

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

export const toSymbolSummary = (row: SqlRowType): SymbolSummaryType => ({
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
});

export const toReference = (row: SqlRowType): ReferenceType => ({
	path: asString(row, 'path'),
	startLine: asNumber(row, 'start_line'),
	startColumn: asNumber(row, 'start_column'),
	endLine: asNumber(row, 'end_line'),
	endColumn: asNumber(row, 'end_column'),
	role: asString(row, 'role') === 'definition' ? 'definition' : 'reference',
	enclosingId: asNullableString(row, 'enclosing_id'),
});

const dependencyKinds: readonly DependencyKindType[] = ['import', 'side-effect', 'export', 'export-all', 'dynamic-import', 'import-type', 'import-equals'];

const dependencyBindingKinds: readonly DependencyBindingKindType[] = ['default', 'named', 'namespace', 'all', 'import-equals'];

const dependencyKindOf = (value: string): DependencyKindType => {
	const kind = dependencyKinds.find((candidate) => candidate === value);

	if (kind === undefined) {
		throw new TypeError(`Expected dependency kind, received ${value}`);
	}

	return kind;
};

const dependencyBindingKindOf = (value: string): DependencyBindingKindType => {
	const kind = dependencyBindingKinds.find((candidate) => candidate === value);

	if (kind === undefined) {
		throw new TypeError(`Expected dependency binding kind, received ${value}`);
	}

	return kind;
};

export const toDependencyEdge = (row: SqlRowType, generationId: string): StoredDependencyEdgeType => ({
	generationId,
	id: asString(row, 'id'),
	sourcePath: asString(row, 'source_path'),
	targetPath: asNullableString(row, 'target_path'),
	rawSpecifier: asString(row, 'raw_specifier'),
	normalizedPackage: asNullableString(row, 'normalized_package'),
	kind: dependencyKindOf(asString(row, 'kind')),
	typeOnly: asNumber(row, 'type_only') === 1,
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
	kind: dependencyBindingKindOf(asString(row, 'kind')),
	importedName: asNullableString(row, 'imported_name'),
	exportedName: asNullableString(row, 'exported_name'),
	localName: asNullableString(row, 'local_name'),
	typeOnly: asNumber(row, 'type_only') === 1,
});

export const DEPENDENCY_EDGE_COLUMNS =
	'id, source_path, target_path, raw_specifier, normalized_package, kind, type_only, start_line, start_column, end_line, end_column, start_offset, end_offset';

export const DEPENDENCY_BINDING_COLUMNS = 'edge_id, position, kind, imported_name, exported_name, local_name, type_only';

export const SYMBOL_COLUMNS = 'id, name, qualified_name, kind, path, start_line, start_column, end_line, end_column, enclosing_id';

export const placeholders = (count: number): string => Array.from({length: count}, () => '?').join(', ');
