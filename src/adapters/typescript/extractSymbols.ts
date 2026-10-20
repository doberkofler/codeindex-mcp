import ts from 'typescript';
import {type ExtractedOccurrenceType, type ExtractedPublicationFactsType} from '../../core/facts/index.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {type ExtractionResultType, type IndexedSymbolType, type SourceFileType} from '../../core/model.ts';
import {type LoadedProjectType} from './loadProject.ts';
import {declarationKindOf, definitionMetadataOf} from './occurrenceMetadata.ts';
import {createTypeScriptPublicationFacts} from './publicationFacts.ts';
import {isPublishedCandidate} from './publicationScope.ts';
import {resolveCanonical, resolveImmediateAliasSymbol, resolveOccurrenceSymbol} from './resolveSymbols.ts';
import {createSymbolId} from './symbolIdentity.ts';

const debug = debugFor('extract');

type CandidateType = Readonly<{
	readonly canonical: ts.Symbol;
	readonly name: string;
	readonly kind: string;
	readonly path: string;
	readonly sourceFile: ts.SourceFile;
	readonly declaration: ts.Node;
	readonly nameNode: ts.Identifier;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly scope: 'module' | 'global';
	readonly published: boolean;
}>;

/** Symbol facts with the preliminary publication facts for one context. */
export type TypeScriptSymbolFactsType = ExtractionResultType &
	Readonly<{
		readonly publication: ExtractedPublicationFactsType;
	}>;

type ExtractionInputType = Readonly<{
	readonly project: LoadedProjectType;
	readonly files: readonly SourceFileType[];
	readonly projectId: string;
	readonly rootDir: string;
	readonly context: string;
}>;

const DEFINITION_DECLARATIONS: readonly ((node: ts.Node) => boolean)[] = [
	ts.isFunctionDeclaration,
	ts.isClassDeclaration,
	ts.isInterfaceDeclaration,
	ts.isTypeAliasDeclaration,
	ts.isEnumDeclaration,
	ts.isEnumMember,
	ts.isModuleDeclaration,
	ts.isMethodDeclaration,
	ts.isMethodSignature,
	ts.isPropertyDeclaration,
	ts.isPropertySignature,
	ts.isGetAccessorDeclaration,
	ts.isSetAccessorDeclaration,
];

const isNode = (value: unknown): value is ts.Node => typeof value === 'object' && value !== null && 'kind' in value && typeof value['kind'] === 'number';

const declarationName = (node: ts.Node): ts.Identifier | undefined => {
	if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
		return ts.isIdentifier(node.name) ? node.name : undefined;
	}

	if (!DEFINITION_DECLARATIONS.some((predicate) => predicate(node))) {
		return undefined;
	}

	if (!('name' in node)) {
		return undefined;
	}

	const {name} = node;

	if (name === null || name === undefined || !isNode(name) || !ts.isIdentifier(name)) {
		return undefined;
	}

	return name;
};

/**
 * Returns the identifier the extractor treats as a candidate declaration name.
 *
 * Variable and binding declarations use their bound identifier; export
 * specifiers expose the authored export alias. Every other candidate must be a
 * supported named declaration.
 *
 * @param node - Candidate declaration node.
 * @returns The candidate name node, or undefined when the node is not a candidate.
 */
export const candidateNameNode = (node: ts.Node): ts.Identifier | undefined =>
	declarationName(node) ?? (ts.isExportSpecifier(node) && ts.isIdentifier(node.name) ? node.name : undefined);

const hasAuthoredDeclaration = (symbol: ts.Symbol, authoredPaths: ReadonlySet<string>): boolean =>
	(symbol.declarations ?? []).some((declaration) => authoredPaths.has(declaration.getSourceFile().fileName));

const walkSourceFile = (sourceFile: ts.SourceFile, visitor: (node: ts.Node) => void): void => {
	const visit = (node: ts.Node): void => {
		visitor(node);
		ts.forEachChild(node, visit);
	};

	ts.forEachChild(sourceFile, visit);
};

