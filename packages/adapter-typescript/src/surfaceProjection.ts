import * as ts from './compiler.ts';
import {type FactAddressType} from '@codeindex/adapter-sdk';
import {
	awaitedTypeOf,
	declaredTypeOf,
	hasAnyFlag,
	isAnonymousShape,
	isArrayType,
	isExternalType,
	namedSymbolOf,
	parametersOf,
	propertiesOf,
	resolveAlias,
	returnTypeOf,
	signaturesOf,
	symbolTypeOf,
	typeArgumentsOf,
	type SurfaceProjectionHostType,
} from './surfaceProjectionCompiler.ts';
import {
	addProjectionStep,
	markSymbolReachable,
	markTypeReachable,
	symbolIdOf,
	SurfaceProjectionError,
	type ProjectionNodeType,
	type ProjectionStateType,
} from './surfaceReachability.ts';
import {authoredDeclarationsOf, isExternalSymbol, isInheritedProperty, isPrivateProperty} from './projectionPredicates.ts';

export {type SurfaceProjectionHostType} from './surfaceProjectionCompiler.ts';
export {SurfaceProjectionError} from './surfaceReachability.ts';

const MAX_PROJECTION_DEPTH = 64;

const addSurface = function* addSurface(
	state: ProjectionStateType,
	symbol: ts.Symbol,
	relativePath: FactAddressType,
	flags: Readonly<{anonymous: boolean; inherited: boolean; depthOne: boolean}>,
): ts.APIRequestGenerator<void> {
	if (relativePath.length > 0) {
		state.addresses += 1;

		if (state.addresses > state.host.maxAddressesPerRoot) {
			throw new SurfaceProjectionError('Surface projection exceeded the configured surface-address ceiling');
		}
	}

	const symbolId = yield* symbolIdOf(state, symbol);

	if (symbolId === null) {
		return;
	}

	state.host.markReachable(symbolId);

	if (relativePath.length === 0) {
		return;
	}

	const relativeSegments = relativePath.slice(state.rootSegments.length);

	if (relativeSegments.length > 0) {
		state.host.addSurface({symbolId, relativeSegments, ...flags});
	}
};

const projectProperties = function* projectProperties(state: ProjectionStateType, node: ProjectionNodeType, anonymous: boolean): ts.APIRequestGenerator<void> {
	for (const property of yield* propertiesOf(state.host, node.type)) {
		if (
			isPrivateProperty(property) ||
			ts.declarationsOf(property).every((declaration) => !state.host.authoredPaths.has(ts.declarationFileNameOf(declaration)))
		) {
			continue;
		}

		const childPath: FactAddressType = [...node.path, ['member', property.name]];
		yield* addSurface(state, property, childPath, {
			anonymous,
			inherited: isInheritedProperty(property, node.rootDeclarations),
			depthOne: node.depth === 0,
		});

		if (node.ancestors.has(property)) {
			continue;
		}

		const propertyType = yield* symbolTypeOf(state.host, property);

		if (propertyType !== null) {
			state.projectionPending.push({
				type: propertyType,
				path: childPath,
				depth: node.depth + 1,
				rootDeclarations: node.rootDeclarations,
				ancestors: new Set([...node.ancestors, property]),
			});
		}
	}
};

