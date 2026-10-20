import ts from 'typescript';
import {type FactAddressType} from '../../core/facts/index.ts';
import {
	addStep,
	authoredDeclarationsOf,
	declaredTypeOf,
	enqueueProjection,
	hasAnyFlag,
	isAnonymousShape,
	isExternalSymbol,
	isExternalType,
	isInheritedProperty,
	isPrivateProperty,
	isTypeReference,
	MAX_PROJECTION_DEPTH,
	markSymbolReachable,
	markTypeReachable,
	namedSymbolOf,
	type ProjectionNodeType,
	type ProjectionStateType,
	SurfaceProjectionError,
	resolveAlias,
	symbolIdOf,
	symbolTypeOf,
	type SurfaceProjectionHostType,
} from './surfaceCore.ts';

export {SurfaceProjectionError, type SurfaceProjectionHostType} from './surfaceCore.ts';

/**
 * Adds one projected surface binding and its origin.
 *
 * @param state - Projection state.
 * @param symbol - Terminal compiler symbol.
 * @param relativePath - Address path after the published root.
 * @param flags - Anonymous, inherited, and depth-one shape flags.
 */
const addSurface = (
	state: ProjectionStateType,
	symbol: ts.Symbol,
	relativePath: FactAddressType,
	flags: Readonly<{anonymous: boolean; inherited: boolean; depthOne: boolean}>,
): void => {
	if (relativePath.length > 0) {
		state.addresses += 1;

		if (state.addresses > state.host.maxAddressesPerRoot) {
			throw new SurfaceProjectionError('Surface projection exceeded the configured surface-address ceiling');
		}
	}

	const symbolId = symbolIdOf(state, symbol);

	if (symbolId === null) {
		return;
	}

	state.host.markReachable(symbolId);

	if (relativePath.length === 0) {
		return;
	}

	const relativeSegments = relativePath.slice(state.rootSegments.length);

	if (relativeSegments.length === 0) {
		return;
	}

	state.host.addSurface({symbolId, relativeSegments, ...flags});
};

const projectProperties = (state: ProjectionStateType, node: ProjectionNodeType, anonymous: boolean): void => {
	const properties = state.host.checker.getPropertiesOfType(node.type);

	for (const property of properties) {
		if (
			isPrivateProperty(property) ||
			(property.declarations ?? []).every((declaration) => !state.host.authoredPaths.has(declaration.getSourceFile().fileName))
		) {
			continue;
		}

		const childPath: FactAddressType = [...node.path, ['member', property.getName()]];
		addSurface(state, property, childPath, {
			anonymous,
			inherited: isInheritedProperty(property, node.rootDeclarations),
			depthOne: node.depth === 0,
		});

		if (node.ancestors.has(property)) {
			continue;
		}

		const propertyType = symbolTypeOf(state.host.checker, property);

		if (propertyType !== null) {
			enqueueProjection(state, {
				type: propertyType,
				path: childPath,
				depth: node.depth + 1,
				rootDeclarations: node.rootDeclarations,
				ancestors: new Set([...node.ancestors, property]),
			});
		}
	}
};

const projectCallSignatures = (state: ProjectionStateType, node: ProjectionNodeType): void => {
	const signatures = state.host.checker.getSignaturesOfType(node.type, ts.SignatureKind.Call);

	for (const [index, signature] of signatures.entries()) {
		const signaturePath: FactAddressType = signatures.length > 1 ? [...node.path, ['sig', index]] : node.path;

		for (const [parameterIndex, parameter] of signature.getParameters().entries()) {
			if (node.ancestors.has(parameter)) {
				continue;
			}

			const parameterType = symbolTypeOf(state.host.checker, parameter);

			if (parameterType !== null) {
				enqueueProjection(state, {
					type: parameterType,
					path: [...signaturePath, ['param', parameterIndex]],
					depth: node.depth + 1,
					rootDeclarations: node.rootDeclarations,
					ancestors: new Set([...node.ancestors, parameter]),
				});
			}
		}

		const returnType = state.host.checker.getReturnTypeOfSignature(signature);

		if (returnType !== node.type) {
			enqueueProjection(state, {
				type: returnType,
				path: [...signaturePath, ['return', null]],
				depth: node.depth + 1,
				rootDeclarations: node.rootDeclarations,
				ancestors: node.ancestors,
			});
		}
	}
};

