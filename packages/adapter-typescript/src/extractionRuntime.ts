import * as ts from './compiler.ts';
import {type FactAddressType, type IndexedSymbolType, type SourceFileType} from '@codeindex/adapter-sdk';
import {preloadAliasTargets} from './aliasTargets.ts';
import {createCandidateResolution} from './candidateResolution.ts';
import {type LoadedProjectType} from './loadProject.ts';
import {definitionMetadataOf} from './occurrenceMetadata.ts';
import {collectTypeScriptCandidates} from './publicationCandidates.ts';
import {type CandidateCollectionType, type CandidateScopeType, type CandidateType, type DeferredCandidateType} from './publicationCandidateTypes.ts';
import {type IdentifierSymbolsType} from './identifierSymbols.ts';
import {candidateSymbolOf} from './publicationCandidateSymbol.ts';
import {createSymbolId} from './symbolIdentity.ts';
import {symbolNameOf} from './symbolName.ts';
import {sourceCandidatesForDeclarationFile as sourceCandidatesOf} from './sourceCandidates.ts';

export type ExtractionInputType = Readonly<{
	readonly project: LoadedProjectType;
	readonly files: readonly SourceFileType[];
	readonly projectId: string;
	readonly rootDir: string;
	readonly context: string;
	readonly onCompilerSessionRetention?: (retain: boolean) => void;
}>;

/** Mutable symbol-table state shared by extraction stages. */
export type ExtractionRuntimeType = {
	readonly input: ExtractionInputType;
	readonly checker: ts.TypeChecker;
	readonly program: ts.Program;
	readonly pathByAbsolute: ReadonlyMap<string, string>;
	readonly authoredPaths: ReadonlySet<string>;
	readonly identifierSymbols: IdentifierSymbolsType;
	readonly fullIdentifierSymbols: IdentifierSymbolsType | null;
	readonly identifierCount: number;
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
	readonly aliasTargets: Map<number, Readonly<{target: ts.Symbol; immediateId: string | null}> | null>;
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
	const {identifierSymbols, fullIdentifierSymbols, identifierCount, candidateAliasTargets, symbolAt, canonicalAt} = createCandidateResolution(input);
	input.onCompilerSessionRetention?.(fullIdentifierSymbols !== null);
	const collection = collectTypeScriptCandidates({
		checker,
		program,
		files: input.files,
		rootDir: input.rootDir,
		projectId: input.projectId,
		context: input.context,
		authoredPaths,
		pathByAbsolute,
		symbolAt,
		canonicalAt,
	});
	const runtime: ExtractionRuntimeType = {
		input,
		checker,
		program,
		pathByAbsolute,
		authoredPaths,
		identifierSymbols,
		fullIdentifierSymbols,
		identifierCount,
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
		aliasTargets: new Map(),
		promotionEnabled: true,
	};

	for (const candidate of collection.candidates.values()) {
		const symbol = candidateSymbolOf(
			{
				checker,
				program,
				files: input.files,
				rootDir: input.rootDir,
				projectId: input.projectId,
				context: input.context,
				authoredPaths,
				pathByAbsolute,
				symbolAt,
				canonicalAt,
			},
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

	preloadAliasTargets(runtime, identifierSymbols.values(), candidateAliasTargets);

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

	const name = symbolNameOf(deferred.canonical);
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

/**
 * Finds the stored symbol for one compiler declaration.
 *
 * A transient object member keeps the identity of the node that already
 * produced its declaration. Promotion is disabled during reference collection,
 * so that identity is reused instead of promoting a second symbol.
 *
 * @param runtime - Extraction state.
 * @param declaration - Compiler declaration node.
 * @returns Stored symbol identifier, or undefined.
 */
const storedIdForDeclaration = (runtime: ExtractionRuntimeType, declaration: ts.Node): string | undefined =>
	runtime.symbolIdByDeclaration.get(declaration) ?? runtime.deferredIdByNode.get(declaration);

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
	const cached = runtime.aliasTargets.get(symbol.id);

	if (cached !== undefined) {
		return cached;
	}

	let target = symbol;

	if ((target.flags & ts.SymbolFlags.Alias) === 0) {
		const result = {target, immediateId: null};
		runtime.aliasTargets.set(symbol.id, result);
		return result;
	}

	try {
		if (!mergedAliasValue) {
			const immediate = runtime.checker.getImmediateAliasedSymbol(target);
			const immediateId = immediate === undefined ? undefined : runtime.symbolIdByCanonical.get(immediate);

			if (immediateId !== undefined) {
				const result = {target, immediateId};
				runtime.aliasTargets.set(symbol.id, result);
				return result;
			}
		}

		target = runtime.checker.getAliasedSymbol(target);
		const result = {target, immediateId: null};
		runtime.aliasTargets.set(symbol.id, result);
		return result;
	} catch {
		runtime.aliasTargets.set(symbol.id, null);
		return null;
	}
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

	for (const declaration of ts.declarationsOf(target)) {
		const declared = storedIdForDeclaration(runtime, declaration);

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

	const sourceCandidate = sourceCandidatesOf(runtime, target);

	if (sourceCandidate !== null) {
		return sourceCandidate;
	}

	if (!runtime.promotionEnabled) {
		return null;
	}

	const promoted = promoteDeferredForDeclaration(runtime, ts.declarationsOf(target));

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
