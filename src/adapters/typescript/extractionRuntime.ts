import ts from 'typescript';
import {type FactAddressType} from '../../core/facts/index.ts';
import {type IndexedSymbolType, type SourceFileType} from '../../core/model.ts';
import {type LoadedProjectType} from './loadProject.ts';
import {definitionMetadataOf} from './occurrenceMetadata.ts';
import {collectTypeScriptCandidates} from './publicationCandidates.ts';
import {type CandidateCollectionType, type CandidateScopeType, type CandidateType, type DeferredCandidateType} from './publicationCandidateTypes.ts';
import {candidateSymbolOf} from './publicationCandidateSymbol.ts';
import {createSymbolId} from './symbolIdentity.ts';

export type ExtractionInputType = Readonly<{
	readonly project: LoadedProjectType;
	readonly files: readonly SourceFileType[];
	readonly projectId: string;
	readonly rootDir: string;
	readonly context: string;
}>;

/** Mutable symbol-table state shared by extraction stages. */
export type ExtractionRuntimeType = {
	readonly input: ExtractionInputType;
	readonly checker: ts.TypeChecker;
	readonly program: ts.Program;
	readonly pathByAbsolute: ReadonlyMap<string, string>;
	readonly authoredPaths: ReadonlySet<string>;
	readonly collection: CandidateCollectionType;
	readonly symbolsByKey: Map<string, IndexedSymbolType>;
	readonly symbolsById: Map<string, IndexedSymbolType>;
	readonly symbolIdByKey: Map<string, string>;
	readonly symbolIdByCanonical: Map<ts.Symbol, string>;
	readonly symbolIdByDeclaration: Map<ts.Node, string>;
	readonly symbolIdByPathAndName: Map<string, string>;
	readonly candidateBySymbolId: Map<string, CandidateType>;
	readonly deferredNodeById: Map<ts.Node, DeferredCandidateType>;
	readonly deferredByCanonical: Map<ts.Symbol, DeferredCandidateType[]>;
	readonly deferredIdByNode: Map<ts.Node, string>;
	readonly deferredNodeBySymbolId: Map<string, ts.Node>;
	promotionEnabled: boolean;
};

const updateSymbol = (runtime: ExtractionRuntimeType, key: string, symbol: IndexedSymbolType): void => {
	runtime.symbolsByKey.set(key, symbol);
	runtime.symbolsById.set(symbol.id, symbol);
};

/**
 * Finds the nearest enclosing stored declaration.
 *
 * @param runtime - Extraction state.
 * @param declaration - Declaration to own.
 * @param ownId - Identifier to exclude, or an empty string.
 * @returns Owner identifier or null.
 */
const nearestOwner = (runtime: ExtractionRuntimeType, declaration: ts.Node, ownId: string): string | null => {
	let current = declaration.parent;

	while (!ts.isSourceFile(current)) {
		const owner = runtime.symbolIdByDeclaration.get(current) ?? runtime.deferredIdByNode.get(current);

		if (owner !== undefined && owner !== ownId) {
			return owner;
		}

		current = current.parent;
	}

	return null;
};

/**
 * Creates the mutable symbol index for one project context.
 *
 * @param input - Loaded project, authored files, and context identity.
 * @returns Runtime state with stored symbols and deferred member indexes.
 */