const projectConstructSignatures = (state: ProjectionStateType, node: ProjectionNodeType): void => {
	const signatures = state.host.checker.getSignaturesOfType(node.type, ts.SignatureKind.Construct);

	for (const [index, signature] of signatures.entries()) {
		const constructPath: FactAddressType = signatures.length > 1 ? [...node.path, ['construct', null], ['sig', index]] : [...node.path, ['construct', null]];

		for (const [parameterIndex, parameter] of signature.getParameters().entries()) {
			if (node.ancestors.has(parameter)) {
				continue;
			}

			const parameterType = symbolTypeOf(state.host.checker, parameter);

			if (parameterType !== null) {
				enqueueProjection(state, {
					type: parameterType,
					path: [...constructPath, ['param', parameterIndex]],
					depth: node.depth + 1,
					rootDeclarations: node.rootDeclarations,
					ancestors: new Set([...node.ancestors, parameter]),
				});
			}
		}

		const returnType = state.host.checker.getReturnTypeOfSignature(signature);

		if (returnType !== node.type) {
			enqueueProjection(state, {
				type: returnType,
				path: constructPath,
				depth: node.depth + 1,
				rootDeclarations: node.rootDeclarations,
				ancestors: node.ancestors,
			});
		}
	}
};

const projectTuple = (state: ProjectionStateType, node: ProjectionNodeType): void => {
	if (!isTypeReference(node.type)) {
		return;
	}

	for (const [index, element] of state.host.checker.getTypeArguments(node.type).entries()) {
		enqueueProjection(state, {
			type: element,
			path: [...node.path, ['element', index]],
			depth: node.depth + 1,
			rootDeclarations: node.rootDeclarations,
			ancestors: node.ancestors,
		});
	}
};

const projectArray = (state: ProjectionStateType, node: ProjectionNodeType): void => {
	if (!isTypeReference(node.type)) {
		return;
	}

	const [element] = state.host.checker.getTypeArguments(node.type);

	if (element !== undefined) {
		enqueueProjection(state, {
			type: element,
			path: [...node.path, ['element', null]],
			depth: node.depth + 1,
			rootDeclarations: node.rootDeclarations,
			ancestors: node.ancestors,
		});
	}
};

const processProjectionNode = (state: ProjectionStateType, node: ProjectionNodeType): void => {
	addStep(state);

	if (node.depth > MAX_PROJECTION_DEPTH) {
		state.depthLimited = true;
		markTypeReachable(state, node.type);
		return;
	}

	if (hasAnyFlag(node.type.flags, [ts.TypeFlags.Any, ts.TypeFlags.Unknown, ts.TypeFlags.Never, ts.TypeFlags.Void])) {
		return;
	}

	if (node.type.isUnionOrIntersection()) {
		markTypeReachable(state, node.type);
		return;
	}

	if (state.host.checker.isTupleType(node.type)) {
		projectTuple(state, node);
		return;
	}

	if (state.host.checker.isArrayType(node.type)) {
		projectArray(state, node);
		return;
	}

	const awaited = state.host.checker.getAwaitedType(node.type);

	if (awaited !== undefined && awaited !== node.type) {
		enqueueProjection(state, {
			type: awaited,
			path: [...node.path, ['awaited', null]],
			depth: node.depth + 1,
			rootDeclarations: node.rootDeclarations,
			ancestors: node.ancestors,
		});
		return;
	}

	if (isExternalType(node.type, state.host.authoredPaths)) {
		return;
	}

	projectCallSignatures(state, node);
	projectConstructSignatures(state, node);

	if ((node.type.flags & ts.TypeFlags.Object) === 0) {
		return;
	}

	const named = namedSymbolOf(node.type, state.host.authoredPaths);

	if (node.depth > 0 && named !== null) {
		markSymbolReachable(state, named);
		return;
	}

	projectProperties(state, node, isAnonymousShape(node.type, state.host.authoredPaths));
};

