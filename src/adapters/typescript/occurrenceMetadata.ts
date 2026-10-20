import ts from 'typescript';
import {type ExtractedOccurrenceType, type FactRangeType} from '../../core/facts/index.ts';

export type DefinitionMetadataType = Pick<ExtractedOccurrenceType, 'declarationKind' | 'forwardDefinition' | 'extent' | 'anchorRank' | 'primaryRank'>;

const KIND_PREDICATES: readonly (readonly [(node: ts.Node) => boolean, string])[] = [
	[ts.isFunctionDeclaration, 'function'],
	[ts.isClassDeclaration, 'class'],
	[ts.isClassExpression, 'class'],
	[ts.isInterfaceDeclaration, 'interface'],
	[ts.isTypeAliasDeclaration, 'type'],
	[ts.isEnumDeclaration, 'enum'],
	[ts.isEnumMember, 'enum_member'],
	[ts.isModuleDeclaration, 'namespace'],
	[ts.isMethodDeclaration, 'method'],
	[ts.isMethodSignature, 'method'],
	[ts.isPropertyDeclaration, 'property'],
	[ts.isPropertySignature, 'property'],
	[(node) => ts.isParameter(node) && ts.isConstructorDeclaration(node.parent), 'property'],
	[ts.isPropertyAssignment, 'property'],
	[ts.isShorthandPropertyAssignment, 'property'],
	[ts.isGetAccessorDeclaration, 'accessor'],
	[ts.isSetAccessorDeclaration, 'accessor'],
	[ts.isExportSpecifier, 'alias'],
	[ts.isNamespaceExport, 'alias'],
	[ts.isExportAssignment, 'alias'],
];

/**
 * Maps a supported declaration node to the adapter's stable kind string.
 *
 * @param node - Declaration node.
 * @returns Adapter declaration kind.
 */
export const declarationKindOf = (node: ts.Node): string => {
	for (const [predicate, kind] of KIND_PREDICATES) {
		if (predicate(node)) {
			return kind;
		}
	}

	return 'variable';
};

const rangeOfNode = (sourceFile: ts.SourceFile, node: ts.Node): FactRangeType => {
	const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	const end = sourceFile.getLineAndCharacterOfPosition(node.end);

	return {
		startLine: start.line + 1,
		startColumn: start.character + 1,
		endLine: end.line + 1,
		endColumn: end.character + 1,
		startOffset: node.getStart(sourceFile),
		endOffset: node.end,
	};
};

const isForwardDeclaration = (node: ts.Node): boolean => (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body === undefined;

const primaryRankOf = (node: ts.Node): number => (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? (node.body === undefined ? 1 : 0) : 0);

/**
 * Emits definition-site metadata without widening the authored declaration.
 *
 * @param sourceFile - Source file containing the definition.
 * @param declaration - Declaration node that owns the identifier.
 * @returns Kind, forward state, extent, and selection ranks.
 */
export const definitionMetadataOf = (sourceFile: ts.SourceFile, declaration: ts.Node): DefinitionMetadataType => ({
	declarationKind: declarationKindOf(declaration),
	forwardDefinition: isForwardDeclaration(declaration),
	extent: rangeOfNode(sourceFile, declaration),
	anchorRank: 0,
	primaryRank: primaryRankOf(declaration),
});