const collectCandidates = (input: ExtractionInputType, authoredPaths: ReadonlySet<string>): readonly CandidateType[] => {
	const {checker} = input.project;
	const candidates: CandidateType[] = [];

	for (const file of input.files) {
		const sourceFile = input.project.program.getSourceFile(file.absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		const scope: 'module' | 'global' = ts.isExternalModule(sourceFile) ? 'module' : 'global';

		walkSourceFile(sourceFile, (node) => {
			const nameNode = candidateNameNode(node);

			if (nameNode === undefined) {
				return;
			}

			const resolved = resolveCanonical(checker, nameNode);

			if (resolved === undefined) {
				return;
			}

			const canonical = hasAuthoredDeclaration(resolved, authoredPaths)
				? resolved
				: ts.isExportSpecifier(node)
					? checker.getSymbolAtLocation(nameNode)
					: undefined;

			if (canonical === undefined || !hasAuthoredDeclaration(canonical, authoredPaths)) {
				return;
			}

			// Internal re-exports continue to resolve to their canonical authored
			// declaration. Preserve the authored export alias only when its target is
			// external and therefore intentionally absent from the index.
			if (ts.isExportSpecifier(node) && canonical === resolved) {
				return;
			}

			candidates.push({
				canonical,
				name: canonical.getName(),
				kind: declarationKindOf(node),
				path: file.path,
				sourceFile,
				declaration: node,
				nameNode,
				startOffset: node.getStart(sourceFile),
				endOffset: node.end,
				scope,
				published: isPublishedCandidate(node, scope),
			});
		});
	}

	return candidates;
};

const selectPrimaryCandidates = (candidates: readonly CandidateType[]): ReadonlyMap<ts.Symbol, CandidateType> => {
	const primaries = new Map<ts.Symbol, CandidateType>();

	for (const candidate of candidates) {
		const existing = primaries.get(candidate.canonical);

		if (existing === undefined || candidate.path < existing.path || (candidate.path === existing.path && candidate.startOffset < existing.startOffset)) {
			primaries.set(candidate.canonical, candidate);
		}
	}

	return primaries;
};

const buildQualifiedName = (checker: ts.TypeChecker, symbol: ts.Symbol, primaryName: string): string => {
	const fullyQualifiedName = checker.getFullyQualifiedName(symbol);
	const withoutModule = fullyQualifiedName.replace(/^"[^"]*"\./u, '').replace(/^"[^"]*"$/u, '');

	return withoutModule.length > 0 ? withoutModule : primaryName;
};

const toIndexedSymbol = (checker: ts.TypeChecker, primary: CandidateType, projectId: string, context: string): IndexedSymbolType => {
	const {sourceFile} = primary;
	const start = sourceFile.getLineAndCharacterOfPosition(primary.startOffset);
	const end = sourceFile.getLineAndCharacterOfPosition(primary.endOffset);

	return {
		id: createSymbolId({
			projectId,
			path: primary.path,
			startOffset: primary.startOffset,
			kind: primary.kind,
			name: primary.name,
		}),
		name: primary.name,
		qualifiedName: buildQualifiedName(checker, primary.canonical, primary.name),
		kind: primary.kind,
		path: primary.path,
		startLine: start.line + 1,
		startColumn: start.character + 1,
		endLine: end.line + 1,
		endColumn: end.character + 1,
		startOffset: primary.startOffset,
		endOffset: primary.endOffset,
		enclosingId: null,
		contexts: [context],
	};
};

const isDefinitionNameNode = (node: ts.Identifier): boolean => {
	const {parent} = node;

	if (
		ts.isImportSpecifier(parent) ||
		ts.isExportSpecifier(parent) ||
		ts.isImportClause(parent) ||
		ts.isNamespaceImport(parent) ||
		ts.isImportEqualsDeclaration(parent)
	) {
		return false;
	}

	if (ts.isBindingElement(parent)) {
		return parent.name === node;
	}

	return declarationName(parent) === node;
};

type CollectedOccurrencesType = Readonly<{
	occurrences: ExtractedOccurrenceType[];
	enclosingBySymbol: ReadonlyMap<string, string>;
	deduplicatedOccurrences: number;
}>;

const definitionInAliasChain = (
	checker: ts.TypeChecker,
	definitions: ReadonlyMap<ts.Symbol, IndexedSymbolType>,
	symbol: ts.Symbol | undefined,
): IndexedSymbolType | undefined => {
	const seen = new Set<ts.Symbol>();
	let current = symbol;

	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		const definition = definitions.get(current);

		if (definition !== undefined) {
			return definition;
		}

		current = resolveImmediateAliasSymbol(checker, current);
	}

	return undefined;
};