const projectSignatures = function* projectSignatures(
	state: ProjectionStateType,
	node: ProjectionNodeType,
	kind: ts.SignatureKind,
): ts.APIRequestGenerator<void> {
	const signatures = yield* signaturesOf(state.host, node.type, kind);

	for (const [index, signature] of signatures.entries()) {
		const signaturePath: FactAddressType =
			kind === ts.SignatureKind.Call
				? signatures.length > 1
					? [...node.path, ['sig', index]]
					: node.path
				: signatures.length > 1
					? [...node.path, ['construct', null], ['sig', index]]
					: [...node.path, ['construct', null]];

		for (const [parameterIndex, parameter] of (yield* parametersOf(state.host, signature)).entries()) {
			if (node.ancestors.has(parameter) || isPrivateProperty(parameter)) {
				continue;
			}

			const parameterType = yield* symbolTypeOf(state.host, parameter);

			if (parameterType !== null) {
				state.projectionPending.push({
					type: parameterType,
					path: [...signaturePath, ['param', parameterIndex]],
					depth: node.depth + 1,
					rootDeclarations: node.rootDeclarations,
					ancestors: new Set([...node.ancestors, parameter]),
				});
			}
		}

		const returnType = yield* returnTypeOf(state.host, signature);

		if (returnType !== node.type) {
			state.projectionPending.push({
				type: returnType,
				path: kind === ts.SignatureKind.Call ? [...signaturePath, ['return', null]] : signaturePath,
				depth: node.depth + 1,
				rootDeclarations: node.rootDeclarations,
				ancestors: node.ancestors,
			});
		}
	}
};

const projectTuple = function* projectTuple(state: ProjectionStateType, node: ProjectionNodeType): ts.APIRequestGenerator<void> {
	if (!node.type.isTypeReference()) {
		return;
	}

	for (const [index, element] of (yield* typeArgumentsOf(state.host, node.type)).entries()) {
		state.projectionPending.push({
			type: element,
			path: [...node.path, ['element', index]],
			depth: node.depth + 1,
			rootDeclarations: node.rootDeclarations,
			ancestors: node.ancestors,
		});
	}
};

const projectArray = function* projectArray(state: ProjectionStateType, node: ProjectionNodeType): ts.APIRequestGenerator<void> {
	if (!node.type.isTypeReference()) {
		return;
	}

	const [element] = yield* typeArgumentsOf(state.host, node.type);

	if (element !== undefined) {
		state.projectionPending.push({
			type: element,
			path: [...node.path, ['element', null]],
			depth: node.depth + 1,
			rootDeclarations: node.rootDeclarations,
			ancestors: node.ancestors,
		});
	}
};

const processProjectionNode = function* processProjectionNode(state: ProjectionStateType, node: ProjectionNodeType): ts.APIRequestGenerator<void> {
	addProjectionStep(state);

	if (node.depth > MAX_PROJECTION_DEPTH) {
		state.depthLimited = true;
		yield* markTypeReachable(state, node.type);
		return;
	}

	if (hasAnyFlag(node.type.flags, [ts.TypeFlags.Any, ts.TypeFlags.Unknown, ts.TypeFlags.Never, ts.TypeFlags.Void])) {
		return;
	}

	if (node.type.isUnionType() || node.type.isIntersectionType()) {
		yield* markTypeReachable(state, node.type);
		return;
	}

	if (node.type.isTupleType()) {
		yield* projectTuple(state, node);
		return;
	}

	if (yield* isArrayType(state.host, node.type)) {
		yield* projectArray(state, node);
		return;
	}

	const awaited = yield* awaitedTypeOf(state.host, node.type);

	if (awaited !== null && awaited !== node.type) {
		state.projectionPending.push({
			type: awaited,
			path: [...node.path, ['awaited', null]],
			depth: node.depth + 1,
			rootDeclarations: node.rootDeclarations,
			ancestors: node.ancestors,
		});
		return;
	}

	if (yield* isExternalType(state.host, node.type)) {
		return;
	}

	yield* projectSignatures(state, node, ts.SignatureKind.Call);
	yield* projectSignatures(state, node, ts.SignatureKind.Construct);

	if ((node.type.flags & ts.TypeFlags.Object) === 0) {
		return;
	}

	const named = yield* namedSymbolOf(state.host, node.type);

	if (node.depth > 0 && named !== null) {
		yield* markSymbolReachable(state, named);
		return;
	}

	yield* projectProperties(state, node, yield* isAnonymousShape(state.host, node.type));
};

const drainProjection = function* drainProjection(state: ProjectionStateType): ts.APIRequestGenerator<void> {
	for (;;) {
		const node = state.projectionPending.pop();

		if (node === undefined) {
			return;
		}

		yield* processProjectionNode(state, node);
	}
};

