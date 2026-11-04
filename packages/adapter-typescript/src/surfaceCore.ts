import * as ts from './compiler.ts';
import {type FactAddressType} from '@codeindex/adapter-sdk';
import {isPrivateMemberSymbol} from './symbolName.ts';

type SurfaceAddressType = Readonly<{
	readonly symbolId: string;
	readonly relativeSegments: FactAddressType;
	readonly anonymous: boolean;
	readonly inherited: boolean;
	readonly depthOne: boolean;
}>;

/** Per-root projection configuration and fact sinks. */
export type SurfaceProjectionHostType = Readonly<{
	readonly checker: ts.TypeChecker;
	readonly authoredPaths: ReadonlySet<string>;
	readonly maxAddressesPerRoot: number;
	readonly maxReachabilityStepsPerRoot: number;
	/** Resolves a compiler symbol to a stored symbol, promoting deferred members. */
	readonly symbolForTsSymbol: (symbol: ts.Symbol) => string | null;
	/** Resolves one authored declaration node to a stored symbol. */
	readonly symbolForDeclaration: (declaration: ts.Node) => string | null;
	readonly addSurface: (address: SurfaceAddressType) => void;
	readonly markReachable: (symbolId: string) => void;
	/** Cached value types keyed by compiler symbol identifier. */
	readonly symbolTypes: Map<number, ts.Type | null>;
	/** Cached declared types keyed by compiler symbol identifier. */
	readonly declaredTypes: Map<number, ts.Type | null>;
	/** Cached property lists keyed by compiler type identifier. */
	readonly typeProperties: Map<number, readonly ts.Symbol[]>;
	/** Cached index information keyed by compiler type identifier. */
	readonly typeIndexes: Map<number, readonly ts.IndexInfo[]>;
	/** Cached base types keyed by compiler type identifier. */
	readonly typeBases: Map<number, readonly ts.Type[]>;
	/** Cached type arguments keyed by compiler type identifier. */
	readonly typeArguments: Map<number, readonly ts.Type[]>;
}>;

type ReachabilityNodeType = Readonly<{kind: 'symbol'; symbol: ts.Symbol}> | Readonly<{kind: 'type'; type: ts.Type}>;

export type ProjectionNodeType = Readonly<{
	readonly type: ts.Type;
	readonly path: FactAddressType;
	readonly depth: number;
	readonly rootDeclarations: readonly ts.Node[];
	readonly ancestors: ReadonlySet<ts.Symbol>;
}>;

export type ProjectionStateType = {
	readonly host: SurfaceProjectionHostType;
	readonly reachableSymbols: Set<ts.Symbol>;
	readonly reachableTypes: Set<ts.Type>;
	readonly reachabilityPending: ReachabilityNodeType[];
	readonly projectionPending: ProjectionNodeType[];
	readonly rootSegments: FactAddressType;
	readonly rootDeclarations: readonly ts.Node[];
	addresses: number;
	steps: number;
	draining: boolean;
	projectionDraining: boolean;
	depthLimited: boolean;
};

export const MAX_PROJECTION_DEPTH = 64;

export class SurfaceProjectionError extends Error {
	public override readonly name = 'SurfaceProjectionError';
}

export const authoredDeclarationsOf = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): readonly ts.Declaration[] =>
	ts.declarationsOf(symbol).filter((declaration) => authoredPaths.has(declaration.getSourceFile().fileName));

export const isExternalSymbol = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): boolean => {
	const declarations = ts.declarationsOf(symbol);

	return declarations.length > 0 && declarations.every((declaration) => !authoredPaths.has(declaration.getSourceFile().fileName));
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

export const isExternalType = (type: ts.Type, authoredPaths: ReadonlySet<string>): boolean => {
	for (const candidate of [type.getAliasSymbol(), type.getSymbol()]) {
		if (candidate !== undefined && isExternalSymbol(candidate, authoredPaths)) {
			return true;
		}
	}

	return false;
};

const isAnonymousClassExpression = (symbol: ts.Symbol): boolean =>
	ts.declarationsOf(symbol).some((declaration) => ts.isClassExpression(declaration) && declaration.name === undefined);

export const namedSymbolOf = (type: ts.Type, authoredPaths: ReadonlySet<string>): ts.Symbol | null => {
	const namedFlags = [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias, ts.SymbolFlags.Enum];

	for (const candidate of [type.getAliasSymbol(), type.getSymbol()]) {
		if (
			candidate !== undefined &&
			namedFlags.some((flag) => (candidate.flags & flag) !== 0) &&
			authoredDeclarationsOf(candidate, authoredPaths).length > 0 &&
			!isAnonymousClassExpression(candidate)
		) {
			return candidate;
		}
	}

	return null;
};

export const isAnonymousShape = (type: ts.Type, authoredPaths: ReadonlySet<string>): boolean =>
	(type.flags & ts.TypeFlags.Object) !== 0 && namedSymbolOf(type, authoredPaths) === null;

const isPrivateDeclaration = (declaration: ts.Declaration): boolean =>
	(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private) !== 0 ||
	(ts.canHaveModifiers(declaration) && (ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) ?? false));

