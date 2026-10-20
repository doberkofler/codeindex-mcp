import ts from 'typescript';
import {type ConfigType} from '../../config/config.ts';
import {loadTypeScriptProject} from '../../../adapters/typescript/loadProject.ts';
import {
	addAddress,
	authoredDeclarationsOf,
	createProjectionState,
	declaredTypeOf,
	isExternalSymbol,
	type ProjectionBudgetType,
	type ProjectionStateType,
	ProjectionBudgetError,
	resolveAlias,
	type RootResultType,
	symbolTypeOf,
} from './projectionModel.ts';
import {markSymbolReachable, projectPropertiesAtRoot, projectType} from './projectionTraversal.ts';

const isTypeLikeSymbol = (symbol: ts.Symbol): boolean =>
	[ts.SymbolFlags.Class, ts.SymbolFlags.Interface, ts.SymbolFlags.TypeAlias].some((flag) => (symbol.flags & flag) !== 0);

const rootSymbolsOf = (checker: ts.TypeChecker, sourceFile: ts.SourceFile): readonly ts.Symbol[] => {
	if (ts.isExternalModule(sourceFile)) {
		const moduleSymbol = checker.getSymbolAtLocation(sourceFile);

		return moduleSymbol === undefined ? [] : [...checker.getExportsOfModule(moduleSymbol)];
	}

	const symbols: ts.Symbol[] = [];

	for (const statement of sourceFile.statements) {
		const {name} = statement as ts.Node & {readonly name?: ts.Node};

		if (name !== undefined) {
			const symbol = checker.getSymbolAtLocation(name);

			if (symbol !== undefined) {
				symbols.push(symbol);
			}
		}
	}

	return symbols;
};

const expandNamespace = (state: ProjectionStateType, symbol: ts.Symbol, path: readonly string[]): void => {
	for (const exported of state.checker.getExportsOfModule(symbol)) {
		if (isExternalSymbol(exported, state.authoredPaths)) {
			continue;
		}

		const childPath = [...path, exported.getName()];
		addAddress(state, childPath, exported, {anonymous: false, inherited: false, depthOne: childPath.length === path.length + 1});
		markSymbolReachable(state, exported);

		if ((exported.flags & ts.SymbolFlags.Namespace) !== 0) {
			expandNamespace(state, exported, childPath);
		}
	}
};

const expandEnum = (state: ProjectionStateType, symbol: ts.Symbol, rootName: string): void => {
	for (const declaration of authoredDeclarationsOf(symbol, state.authoredPaths)) {
		if (ts.isEnumDeclaration(declaration)) {
			for (const member of declaration.members) {
				const memberSymbol = state.checker.getSymbolAtLocation(member.name);

				if (memberSymbol !== undefined) {
					addAddress(state, [rootName, member.name.getText()], memberSymbol, {anonymous: false, inherited: false, depthOne: true});
				}
			}
		}
	}
};

const projectRoot = (state: ProjectionStateType, exported: ts.Symbol, rootName: string): void => {
	const target = resolveAlias(state.checker, exported);

	if (isExternalSymbol(target, state.authoredPaths)) {
		addAddress(state, [rootName], exported, {anonymous: false, inherited: false, depthOne: false});
		return;
	}

	const declarations = authoredDeclarationsOf(target, state.authoredPaths);
	addAddress(state, [rootName], target, {anonymous: false, inherited: false, depthOne: false});

	if ((target.flags & ts.SymbolFlags.Enum) !== 0) {
		expandEnum(state, target, rootName);
		return;
	}

	if ((target.flags & ts.SymbolFlags.Namespace) !== 0) {
		expandNamespace(state, target, [rootName]);
		return;
	}

	const type = isTypeLikeSymbol(target) ? declaredTypeOf(state.checker, target) : symbolTypeOf(state.checker, target);

	if (type !== null) {
		projectType({state, type, path: [rootName], depth: 0, rootDeclarations: declarations, ancestors: new Set([target])});
	}

	if ((target.flags & ts.SymbolFlags.Class) !== 0) {
		const staticType = symbolTypeOf(state.checker, target);

		if (staticType !== null) {
			projectPropertiesAtRoot({state, type: staticType, rootName, rootDeclarations: declarations, ancestors: new Set([target])});
		}
	}
};

export const projectContext = (
	input: Readonly<{
		config: ConfigType;
		context: ConfigType['projects'][number];
		authoredPaths: ReadonlySet<string>;
		pathByAbsolute: ReadonlyMap<string, string>;
		budget: ProjectionBudgetType;
	}>,
): readonly RootResultType[] => {
	const project = loadTypeScriptProject(input.config, input.context.projectFilePath);
	const results: RootResultType[] = [];

	for (const sourceFile of project.program.getSourceFiles()) {
		if (sourceFile.isDeclarationFile || !input.authoredPaths.has(sourceFile.fileName)) {
			continue;
		}

		for (const exported of rootSymbolsOf(project.checker, sourceFile)) {
			const state = createProjectionState(project.checker, input.authoredPaths, input.pathByAbsolute, input.budget);

			try {
				projectRoot(state, exported, exported.getName());
			} catch (error) {
				if (!(error instanceof ProjectionBudgetError)) {
					throw error;
				}

				state.exceeded = true;
			}

			results.push({addresses: state.addresses, steps: state.steps, exceeded: state.exceeded, depthLimited: state.depthLimited});
		}
	}

	return results;
};
