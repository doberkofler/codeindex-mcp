import * as ts from './compiler.ts';
import {type FactAddressType} from '@codeindex/adapter-sdk';
import {authoredDeclarationsOf, isExternalSymbol} from './projectionPredicates.ts';

type SurfaceAddressType = Readonly<{
	readonly symbolId: string;
	readonly relativeSegments: FactAddressType;
	readonly anonymous: boolean;
	readonly inherited: boolean;
	readonly depthOne: boolean;
}>;

type TypeClassificationType = {
	array: boolean | undefined;
	awaited: ts.Type | null | undefined;
	external: boolean | undefined;
	named: ts.Symbol | null | undefined;
	anonymous: boolean | undefined;
};

type TypeSymbolsType = Readonly<{alias: ts.Symbol | undefined; direct: ts.Symbol | undefined}>;

/** Shared compiler access and caches for scheduled surface projection. */
export type SurfaceProjectionHostType = Readonly<{
	readonly checker: ts.TypeChecker;
	readonly authoredPaths: ReadonlySet<string>;
	readonly maxAddressesPerRoot: number;
	readonly maxReachabilityStepsPerRoot: number;
	readonly symbolForTsSymbol: (symbol: ts.Symbol) => string | null;
	readonly symbolForDeclaration: (declaration: ts.Node) => string | null;
	readonly addSurface: (address: SurfaceAddressType) => void;
	readonly markReachable: (symbolId: string) => void;
	readonly aliases: Map<number, ts.Symbol>;
	readonly symbolTypes: Map<number, ts.Type | null>;
	readonly declaredTypes: Map<number, ts.Type | null>;
	readonly typeProperties: Map<number, readonly ts.Symbol[]>;
	readonly typeIndexes: Map<number, readonly ts.IndexInfo[]>;
	readonly typeBases: Map<number, readonly ts.Type[]>;
	readonly typeArguments: Map<number, readonly ts.Type[]>;
	readonly typeClassifications: Map<number, TypeClassificationType>;
	readonly typeSymbols: Map<number, TypeSymbolsType>;
	readonly typeSignatures: Map<number, Map<number, readonly ts.Signature[]>>;
	readonly signatureParameters: Map<number, readonly ts.Symbol[]>;
	readonly signatureReturnTypes: Map<number, ts.Type>;
}>;

export const hasAnyFlag = (flags: number, candidates: readonly number[]): boolean => candidates.some((flag) => (flags & flag) !== 0);

const classificationOf = (host: SurfaceProjectionHostType, type: ts.Type): TypeClassificationType => {
	const cached = host.typeClassifications.get(type.id);

	if (cached !== undefined) {
		return cached;
	}

	const created: TypeClassificationType = {array: undefined, awaited: undefined, external: undefined, named: undefined, anonymous: undefined};
	host.typeClassifications.set(type.id, created);
	return created;
};

export const resolveAlias = function* resolveAlias(host: SurfaceProjectionHostType, symbol: ts.Symbol): ts.APIRequestGenerator<ts.Symbol> {
	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
		return symbol;
	}

	const cached = host.aliases.get(symbol.id);

	if (cached !== undefined) {
		return cached;
	}

	let target: ts.Symbol;

	try {
		target = yield* host.checker.getAliasedSymbol.gen(symbol);
	} catch {
		target = symbol;
	}

	host.aliases.set(symbol.id, target);
	return target;
};

export const symbolTypeOf = function* symbolTypeOf(host: SurfaceProjectionHostType, symbol: ts.Symbol): ts.APIRequestGenerator<ts.Type | null> {
	const cached = host.symbolTypes.get(symbol.id);

	if (cached !== undefined) {
		return cached;
	}
	const declaration = ts.valueDeclarationOf(symbol) ?? ts.declarationsOf(symbol)[0];

	if (declaration === undefined) {
		host.symbolTypes.set(symbol.id, null);
		return null;
	}

	let type: ts.Type | null;

	try {
		type = yield* host.checker.getTypeOfSymbolAtLocation.gen(symbol, declaration);
	} catch {
		type = null;
	}

	host.symbolTypes.set(symbol.id, type);
	return type;
};

export const declaredTypeOf = function* declaredTypeOf(host: SurfaceProjectionHostType, symbol: ts.Symbol): ts.APIRequestGenerator<ts.Type | null> {
	const cached = host.declaredTypes.get(symbol.id);

	if (cached !== undefined) {
		return cached;
	}

	let type: ts.Type | null;

	try {
		type = yield* host.checker.getDeclaredTypeOfSymbol.gen(symbol);
	} catch {
		type = null;
	}

	host.declaredTypes.set(symbol.id, type);
	return type;
};

export const propertiesOf = function* propertiesOf(host: SurfaceProjectionHostType, type: ts.Type): ts.APIRequestGenerator<readonly ts.Symbol[]> {
	const cached = host.typeProperties.get(type.id);

	if (cached !== undefined) {
		return cached;
	}

	const properties = yield* host.checker.getPropertiesOfType.gen(type);
	host.typeProperties.set(type.id, properties);
	return properties;
};

export const indexInfosOf = function* indexInfosOf(host: SurfaceProjectionHostType, type: ts.Type): ts.APIRequestGenerator<readonly ts.IndexInfo[]> {
	const cached = host.typeIndexes.get(type.id);

	if (cached !== undefined) {
		return cached;
	}

	const indexes = yield* host.checker.getIndexInfosOfType.gen(type);
	host.typeIndexes.set(type.id, indexes);
	return indexes;
};

