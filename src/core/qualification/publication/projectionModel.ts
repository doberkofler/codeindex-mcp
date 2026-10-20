import ts from 'typescript';

/** Per-root probe budget. Reaching it marks the root incomplete instead of truncating it. */
export type ProjectionBudgetType = Readonly<{
	readonly maxAddressesPerRoot: number;
	readonly maxReachabilityStepsPerRoot: number;
}>;

export type AddressFlagsType = Readonly<{
	readonly anonymous: boolean;
	readonly inherited: boolean;
	readonly depthOne: boolean;
}>;

type AddressType = AddressFlagsType &
	Readonly<{
		readonly terminalKey: string | null;
	}>;

export type ReachabilityNodeType = {readonly kind: 'symbol'; readonly symbol: ts.Symbol} | {readonly kind: 'type'; readonly type: ts.Type};

export type ProjectionNodeType = Readonly<{
	readonly type: ts.Type;
	readonly path: readonly string[];
	readonly depth: number;
	readonly rootDeclarations: readonly ts.Node[];
	readonly ancestors: ReadonlySet<ts.Symbol>;
}>;

export type ProjectionStateType = {
	readonly checker: ts.TypeChecker;
	readonly authoredPaths: ReadonlySet<string>;
	readonly pathByAbsolute: ReadonlyMap<string, string>;
	readonly budget: ProjectionBudgetType;
	readonly addresses: AddressType[];
	readonly addressKeys: Set<string>;
	readonly reachabilityVisited: Set<ts.Symbol>;
	readonly reachabilityTypes: Set<ts.Type>;
	readonly reachabilityPending: ReachabilityNodeType[];
	readonly projectionPending: ProjectionNodeType[];
	draining: boolean;
	projectionDraining: boolean;
	steps: number;
	projectionSteps: number;
	reachabilitySteps: number;
	depthLimited: boolean;
	exceeded: boolean;
};

export type RootResultType = Readonly<{
	readonly addresses: readonly AddressType[];
	readonly steps: number;
	readonly exceeded: boolean;
	readonly depthLimited: boolean;
}>;

export type TraversalContextType = Readonly<{
	readonly state: ProjectionStateType;
	readonly path: readonly string[];
	readonly depth: number;
	readonly rootDeclarations: readonly ts.Node[];
	readonly ancestors: ReadonlySet<ts.Symbol>;
}>;

/** Probe projection depth guard. A deeper root makes the measurement partial. */
export const MAX_PROJECTION_DEPTH = 64;

export class ProjectionBudgetError extends Error {
	public override readonly name = 'ProjectionBudgetError';
}

export const locationKey = (path: string, offset: number): string => `${path}\u0000${String(offset)}`;

export const hasAnyFlag = (flags: number, candidates: readonly number[]): boolean => candidates.some((flag) => (flags & flag) !== 0);

export const isObjectType = (type: ts.Type): type is ts.ObjectType => 'objectFlags' in type;

export const isTypeReference = (type: ts.Type): type is ts.TypeReference => 'target' in type && 'typeArguments' in type;

export const isInterfaceType = (type: ts.Type): type is ts.InterfaceType => 'typeParameters' in type;

export const authoredDeclarationsOf = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): readonly ts.Declaration[] =>
	(symbol.declarations ?? []).filter((declaration) => authoredPaths.has(declaration.getSourceFile().fileName));

export const isExternalSymbol = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): boolean =>
	(symbol.declarations ?? []).every((declaration) => !authoredPaths.has(declaration.getSourceFile().fileName));

export const isExternalType = (type: ts.Type, authoredPaths: ReadonlySet<string>): boolean => {
	for (const candidate of [type.aliasSymbol, type.getSymbol()]) {
		if (candidate !== undefined && isExternalSymbol(candidate, authoredPaths)) {
			return true;
		}
	}

	return false;
};

export const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol => {
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
		return symbol;
	}

	try {
		return checker.getAliasedSymbol(symbol);
	} catch {
		return symbol;
	}
};

export const isPrivateProperty = (property: ts.Symbol): boolean => {
	if (property.getName().startsWith('#')) {
		return true;
	}

	return (property.declarations ?? []).some((declaration) => (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private) !== 0);
};

const terminalLocation = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>, pathByAbsolute: ReadonlyMap<string, string>): string | null => {
	for (const declaration of symbol.declarations ?? []) {
		const {fileName} = declaration.getSourceFile();
		const path = pathByAbsolute.get(fileName);

		if (path !== undefined && authoredPaths.has(fileName)) {
			return locationKey(path, declaration.getStart());
		}
	}

	return null;
};

export const namedSymbolOf = (type: ts.Type, authoredPaths: ReadonlySet<string>): ts.Symbol | null => {
	for (const candidate of [type.aliasSymbol, type.getSymbol()]) {
		if (candidate !== undefined && authoredDeclarationsOf(candidate, authoredPaths).length > 0) {
			return candidate;
		}
	}

	return null;
};

export const isAnonymousShape = (type: ts.Type, authoredPaths: ReadonlySet<string>): boolean =>
	(type.flags & ts.TypeFlags.Object) !== 0 && namedSymbolOf(type, authoredPaths) === null;

export const isInheritedProperty = (property: ts.Symbol, rootDeclarations: readonly ts.Node[]): boolean => {
	const declarations = property.declarations ?? [];

	if (declarations.length === 0 || rootDeclarations.length === 0) {
		return false;
	}

	return declarations.every((declaration) => ts.findAncestor(declaration, (ancestor) => rootDeclarations.includes(ancestor)) === undefined);
};

export const addStep = (state: ProjectionStateType, channel: 'projection' | 'reachability'): void => {
	state.steps += 1;

	if (channel === 'projection') {
		state.projectionSteps += 1;
	} else {
		state.reachabilitySteps += 1;
	}

	if (state.steps > state.budget.maxReachabilityStepsPerRoot) {
		throw new ProjectionBudgetError('reachability-step budget exceeded');
	}
};

export const addAddress = (state: ProjectionStateType, path: readonly string[], symbol: ts.Symbol, flags: AddressFlagsType): void => {
	if (state.addresses.length >= state.budget.maxAddressesPerRoot) {
		throw new ProjectionBudgetError('surface-address budget exceeded');
	}

	const terminalKey = terminalLocation(symbol, state.authoredPaths, state.pathByAbsolute);
	const key = `${path.join('\u0000')}\u0000${terminalKey ?? ''}`;

	if (state.addressKeys.has(key)) {
		return;
	}

	state.addressKeys.add(key);
	state.addresses.push({terminalKey, ...flags});
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

export const declaredTypeOf = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | null => {
	try {
		return checker.getDeclaredTypeOfSymbol(symbol);
	} catch {
		return null;
	}
};

export const createProjectionState = (
	checker: ts.TypeChecker,
	authoredPaths: ReadonlySet<string>,
	pathByAbsolute: ReadonlyMap<string, string>,
	budget: ProjectionBudgetType,
): ProjectionStateType => ({
	checker,
	authoredPaths,
	pathByAbsolute,
	budget,
	addresses: [],
	addressKeys: new Set<string>(),
	reachabilityVisited: new Set<ts.Symbol>(),
	reachabilityTypes: new Set<ts.Type>(),
	reachabilityPending: [],
	projectionPending: [],
	draining: false,
	projectionDraining: false,
	steps: 0,
	projectionSteps: 0,
	reachabilitySteps: 0,
	depthLimited: false,
	exceeded: false,
});
