import {
	finalizeFacts,
	type ExtractedBindingContextType,
	type ExtractedBindingSiteType,
	type ExtractedFactSetType,
	type ExtractedOccurrenceType,
	type FactAddressType,
	type FactExposureType,
	type FactRangeType,
	type FactSiteKindType,
	type FinalizedFactSetType,
} from '../../src/core/facts/index.ts';
import {
	type DependencyExtractionResultType,
	type DiagnosticType,
	type IndexedSymbolType,
	type ScanProjectResultType,
	type SourceFileType,
} from '../../src/core/model.ts';

const CONTEXT = 'app';
const PATH = 'src/example.ts';
const SHA256 = 'a'.repeat(64);

const address = (name: string): FactAddressType => [
	['global', null],
	['member', name],
];

export type GenerationFactSeedType = Readonly<{
	readonly language: string;
	readonly files: readonly SourceFileType[];
	readonly projects: readonly ScanProjectResultType[];
	readonly facts: FinalizedFactSetType;
	readonly dependencies: DependencyExtractionResultType;
	readonly diagnostics: readonly DiagnosticType[];
	readonly sourceHash: string;
}>;

/**
 * Builds one valid finalized generation fact set for storage tests.
 *
 * Every symbol has one published binding, one project context, one declared
 * site, and one definition occurrence.
 *
 * @param input - Symbol count, file path, and optional dependency facts.
 * @returns Complete storage input without a generation identifier.
 */
export const createGenerationFactSeed = (
	input: Readonly<{
		readonly symbolCount?: number;
		readonly path?: string;
		readonly dependencies?: DependencyExtractionResultType;
	}> = {},
): GenerationFactSeedType => {
	const symbolCount = input.symbolCount ?? 1;
	const pathName = input.path ?? PATH;
	const files: readonly SourceFileType[] = [{path: pathName, absolutePath: '/tmp/example.ts', sha256: SHA256, byteCount: 0, lineCount: symbolCount}];
	const projects: readonly ScanProjectResultType[] = [
		{name: CONTEXT, projectFile: 'tsconfig.json', configHash: CONTEXT, projectFileCount: 1, configDiagnosticCount: 0},
	];
	const symbols = Array.from({length: symbolCount}, (_value, index) => {
		const startOffset = index * 20;

		return {
			id: `symbol-${String(index)}`,
			name: `example${String(index)}`,
			qualifiedName: `example${String(index)}`,
			kind: 'variable',
			path: pathName,
			startLine: index + 1,
			startColumn: 14,
			endLine: index + 1,
			endColumn: 21,
			startOffset: startOffset + 13,
			endOffset: startOffset + 20,
			enclosingId: null,
			contexts: [CONTEXT],
		};
	});
	const occurrences = symbols.map((symbol) => ({
		symbolId: symbol.id,
		path: pathName,
		startLine: symbol.startLine,
		startColumn: symbol.startColumn,
		endLine: symbol.endLine,
		endColumn: symbol.endColumn,
		startOffset: symbol.startOffset,
		endOffset: symbol.endOffset,
		role: 'definition' as const,
		enclosingId: null,
		contexts: [CONTEXT],
		declarationKind: 'variable',
		forwardDefinition: false,
		extent: {
			startLine: symbol.startLine,
			startColumn: 1,
			endLine: symbol.endLine,
			endColumn: 21,
			startOffset: symbol.startOffset - 13,
			endOffset: symbol.startOffset + 7,
		},
		anchorRank: 0,
		primaryRank: 0,
	}));
	const extracted: ExtractedFactSetType = {
		files,
		symbols,
		bindings: symbols.map((symbol, index) => ({symbolId: symbol.id, segments: address(`example${String(index)}`)})),
		bindingContexts: symbols.map((symbol, index) => ({
			symbolId: symbol.id,
			segments: address(`example${String(index)}`),
			context: CONTEXT,
			exposure: 'published' as const,
		})),
		bindingSites: symbols.map((symbol, index) => ({
			symbolId: symbol.id,
			segments: address(`example${String(index)}`),
			kind: 'declared' as const,
			path: pathName,
			range: {
				startLine: symbol.startLine,
				startColumn: symbol.startColumn,
				endLine: symbol.endLine,
				endColumn: symbol.endColumn,
				startOffset: symbol.startOffset,
				endOffset: symbol.endOffset,
			},
		})),
		surfaceOrigins: [],
		occurrences,
		dependencies: input.dependencies ?? {edges: [], bindings: []},
		adapterStats: [],
		diagnostics: [],
		compilerMs: 0,
		extractionMs: 0,
	};
	const facts = finalizeFacts(extracted, {mode: 'enforce', maxBindingsPerRoot: 10});

	return {
		language: 'typescript',
		files,
		projects,
		facts,
		dependencies: extracted.dependencies,
		diagnostics: [],
		sourceHash: 'source',
	};
};

const rangeOf = (startOffset: number, line: number): FactRangeType => ({
	startLine: line,
	startColumn: 1,
	endLine: line,
	endColumn: 20,
	startOffset,
	endOffset: startOffset + 10,
});