export const baseTypesOf = function* baseTypesOf(host: SurfaceProjectionHostType, type: ts.InterfaceType): ts.APIRequestGenerator<readonly ts.Type[]> {
	const cached = host.typeBases.get(type.id);

	if (cached !== undefined) {
		return cached;
	}

	const bases = yield* host.checker.getBaseTypes.gen(type);
	host.typeBases.set(type.id, bases);
	return bases;
};

export const typeArgumentsOf = function* typeArgumentsOf(host: SurfaceProjectionHostType, type: ts.TypeReference): ts.APIRequestGenerator<readonly ts.Type[]> {
	const cached = host.typeArguments.get(type.id);

	if (cached !== undefined) {
		return cached;
	}

	const typeArguments = yield* host.checker.getTypeArguments.gen(type);
	host.typeArguments.set(type.id, typeArguments);
	return typeArguments;
};

export const typeSymbolsOf = function* typeSymbolsOf(host: SurfaceProjectionHostType, type: ts.Type): ts.APIRequestGenerator<TypeSymbolsType> {
	const cached = host.typeSymbols.get(type.id);

	if (cached !== undefined) {
		return cached;
	}

	const alias = yield* type.getAliasSymbol.gen();
	const direct = yield* type.getSymbol.gen();
	const symbols = {alias, direct};
	host.typeSymbols.set(type.id, symbols);
	return symbols;
};

export const isExternalType = function* isExternalType(host: SurfaceProjectionHostType, type: ts.Type): ts.APIRequestGenerator<boolean> {
	const classification = classificationOf(host, type);

	if (classification.external !== undefined) {
		return classification.external;
	}

	const symbols = yield* typeSymbolsOf(host, type);
	classification.external = [symbols.alias, symbols.direct].some((symbol) => symbol !== undefined && isExternalSymbol(symbol, host.authoredPaths));
	return classification.external;
};

const isAnonymousClassExpression = (symbol: ts.Symbol): boolean =>
	ts.declarationsOf(symbol).some((declaration) => ts.isClassExpression(declaration) && declaration.name === undefined);

export const namedSymbolOf = function* namedSymbolOf(host: SurfaceProjectionHostType, type: ts.Type): ts.APIRequestGenerator<ts.Symbol | null> {
	const classification = classificationOf(host, type);

	if (classification.named !== undefined) {
		return classification.named;
	}

	const namedFlags = [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias, ts.SymbolFlags.Enum];
	const symbols = yield* typeSymbolsOf(host, type);
	classification.named =
		[symbols.alias, symbols.direct].find(
			(symbol) =>
				symbol !== undefined &&
				namedFlags.some((flag) => (symbol.flags & flag) !== 0) &&
				authoredDeclarationsOf(symbol, host.authoredPaths).length > 0 &&
				!isAnonymousClassExpression(symbol),
		) ?? null;
	return classification.named;
};

export const isAnonymousShape = function* isAnonymousShape(host: SurfaceProjectionHostType, type: ts.Type): ts.APIRequestGenerator<boolean> {
	const classification = classificationOf(host, type);

	classification.anonymous ??= (type.flags & ts.TypeFlags.Object) !== 0 && (yield* namedSymbolOf(host, type)) === null;

	return classification.anonymous;
};

export const isArrayType = function* isArrayType(host: SurfaceProjectionHostType, type: ts.Type): ts.APIRequestGenerator<boolean> {
	const classification = classificationOf(host, type);

	classification.array ??= yield* host.checker.isArrayType.gen(type);

	return classification.array;
};

export const awaitedTypeOf = function* awaitedTypeOf(host: SurfaceProjectionHostType, type: ts.Type): ts.APIRequestGenerator<ts.Type | null> {
	const classification = classificationOf(host, type);

	if (classification.awaited === undefined) {
		classification.awaited = (yield* host.checker.getAwaitedType.gen(type)) ?? null;
	}

	return classification.awaited;
};

export const signaturesOf = function* signaturesOf(
	host: SurfaceProjectionHostType,
	type: ts.Type,
	kind: ts.SignatureKind,
): ts.APIRequestGenerator<readonly ts.Signature[]> {
	const byKind = host.typeSignatures.get(type.id);
	const cached = byKind?.get(kind);

	if (cached !== undefined) {
		return cached;
	}

	const signatures = yield* host.checker.getSignaturesOfType.gen(type, kind);

	if (byKind === undefined) {
		host.typeSignatures.set(type.id, new Map([[kind, signatures]]));
	} else {
		byKind.set(kind, signatures);
	}

	return signatures;
};

export const parametersOf = function* parametersOf(host: SurfaceProjectionHostType, signature: ts.Signature): ts.APIRequestGenerator<readonly ts.Symbol[]> {
	const cached = host.signatureParameters.get(signature.id);

	if (cached !== undefined) {
		return cached;
	}

	const parameters = yield* signature.getParameters.gen();
	host.signatureParameters.set(signature.id, parameters);
	return parameters;
};

export const returnTypeOf = function* returnTypeOf(host: SurfaceProjectionHostType, signature: ts.Signature): ts.APIRequestGenerator<ts.Type> {
	const cached = host.signatureReturnTypes.get(signature.id);

	if (cached !== undefined) {
		return cached;
	}

	const returnType = yield* signature.getReturnType.gen();
	host.signatureReturnTypes.set(signature.id, returnType);
	return returnType;
};
