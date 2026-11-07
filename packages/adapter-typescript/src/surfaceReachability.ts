import * as ts from './compiler.ts';
import {type FactAddressType} from '@codeindex/adapter-sdk';
import {
	baseTypesOf,
	declaredTypeOf,
	hasAnyFlag,
	indexInfosOf,
	isExternalType,
	namedSymbolOf,
	propertiesOf,
	resolveAlias,
	symbolTypeOf,
	typeArgumentsOf,
	typeSymbolsOf,
	type SurfaceProjectionHostType,
} from './surfaceProjectionCompiler.ts';
import {isExternalSymbol, isPrivateProperty} from './projectionPredicates.ts';

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
	addresses: number;
	steps: number;
	depthLimited: boolean;
};

export class SurfaceProjectionError extends Error {
	public override readonly name = 'SurfaceProjectionError';
}

export const addProjectionStep = (state: ProjectionStateType): void => {
	state.steps += 1;

	if (state.steps > state.host.maxReachabilityStepsPerRoot) {
		throw new SurfaceProjectionError('Surface projection exceeded the configured reachability-step ceiling');
	}
};

export const symbolIdOf = function* symbolIdOf(state: ProjectionStateType, symbol: ts.Symbol): ts.APIRequestGenerator<string | null> {
	const target = yield* resolveAlias(state.host, symbol);

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

const enqueueSymbol = function* enqueueSymbol(state: ProjectionStateType, symbol: ts.Symbol): ts.APIRequestGenerator<void> {
	if (state.reachableSymbols.has(symbol) || isPrivateProperty(symbol) || isExternalSymbol(symbol, state.host.authoredPaths)) {
		return;
	}

	const symbolId = yield* symbolIdOf(state, symbol);

	if (symbolId === null) {
		return;
	}

	state.reachableSymbols.add(symbol);
	addProjectionStep(state);
	state.host.markReachable(symbolId);
	state.reachabilityPending.push({kind: 'symbol', symbol});
};

const enqueueType = (state: ProjectionStateType, type: ts.Type): void => {
	if (state.reachableTypes.has(type)) {
		return;
	}

	state.reachableTypes.add(type);
	addProjectionStep(state);
	state.reachabilityPending.push({kind: 'type', type});
};

const processReachabilitySymbol = function* processReachabilitySymbol(state: ProjectionStateType, symbol: ts.Symbol): ts.APIRequestGenerator<void> {
	const type = hasAnyFlag(symbol.flags, [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias, ts.SymbolFlags.Enum])
		? yield* declaredTypeOf(state.host, symbol)
		: yield* symbolTypeOf(state.host, symbol);

	if (type !== null) {
		enqueueType(state, type);
	}
};

const enqueueTypeArguments = function* enqueueTypeArguments(state: ProjectionStateType, type: ts.Type): ts.APIRequestGenerator<void> {
	if (!type.isTypeReference() || (type.objectFlags & ts.ObjectFlags.Reference) === 0) {
		return;
	}

	for (const argument of yield* typeArgumentsOf(state.host, type)) {
		enqueueType(state, argument);
	}
};

const processObjectType = function* processObjectType(state: ProjectionStateType, type: ts.ObjectType): ts.APIRequestGenerator<void> {
	const named = yield* namedSymbolOf(state.host, type);

	if (named !== null) {
		yield* enqueueSymbol(state, named);
	}

	if (type.isClassOrInterface() && (type.objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0) {
		for (const base of yield* baseTypesOf(state.host, type)) {
			enqueueType(state, base);
		}
	}

	for (const property of yield* propertiesOf(state.host, type)) {
		yield* enqueueSymbol(state, property);
	}
};

const processReachabilityType = function* processReachabilityType(state: ProjectionStateType, type: ts.Type): ts.APIRequestGenerator<void> {
	if (yield* isExternalType(state.host, type)) {
		yield* enqueueTypeArguments(state, type);
		return;
	}

	const symbols = yield* typeSymbolsOf(state.host, type);

	if (hasAnyFlag(type.flags, [ts.TypeFlags.Conditional, ts.TypeFlags.IndexedAccess]) && symbols.alias !== undefined) {
		yield* enqueueSymbol(state, symbols.alias);
	}

	if (type.isUnionType() || type.isIntersectionType()) {
		for (const constituent of yield* type.getTypes.gen()) {
			enqueueType(state, constituent);
		}

		return;
	}

	yield* enqueueTypeArguments(state, type);

	if (type.isObjectType()) {
		yield* processObjectType(state, type);
	}

	for (const index of yield* indexInfosOf(state.host, type)) {
		enqueueType(state, index.valueType);
	}
};

const drainReachability = function* drainReachability(state: ProjectionStateType): ts.APIRequestGenerator<void> {
	for (;;) {
		const pending = state.reachabilityPending.pop();

		if (pending === undefined) {
			return;
		}

		yield* pending.kind === 'symbol' ? processReachabilitySymbol(state, pending.symbol) : processReachabilityType(state, pending.type);
	}
};

export const markSymbolReachable = function* markSymbolReachable(state: ProjectionStateType, symbol: ts.Symbol): ts.APIRequestGenerator<void> {
	yield* enqueueSymbol(state, symbol);
	yield* drainReachability(state);
};

export const markTypeReachable = function* markTypeReachable(state: ProjectionStateType, type: ts.Type): ts.APIRequestGenerator<void> {
	enqueueType(state, type);
	yield* drainReachability(state);
};
