import ts from 'typescript';
import {
	addDeclaration,
	authoredDeclarationsOf,
	declaredTypeOf,
	enqueueSymbol,
	enqueueType,
	hasSymbolFlag,
	hasTypeFlag,
	isClassOrInterfaceType,
	isExternalSymbol,
	isExternalType,
	isPrivateSymbol,
	isTypeReference,
	MAX_TRUTH_DEPTH,
	namedSymbolOf,
	resolveAlias,
	symbolTypeOf,
	type TruthStateType,
} from './reachabilityTruthSupport.ts';

const drainSymbol = (state: TruthStateType, symbol: ts.Symbol): void => {
	const type = hasSymbolFlag(symbol, [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias, ts.SymbolFlags.Enum])
		? declaredTypeOf(state.checker, symbol)
		: symbolTypeOf(state.checker, symbol);

	if (type !== null) {
		enqueueType(state, type);
	}
};

const enqueueTypeArguments = (state: TruthStateType, type: ts.Type): void => {
	if (isTypeReference(type) && (type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
		for (const argument of state.checker.getTypeArguments(type)) {
			enqueueType(state, argument);
		}
	}
};

const drainType = (state: TruthStateType, type: ts.Type): void => {
	if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
		return;
	}

	if (isExternalType(type, state.authoredPaths)) {
		enqueueTypeArguments(state, type);
		return;
	}

	if (type.isUnionOrIntersection()) {
		for (const constituent of type.types) {
			enqueueType(state, constituent);
		}

		return;
	}

	enqueueTypeArguments(state, type);

	const named = namedSymbolOf(type, state.authoredPaths);

	if (named !== null) {
		enqueueSymbol(state, named);
	}

	if (isClassOrInterfaceType(type)) {
		for (const base of state.checker.getBaseTypes(type)) {
			enqueueType(state, base);
		}
	}

	for (const property of state.checker.getPropertiesOfType(type)) {
		enqueueSymbol(state, property);
	}

	for (const index of state.checker.getIndexInfosOfType(type)) {
		enqueueType(state, index.type);
	}
};

const drainReachability = (state: TruthStateType): void => {
	for (;;) {
		const symbol = state.pendingSymbols.pop();

		if (symbol !== undefined) {
			drainSymbol(state, symbol);
			continue;
		}

		const type = state.pendingTypes.pop();

		if (type === undefined) {
			return;
		}

		drainType(state, type);
	}
};

const markSymbolReachable = (state: TruthStateType, symbol: ts.Symbol): void => {
	enqueueSymbol(state, symbol);
	drainReachability(state);
};

type ProjectTypeFnType = (state: TruthStateType, type: ts.Type, depth: number) => void;

type SignatureProjectionInputType = Readonly<{
	state: TruthStateType;
	type: ts.Type;
	depth: number;
	kind: ts.SignatureKind;
	project: ProjectTypeFnType;
}>;

const projectSignatureList = ({state, type, depth, kind, project}: SignatureProjectionInputType): void => {
	for (const signature of state.checker.getSignaturesOfType(type, kind)) {
		for (const parameter of signature.getParameters()) {
			if (isPrivateSymbol(parameter)) {
				continue;
			}

			const parameterType = symbolTypeOf(state.checker, parameter);

			if (parameterType !== null) {
				project(state, parameterType, depth + 1);
			}
		}

		const returnType = state.checker.getReturnTypeOfSignature(signature);

		if (returnType !== type) {
			project(state, returnType, depth + 1);
		}
	}
};

const projectProperties = (state: TruthStateType, type: ts.Type, depth: number, project: ProjectTypeFnType): void => {
	for (const property of state.checker.getPropertiesOfType(type)) {
		if (isPrivateSymbol(property) || isExternalSymbol(property, state.authoredPaths)) {
			continue;
		}

		markSymbolReachable(state, property);
		const propertyType = symbolTypeOf(state.checker, property);

		if (propertyType !== null) {
			project(state, propertyType, depth + 1);
		}
	}
};

const projectObjectType = (state: TruthStateType, type: ts.Type, depth: number, project: ProjectTypeFnType): void => {
	const named = namedSymbolOf(type, state.authoredPaths);

	if (depth > 0 && named !== null) {
		markSymbolReachable(state, named);
		return;
	}

	projectProperties(state, type, depth, project);
};

const projectTuple = (state: TruthStateType, type: ts.Type, depth: number, project: ProjectTypeFnType): void => {
	if (isTypeReference(type)) {
		for (const element of state.checker.getTypeArguments(type)) {
			project(state, element, depth + 1);
		}
	}
};

const projectArray = (state: TruthStateType, type: ts.Type, depth: number, project: ProjectTypeFnType): void => {
	if (!isTypeReference(type)) {
		return;
	}

	const [element] = state.checker.getTypeArguments(type);

	if (element !== undefined) {
		project(state, element, depth + 1);
	}
};

