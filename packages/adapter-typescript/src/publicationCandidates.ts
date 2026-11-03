import ts from 'typescript';
import {
	authoredOf,
	defaultTokenOf,
	definitionOf,
	externalAliasOf,
	isObjectLiteralMember,
	isStoredDeclaration,
	nameNodeOf,
	scopeOfNode,
} from './publicationAddress.ts';
import {declarationKindOf} from './occurrenceMetadata.ts';
import {
	type CandidateCollectionType,
	type CandidateDefinitionType,
	type CandidateInputType,
	type CandidateType,
	type DeferredCandidateType,
} from './publicationCandidateTypes.ts';
import {resolveCanonical} from './resolveSymbols.ts';

const keyForSymbol = (definition: CandidateDefinitionType): string => `symbol:${definition.path}:${String(definition.range.startOffset)}`;

type CandidateForInputType = Readonly<{
	input: CandidateInputType;
	canonical: ts.Symbol | null;
	key: string;
	name: string;
	kind: string;
	declaration: ts.Node;
	nameNode: ts.Node;
	external: Readonly<{target: string; name: string}> | null;
	synthetic: boolean;
}>;

const candidateFor = (candidate: CandidateForInputType): CandidateType => {
	const sourceFile = candidate.declaration.getSourceFile();
	const definition = definitionOf(candidate.input, candidate.declaration, candidate.nameNode);

	return {
		key: candidate.key,
		canonical: candidate.canonical,
		name: candidate.name,
		kind: candidate.kind,
		path: definition.path,
		sourceFile,
		scope: scopeOfNode(candidate.declaration, sourceFile, candidate.input.pathByAbsolute),
		definitions: [definition],
		primary: definition,
		externalTarget: candidate.external?.target ?? null,
		externalName: candidate.external?.name ?? null,
		synthetic: candidate.synthetic,
	};
};

type CollectorStateType = {
	readonly candidates: Map<string, CandidateType>;
	readonly symbolKeys: Map<ts.Symbol, string>;
	readonly declarationKeys: Map<ts.Node, string>;
	readonly deferred: Map<ts.Node, DeferredCandidateType>;
	readonly ephemeralKinds: Map<string, number>;
};

const addDefinition = (
	input: CandidateInputType,
	state: CollectorStateType,
	entry: Readonly<{canonical: ts.Symbol; declaration: ts.Node; nameNode: ts.Node}>,
): void => {
	const {canonical, declaration, nameNode} = entry;
	const definition = definitionOf(input, declaration, nameNode);
	const canonicalPaths = new Set((canonical.declarations ?? []).map((entryDeclaration) => entryDeclaration.getSourceFile().fileName));
	const aliasShadowed = !canonicalPaths.has(declaration.getSourceFile().fileName);

	if (aliasShadowed) {
		const key = `shadow:${definition.path}:${String(definition.range.startOffset)}`;

		state.candidates.set(
			key,
			candidateFor({
				input,
				canonical: null,
				key,
				name: canonical.getName(),
				kind: definition.kind,
				declaration,
				nameNode,
				external: null,
				synthetic: false,
			}),
		);
		state.declarationKeys.set(declaration, key);
		return;
	}

	const existingKey = state.symbolKeys.get(canonical);
	const existing = existingKey === undefined ? undefined : state.candidates.get(existingKey);

	if (existing === undefined) {
		const key = keyForSymbol(definition);
		const candidate = candidateFor({
			input,
			canonical,
			key,
			name: canonical.getName(),
			kind: definition.kind,
			declaration,
			nameNode,
			external: null,
			synthetic: false,
		});

		state.symbolKeys.set(canonical, key);
		state.candidates.set(key, candidate);
		state.declarationKeys.set(declaration, key);
		return;
	}

	const definitions = [...existing.definitions, definition].sort(
		(left, right) => left.path.localeCompare(right.path) || left.range.startOffset - right.range.startOffset,
	);
	const [primary] = definitions;

	if (primary !== undefined) {
		state.candidates.set(existing.key, {...existing, definitions, primary});
		state.declarationKeys.set(declaration, existing.key);
	}
};

const syntheticDefaultOf = (input: CandidateInputType, node: ts.Node): CandidateType | null => {
	if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name === undefined) {
		const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
		const hasDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

		if (!hasDefault) {
			return null;
		}

		const sourceFile = node.getSourceFile();
		const defaultToken = defaultTokenOf(sourceFile, node);

		if (defaultToken === null) {
			return null;
		}

		const definition = definitionOf(input, node, defaultToken);
		const key = `synthetic:${definition.path}:${String(definition.range.startOffset)}`;

		return candidateFor({
			input,
			canonical: null,
			key,
			name: 'default',
			kind: ts.isFunctionDeclaration(node) ? 'function' : 'class',
			declaration: node,
			nameNode: defaultToken,
			external: null,
			synthetic: true,
		});
	}

	if (!ts.isExportAssignment(node) || node.isExportEquals === true || ts.isIdentifier(node.expression)) {
		return null;
	}

	const sourceFile = node.getSourceFile();
	const defaultToken = defaultTokenOf(sourceFile, node);

	if (defaultToken === null) {
		return null;
	}

	const definition = definitionOf(input, node, defaultToken);
	const key = `synthetic:${definition.path}:${String(definition.range.startOffset)}`;

	return candidateFor({
		input,
		canonical: null,
		key,
		name: 'default',
		kind: 'variable',
		declaration: node,
		nameNode: defaultToken,
		external: null,
		synthetic: true,
	});
};

