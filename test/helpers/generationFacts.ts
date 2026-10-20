import {finalizeFacts, type ExtractedFactSetType, type FactAddressType, type FinalizedFactSetType} from '../../src/core/facts/index.ts';
import {type DependencyExtractionResultType, type DiagnosticType, type ScanProjectResultType, type SourceFileType} from '../../src/core/model.ts';

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