const projectType: ProjectTypeFnType = (state, type, depth) => {
	state.addresses += 1;

	if (depth > MAX_TRUTH_DEPTH) {
		enqueueType(state, type);
		drainReachability(state);
		return;
	}

	if (hasTypeFlag(type.flags, [ts.TypeFlags.Any, ts.TypeFlags.Unknown, ts.TypeFlags.Never, ts.TypeFlags.Void, ts.TypeFlags.TypeParameter])) {
		return;
	}

	if (type.isUnionOrIntersection()) {
		enqueueType(state, type);
		drainReachability(state);
		return;
	}

	if (state.checker.isTupleType(type)) {
		projectTuple(state, type, depth, projectType);
		return;
	}

	if (state.checker.isArrayType(type)) {
		projectArray(state, type, depth, projectType);
		return;
	}

	const awaited = state.checker.getAwaitedType(type);

	if (awaited !== undefined && awaited !== type) {
		projectType(state, awaited, depth + 1);
		return;
	}

	if (isExternalType(type, state.authoredPaths)) {
		return;
	}

	projectSignatureList({state, type, depth, kind: ts.SignatureKind.Call, project: projectType});
	projectSignatureList({state, type, depth, kind: ts.SignatureKind.Construct, project: projectType});

	if ((type.flags & ts.TypeFlags.Object) !== 0) {
		projectObjectType(state, type, depth, projectType);
	}
};

const addNamespace = (state: TruthStateType, symbol: ts.Symbol): void => {
	for (const exported of state.checker.getExportsOfModule(symbol)) {
		if (isPrivateSymbol(exported) || isExternalSymbol(exported, state.authoredPaths)) {
			continue;
		}

		markSymbolReachable(state, exported);

		if ((exported.flags & ts.SymbolFlags.Namespace) !== 0) {
			addNamespace(state, exported);
		}
	}
};

const addEnum = (state: TruthStateType, symbol: ts.Symbol): void => {
	for (const declaration of authoredDeclarationsOf(symbol, state.authoredPaths)) {
		if (!ts.isEnumDeclaration(declaration)) {
			continue;
		}

		for (const member of declaration.members) {
			const memberSymbol = state.checker.getSymbolAtLocation(member.name);

			if (memberSymbol !== undefined) {
				markSymbolReachable(state, memberSymbol);
			}
		}
	}
};

const projectRootType = (state: TruthStateType, symbol: ts.Symbol): void => {
	const type = hasSymbolFlag(symbol, [ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias])
		? declaredTypeOf(state.checker, symbol)
		: symbolTypeOf(state.checker, symbol);

	if (type !== null) {
		projectType(state, type, 0);
	}

	if ((symbol.flags & ts.SymbolFlags.Class) === 0) {
		return;
	}

	const staticType = symbolTypeOf(state.checker, symbol);

	if (staticType !== null) {
		projectType(state, staticType, 0);
	}
};

const addRoot = (state: TruthStateType, symbol: ts.Symbol): void => {
	const target = resolveAlias(state.checker, symbol);

	state.roots += 1;

	if (symbol !== target) {
		addDeclaration(state, symbol);
	}

	if (isExternalSymbol(target, state.authoredPaths)) {
		state.addresses += 1;
		addDeclaration(state, symbol);
		return;
	}

	const moduleOnly = (target.declarations ?? []).every((declaration) => ts.isSourceFile(declaration));

	if ((target.flags & ts.SymbolFlags.ValueModule) !== 0 && moduleOnly) {
		state.addresses += 1;
		addDeclaration(state, symbol);
		addNamespace(state, target);
		return;
	}

	markSymbolReachable(state, target);

	const isEnum = (target.flags & ts.SymbolFlags.Enum) !== 0;
	const isNamespace = (target.flags & ts.SymbolFlags.Namespace) !== 0;

	if (isEnum) {
		addEnum(state, target);
	}

	if (isNamespace) {
		addNamespace(state, target);
	}

	if (!isEnum && !isNamespace) {
		projectRootType(state, target);
	}
};

const addModuleRoots = (state: TruthStateType, sourceFile: ts.SourceFile): void => {
	const moduleSymbol = state.checker.getSymbolAtLocation(sourceFile);

	for (const exported of moduleSymbol === undefined ? [] : state.checker.getExportsOfModule(moduleSymbol)) {
		addRoot(state, exported);
	}
};

const topLevelSymbolsOf = (state: TruthStateType, sourceFile: ts.SourceFile): readonly ts.Symbol[] => {
	const symbols: ts.Symbol[] = [];

	for (const statement of sourceFile.statements) {
		const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : ts.isDeclarationStatement(statement) ? [statement] : [];

		for (const declaration of declarations) {
			const name = ts.getNameOfDeclaration(declaration);
			const symbol = name === undefined ? undefined : state.checker.getSymbolAtLocation(name);

			if (symbol !== undefined) {
				symbols.push(symbol);
			}
		}
	}

	return symbols;
};

const addScriptRoots = (state: TruthStateType, sourceFile: ts.SourceFile): void => {
	for (const symbol of topLevelSymbolsOf(state, sourceFile)) {
		addRoot(state, symbol);
	}
};

export const addProgramRoots = (state: TruthStateType, program: ts.Program): void => {
	for (const sourceFile of program.getSourceFiles()) {
		if (!state.authoredPaths.has(sourceFile.fileName) || sourceFile.isDeclarationFile) {
			continue;
		}

		if (ts.isExternalModule(sourceFile)) {
			addModuleRoots(state, sourceFile);
		} else {
			addScriptRoots(state, sourceFile);
		}
	}
};
