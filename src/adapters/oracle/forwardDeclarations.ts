import {type MutableBindingType, type OracleParsedFileType} from './symbolTables.ts';
import {type OracleDeclarationType} from './syntax.ts';

type BindingEntryType = Readonly<{fileIndex: number; index: number}>;

const declarationOf = (files: readonly OracleParsedFileType[], entry: BindingEntryType): OracleDeclarationType | undefined =>
	files[entry.fileIndex]?.parse.declarations[entry.index];

const collectGroups = (files: readonly OracleParsedFileType[], bindings: readonly MutableBindingType[][]): ReadonlyMap<string, readonly BindingEntryType[]> => {
	const groups = new Map<string, BindingEntryType[]>();

	for (const [fileIndex, file] of files.entries()) {
		for (const [index, declaration] of file.parse.declarations.entries()) {
			const unit = file.parse.units[declaration.unit];
			const binding = bindings[fileIndex]?.[index];

			if (unit?.kind !== 'package-body' || (declaration.kind !== 'procedure' && declaration.kind !== 'function')) {
				continue;
			}

			if (binding === undefined || binding.definitionOnly) {
				continue;
			}

			const key = `${file.path}\u0000${unit.canonical}\u0000${declaration.parent ?? -1}\u0000${binding.signature}`;
			const group = groups.get(key) ?? [];

			group.push({fileIndex, index});
			groups.set(key, group);
		}
	}

	return groups;
};

const chooseImplementation = (files: readonly OracleParsedFileType[], group: readonly BindingEntryType[]): BindingEntryType | null => {
	let chosen: BindingEntryType | null = null;
	let chosenEnd = -1;

	for (const entry of group) {
		const declaration = declarationOf(files, entry);
		const end = declaration?.range.endOffset ?? -1;

		if (end > chosenEnd) {
			chosen = entry;
			chosenEnd = end;
		}
	}

	return chosen;
};

const reassignDescendants = (bindings: readonly MutableBindingType[][], previousSymbolId: string, nextSymbolId: string): void => {
	for (const fileBindings of bindings) {
		for (const descendant of fileBindings) {
			if (descendant.enclosingId === previousSymbolId) {
				descendant.enclosingId = nextSymbolId;
			}
		}
	}
};

const mergeGroup = (files: readonly OracleParsedFileType[], bindings: readonly MutableBindingType[][], group: readonly BindingEntryType[]): void => {
	const chosen = chooseImplementation(files, group);
	const chosenBinding = chosen === null ? undefined : bindings[chosen.fileIndex]?.[chosen.index];

	if (chosen === null || chosenBinding === undefined) {
		return;
	}

	for (const entry of group) {
		if (entry.fileIndex === chosen.fileIndex && entry.index === chosen.index) {
			continue;
		}

		const binding = bindings[entry.fileIndex]?.[entry.index];

		if (binding !== undefined) {
			const previousSymbolId = binding.symbolId;

			binding.symbolId = chosenBinding.symbolId;
			binding.definitionOnly = true;
			binding.ownSymbol = null;
			binding.enclosingId = chosenBinding.enclosingId;
			reassignDescendants(bindings, previousSymbolId, chosenBinding.symbolId);
		}
	}
};

/**
 * Collapses package-body forward declarations onto their implementation symbol.
 *
 * @param files - Parsed files in one context.
 * @param bindings - Mutable declaration bindings.
 */
export const mergeForwardDeclarations = (files: readonly OracleParsedFileType[], bindings: readonly MutableBindingType[][]): void => {
	const groups = collectGroups(files, bindings);

	for (const group of groups.values()) {
		if (group.length > 1) {
			mergeGroup(files, bindings, group);
		}
	}
};