const collectDeferredMember = (input: CandidateInputType, state: CollectorStateType, node: ts.Node): boolean => {
	if (!isObjectLiteralMember(node)) {
		return false;
	}

	const sourceFile = node.getSourceFile();
	const pathName = input.pathByAbsolute.get(sourceFile.fileName);
	const nameNode = nameNodeOf(node);
	const canonical = nameNode === undefined ? undefined : input.checker.getSymbolAtLocation(nameNode);

	if (nameNode !== undefined && canonical !== undefined && pathName !== undefined && !canonical.getName().startsWith('__computed')) {
		state.deferred.set(node, {
			canonical,
			declaration: node,
			nameNode,
			kind: declarationKindOf(node),
			path: pathName,
			sourceFile,
			scope: scopeOfNode(node, sourceFile, input.pathByAbsolute),
		});
	}

	return true;
};

type NamespaceExportInputType = Readonly<{
	input: CandidateInputType;
	state: CollectorStateType;
	sourceFile: ts.SourceFile;
	node: ts.Node;
	nameNode: ts.Node;
	target: ts.Symbol;
	direct: ts.Symbol;
}>;

const addAuthoredNamespaceExport = ({input, state, sourceFile, node, nameNode, target, direct}: NamespaceExportInputType): void => {
	if ((target.flags & ts.SymbolFlags.ValueModule) === 0) {
		return;
	}

	const definition = definitionOf(input, node, nameNode);
	const key = `namespace:${definition.path}:${String(definition.range.startOffset)}`;

	state.candidates.set(
		key,
		candidateFor({
			input,
			canonical: direct,
			key,
			name: nameNode.getText(sourceFile),
			kind: 'namespace',
			declaration: node,
			nameNode,
			external: null,
			synthetic: false,
		}),
	);
	state.declarationKeys.set(node, key);
};

type ExternalAliasInputType = Readonly<{
	input: CandidateInputType;
	state: CollectorStateType;
	node: ts.Node;
	nameNode: ts.Node;
	resolved: ts.Symbol;
	direct: ts.Symbol;
}>;

const addExternalAliasCandidate = ({input, state, node, nameNode, resolved, direct}: ExternalAliasInputType): void => {
	const sourceFile = node.getSourceFile();
	const external = externalAliasOf(node, resolved, sourceFile);

	if (external === null) {
		return;
	}

	const definition = definitionOf(input, node, nameNode);
	const key = `external:${definition.path}:${String(definition.range.startOffset)}`;

	state.candidates.set(
		key,
		candidateFor({input, canonical: direct, key, name: nameNode.getText(sourceFile), kind: 'alias', declaration: node, nameNode, external, synthetic: false}),
	);
	state.declarationKeys.set(node, key);
};

const isDynamicComputedName = (nameNode: ts.Node, resolved: ts.Symbol): boolean =>
	ts.isComputedPropertyName(nameNode) && resolved.getName().startsWith('__computed');

type AuthoredCandidateInputType = Readonly<{
	input: CandidateInputType;
	state: CollectorStateType;
	sourceFile: ts.SourceFile;
	node: ts.Node;
	nameNode: ts.Node;
	resolved: ts.Symbol;
	direct: ts.Symbol | undefined;
}>;

const collectAuthoredCandidate = ({input, state, sourceFile, node, nameNode, resolved, direct}: AuthoredCandidateInputType): void => {
	if (!ts.isExportSpecifier(node) && !ts.isNamespaceExport(node)) {
		addDefinition(input, state, {canonical: resolved, declaration: node, nameNode});
		return;
	}

	// An authored namespace imported and re-exported as one binding has a
	// module symbol as its alias target. The module file is not a candidate,
	// so bind the export clause itself as the namespace root.
	if (direct !== undefined) {
		addAuthoredNamespaceExport({input, state, sourceFile, node, nameNode, target: resolved, direct});
	}
};