export const createExtractionRuntime = (input: ExtractionInputType): ExtractionRuntimeType => {
	const {checker, program} = input.project;
	const pathByAbsolute = new Map(input.files.map((file) => [file.absolutePath, file.path]));
	const authoredPaths = new Set(input.files.map((file) => file.absolutePath));
	const collection = collectTypeScriptCandidates({
		checker,
		program,
		files: input.files,
		rootDir: input.rootDir,
		projectId: input.projectId,
		context: input.context,
		authoredPaths,
		pathByAbsolute,
	});
	const runtime: ExtractionRuntimeType = {
		input,
		checker,
		program,
		pathByAbsolute,
		authoredPaths,
		collection,
		symbolsByKey: new Map(),
		symbolsById: new Map(),
		symbolIdByKey: new Map(),
		symbolIdByCanonical: new Map(),
		symbolIdByDeclaration: new Map(),
		symbolIdByPathAndName: new Map(),
		candidateBySymbolId: new Map(),
		deferredNodeById: new Map(),
		deferredByCanonical: new Map(),
		deferredIdByNode: new Map(),
		deferredNodeBySymbolId: new Map(),
		promotionEnabled: true,
	};

	for (const candidate of collection.candidates.values()) {
		const symbol = candidateSymbolOf(
			{checker, program, files: input.files, rootDir: input.rootDir, projectId: input.projectId, context: input.context, authoredPaths, pathByAbsolute},
			candidate,
		);

		runtime.symbolsByKey.set(candidate.key, symbol);
		runtime.symbolsById.set(symbol.id, symbol);
		runtime.symbolIdByKey.set(candidate.key, symbol.id);
		runtime.candidateBySymbolId.set(symbol.id, candidate);

		const pathAndName = `${candidate.path}\u0000${candidate.name}`;

		if (!runtime.symbolIdByPathAndName.has(pathAndName)) {
			runtime.symbolIdByPathAndName.set(pathAndName, symbol.id);
		}

		if (candidate.canonical !== null) {
			runtime.symbolIdByCanonical.set(candidate.canonical, symbol.id);
		}

		for (const definition of candidate.definitions) {
			runtime.symbolIdByDeclaration.set(definition.declaration, symbol.id);
		}
	}

	for (const [node, deferred] of collection.deferred) {
		runtime.deferredNodeById.set(node, deferred);
		const group = runtime.deferredByCanonical.get(deferred.canonical) ?? [];
		group.push(deferred);
		runtime.deferredByCanonical.set(deferred.canonical, group);
	}

	for (const group of runtime.deferredByCanonical.values()) {
		group.sort((left, right) => left.path.localeCompare(right.path) || left.nameNode.getStart(left.sourceFile) - right.nameNode.getStart(right.sourceFile));
	}

	for (const symbol of runtime.symbolsByKey.values()) {
		const candidate = runtime.candidateBySymbolId.get(symbol.id);

		if (candidate !== undefined) {
			updateSymbol(runtime, candidate.key, {...symbol, enclosingId: nearestOwner(runtime, candidate.primary.declaration, symbol.id)});
		}
	}

	return runtime;
};

const promoteDeferred = (runtime: ExtractionRuntimeType, deferred: DeferredCandidateType): string => {
	const existing = runtime.symbolIdByCanonical.get(deferred.canonical);

	if (existing !== undefined) {
		return existing;
	}

	if (ts.isShorthandPropertyAssignment(deferred.declaration)) {
		const value = runtime.checker.getShorthandAssignmentValueSymbol(deferred.declaration);
		const target = value === undefined ? undefined : runtime.symbolIdByCanonical.get(value);

		if (target !== undefined) {
			runtime.symbolIdByCanonical.set(deferred.canonical, target);
			return target;
		}
	}

	const name = deferred.canonical.getName();
	const metadata = definitionMetadataOf(deferred.sourceFile, deferred.declaration);
	const extent = metadata.extent ?? {
		startLine: 1,
		startColumn: 1,
		endLine: 1,
		endColumn: 1,
		startOffset: deferred.nameNode.getStart(deferred.sourceFile),
		endOffset: deferred.nameNode.end,
	};
	const symbol: IndexedSymbolType = {
		id: createSymbolId({
			projectId: runtime.input.projectId,
			path: deferred.path,
			startOffset: deferred.nameNode.getStart(deferred.sourceFile),
			kind: deferred.kind,
			name,
		}),
		name,
		qualifiedName: name,
		kind: deferred.kind,
		path: deferred.path,
		startLine: extent.startLine,
		startColumn: extent.startColumn,
		endLine: extent.endLine,
		endColumn: extent.endColumn,
		startOffset: extent.startOffset,
		endOffset: extent.endOffset,
		enclosingId: nearestOwner(runtime, deferred.declaration, ''),
		externalTarget: null,
		externalName: null,
		contexts: [runtime.input.context],
	};
	const key = `deferred:${deferred.path}:${String(symbol.startOffset)}`;

	runtime.symbolsByKey.set(key, symbol);
	runtime.symbolsById.set(symbol.id, symbol);
	runtime.symbolIdByKey.set(key, symbol.id);
	runtime.symbolIdByCanonical.set(deferred.canonical, symbol.id);
	runtime.deferredIdByNode.set(deferred.declaration, symbol.id);
	runtime.deferredNodeBySymbolId.set(symbol.id, deferred.declaration);
	return symbol.id;
};

