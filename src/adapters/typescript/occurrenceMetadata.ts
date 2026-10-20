import ts from 'typescript';
import {type ExtractedOccurrenceType, type FactRangeType} from '../../core/facts/index.ts';

export type DefinitionMetadataType = Pick<ExtractedOccurrenceType, 'declarationKind' | 'forwardDefinition' | 'extent' | 'anchorRank' | 'primaryRank'>;

/**
 * Maps a supported declaration node to the adapter's stable kind string.
 *
 * @param node - Declaration node.
 * @returns Adapter declaration kind.
 */
export const declarationKindOf = (node: ts.Node): string => {
	if (ts.isFunctionDeclaration(node)) {
		return 'function';
	}

	if (ts.isClassDeclaration(node)) {
		return 'class';
	}

	if (ts.isInterfaceDeclaration(node)) {
		return 'interface';
	}

	if (ts.isTypeAliasDeclaration(node)) {
		return 'type';
	}

	if (ts.isEnumDeclaration(node)) {
		return 'enum';
	}

	if (ts.isEnumMember(node)) {
		return 'enum_member';
	}

	if (ts.isModuleDeclaration(node)) {
		return 'namespace';
	}

	if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
		return 'method';
	}

	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
		return 'property';
	}

	if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
		return 'accessor';
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

const isForwardDeclaration = (node: ts.Node): boolean => {
	if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
		return node.body === undefined;
	}

	return false;
};

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
