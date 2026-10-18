import ts from 'typescript';
import {debugFor} from '../../logging/debug.ts';
import {type ExtractionResultType, type IndexedOccurrenceType, type IndexedSymbolType, type SourceFileType} from '../../index/model.ts';
import {type LoadedProjectType} from './loadProject.ts';
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
}>;

type ExtractionInputType = Readonly<{
	readonly project: LoadedProjectType;
	readonly files: readonly SourceFileType[];
	readonly projectId: string;
	readonly rootDir: string;
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

const kindOfDeclaration = (node: ts.Node): string => {
	if (ts.isFunctionDeclaration(node)) {
		return 'function';
	}

	if (ts.isClassDeclaration(node)) {
		return 'class';
	}

	if (ts.isInterfaceDeclaration(node)) {
		return 'interface';
	}

	if (ts.isTypeAliasDeclaration(node)) {
		return 'type';
	}

	if (ts.isEnumDeclaration(node)) {
		return 'enum';
	}

	if (ts.isEnumMember(node)) {
		return 'enum_member';
	}

	if (ts.isModuleDeclaration(node)) {
		return 'namespace';
	}

	if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
		return 'method';
	}

	if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
		return 'property';
	}

	if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
		return 'accessor';
	}

	return 'variable';
};

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

		walkSourceFile(sourceFile, (node) => {
			const declaredName = declarationName(node);
			const nameNode = declaredName ?? (ts.isExportSpecifier(node) && ts.isIdentifier(node.name) ? node.name : undefined);

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
				kind: kindOfDeclaration(node),
				path: file.path,
				sourceFile,
				declaration: node,
				nameNode,
				startOffset: node.getStart(sourceFile),
				endOffset: node.end,
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

const toIndexedSymbol = (checker: ts.TypeChecker, primary: CandidateType, projectId: string): IndexedSymbolType => {
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
	occurrences: IndexedOccurrenceType[];
	enclosingBySymbol: ReadonlyMap<string, string>;
	deduplicatedOccurrences: number;
}>;

const collectOccurrences = (
	input: ExtractionInputType,
	checker: ts.TypeChecker,
	definitions: ReadonlyMap<ts.Symbol, IndexedSymbolType>,
	declarationNodes: ReadonlyMap<ts.Node, IndexedSymbolType>,
): CollectedOccurrencesType => {
	const definitionInAliasChain = (symbol: ts.Symbol | undefined): IndexedSymbolType | undefined => {
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

	const symbolForCanonical = (canonical: ts.Symbol | undefined): IndexedSymbolType | undefined => {
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

	const occurrences: IndexedOccurrenceType[] = [];
	const seenOccurrences = new Set<string>();
	const enclosingBySymbol = new Map<string, string>();

	for (const file of input.files) {
		const sourceFile = input.project.program.getSourceFile(file.absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		const visit = (node: ts.Node, enclosingId: string | null): void => {
			const declarationSymbol = declarationNodes.get(node);
			const nextEnclosingId = declarationSymbol?.id ?? enclosingId;

			if (declarationSymbol !== undefined && enclosingId !== null) {
				enclosingBySymbol.set(declarationSymbol.id, enclosingId);
			}

			if (ts.isIdentifier(node)) {
				const locationSymbol = checker.getSymbolAtLocation(node);
				let definition = definitionInAliasChain(locationSymbol);

				if (definition === undefined) {
					let canonical = resolveOccurrenceSymbol(checker, node);

					if (symbolForCanonical(canonical) === undefined) {
						canonical = resolveCanonical(checker, node);
					}

					definition = symbolForCanonical(canonical);
				}

				if (definition !== undefined) {
					const declaredDefinition = declarationNodes.get(node.parent);
					const role = declaredDefinition?.id === definition.id || isDefinitionNameNode(node) ? 'definition' : 'reference';
					const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
					const end = sourceFile.getLineAndCharacterOfPosition(node.end);
					const key = `${definition.id}\u0000${file.path}\u0000${node.getStart(sourceFile)}\u0000${node.end}\u0000${role}`;

					if (!seenOccurrences.has(key)) {
						seenOccurrences.add(key);
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
							enclosingId: nextEnclosingId,
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

	return {occurrences, enclosingBySymbol, deduplicatedOccurrences: seenOccurrences.size};
};

/**
 * Extracts indexed declarations and references from a loaded TypeScript program.
 *
 * The extractor performs two AST walks. The first resolves declarations and
 * chooses one deterministic primary declaration per canonical symbol. The second
 * resolves identifier occurrences against those primary symbols.
 *
 * @param input - Loaded project, authored files, and project identity.
 * @returns Indexed symbols, occurrences, and diagnostics.
 */
export const extractSymbolFacts = (input: ExtractionInputType): ExtractionResultType => {
	const startedAt = performance.now();
	const {checker} = input.project;
	const authoredPaths = new Set(input.files.map((file) => file.absolutePath));
	const candidates = collectCandidates(input, authoredPaths);
	const primaries = selectPrimaryCandidates(candidates);
	debug('candidates resolved', {authoredFiles: input.files.length, candidates: candidates.length, primaries: primaries.size});
	const definitions = new Map<ts.Symbol, IndexedSymbolType>();
	const declarationNodes = new Map<ts.Node, IndexedSymbolType>();

	for (const [canonical, primary] of primaries) {
		const symbol = toIndexedSymbol(checker, primary, input.projectId);
		definitions.set(canonical, symbol);
		declarationNodes.set(primary.declaration, symbol);
	}

	const collected = collectOccurrences(input, checker, definitions, declarationNodes);
	const symbols = [...definitions.values()].map((definition) => ({
		...definition,
		enclosingId: collected.enclosingBySymbol.get(definition.id) ?? null,
	}));

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
	};
};
