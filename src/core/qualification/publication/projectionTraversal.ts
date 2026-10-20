import ts from 'typescript';
import {
	addAddress,
	addStep,
	declaredTypeOf,
	hasAnyFlag,
	isAnonymousShape,
	isExternalSymbol,
	isExternalType,
	isInheritedProperty,
	isInterfaceType,
	isObjectType,
	isPrivateProperty,
	isTypeReference,
	MAX_PROJECTION_DEPTH,
	namedSymbolOf,
	type ProjectionNodeType,
	type ProjectionStateType,
	symbolTypeOf,
	type ReachabilityNodeType,
	type TraversalContextType,
} from './projectionModel.ts';

const enqueueSymbol = (state: ProjectionStateType, symbol: ts.Symbol): void => {
	if (isPrivateProperty(symbol) || isExternalSymbol(symbol, state.authoredPaths) || state.reachabilityVisited.has(symbol)) {
		return;
	}

	state.reachabilityVisited.add(symbol);
	addStep(state, 'reachability');
	state.reachabilityPending.push({kind: 'symbol', symbol});
};

const enqueueType = (state: ProjectionStateType, type: ts.Type): void => {
	if (state.reachabilityTypes.has(type)) {
		return;
	}

	state.reachabilityTypes.add(type);
	addStep(state, 'reachability');
	state.reachabilityPending.push({kind: 'type', type});
};

const processReachabilitySymbol = (state: ProjectionStateType, symbol: ts.Symbol): void => {
	const type = hasAnyFlag(symbol.flags, [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias, ts.SymbolFlags.Enum])
		? declaredTypeOf(state.checker, symbol)
		: symbolTypeOf(state.checker, symbol);

	if (type !== null) {
		enqueueType(state, type);
	}
};