type DerivedSymbolInputType = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly startOffset: number;
	readonly line: number;
	readonly contexts: readonly string[];
}>;

const derivedSymbolOf = (input: DerivedSymbolInputType): IndexedSymbolType => ({
	id: input.id,
	name: input.name,
	qualifiedName: input.name,
	kind: 'variable',
	path: 'src/derived.ts',
	startLine: input.line,
	startColumn: 1,
	endLine: input.line,
	endColumn: 20,
	startOffset: input.startOffset,
	endOffset: input.startOffset + 10,
	enclosingId: null,
	contexts: input.contexts,
});

const derivedOccurrenceOf = (
	symbol: IndexedSymbolType,
	input: Readonly<{startOffset: number; line: number; contexts: readonly string[]}>,
): ExtractedOccurrenceType => ({
	symbolId: symbol.id,
	path: symbol.path,
	startLine: input.line,
	startColumn: 1,
	endLine: input.line,
	endColumn: 20,
	startOffset: input.startOffset,
	endOffset: input.startOffset + 10,
	role: 'definition',
	enclosingId: null,
	contexts: input.contexts,
	declarationKind: 'variable',
	forwardDefinition: false,
	extent: {...rangeOf(input.startOffset, input.line), startOffset: input.startOffset - 10, endOffset: input.startOffset + 20},
	anchorRank: 0,
	primaryRank: 0,
});

const derivedSiteOf = (symbol: IndexedSymbolType, kind: FactSiteKindType): ExtractedBindingSiteType => ({
	symbolId: symbol.id,
	segments: address(symbol.name),
	kind,
	path: symbol.path,
	range: rangeOf(symbol.startOffset, symbol.startLine),
});

const derivedContextOf = (symbol: IndexedSymbolType, context: string, exposure: FactExposureType): ExtractedBindingContextType => ({
	symbolId: symbol.id,
	segments: address(symbol.name),
	context,
	exposure,
});

/**
 * Builds facts that exercise every derived publication column.
 *
 * The first binding is published in one context and internal in another; the
 * second is reachable only; the third is internal only. Their site kinds and
 * definition counts also vary so `has_declared_site` and `first_in_symbol` are
 * observable in the persisted rows.
 *
 * @returns Complete storage input without a generation identifier.
 */
export const createDerivedGenerationFactSeed = (): GenerationFactSeedType => {
	const pathName = 'src/derived.ts';
	const files: readonly SourceFileType[] = [{path: pathName, absolutePath: '/tmp/derived.ts', sha256: SHA256, byteCount: 0, lineCount: 300}];
	const projects: readonly ScanProjectResultType[] = [
		{name: 'app', projectFile: 'tsconfig.json', configHash: 'app', projectFileCount: 1, configDiagnosticCount: 0},
		{name: 'test', projectFile: 'tsconfig.test.json', configHash: 'test', projectFileCount: 1, configDiagnosticCount: 0},
	];
	const first = derivedSymbolOf({id: 'symbol-0', name: 'publishedValue', startOffset: 50, line: 10, contexts: ['app', 'test']});
	const second = derivedSymbolOf({id: 'symbol-1', name: 'reachableAlias', startOffset: 150, line: 20, contexts: ['app', 'test']});
	const third = derivedSymbolOf({id: 'symbol-2', name: 'internalDefault', startOffset: 250, line: 30, contexts: ['app']});
	const symbols = [first, second, third];
	const occurrences = [
		derivedOccurrenceOf(first, {startOffset: 50, line: 10, contexts: ['app', 'test']}),
		derivedOccurrenceOf(first, {startOffset: 100, line: 15, contexts: ['app']}),
		derivedOccurrenceOf(second, {startOffset: 150, line: 20, contexts: ['app', 'test']}),
		derivedOccurrenceOf(third, {startOffset: 250, line: 30, contexts: ['app']}),
	];
	const extracted: ExtractedFactSetType = {
		files,
		symbols,
		bindings: symbols.map((symbol) => ({symbolId: symbol.id, segments: address(symbol.name)})),
		bindingContexts: [
			derivedContextOf(first, 'app', 'published'),
			derivedContextOf(first, 'test', 'internal'),
			derivedContextOf(second, 'app', 'reachable'),
			derivedContextOf(second, 'test', 'internal'),
			derivedContextOf(third, 'app', 'internal'),
		],
		bindingSites: [derivedSiteOf(first, 'declared'), derivedSiteOf(second, 'alias'), derivedSiteOf(third, 'default')],
		surfaceOrigins: [],
		occurrences,
		dependencies: {edges: [], bindings: []},
		adapterStats: [],
		diagnostics: [],
		compilerMs: 0,
		extractionMs: 0,
	};
	const facts = finalizeFacts(extracted, {mode: 'enforce', maxBindingsPerRoot: 10});

	return {
		language: 'typescript',
		files,
		projects,
		facts,
		dependencies: extracted.dependencies,
		diagnostics: [],
		sourceHash: 'derived-source',
	};
};