const expandNamespace = function* expandNamespace(state: ProjectionStateType, symbol: ts.Symbol, path: FactAddressType): ts.APIRequestGenerator<void> {
	for (const exported of yield* state.host.checker.getExportsOfModule.gen(symbol)) {
		if (isPrivateProperty(exported) || isExternalSymbol(exported, state.host.authoredPaths)) {
			continue;
		}

		const childPath: FactAddressType = [...path, ['member', exported.name]];
		yield* addSurface(state, exported, childPath, {anonymous: false, inherited: false, depthOne: true});
		yield* markSymbolReachable(state, exported);

		if ((exported.flags & ts.SymbolFlags.Namespace) !== 0) {
			yield* expandNamespace(state, exported, childPath);
		}
	}
};

const expandEnum = function* expandEnum(state: ProjectionStateType, symbol: ts.Symbol, path: FactAddressType): ts.APIRequestGenerator<void> {
	for (const declaration of authoredDeclarationsOf(symbol, state.host.authoredPaths)) {
		if (!ts.isEnumDeclaration(declaration)) {
			continue;
		}

		for (const member of declaration.members) {
			const memberSymbol = yield* state.host.checker.getSymbolAtLocation.gen(member.name);

			if (memberSymbol !== undefined) {
				yield* addSurface(state, memberSymbol, [...path, ['member', member.name.getText()]], {
					anonymous: false,
					inherited: false,
					depthOne: true,
				});
			}
		}
	}
};

/**
 * Projects one root as a resumable compiler operation.
 *
 * `API.batch` runs one of these generators per published root. Every yielded
 * dependency round is deduplicated and sent to the native compiler as one
 * request, instead of blocking once per scalar checker call.
 *
 * @param host - Shared compiler-query caches and fact sinks.
 * @param root - Published root symbol to traverse.
 * @param rootSegments - Canonical address of the published root.
 * @returns Projection bounds observed for this root.
 * @yields {unknown} Compiler requests consumed by `API.batch`.
 */
export const projectPublishedRoot = function* projectPublishedRoot(
	host: SurfaceProjectionHostType,
	root: ts.Symbol,
	rootSegments: FactAddressType,
): ts.APIRequestGenerator<Readonly<{addresses: number; steps: number; depthLimited: boolean}>> {
	const state: ProjectionStateType = {
		host,
		reachableSymbols: new Set(),
		reachableTypes: new Set(),
		reachabilityPending: [],
		projectionPending: [],
		rootSegments,
		addresses: 0,
		steps: 0,
		depthLimited: false,
	};
	const target = yield* resolveAlias(host, root);

	yield* markSymbolReachable(state, target);

	const isEnum = (target.flags & ts.SymbolFlags.Enum) !== 0;
	const isNamespace = (target.flags & ts.SymbolFlags.Namespace) !== 0;

	if (isEnum) {
		yield* expandEnum(state, target, rootSegments);
	}

	if (isNamespace) {
		yield* expandNamespace(state, target, rootSegments);
	}

	if (!isEnum && !isNamespace) {
		const type = hasAnyFlag(target.flags, [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias])
			? yield* declaredTypeOf(host, target)
			: yield* symbolTypeOf(host, target);

		if (type !== null) {
			state.projectionPending.push({
				type,
				path: rootSegments,
				depth: 0,
				rootDeclarations: authoredDeclarationsOf(root, host.authoredPaths),
				ancestors: new Set(),
			});
			yield* drainProjection(state);
		}

		if ((target.flags & ts.SymbolFlags.Class) !== 0) {
			const staticType = yield* symbolTypeOf(host, target);

			if (staticType !== null) {
				state.projectionPending.push({
					type: staticType,
					path: rootSegments,
					depth: 0,
					rootDeclarations: authoredDeclarationsOf(root, host.authoredPaths),
					ancestors: new Set([target]),
				});
				yield* drainProjection(state);
			}
		}
	}

	return {addresses: state.addresses, steps: state.steps, depthLimited: state.depthLimited};
};
