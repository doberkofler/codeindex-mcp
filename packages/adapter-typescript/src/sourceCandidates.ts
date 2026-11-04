import * as ts from './compiler.ts';
import {type ExtractionRuntimeType} from './extractionRuntime.ts';
import {symbolNameOf} from './symbolName.ts';

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/**
 * Maps an external declaration symbol back to an authored source candidate.
 *
 * A declaration file that shadows a source file reports the same public name.
 * Resolving the authored source keeps references attached to the indexed
 * symbol instead of the resolution-only declaration.
 *
 * @param runtime - Extraction state.
 * @param symbol - External declaration symbol.
 * @returns Stored symbol identifier, or null when no authored source matches.
 */
export const sourceCandidatesForDeclarationFile = (runtime: ExtractionRuntimeType, symbol: ts.Symbol): string | null => {
	for (const declaration of ts.declarationsOf(symbol)) {
		const sourceFile = declaration.getSourceFile();

		if (!sourceFile.isDeclarationFile) {
			continue;
		}

		const base = sourceFile.fileName.replace(/\.d\.(?:ts|mts|cts)$/u, '');

		for (const extension of SOURCE_EXTENSIONS) {
			const absolute = `${base}${extension}`;
			const relative = runtime.pathByAbsolute.get(absolute);

			if (relative === undefined) {
				continue;
			}

			const symbolId = runtime.symbolIdByPathAndName.get(`${relative}\u0000${symbolNameOf(symbol)}`);

			if (symbolId !== undefined) {
				return symbolId;
			}
		}
	}

	return null;
};
