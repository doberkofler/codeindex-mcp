import {type DiagnosticType, type IndexedOccurrenceType, type IndexedSymbolType} from '../../core/model.ts';
import {type OracleFileGraphType, type OraclePackageLookupMapType} from './scopeGraph.ts';
import {type OracleParseResultType, type OracleRangeType} from './syntax.ts';
import {buildSymbolTable, type OracleParsedFileType} from './symbolTables.ts';

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
		enclosingId: string | null;
	}>[];
}>;

export type OracleContextSymbolsType = Readonly<{
	analyses: readonly OracleFileAnalysisType[];
	packages: OraclePackageLookupMapType;
	symbols: readonly IndexedSymbolType[];
	occurrences: readonly IndexedOccurrenceType[];
	diagnostics: readonly DiagnosticType[];
}>;

type InputType = Readonly<{
	projectId: string;
	context: string;
	files: readonly OracleParsedFileType[];
}>;

const definitionOccurrence = (
	input: Readonly<{path: string; context: string; range: OracleRangeType; symbolId: string; enclosingId: string | null}>,
): IndexedOccurrenceType => ({
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
			enclosingId: binding.enclosingId,
		})),
	}));

const emitFacts = (
	input: Readonly<{files: readonly OracleParsedFileType[]; context: string; table: ReturnType<typeof buildSymbolTable>}>,
): Readonly<{symbols: IndexedSymbolType[]; occurrences: IndexedOccurrenceType[]}> => {
	const symbols: IndexedSymbolType[] = [];
	const occurrences: IndexedOccurrenceType[] = [];

	for (const [fileIndex, file] of input.files.entries()) {
		for (const [index, declaration] of file.parse.declarations.entries()) {
			const binding = input.table.bindings[fileIndex]?.[index];

			if (binding === undefined || binding.symbolId === '') {
				continue;
			}

			if (binding.ownSymbol !== null) {
				symbols.push({...binding.ownSymbol, enclosingId: binding.enclosingId});
			}

			occurrences.push(
				definitionOccurrence({
					path: file.path,
					context: input.context,
					range: declaration.nameRange,
					symbolId: binding.symbolId,
					enclosingId: binding.enclosingId,
				}),
			);
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

	return {symbols, occurrences};
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
		diagnostics: table.diagnostics,
	};
};