const symbolForCanonical = (
	canonical: ts.Symbol | undefined,
	definitions: ReadonlyMap<ts.Symbol, IndexedSymbolType>,
	declarationNodes: ReadonlyMap<ts.Node, IndexedSymbolType>,
): IndexedSymbolType | undefined => {
	if (canonical === undefined) {
		return undefined;
	}

	const direct = definitions.get(canonical);

	if (direct !== undefined) {
		return direct;
	}

	for (const declaration of canonical.declarations ?? []) {
		const mapped = declarationNodes.get(declaration);

		if (mapped !== undefined) {
			return mapped;
		}
	}

	return undefined;
};

const resolvedDefinitionOf = (
	checker: ts.TypeChecker,
	node: ts.Identifier,
	definitions: ReadonlyMap<ts.Symbol, IndexedSymbolType>,
	declarationNodes: ReadonlyMap<ts.Node, IndexedSymbolType>,
): IndexedSymbolType | undefined => {
	const direct = definitionInAliasChain(checker, definitions, checker.getSymbolAtLocation(node));

	if (direct !== undefined) {
		return direct;
	}

	let canonical = resolveOccurrenceSymbol(checker, node);

	if (symbolForCanonical(canonical, definitions, declarationNodes) === undefined) {
		canonical = resolveCanonical(checker, node);
	}

	return symbolForCanonical(canonical, definitions, declarationNodes);
};

const occurrenceOwnerOf = (
	input: Readonly<{
		role: 'definition' | 'reference';
		declaredDefinition: IndexedSymbolType | undefined;
		enclosingId: string | null;
		nextEnclosingId: string | null;
		enclosingBySymbol: ReadonlyMap<string, string>;
	}>,
): string | null => {
	if (input.role === 'reference') {
		return input.nextEnclosingId;
	}

	return input.declaredDefinition === undefined ? input.enclosingId : (input.enclosingBySymbol.get(input.declaredDefinition.id) ?? null);
};

type OccurrenceCollectInputType = ExtractionInputType &
	Readonly<{
		checker: ts.TypeChecker;
		definitions: ReadonlyMap<ts.Symbol, IndexedSymbolType>;
		declarationNodes: ReadonlyMap<ts.Node, IndexedSymbolType>;
		primaryDeclarationNodes: ReadonlyMap<ts.Node, IndexedSymbolType>;
	}>;

