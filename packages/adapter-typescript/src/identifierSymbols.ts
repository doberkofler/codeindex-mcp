import * as ts from './compiler.ts';

/** Bulk-resolved compiler symbols keyed by identifier node. */
export type IdentifierSymbolsType = ReadonlyMap<ts.Node, ts.Symbol | undefined>;

const MAX_RETAINED_IDENTIFIER_SYMBOLS = 250_000;

const identifiersOf = (sourceFile: ts.SourceFile): readonly ts.Identifier[] => {
	const identifiers: ts.Identifier[] = [];
	const collect = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			identifiers.push(node);
		}

		ts.forEachChild(node, collect);
	};

	ts.forEachChild(sourceFile, collect);
	return identifiers;
};

/**
 * Resolves one bounded identifier collection in one compiler request.
 *
 * @param checker - Program type checker.
 * @param identifiers - Identifier nodes to resolve.
 * @param retained - Project-wide symbols that need not be queried again.
 * @returns Identifier nodes mapped to compiler symbols.
 */
export const resolveIdentifierSymbols = (
	checker: ts.TypeChecker,
	identifiers: readonly ts.Identifier[],
	retained: IdentifierSymbolsType,
): IdentifierSymbolsType => {
	const symbols = new Map<ts.Node, ts.Symbol | undefined>();
	const unresolved: ts.Identifier[] = [];

	for (const identifier of identifiers) {
		if (retained.has(identifier)) {
			symbols.set(identifier, retained.get(identifier));
		} else {
			unresolved.push(identifier);
		}
	}

	if (unresolved.length > 0) {
		const resolved = checker.getSymbolAtLocation(unresolved);

		for (const [index, node] of unresolved.entries()) {
			symbols.set(node, resolved[index]);
		}
	}

	return symbols;
};

/**
 * Retains the original full lookup only for projects below the memory gate.
 * Large projects defer candidate resolution to the collector and references to
 * bounded groups, avoiding project-wide compiler-wrapper retention.
 *
 * @param checker - Program type checker.
 * @param program - Loaded program.
 * @param absolutePaths - Authored files to index.
 * @returns Optional full lookup and total authored identifier count.
 */
export const createIdentifierSymbols = (
	checker: ts.TypeChecker,
	program: ts.Program,
	absolutePaths: readonly string[],
): Readonly<{symbols: IdentifierSymbolsType; fullSymbols: IdentifierSymbolsType | null; identifierCount: number}> => {
	let fullSymbols: Map<ts.Node, ts.Symbol | undefined> | null = new Map();
	let identifierCount = 0;

	for (const absolutePath of absolutePaths) {
		const sourceFile = program.getSourceFile(absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		const identifiers = identifiersOf(sourceFile);
		const resolved = identifiers.length === 0 ? [] : checker.getSymbolAtLocation(identifiers);
		identifierCount += identifiers.length;

		if (fullSymbols !== null && identifierCount <= MAX_RETAINED_IDENTIFIER_SYMBOLS) {
			for (const [index, node] of identifiers.entries()) {
				fullSymbols.set(node, resolved[index]);
			}
		} else if (fullSymbols !== null) {
			fullSymbols = null;
		}
	}

	return {symbols: fullSymbols ?? new Map(), fullSymbols, identifierCount};
};