const deferredFor = (runtime: ExtractionRuntimeType, symbol: ts.Symbol): DeferredCandidateType | undefined => runtime.deferredByCanonical.get(symbol)?.[0];

const promoteDeferredForDeclaration = (runtime: ExtractionRuntimeType, declarations: readonly ts.Declaration[]): string | null => {
	for (const declaration of declarations) {
		const deferred = runtime.deferredNodeById.get(declaration);

		if (deferred !== undefined) {
			return promoteDeferred(runtime, deferred);
		}
	}

	return null;
};

const resolveAliasTarget = (
	runtime: ExtractionRuntimeType,
	symbol: ts.Symbol,
	mergedAliasValue: boolean,
): Readonly<{target: ts.Symbol; immediateId: string | null}> | null => {
	let target = symbol;

	if ((target.flags & ts.SymbolFlags.Alias) === 0) {
		return {target, immediateId: null};
	}

	try {
		if (!mergedAliasValue) {
			const immediate = runtime.checker.getImmediateAliasedSymbol(target);
			const immediateId = immediate === undefined ? undefined : runtime.symbolIdByCanonical.get(immediate);

			if (immediateId !== undefined) {
				return {target, immediateId};
			}
		}

		target = runtime.checker.getAliasedSymbol(target);
		return {target, immediateId: null};
	} catch {
		return null;
	}
};

const sourceCandidatesForDeclarationFile = (runtime: ExtractionRuntimeType, symbol: ts.Symbol): string | null => {
	const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

	for (const declaration of symbol.declarations ?? []) {
		const sourceFile = declaration.getSourceFile();

		if (!sourceFile.isDeclarationFile) {
			continue;
		}

		const base = sourceFile.fileName.replace(/\.d\.(?:ts|mts|cts)$/u, '');

		for (const extension of extensions) {
			const absolute = `${base}${extension}`;
			const relative = runtime.pathByAbsolute.get(absolute);

			if (relative === undefined) {
				continue;
			}

			const symbolId = runtime.symbolIdByPathAndName.get(`${relative}\u0000${symbol.getName()}`);

			if (symbolId !== undefined) {
				return symbolId;
			}
		}
	}

	return null;
};

/**
 * Resolves one compiler symbol to a stored symbol, promoting projected members.
 *
 * @param runtime - Extraction state.
 * @param symbol - Compiler symbol, possibly an alias.
 * @returns Stored symbol identifier, or null.
 */
