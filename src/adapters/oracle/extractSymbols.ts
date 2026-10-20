import {type ExtractedOccurrenceType, type ExtractedPublicationFactsType} from '../../core/facts/index.ts';
import {type DiagnosticType, type IndexedOccurrenceType, type IndexedSymbolType} from '../../core/model.ts';
import {createOraclePublicationFacts, type OraclePublicationSymbolMetadataType} from './publicationFacts.ts';
import {type OracleFileGraphType, type OraclePackageLookupMapType} from './scopeGraph.ts';
import {type OracleParseResultType, type OracleRangeType} from './syntax.ts';
import {buildSymbolTable, type MutableBindingType, type OracleParsedFileType} from './symbolTables.ts';

export type {OracleParsedFileType} from './symbolTables.ts';

export type OracleFileAnalysisType = Readonly<{
	path: string;
	parse: OracleParseResultType;
	graph: OracleFileGraphType;
	bindings: readonly Readonly<{
		canonical: string;
		signature: string;
		symbolId: string;
		definitionOnly: boolean;
		mapped: boolean;
		enclosingId: string | null;
	}>[];
}>;

export type OracleContextSymbolsType = Readonly<{
	analyses: readonly OracleFileAnalysisType[];
	packages: OraclePackageLookupMapType;
	symbols: readonly IndexedSymbolType[];
	occurrences: readonly IndexedOccurrenceType[];
	publication: ExtractedPublicationFactsType;
	diagnostics: readonly DiagnosticType[];
}>;

type InputType = Readonly<{
	projectId: string;
	context: string;
	files: readonly OracleParsedFileType[];
}>;

const definitionOccurrence = (
	input: Readonly<{path: string; context: string; range: OracleRangeType; symbolId: string; enclosingId: string | null}>,
): ExtractedOccurrenceType => ({
	symbolId: input.symbolId,
	path: input.path,
	startLine: input.range.startLine,
	startColumn: input.range.startColumn,
	endLine: input.range.endLine,
	endColumn: input.range.endColumn,
	startOffset: input.range.startOffset,
	endOffset: input.range.endOffset,
	role: 'definition',
	enclosingId: input.enclosingId,
	contexts: [input.context],
});

const analysesOf = (files: readonly OracleParsedFileType[], table: ReturnType<typeof buildSymbolTable>): readonly OracleFileAnalysisType[] =>
	files.map((file, index) => ({
		path: file.path,
		parse: file.parse,
		graph: table.graphs[index] ?? {canonicals: [], signatures: [], childrenByParent: new Map()},
		bindings: (table.bindings[index] ?? []).map((binding) => ({
			canonical: binding.canonical,
			signature: binding.signature,
			symbolId: binding.symbolId,
			definitionOnly: binding.definitionOnly,
			mapped: binding.mappedSpec !== null,
			enclosingId: binding.enclosingId,
		})),
	}));

const bodyMappedIdsOf = (table: ReturnType<typeof buildSymbolTable>): ReadonlySet<string> => {
	const ids = new Set<string>();

	for (const fileBindings of table.bindings) {
		for (const binding of fileBindings) {
			if (binding.mappedSpec !== null) {
				ids.add(binding.symbolId);
			}
		}
	}

	return ids;
};

const isRoutineKind = (kind: string): boolean => kind === 'procedure' || kind === 'function' || kind === 'cursor';

const isSpecUnitKind = (kind: string | undefined): boolean => kind === 'package-spec' || kind === 'procedure' || kind === 'function';

const anchorRankOf = (bodyUnit: boolean, bodyForward: boolean, definitionOnly: boolean): number => {
	if (!bodyUnit) {
		return 0;
	}

	return bodyForward ? 2 : definitionOnly ? 1 : 0;
};

const primaryRankOf = (bodyUnit: boolean, kind: string, isRoutine: boolean): number => {
	if (bodyUnit) {
		return kind === 'package' ? 1 : 0;
	}

	return kind === 'package' || !isRoutine ? 0 : 1;
};