const drainProjection = (state: ProjectionStateType): void => {
	if (state.projectionDraining) {
		return;
	}

	state.projectionDraining = true;

	try {
		for (;;) {
			const node = state.projectionPending.pop();

			if (node === undefined) {
				return;
			}

			processProjectionNode(state, node);
		}
	} finally {
		state.projectionDraining = false;
	}
};

const projectType = (
	state: ProjectionStateType,
	input: Readonly<{type: ts.Type; path: FactAddressType; depth: number; rootDeclarations: readonly ts.Node[]}>,
): void => {
	enqueueProjection(state, {type: input.type, path: input.path, depth: input.depth, rootDeclarations: input.rootDeclarations, ancestors: new Set()});
	drainProjection(state);
};

const expandNamespace = (state: ProjectionStateType, symbol: ts.Symbol, path: FactAddressType): void => {
	for (const exported of state.host.checker.getExportsOfModule(symbol)) {
		if (isExternalSymbol(exported, state.host.authoredPaths)) {
			continue;
		}

		const childPath: FactAddressType = [...path, ['member', exported.getName()]];
		addSurface(state, exported, childPath, {anonymous: false, inherited: false, depthOne: true});
		markSymbolReachable(state, exported);

		if ((exported.flags & ts.SymbolFlags.Namespace) !== 0) {
			expandNamespace(state, exported, childPath);
		}
	}
};

const expandEnum = (state: ProjectionStateType, symbol: ts.Symbol, path: FactAddressType): void => {
	for (const declaration of authoredDeclarationsOf(symbol, state.host.authoredPaths)) {
		if (!ts.isEnumDeclaration(declaration)) {
			continue;
		}

		for (const member of declaration.members) {
			const memberSymbol = state.host.checker.getSymbolAtLocation(member.name);

			if (memberSymbol !== undefined) {
				addSurface(state, memberSymbol, [...path, ['member', member.name.getText()]], {
					anonymous: false,
					inherited: false,
					depthOne: true,
				});
			}
		}
	}
};

/**
 * Projects one published root binding through compiler-resolved types.
 *
 * Addresses are emitted only for authored terminals. Named types below depth
 * zero become reachable declarations instead of projected addresses.
 *
 * @param host - Compiler access, fact sinks, and configured ceilings.
 * @param root - Published root compiler symbol.
 * @param rootSegments - Canonical address of the published root binding.
 * @returns Per-root projection counters.
 * @throws {@link SurfaceProjectionError} When a configured ceiling is exceeded.
 */
export const projectPublishedRoot = (
	host: SurfaceProjectionHostType,
	root: ts.Symbol,
	rootSegments: FactAddressType,
): Readonly<{addresses: number; steps: number; depthLimited: boolean}> => {
	const state: ProjectionStateType = {
		host,
		reachableSymbols: new Set(),
		reachableTypes: new Set(),
		reachabilityPending: [],
		projectionPending: [],
		rootSegments,
		rootDeclarations: authoredDeclarationsOf(root, host.authoredPaths),
		addresses: 0,
		steps: 0,
		draining: false,
		projectionDraining: false,
		depthLimited: false,
	};
	const target = resolveAlias(host.checker, root);

	markSymbolReachable(state, target);

	if ((target.flags & ts.SymbolFlags.Enum) !== 0) {
		expandEnum(state, target, rootSegments);
	} else if ((target.flags & ts.SymbolFlags.Namespace) !== 0) {
		expandNamespace(state, target, rootSegments);
	} else {
		const type = hasAnyFlag(target.flags, [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias])
			? declaredTypeOf(host.checker, target)
			: symbolTypeOf(host.checker, target);

		if (type !== null) {
			projectType(state, {type, path: rootSegments, depth: 0, rootDeclarations: state.rootDeclarations});
		}

		if ((target.flags & ts.SymbolFlags.Class) !== 0) {
			const staticType = symbolTypeOf(host.checker, target);

			if (staticType !== null) {
				enqueueProjection(state, {type: staticType, path: rootSegments, depth: 0, rootDeclarations: state.rootDeclarations, ancestors: new Set([target])});
				drainProjection(state);
			}
		}
	}

	return {addresses: state.addresses, steps: state.steps, depthLimited: state.depthLimited};
};