const collectNamedCandidate = (input: CandidateInputType, state: CollectorStateType, sourceFile: ts.SourceFile, node: ts.Node): void => {
	const nameNode = nameNodeOf(node);
	const eligible = nameNode !== undefined && (isStoredDeclaration(node) || ts.isExportSpecifier(node) || ts.isNamespaceExport(node));

	if (nameNode === undefined) {
		return;
	}

	if (!eligible) {
		const kind = declarationKindOf(node);
		state.ephemeralKinds.set(kind, (state.ephemeralKinds.get(kind) ?? 0) + 1);
		return;
	}

	const direct = input.checker.getSymbolAtLocation(nameNode);
	const resolved = resolveCanonical(input.checker, nameNode);

	if (resolved === undefined) {
		return;
	}

	if (isDynamicComputedName(nameNode, resolved)) {
		return;
	}

	if (authoredOf(resolved, input.authoredPaths).length > 0) {
		collectAuthoredCandidate({input, state, sourceFile, node, nameNode, resolved, direct});
		return;
	}

	if ((!ts.isExportSpecifier(node) && !ts.isNamespaceExport(node)) || direct === undefined) {
		return;
	}

	addExternalAliasCandidate({input, state, node, nameNode, resolved, direct});
};

const collectFile = (input: CandidateInputType, file: {readonly path: string; readonly absolutePath: string}, state: CollectorStateType): void => {
	const sourceFile = input.program.getSourceFile(file.absolutePath);

	if (sourceFile === undefined) {
		return;
	}

	const visit = (node: ts.Node): void => {
		if (collectDeferredMember(input, state, node)) {
			ts.forEachChild(node, visit);
			return;
		}

		const synthetic = syntheticDefaultOf(input, node);

		if (synthetic !== null) {
			state.candidates.set(synthetic.key, synthetic);
			state.declarationKeys.set(synthetic.primary.declaration, synthetic.key);
		}

		collectNamedCandidate(input, state, sourceFile, node);
		ts.forEachChild(node, visit);
	};

	ts.forEachChild(sourceFile, visit);
};

const collectExternalDefaultAliases = (input: CandidateInputType, state: CollectorStateType): void => {
	for (const file of input.files) {
		const sourceFile = input.program.getSourceFile(file.absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		for (const statement of sourceFile.statements) {
			if (!ts.isExportAssignment(statement) || statement.isExportEquals === true || !ts.isIdentifier(statement.expression)) {
				continue;
			}

			const target = resolveCanonical(input.checker, statement.expression);

			if (target === undefined || authoredOf(target, input.authoredPaths).length > 0) {
				continue;
			}

			const external = externalAliasOf(statement, target, sourceFile);
			const defaultToken = defaultTokenOf(sourceFile, statement);

			if (external !== null && defaultToken !== null) {
				const definition = definitionOf(input, statement, defaultToken);
				const key = `external-default:${definition.path}:${String(definition.range.startOffset)}`;

				state.candidates.set(
					key,
					candidateFor({
						input,
						canonical: target,
						key,
						name: 'default',
						kind: 'alias',
						declaration: statement,
						nameNode: defaultToken,
						external,
						synthetic: true,
					}),
				);
				state.declarationKeys.set(statement, key);
			}
		}
	}
};

/**
 * Collects authored stored declarations and deferred projected members.
 *
 * Named declarations, top-level variables, and stored members become symbol
 * candidates. Object-literal members stay deferred until projection or
 * reachability proves that a consumer can observe them.
 *
 * @param input - Compiler program, authored files, and path mapping.
 * @returns Candidate symbols and deferred member records.
 */
export const collectTypeScriptCandidates = (input: CandidateInputType): CandidateCollectionType => {
	const state: CollectorStateType = {
		candidates: new Map(),
		symbolKeys: new Map(),
		declarationKeys: new Map(),
		deferred: new Map(),
		ephemeralKinds: new Map(),
	};

	for (const file of input.files) {
		collectFile(input, file, state);
	}

	collectExternalDefaultAliases(input, state);

	let externalAliases = 0;
	let externalStars = 0;
	let mergedDeclarationCount = 0;

	for (const candidate of state.candidates.values()) {
		if (candidate.externalTarget !== null) {
			externalAliases += 1;
		}

		if (candidate.definitions.length > 1) {
			mergedDeclarationCount += 1;
		}
	}

	for (const file of input.files) {
		const sourceFile = input.program.getSourceFile(file.absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		for (const statement of sourceFile.statements) {
			if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || statement.exportClause !== undefined) {
				continue;
			}

			const target = input.checker.getSymbolAtLocation(statement.moduleSpecifier);

			if (target !== undefined && authoredOf(target, input.authoredPaths).length === 0) {
				externalStars += 1;
			}
		}
	}

	return {
		candidates: state.candidates,
		symbolKeys: state.symbolKeys,
		declarationKeys: state.declarationKeys,
		deferred: state.deferred,
		ephemeralKinds: state.ephemeralKinds,
		externalAliases,
		externalStars,
		mergedDeclarationCount,
	};
};