const definitionRanks = (
	declaration: OracleParsedFileType['parse']['declarations'][number],
	binding: MutableBindingType,
	unit: OracleParsedFileType['parse']['units'][number] | undefined,
	bodyMappedSymbolIds: ReadonlySet<string>,
): Readonly<{forwardDefinition: boolean; anchorRank: number; primaryRank: number}> => {
	const isRoutine = isRoutineKind(declaration.kind);
	const bodyUnit = unit?.kind === 'package-body';
	const pairedForward = isSpecUnitKind(unit?.kind) && isRoutine && bodyMappedSymbolIds.has(binding.symbolId);
	const bodyForward = bodyUnit && binding.definitionOnly && binding.mappedSpec === null && isRoutine;

	return {
		forwardDefinition: pairedForward || bodyForward,
		anchorRank: anchorRankOf(bodyUnit, bodyForward, binding.definitionOnly),
		primaryRank: primaryRankOf(bodyUnit, declaration.kind, isRoutine),
	};
};

const emitDeclaration = (
	input: Readonly<{
		file: OracleParsedFileType;
		context: string;
		declaration: OracleParsedFileType['parse']['declarations'][number];
		binding: MutableBindingType;
		bodyMappedSymbolIds: ReadonlySet<string>;
		symbols: IndexedSymbolType[];
		occurrences: ExtractedOccurrenceType[];
		metadata: Map<string, OraclePublicationSymbolMetadataType>;
	}>,
): void => {
	const {declaration, binding} = input;

	if (binding.symbolId === '') {
		return;
	}

	const unit = input.file.parse.units[declaration.unit];
	const ranks = definitionRanks(declaration, binding, unit, input.bodyMappedSymbolIds);

	if (binding.ownSymbol !== null) {
		const ownSymbol = {...binding.ownSymbol, enclosingId: binding.enclosingId};
		const existing = input.metadata.get(ownSymbol.id);

		input.symbols.push(ownSymbol);
		input.metadata.set(ownSymbol.id, {
			owner: unit?.schema.canonical ?? '',
			exported: (existing?.exported ?? false) || declaration.exported,
		});
	}

	input.occurrences.push({
		...definitionOccurrence({
			path: input.file.path,
			context: input.context,
			range: declaration.nameRange,
			symbolId: binding.symbolId,
			enclosingId: binding.enclosingId,
		}),
		declarationKind: declaration.kind,
		forwardDefinition: ranks.forwardDefinition,
		extent: declaration.range,
		anchorRank: ranks.anchorRank,
		primaryRank: ranks.primaryRank,
	});
};

const emitFacts = (
	input: Readonly<{files: readonly OracleParsedFileType[]; context: string; table: ReturnType<typeof buildSymbolTable>}>,
): Readonly<{
	symbols: IndexedSymbolType[];
	occurrences: IndexedOccurrenceType[];
	metadata: ReadonlyMap<string, OraclePublicationSymbolMetadataType>;
}> => {
	const symbols: IndexedSymbolType[] = [];
	const occurrences: ExtractedOccurrenceType[] = [];
	const metadata = new Map<string, OraclePublicationSymbolMetadataType>();
	const bodyMappedSymbolIds = bodyMappedIdsOf(input.table);

	for (const [fileIndex, file] of input.files.entries()) {
		for (const [index, declaration] of file.parse.declarations.entries()) {
			const binding = input.table.bindings[fileIndex]?.[index];

			if (binding !== undefined) {
				emitDeclaration({file, context: input.context, declaration, binding, bodyMappedSymbolIds, symbols, occurrences, metadata});
			}
		}
	}

	symbols.sort((left, right) => left.path.localeCompare(right.path) || left.startOffset - right.startOffset || left.id.localeCompare(right.id));
	occurrences.sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.startOffset - right.startOffset ||
			left.symbolId.localeCompare(right.symbolId) ||
			left.role.localeCompare(right.role),
	);

	return {symbols, occurrences, metadata};
};

/**
 * Assigns deterministic symbols and definition occurrences for one Oracle context.
 *
 * Package specifications own canonical public member symbols. Matching package
 * body routines and parameters add definition occurrences for those symbols;
 * private and nested body declarations own new symbols.
 *
 * @param input - Project identity, context name, and parsed files.
 * @returns Symbols, definition occurrences, analyses, and package lookup tables.
 */
export const extractOracleSymbols = (input: InputType): OracleContextSymbolsType => {
	const table = buildSymbolTable(input);
	const facts = emitFacts({files: input.files, context: input.context, table});

	return {
		analyses: analysesOf(input.files, table),
		packages: table.packages,
		symbols: facts.symbols,
		occurrences: facts.occurrences,
		publication: createOraclePublicationFacts({
			context: input.context,
			symbols: facts.symbols,
			occurrences: facts.occurrences,
			metadata: facts.metadata,
		}),
		diagnostics: table.diagnostics,
	};
};