export const isPrivateProperty = (property: ts.Symbol): boolean => {
	if (isPrivateMemberSymbol(property)) {
		return true;
	}

	return ts.declarationsOf(property).some((declaration) => isPrivateDeclaration(declaration));
};

export const isInheritedProperty = (property: ts.Symbol, rootDeclarations: readonly ts.Node[]): boolean => {
	const declarations = ts.declarationsOf(property);

	if (declarations.length === 0 || rootDeclarations.length === 0) {
		return false;
	}

	return declarations.every((declaration) => ts.findAncestor(declaration, (ancestor) => rootDeclarations.includes(ancestor)) === undefined);
};

const isObjectType = (type: ts.Type): type is ts.ObjectType => type.isObjectType();

export const hasAnyFlag = (flags: number, candidates: readonly number[]): boolean => candidates.some((flag) => (flags & flag) !== 0);

export const isTypeReference = (type: ts.Type): type is ts.TypeReference => type.isTypeReference();

const isInterfaceType = (type: ts.Type): type is ts.InterfaceType => type.isClassOrInterface();

export const symbolTypeOf = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Type | null => {
	const declaration = ts.valueDeclarationOf(symbol) ?? ts.declarationsOf(symbol)[0];

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

/**
 * Returns a symbol's value type, caching it for the current projection run.
 *
 * TypeScript 7 answers every checker query over a process boundary. The type of
 * a symbol is stable for the lifetime of a project, so the same query is never
 * repeated within one extraction.
 *
 * @param host - Projection host that owns the cache.
 * @param symbol - Compiler symbol.
 * @returns The symbol's value type, or null.
 */
export const cachedSymbolTypeOf = (host: SurfaceProjectionHostType, symbol: ts.Symbol): ts.Type | null => {
	const cached = host.symbolTypes.get(symbol.id);

	if (cached !== undefined) {
		return cached;
	}

	const type = symbolTypeOf(host.checker, symbol);
	host.symbolTypes.set(symbol.id, type);
	return type;
};

/**
 * Returns a symbol's declared type, caching it for the current projection run.
 *
 * @param host - Projection host that owns the cache.
 * @param symbol - Compiler symbol.
 * @returns The symbol's declared type, or null.
 */
export const cachedDeclaredTypeOf = (host: SurfaceProjectionHostType, symbol: ts.Symbol): ts.Type | null => {
	const cached = host.declaredTypes.get(symbol.id);

	if (cached !== undefined) {
		return cached;
	}

	const type = declaredTypeOf(host.checker, symbol);
	host.declaredTypes.set(symbol.id, type);
	return type;
};

const memoized = <ValueType>(cache: Map<number, ValueType>, key: number, compute: () => ValueType): ValueType => {
	const cached = cache.get(key);

	if (cached !== undefined) {
		return cached;
	}

	const value = compute();
	cache.set(key, value);
	return value;
};

/**
 * Returns a type's properties, cached for the current projection run.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Compiler type.
 * @returns The type's properties.
 */
export const cachedPropertiesOfType = (host: SurfaceProjectionHostType, type: ts.Type): readonly ts.Symbol[] =>
	memoized(host.typeProperties, type.id, () => host.checker.getPropertiesOfType(type));

/**
 * Returns a type's index information, cached for the current projection run.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Compiler type.
 * @returns The type's index signatures.
 */
export const cachedIndexInfosOfType = (host: SurfaceProjectionHostType, type: ts.Type): readonly ts.IndexInfo[] =>
	memoized(host.typeIndexes, type.id, () => host.checker.getIndexInfosOfType(type));

/**
 * Returns a type's base types, cached for the current projection run.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Class or interface type.
 * @returns The type's base types.
 */
export const cachedBaseTypesOfType = (host: SurfaceProjectionHostType, type: ts.InterfaceType): readonly ts.Type[] =>
	memoized(host.typeBases, type.id, () => host.checker.getBaseTypes(type));

/**
 * Returns a type's type arguments, cached for the current projection run.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Type reference.
 * @returns The reference's type arguments.
 */
export const cachedTypeArguments = (host: SurfaceProjectionHostType, type: ts.TypeReference): readonly ts.Type[] =>
	memoized(host.typeArguments, type.id, () => host.checker.getTypeArguments(type));

export const addStep = (state: ProjectionStateType): void => {
	state.steps += 1;

	if (state.steps > state.host.maxReachabilityStepsPerRoot) {
		throw new SurfaceProjectionError('Surface projection exceeded the configured reachability-step ceiling');
	}
};

export const symbolIdOf = (state: ProjectionStateType, symbol: ts.Symbol): string | null => {
	const target = resolveAlias(state.host.checker, symbol);

	if (isExternalSymbol(target, state.host.authoredPaths)) {
		return null;
	}

	const direct = state.host.symbolForTsSymbol(target);

	if (direct !== null) {
		return direct;
	}

	for (const declaration of ts.declarationsOf(target)) {
		const declared = state.host.symbolForDeclaration(declaration);

		if (declared !== null) {
			return declared;
		}
	}

	return null;
};

const enqueueSymbol = (state: ProjectionStateType, symbol: ts.Symbol): void => {
	if (isPrivateProperty(symbol) || isExternalSymbol(symbol, state.host.authoredPaths) || state.reachableSymbols.has(symbol)) {
		return;
	}

	const symbolId = symbolIdOf(state, symbol);

	if (symbolId === null) {
		return;
	}

	state.reachableSymbols.add(symbol);
	addStep(state);
	state.host.markReachable(symbolId);
	state.reachabilityPending.push({kind: 'symbol', symbol});
};

const enqueueType = (state: ProjectionStateType, type: ts.Type): void => {
	if (state.reachableTypes.has(type)) {
		return;
	}

	state.reachableTypes.add(type);
	addStep(state);
	state.reachabilityPending.push({kind: 'type', type});
};

const enqueueExternalTypeArguments = (state: ProjectionStateType, type: ts.Type): void => {
	if (isTypeReference(type) && (type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
		for (const argument of cachedTypeArguments(state.host, type)) {
			enqueueType(state, argument);
		}
	}
};

const enqueueObjectReachability = (state: ProjectionStateType, type: ts.Type): void => {
	const named = namedSymbolOf(type, state.host.authoredPaths);

	if (named !== null) {
		enqueueSymbol(state, named);
	}

	if (isInterfaceType(type) && isObjectType(type) && (type.objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0) {
		for (const base of cachedBaseTypesOfType(state.host, type)) {
			enqueueType(state, base);
		}
	}

	for (const property of cachedPropertiesOfType(state.host, type)) {
		enqueueSymbol(state, property);
	}
};

const processReachabilitySymbol = (state: ProjectionStateType, symbol: ts.Symbol): void => {
	const type = hasAnyFlag(symbol.flags, [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias, ts.SymbolFlags.Enum])
		? cachedDeclaredTypeOf(state.host, symbol)
		: cachedSymbolTypeOf(state.host, symbol);

	if (type !== null) {
		enqueueType(state, type);
	}
};

const processReachabilityType = (state: ProjectionStateType, type: ts.Type): void => {
	if (isExternalType(type, state.host.authoredPaths)) {
		enqueueExternalTypeArguments(state, type);
		return;
	}

	const aliasSymbol = type.getAliasSymbol();

	if (hasAnyFlag(type.flags, [ts.TypeFlags.Conditional, ts.TypeFlags.IndexedAccess]) && aliasSymbol !== undefined) {
		enqueueSymbol(state, aliasSymbol);
	}

	if (type.isUnionType() || type.isIntersectionType()) {
		for (const constituent of type.getTypes()) {
			enqueueType(state, constituent);
		}

		return;
	}

	if (isTypeReference(type) && (type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
		for (const argument of cachedTypeArguments(state.host, type)) {
			enqueueType(state, argument);
		}
	}

	if (isObjectType(type)) {
		enqueueObjectReachability(state, type);
	}

	for (const index of cachedIndexInfosOfType(state.host, type)) {
		enqueueType(state, index.valueType);
	}
};

const drainReachability = (state: ProjectionStateType): void => {
	if (state.draining) {
		return;
	}

	state.draining = true;

	try {
		for (;;) {
			const pending = state.reachabilityPending.pop();

			if (pending === undefined) {
				return;
			}

			if (pending.kind === 'symbol') {
				processReachabilitySymbol(state, pending.symbol);
			} else {
				processReachabilityType(state, pending.type);
			}
		}
	} finally {
		state.draining = false;
	}
};

export const markSymbolReachable = (state: ProjectionStateType, symbol: ts.Symbol): void => {
	enqueueSymbol(state, symbol);
	drainReachability(state);
};

export const markTypeReachable = (state: ProjectionStateType, type: ts.Type): void => {
	enqueueType(state, type);
	drainReachability(state);
};

export const enqueueProjection = (state: ProjectionStateType, node: ProjectionNodeType): void => {
	state.projectionPending.push(node);
};
