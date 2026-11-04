import * as ts from './compiler.ts';

/**
 * Symbol lookup for every identifier in the authored files.
 *
 * TypeScript 7 answers each `getSymbolAtLocation` with one synchronous request,
 * so resolving identifiers one at a time dominated extraction on large
 * projects. One batched request per file builds the map once, and publication,
 * occurrence extraction, and reachability all read from it.
 */
export type IdentifierSymbolsType = ReadonlyMap<ts.Node, ts.Symbol | undefined>;

/**
 * Resolves every identifier of the given files in one request per file.
 *
 * @param checker - Program type checker.
 * @param program - Loaded program.
 * @param absolutePaths - Authored files to index.
 * @returns Identifier nodes mapped to their compiler symbols.
 */
export const createIdentifierSymbols = (checker: ts.TypeChecker, program: ts.Program, absolutePaths: readonly string[]): IdentifierSymbolsType => {
	const symbols = new Map<ts.Node, ts.Symbol | undefined>();

	for (const absolutePath of absolutePaths) {
		const sourceFile = program.getSourceFile(absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		const identifiers: ts.Identifier[] = [];
		const collect = (node: ts.Node): void => {
			if (ts.isIdentifier(node)) {
				identifiers.push(node);
			}

			ts.forEachChild(node, collect);
		};

		ts.forEachChild(sourceFile, collect);

		if (identifiers.length === 0) {
			continue;
		}

		const resolved = checker.getSymbolAtLocation(identifiers);

		for (const [index, node] of identifiers.entries()) {
			symbols.set(node, resolved[index]);
		}
	}

	return symbols;
};