export const symbolForTsSymbol = (runtime: ExtractionRuntimeType, symbol: ts.Symbol | undefined): string | null => {
	if (symbol === undefined) {
		return null;
	}

	// A merged import alias and local value declaration shares one compiler
	// symbol. Prefer the aliased type target and its own declarations so the
	// local value is not treated as reachable merely because the imported type is
	// observed.
	const valueFlags = [ts.SymbolFlags.Function, ts.SymbolFlags.Class, ts.SymbolFlags.BlockScopedVariable];
	const mergedAliasValue = (symbol.flags & ts.SymbolFlags.Alias) !== 0 && valueFlags.some((flag) => (symbol.flags & flag) !== 0);
	const alias = resolveAliasTarget(runtime, symbol, mergedAliasValue);

	if (alias === null) {
		return null;
	}

	if (alias.immediateId !== null) {
		return alias.immediateId;
	}

	const {target} = alias;

	for (const declaration of target.declarations ?? []) {
		const declared = runtime.symbolIdByDeclaration.get(declaration);

		if (declared !== undefined) {
			return declared;
		}
	}

	const resolved = runtime.symbolIdByCanonical.get(target);

	if (resolved !== undefined) {
		return resolved;
	}

	const direct = runtime.symbolIdByCanonical.get(symbol);

	if (direct !== undefined) {
		return direct;
	}

	const sourceCandidate = sourceCandidatesForDeclarationFile(runtime, target);

	if (sourceCandidate !== null) {
		return sourceCandidate;
	}

	if (!runtime.promotionEnabled) {
		return null;
	}

	const promoted = promoteDeferredForDeclaration(runtime, target.declarations ?? []);

	if (promoted !== null) {
		return promoted;
	}

	const deferred = deferredFor(runtime, target);

	return deferred === undefined ? null : promoteDeferred(runtime, deferred);
};

/**
 * Resolves one declaration node to a stored symbol.
 *
 * @param runtime - Extraction state.
 * @param declaration - Declaration node.
 * @returns Stored symbol identifier, or null.
 */
export const symbolForDeclaration = (runtime: ExtractionRuntimeType, declaration: ts.Node): string | null => {
	const declared = runtime.symbolIdByDeclaration.get(declaration);

	if (declared !== undefined) {
		return declared;
	}

	const promoted = runtime.deferredIdByNode.get(declaration);

	if (promoted !== undefined) {
		return promoted;
	}

	const deferred = runtime.deferredNodeById.get(declaration);

	return deferred === undefined ? null : promoteDeferred(runtime, deferred);
};

const scopeSegments = (scope: CandidateScopeType): FactAddressType => {
	if (scope.kind === 'module') {
		return [['module', scope.path]];
	}

	if (scope.kind === 'external_module') {
		return [['external_module', scope.target]];
	}

	return [['global', null]];
};

const scopeOfSymbol = (runtime: ExtractionRuntimeType, symbolId: string): CandidateScopeType => {
	const candidate = runtime.candidateBySymbolId.get(symbolId);

	if (candidate !== undefined) {
		return candidate.scope;
	}

	const deferredNode = runtime.deferredNodeBySymbolId.get(symbolId);
	const deferred = deferredNode === undefined ? undefined : runtime.deferredNodeById.get(deferredNode);

	if (deferred !== undefined) {
		return deferred.scope;
	}

	return {kind: 'global'};
};

/**
 * Builds the lexical address of one stored symbol.
 *
 * @param runtime - Extraction state.
 * @param symbolId - Stored symbol identifier.
 * @returns Scope segment followed by lexical member segments.
 */
export const lexicalSegmentsOf = (runtime: ExtractionRuntimeType, symbolId: string): FactAddressType => {
	const names: string[] = [];
	const seen = new Set<string>();
	let current: string | null = symbolId;

	while (current !== null && !seen.has(current)) {
		seen.add(current);
		const symbol = runtime.symbolsById.get(current);

		if (symbol === undefined) {
			break;
		}

		names.push(symbol.name);
		current = symbol.enclosingId;
	}

	names.reverse();
	return [...scopeSegments(scopeOfSymbol(runtime, symbolId)), ...names.map((name) => ['member', name] as const)];
};

/**
 * Recomputes lexical ownership for every stored and promoted symbol.
 *
 * @param runtime - Extraction state.
 */
export const refreshEnclosing = (runtime: ExtractionRuntimeType): void => {
	for (const [key, symbol] of runtime.symbolsByKey) {
		const candidate = runtime.candidateBySymbolId.get(symbol.id);
		const declaration = candidate?.primary.declaration ?? runtime.deferredNodeBySymbolId.get(symbol.id);
		const owner = declaration === undefined ? symbol.enclosingId : nearestOwner(runtime, declaration, symbol.id);

		if (owner !== symbol.enclosingId) {
			updateSymbol(runtime, key, {...symbol, enclosingId: owner});
		}
	}
};
