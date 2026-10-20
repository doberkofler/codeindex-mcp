import ts from 'typescript';

export const MAX_TRUTH_DEPTH = 64;

type TruthDeclarationType = Readonly<{
	readonly path: string;
	readonly nameStart: number;
}>;

export type TruthStateType = {
	readonly checker: ts.TypeChecker;
	readonly authoredPaths: ReadonlySet<string>;
	readonly pathByAbsolute: ReadonlyMap<string, string>;
	readonly declarations: Map<string, TruthDeclarationType>;
	readonly seenSymbols: Set<ts.Symbol>;
	readonly seenTypes: Set<ts.Type>;
	readonly pendingSymbols: ts.Symbol[];
	readonly pendingTypes: ts.Type[];
	roots: number;
	addresses: number;
	ambiguous: number;
};

const isAlias = (symbol: ts.Symbol): boolean => (symbol.flags & ts.SymbolFlags.Alias) !== 0;

export const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol => {
	if (!isAlias(symbol)) {
		return symbol;
	}

	try {
		return checker.getAliasedSymbol(symbol);
	} catch {
		return symbol;
	}
};

export const authoredDeclarationsOf = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): readonly ts.Declaration[] =>
	(symbol.declarations ?? []).filter((declaration) => authoredPaths.has(declaration.getSourceFile().fileName));

export const isExternalSymbol = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): boolean =>
	(symbol.declarations ?? []).every((declaration) => !authoredPaths.has(declaration.getSourceFile().fileName));

export const isPrivateSymbol = (symbol: ts.Symbol): boolean => {
	if (symbol.getName().startsWith('#')) {
		return true;
	}

	return (symbol.declarations ?? []).some((declaration) => (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private) !== 0);
};

const defaultTokenOf = (sourceFile: ts.SourceFile, node: ts.Node): ts.Node | null => {
	const modifier = ts.canHaveModifiers(node) ? ts.getModifiers(node)?.find((entry) => entry.kind === ts.SyntaxKind.DefaultKeyword) : undefined;

	if (modifier !== undefined) {
		return modifier;
	}

	const visit = (current: ts.Node): ts.Node | null => {
		if (current.kind === ts.SyntaxKind.DefaultKeyword) {
			return current;
		}

		for (const child of current.getChildren(sourceFile)) {
			const found = visit(child);

			if (found !== null) {
				return found;
			}
		}

		return null;
	};

	return visit(node);
};

const authoredNameNodeOf = (sourceFile: ts.SourceFile, declaration: ts.Declaration): ts.Node | null => {
	if (ts.isExportAssignment(declaration)) {
		return defaultTokenOf(sourceFile, declaration) ?? declaration;
	}

	const name = ts.getNameOfDeclaration(declaration);

	if (name !== undefined) {
		return name;
	}

	return defaultTokenOf(sourceFile, declaration);
};

const isImportDeclaration = (declaration: ts.Declaration): boolean =>
	ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration);

export const keyOf = (path: string, nameStart: number): string => `${path}\u0000${String(nameStart)}`;

export const addDeclaration = (state: TruthStateType, symbol: ts.Symbol): void => {
	for (const declaration of authoredDeclarationsOf(symbol, state.authoredPaths)) {
		if (isImportDeclaration(declaration)) {
			continue;
		}

		const sourceFile = declaration.getSourceFile();
		const path = state.pathByAbsolute.get(sourceFile.fileName);
		const nameNode = authoredNameNodeOf(sourceFile, declaration);

		if (path === undefined || nameNode === null) {
			continue;
		}

		const key = keyOf(path, nameNode.getStart(sourceFile));

		if (!state.declarations.has(key)) {
			state.declarations.set(key, {path, nameStart: nameNode.getStart(sourceFile)});
		}
	}
};

export const declaredTypeOf = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | null => {
	try {
		return checker.getDeclaredTypeOfSymbol(symbol);
	} catch {
		return null;
	}
};

export const symbolTypeOf = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | null => {
	const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];

	if (declaration === undefined) {
		return null;
	}

	try {
		return checker.getTypeOfSymbolAtLocation(symbol, declaration);
	} catch {
		return null;
	}
};

export const hasSymbolFlag = (symbol: ts.Symbol, flags: readonly ts.SymbolFlags[]): boolean => flags.some((flag) => (symbol.flags & flag) !== 0);

export const hasTypeFlag = (flags: ts.TypeFlags, candidates: readonly ts.TypeFlags[]): boolean => candidates.some((flag) => (flags & flag) !== 0);

export const namedSymbolOf = (type: ts.Type, authoredPaths: ReadonlySet<string>): ts.Symbol | null => {
	const namedFlags = [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias, ts.SymbolFlags.Enum];
	const valueFlags = [ts.SymbolFlags.Function, ts.SymbolFlags.Class, ts.SymbolFlags.BlockScopedVariable];

	for (const candidate of [type.aliasSymbol, type.getSymbol()]) {
		if (candidate === undefined || authoredDeclarationsOf(candidate, authoredPaths).length === 0) {
			continue;
		}

		const mergedAliasValue = (candidate.flags & ts.SymbolFlags.Alias) !== 0 && valueFlags.some((flag) => (candidate.flags & flag) !== 0);

		if (hasSymbolFlag(candidate, namedFlags) || mergedAliasValue) {
			return candidate;
		}
	}

	return null;
};

export const isExternalType = (type: ts.Type, authoredPaths: ReadonlySet<string>): boolean => {
	for (const candidate of [type.aliasSymbol, type.getSymbol()]) {
		if (candidate !== undefined && isExternalSymbol(candidate, authoredPaths)) {
			return true;
		}
	}

	return false;
};

export const isTypeReference = (type: ts.Type): type is ts.TypeReference => 'target' in type && 'typeArguments' in type;

const isInterfaceType = (type: ts.Type): type is ts.InterfaceType => 'typeParameters' in type;

export const isClassOrInterfaceType = (type: ts.Type): type is ts.InterfaceType => {
	const value: unknown = 'objectFlags' in type ? type.objectFlags : undefined;

	return typeof value === 'number' && (value & ts.ObjectFlags.ClassOrInterface) !== 0 && isInterfaceType(type);
};

export const enqueueType = (state: TruthStateType, type: ts.Type): void => {
	if (state.seenTypes.has(type)) {
		return;
	}

	state.seenTypes.add(type);
	state.pendingTypes.push(type);
};

export const enqueueSymbol = (state: TruthStateType, symbol: ts.Symbol): void => {
	const target = resolveAlias(state.checker, symbol);

	if (isPrivateSymbol(target) || isExternalSymbol(target, state.authoredPaths) || state.seenSymbols.has(target)) {
		return;
	}

	state.seenSymbols.add(target);
	addDeclaration(state, target);
	state.pendingSymbols.push(target);
};