const collectOccurrences = (input: OccurrenceCollectInputType): CollectedOccurrencesType => {
	const {checker, definitions, declarationNodes, primaryDeclarationNodes} = input;
	const occurrences: ExtractedOccurrenceType[] = [];
	const enclosingBySymbol = new Map<string, string>();
	const contexts = [input.context];

	for (const file of input.files) {
		const sourceFile = input.project.program.getSourceFile(file.absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		// Occurrence coordinates are unique within one file, so deduplication
		// state stays bounded instead of retaining a workspace-wide key set.
		const seenOccurrences = new Set<string>();
		const visit = (node: ts.Node, enclosingId: string | null): void => {
			const declarationSymbol = declarationNodes.get(node);
			const primarySymbol = primaryDeclarationNodes.get(node);
			const nextEnclosingId = declarationSymbol?.id ?? enclosingId;

			if (primarySymbol !== undefined && enclosingId !== null) {
				enclosingBySymbol.set(primarySymbol.id, enclosingId);
			}

			if (ts.isIdentifier(node)) {
				const definition = resolvedDefinitionOf(checker, node, definitions, declarationNodes);

				if (definition !== undefined) {
					const declaredDefinition = declarationNodes.get(node.parent);
					const role = declaredDefinition?.id === definition.id || isDefinitionNameNode(node) ? 'definition' : 'reference';
					const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
					const end = sourceFile.getLineAndCharacterOfPosition(node.end);
					const key = `${definition.id}\u0000${node.getStart(sourceFile)}\u0000${node.end}\u0000${role}`;

					if (!seenOccurrences.has(key)) {
						seenOccurrences.add(key);
						const declaration = node.parent;
						const definitionMetadata = role === 'definition' ? definitionMetadataOf(sourceFile, declaration) : {};

						occurrences.push({
							symbolId: definition.id,
							path: file.path,
							startLine: start.line + 1,
							startColumn: start.character + 1,
							endLine: end.line + 1,
							endColumn: end.character + 1,
							startOffset: node.getStart(sourceFile),
							endOffset: node.end,
							role,
							enclosingId: occurrenceOwnerOf({role, declaredDefinition, enclosingId, nextEnclosingId, enclosingBySymbol}),
							contexts,
							...definitionMetadata,
						});
					}
				}
			}

			ts.forEachChild(node, (child) => {
				visit(child, nextEnclosingId);
			});
		};

		ts.forEachChild(sourceFile, (node) => {
			visit(node, null);
		});
	}

	return {occurrences, enclosingBySymbol, deduplicatedOccurrences: occurrences.length};
};

/**
 * Extracts indexed declarations and references from a loaded TypeScript program.
 *
 * The extractor performs two AST walks. The first resolves declarations and
 * chooses one deterministic primary declaration per canonical symbol. The second
 * resolves identifier occurrences against those primary symbols.
 *
 * @param input - Loaded project, authored files, project identity, and context.
 * @returns Indexed symbols, occurrences, and diagnostics tagged with that context.
 */
export const extractSymbolFacts = (input: ExtractionInputType): TypeScriptSymbolFactsType => {
	const startedAt = performance.now();
	const {checker} = input.project;
	const authoredPaths = new Set(input.files.map((file) => file.absolutePath));
	const definitions = new Map<ts.Symbol, IndexedSymbolType>();
	const declarationNodes = new Map<ts.Node, IndexedSymbolType>();
	const primaryDeclarationNodes = new Map<ts.Node, IndexedSymbolType>();
	const publishedSymbolIds = new Set<string>();

	{
		const candidates = collectCandidates(input, authoredPaths);
		const primaries = selectPrimaryCandidates(candidates);
		debug('candidates resolved', {authoredFiles: input.files.length, candidates: candidates.length, primaries: primaries.size});

		for (const [canonical, primary] of primaries) {
			const symbol = toIndexedSymbol(checker, primary, input.projectId, input.context);
			definitions.set(canonical, symbol);
			primaryDeclarationNodes.set(primary.declaration, symbol);
		}

		for (const candidate of candidates) {
			const symbol = definitions.get(candidate.canonical);

			if (symbol === undefined) {
				continue;
			}

			declarationNodes.set(candidate.declaration, symbol);

			if (candidate.published) {
				publishedSymbolIds.add(symbol.id);
			}
		}
	}

	const collected = collectOccurrences({...input, checker, definitions, declarationNodes, primaryDeclarationNodes});
	const symbols = [...definitions.values()].map((definition) => ({
		...definition,
		enclosingId: collected.enclosingBySymbol.get(definition.id) ?? null,
	}));
	const scopeByPath = new Map<string, 'module' | 'global'>();

	for (const file of input.files) {
		const sourceFile = input.project.program.getSourceFile(file.absolutePath);

		if (sourceFile !== undefined) {
			scopeByPath.set(file.path, ts.isExternalModule(sourceFile) ? 'module' : 'global');
		}
	}

	symbols.sort((left, right) => left.path.localeCompare(right.path) || left.startOffset - right.startOffset || left.id.localeCompare(right.id));
	collected.occurrences.sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.startOffset - right.startOffset ||
			left.symbolId.localeCompare(right.symbolId) ||
			left.role.localeCompare(right.role),
	);
	debug('extraction complete', {
		symbols: symbols.length,
		occurrences: collected.occurrences.length,
		definitionOccurrences: collected.occurrences.filter((occurrence) => occurrence.role === 'definition').length,
		deduplicatedOccurrences: collected.deduplicatedOccurrences,
		durationMs: Math.round(performance.now() - startedAt),
	});

	return {
		symbols,
		occurrences: collected.occurrences,
		diagnostics: [],
		diagnosticCount: 0,
		publication: createTypeScriptPublicationFacts({
			context: input.context,
			symbols,
			occurrences: collected.occurrences,
			scopeByPath,
			publishedSymbolIds,
		}),
	};
};
