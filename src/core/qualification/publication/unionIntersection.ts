import * as ts from '@codeindex/adapter-typescript/compiler';

const countTypeNodes = (sourceFile: ts.SourceFile): Readonly<{unionCases: number; intersectionCases: number}> => {
	let unionCases = 0;
	let intersectionCases = 0;

	const visit = (node: ts.Node): void => {
		if (ts.isUnionTypeNode(node)) {
			unionCases += 1;
		} else if (ts.isIntersectionTypeNode(node)) {
			intersectionCases += 1;
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	return {unionCases, intersectionCases};
};

/**
 * Counts union and intersection type nodes in authored source text.
 *
 * This is a source-form measurement for M13; it does not decide projection
 * semantics.
 *
 * @param sources - Authored source text keyed by workspace-relative path.
 * @returns Aggregate union and intersection case counts.
 */
export const countUnionIntersection = (sources: ReadonlyMap<string, string>): Readonly<{unionCases: number; intersectionCases: number}> => {
	let unionCases = 0;
	let intersectionCases = 0;
	const api = new ts.API({cwd: process.cwd()});

	try {
		for (const [filePath, source] of sources) {
			const retained = api.createSourceFile(filePath, source);

			try {
				const counts = countTypeNodes(retained.sourceFile);
				unionCases += counts.unionCases;
				intersectionCases += counts.intersectionCases;
			} finally {
				retained[Symbol.dispose]();
			}
		}
	} finally {
		api[Symbol.dispose]();
	}

	return {unionCases, intersectionCases};
};
