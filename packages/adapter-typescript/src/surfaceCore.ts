import * as ts from './compiler.ts';
import {type FactAddressType} from '@codeindex/adapter-sdk';
import {isAnonymousShape, isExternalSymbol, isExternalType, isPrivateProperty, namedSymbolOf, resolveAlias} from './projectionPredicates.ts';

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
	/** Cached per-type classification facts used by projection. */
	readonly typeClassifications: Map<number, TypeClassificationType>;
}>;

/**
 * Lazily filled classification of one compiler type.
 *
 * Projection asks the same shape, externality, and naming questions about the
 * same type from many roots. Every one of those questions is a synchronous
 * compiler request, so each answer is retained for the run.
 */
export type TypeClassificationType = {
	tuple: boolean | undefined;
	array: boolean | undefined;
	awaited: ts.Type | null | undefined;
	external: boolean | undefined;
	named: ts.Symbol | null | undefined;
	anonymous: boolean | undefined;
};

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

const classificationOf = (host: SurfaceProjectionHostType, type: ts.Type): TypeClassificationType => {
	const cached = host.typeClassifications.get(type.id);

	if (cached !== undefined) {
		return cached;
	}

	const created: TypeClassificationType = {tuple: undefined, array: undefined, awaited: undefined, external: undefined, named: undefined, anonymous: undefined};
	host.typeClassifications.set(type.id, created);
	return created;
};

/**
 * Reports whether a type is a tuple type, caching the compiler answer.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Compiler type.
 * @returns True for tuple types.
 */
export const cachedIsTupleType = (host: SurfaceProjectionHostType, type: ts.Type): boolean => {
	const classification = classificationOf(host, type);

	classification.tuple ??= host.checker.isTupleType(type);
	return classification.tuple;
};

/**
 * Reports whether a type is an array type, caching the compiler answer.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Compiler type.
 * @returns True for array types.
 */
export const cachedIsArrayType = (host: SurfaceProjectionHostType, type: ts.Type): boolean => {
	const classification = classificationOf(host, type);

	classification.array ??= host.checker.isArrayType(type);
	return classification.array;
};

/**
 * Returns a type's awaited type, caching the compiler answer.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Compiler type.
 * @returns The awaited type, or null when there is none.
 */
export const cachedAwaitedTypeOf = (host: SurfaceProjectionHostType, type: ts.Type): ts.Type | null => {
	const classification = classificationOf(host, type);

	if (classification.awaited === undefined) {
		classification.awaited = host.checker.getAwaitedType(type) ?? null;
	}

	return classification.awaited;
};

/**
 * Reports whether a type resolves only to external declarations.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Compiler type.
 * @returns True for external types.
 */
export const cachedIsExternalType = (host: SurfaceProjectionHostType, type: ts.Type): boolean => {
	const classification = classificationOf(host, type);

	classification.external ??= isExternalType(type, host.authoredPaths);
	return classification.external;
};

/**
 * Returns the authored named symbol of a type, caching the compiler answer.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Compiler type.
 * @returns The named symbol, or null.
 */
export const cachedNamedSymbolOf = (host: SurfaceProjectionHostType, type: ts.Type): ts.Symbol | null => {
	const classification = classificationOf(host, type);

	if (classification.named === undefined) {
		classification.named = namedSymbolOf(type, host.authoredPaths);
	}

	return classification.named;
};

/**
 * Reports whether a type is an anonymous object shape.
 *
 * @param host - Projection host that owns the cache.
 * @param type - Compiler type.
 * @returns True for anonymous object shapes.
 */
export const cachedIsAnonymousShape = (host: SurfaceProjectionHostType, type: ts.Type): boolean => {
	const classification = classificationOf(host, type);

	classification.anonymous ??= isAnonymousShape(type, host.authoredPaths);
	return classification.anonymous;
};

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
	// Visited symbols are the common case: reachability reaches the same symbol
	// from many types. Checking that first avoids re-running the privacy and
	// externality predicates, which resolve declarations through the compiler.
	if (state.reachableSymbols.has(symbol) || isPrivateProperty(symbol) || isExternalSymbol(symbol, state.host.authoredPaths)) {
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