const enqueueExternalTypeArguments = (state: ProjectionStateType, type: ts.Type): void => {
	if (isTypeReference(type) && (type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
		for (const argument of state.checker.getTypeArguments(type)) {
			enqueueType(state, argument);
		}
	}
};

const enqueueObjectReachability = (state: ProjectionStateType, type: ts.Type): void => {
	const named = namedSymbolOf(type, state.authoredPaths);

	if (named !== null) {
		enqueueSymbol(state, named);
	}

	if (isInterfaceType(type) && isObjectType(type) && (type.objectFlags & ts.ObjectFlags.ClassOrInterface) !== 0) {
		for (const base of state.checker.getBaseTypes(type)) {
			enqueueType(state, base);
		}
	}

	for (const property of state.checker.getPropertiesOfType(type)) {
		enqueueSymbol(state, property);
	}
};

const processReachabilityType = (state: ProjectionStateType, type: ts.Type): void => {
	if (isExternalType(type, state.authoredPaths)) {
		enqueueExternalTypeArguments(state, type);
		return;
	}

	if (type.isUnionOrIntersection()) {
		for (const constituent of type.types) {
			enqueueType(state, constituent);
		}

		return;
	}

	if (isTypeReference(type) && (type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
		for (const argument of state.checker.getTypeArguments(type)) {
			enqueueType(state, argument);
		}
	}

	if (isObjectType(type)) {
		enqueueObjectReachability(state, type);
	}

	for (const index of state.checker.getIndexInfosOfType(type)) {
		enqueueType(state, index.type);
	}
};

const drainReachability = (state: ProjectionStateType): void => {
	if (state.draining) {
		return;
	}

	state.draining = true;

	try {
		for (;;) {
			const pending: ReachabilityNodeType | undefined = state.reachabilityPending.pop();

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

const markTypeReachable = (state: ProjectionStateType, type: ts.Type): void => {
	enqueueType(state, type);
	drainReachability(state);
};

const enqueueProjection = (context: TraversalContextType, type: ts.Type, overrides: Partial<TraversalContextType> = {}): void => {
	context.state.projectionPending.push({
		type,
		path: overrides.path ?? context.path,
		depth: overrides.depth ?? context.depth,
		rootDeclarations: overrides.rootDeclarations ?? context.rootDeclarations,
		ancestors: overrides.ancestors ?? context.ancestors,
	});
};

const projectProperties = (context: TraversalContextType, type: ts.Type, anonymous: boolean): void => {
	const {state, path, depth, rootDeclarations, ancestors} = context;

	for (const property of state.checker.getPropertiesOfType(type)) {
		if (isPrivateProperty(property) || (property.declarations ?? []).every((declaration) => !state.authoredPaths.has(declaration.getSourceFile().fileName))) {
			continue;
		}

		const childPath = [...path, property.getName()];
		addAddress(state, childPath, property, {
			anonymous,
			inherited: isInheritedProperty(property, rootDeclarations),
			depthOne: childPath.length === path.length + 1 && depth === 0,
		});

		if (ancestors.has(property)) {
			continue;
		}

		const propertyType = symbolTypeOf(state.checker, property);

		if (propertyType !== null) {
			enqueueProjection(context, propertyType, {
				path: childPath,
				depth: depth + 1,
				ancestors: new Set([...ancestors, property]),
			});
		}
	}
};

export const projectPropertiesAtRoot = (
	input: Readonly<{
		state: ProjectionStateType;
		type: ts.Type;
		rootName: string;
		rootDeclarations: readonly ts.Node[];
		ancestors: ReadonlySet<ts.Symbol>;
	}>,
): void => {
	projectProperties(
		{state: input.state, path: [input.rootName], depth: 0, rootDeclarations: input.rootDeclarations, ancestors: input.ancestors},
		input.type,
		false,
	);
};

const projectCallSignatures = (context: TraversalContextType, type: ts.Type): void => {
	const {state, path, depth, ancestors} = context;
	const signatures = state.checker.getSignaturesOfType(type, ts.SignatureKind.Call);

	for (const [index, signature] of signatures.entries()) {
		const signaturePath = signatures.length > 1 ? [...path, `sig[${String(index)}]`] : path;

		for (const [parameterIndex, parameter] of signature.getParameters().entries()) {
			if (ancestors.has(parameter)) {
				continue;
			}

			const parameterType = symbolTypeOf(state.checker, parameter);

			if (parameterType !== null) {
				enqueueProjection(context, parameterType, {
					path: [...signaturePath, `param[${String(parameterIndex)}]`],
					depth: depth + 1,
					ancestors: new Set([...ancestors, parameter]),
				});
			}
		}

		const returnType = state.checker.getReturnTypeOfSignature(signature);

		if (returnType !== type) {
			enqueueProjection(context, returnType, {path: [...signaturePath, 'return'], depth: depth + 1});
		}
	}
};

const projectConstructSignatures = (context: TraversalContextType, type: ts.Type): void => {
	const {state, path, depth, ancestors} = context;
	const signatures = state.checker.getSignaturesOfType(type, ts.SignatureKind.Construct);

	for (const [index, signature] of signatures.entries()) {
		const instancePath = signatures.length > 1 ? [...path, 'construct', `sig[${String(index)}]`] : [...path, 'construct'];

		for (const [parameterIndex, parameter] of signature.getParameters().entries()) {
			if (ancestors.has(parameter)) {
				continue;
			}

			const parameterType = symbolTypeOf(state.checker, parameter);

			if (parameterType !== null) {
				enqueueProjection(context, parameterType, {
					path: [...instancePath, `param[${String(parameterIndex)}]`],
					depth: depth + 1,
					ancestors: new Set([...ancestors, parameter]),
				});
			}
		}

		const returnType = state.checker.getReturnTypeOfSignature(signature);

		if (returnType !== type) {
			enqueueProjection(context, returnType, {path: instancePath, depth: depth + 1});
		}
	}
};

const projectTuple = (context: TraversalContextType, type: ts.Type): void => {
	if (!isTypeReference(type)) {
		return;
	}

	for (const [index, element] of context.state.checker.getTypeArguments(type).entries()) {
		enqueueProjection(context, element, {path: [...context.path, `element[${String(index)}]`], depth: context.depth + 1});
	}
};

const projectArray = (context: TraversalContextType, type: ts.Type): void => {
	if (!isTypeReference(type)) {
		return;
	}

	const [element] = context.state.checker.getTypeArguments(type);

	if (element !== undefined) {
		enqueueProjection(context, element, {path: [...context.path, 'element'], depth: context.depth + 1});
	}
};

const processProjectionNode = (state: ProjectionStateType, node: ProjectionNodeType): void => {
	const {type, path, depth, rootDeclarations, ancestors} = node;
	addStep(state, 'projection');

	if (depth > MAX_PROJECTION_DEPTH) {
		state.depthLimited = true;
		markTypeReachable(state, type);
		return;
	}

	if (hasAnyFlag(type.flags, [ts.TypeFlags.Any, ts.TypeFlags.Unknown, ts.TypeFlags.Never, ts.TypeFlags.Void])) {
		return;
	}

	const context: TraversalContextType = {state, path, depth, rootDeclarations, ancestors};

	if (type.isUnionOrIntersection()) {
		markTypeReachable(state, type);
		return;
	}

	if (state.checker.isTupleType(type)) {
		projectTuple(context, type);
		return;
	}

	if (state.checker.isArrayType(type)) {
		projectArray(context, type);
		return;
	}

	const awaited = state.checker.getAwaitedType(type);

	if (awaited !== undefined && awaited !== type) {
		enqueueProjection(context, awaited, {path: [...path, 'awaited'], depth: depth + 1});
		return;
	}

	if (isExternalType(type, state.authoredPaths)) {
		return;
	}

	projectCallSignatures(context, type);
	projectConstructSignatures(context, type);

	if ((type.flags & ts.TypeFlags.Object) === 0) {
		return;
	}

	const named = namedSymbolOf(type, state.authoredPaths);

	if (depth > 0 && named !== null) {
		markSymbolReachable(state, named);
		return;
	}

	projectProperties(context, type, isAnonymousShape(type, state.authoredPaths));
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

export const projectType = (
	input: Readonly<{
		state: ProjectionStateType;
		type: ts.Type;
		path: readonly string[];
		depth: number;
		rootDeclarations: readonly ts.Node[];
		ancestors?: ReadonlySet<ts.Symbol>;
	}>,
): void => {
	const ancestors = input.ancestors ?? new Set<ts.Symbol>();

	enqueueProjection({state: input.state, path: input.path, depth: input.depth, rootDeclarations: input.rootDeclarations, ancestors}, input.type);
	drainProjection(input.state);
};
