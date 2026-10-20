import ts from 'typescript';
import {type ExtractedOccurrenceType, type FactRangeType} from '../../core/facts/index.ts';
import {definitionMetadataOf} from './occurrenceMetadata.ts';
import {type ExtractionRuntimeType, lexicalSegmentsOf, symbolForTsSymbol} from './extractionRuntime.ts';
import {addSite, bindingKey, ensureBinding, type FactSinkType} from './extractionRoots.ts';
import {resolveCanonical, resolveOccurrenceSymbol} from './resolveSymbols.ts';
import {usageOfReference} from './usage.ts';

const rangeOfNode = (sourceFile: ts.SourceFile, node: ts.Node): FactRangeType => {
	const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	const end = sourceFile.getLineAndCharacterOfPosition(node.end);

	return {
		startLine: start.line + 1,
		startColumn: start.character + 1,
		endLine: end.line + 1,
		endColumn: end.character + 1,
		startOffset: node.getStart(sourceFile),
		endOffset: node.end,
	};
};

export type OccurrenceFactsType = Readonly<{
	occurrences: readonly ExtractedOccurrenceType[];
	dropped: Readonly<Record<'external_target' | 'ephemeral_target', number>>;
}>;

const addCandidateDefinitions = (
	runtime: ExtractionRuntimeType,
	definitionsBySymbol: Map<string, ExtractedOccurrenceType[]>,
	definitionNodes: Set<ts.Node>,
): void => {
	for (const candidate of runtime.collection.candidates.values()) {
		const symbolId = runtime.symbolIdByKey.get(candidate.key);
		const symbol = symbolId === undefined ? undefined : runtime.symbolsById.get(symbolId);

		if (symbol === undefined) {
			continue;
		}

		definitionsBySymbol.set(
			symbol.id,
			candidate.definitions.map((definition) => {
				definitionNodes.add(definition.nameNode);

				return {
					symbolId: symbol.id,
					path: definition.path,
					startLine: definition.range.startLine,
					startColumn: definition.range.startColumn,
					endLine: definition.range.endLine,
					endColumn: definition.range.endColumn,
					startOffset: definition.range.startOffset,
					endOffset: definition.range.endOffset,
					role: 'definition' as const,
					enclosingId: symbol.enclosingId,
					contexts: [runtime.input.context],
					declarationKind: candidate.synthetic ? candidate.kind : definition.kind,
					forwardDefinition: definition.forwardDefinition,
					extent: definition.extent,
					anchorRank: definition.anchorRank,
					primaryRank: definition.primaryRank,
				};
			}),
		);
	}
};

const addDeferredDefinitions = (
	runtime: ExtractionRuntimeType,
	definitionsBySymbol: Map<string, ExtractedOccurrenceType[]>,
	definitionNodes: Set<ts.Node>,
): void => {
	for (const [node, symbolId] of runtime.deferredIdByNode) {
		const deferred = runtime.deferredNodeById.get(node);
		const symbol = runtime.symbolsById.get(symbolId);

		if (deferred === undefined || symbol === undefined || definitionsBySymbol.has(symbolId)) {
			continue;
		}

		const metadata = definitionMetadataOf(deferred.sourceFile, deferred.declaration);
		const range = rangeOfNode(deferred.sourceFile, deferred.nameNode);
		definitionNodes.add(deferred.nameNode);
		definitionsBySymbol.set(symbolId, [
			{
				symbolId,
				path: deferred.path,
				...range,
				role: 'definition',
				enclosingId: symbol.enclosingId,
				contexts: [runtime.input.context],
				declarationKind: deferred.kind,
				forwardDefinition: metadata.forwardDefinition ?? false,
				extent: metadata.extent ?? range,
				anchorRank: metadata.anchorRank ?? 0,
				primaryRank: metadata.primaryRank ?? 0,
			},
		]);
	}
};

const addLexicalBindings = (
	runtime: ExtractionRuntimeType,
	sink: FactSinkType,
	definitionsBySymbol: ReadonlyMap<string, readonly ExtractedOccurrenceType[]>,
): void => {
	for (const symbol of runtime.symbolsById.values()) {
		const segments = lexicalSegmentsOf(runtime, symbol.id);
		const draft = ensureBinding(sink, symbol.id, segments);
		const candidate = runtime.candidateBySymbolId.get(symbol.id);
		const syntheticDefault = candidate?.synthetic === true && candidate.name === 'default';

		for (const definition of definitionsBySymbol.get(symbol.id) ?? []) {
			addSite(sink, {symbolId: symbol.id, segments, kind: syntheticDefault ? 'default' : 'declared', pathName: definition.path, range: definition});
		}

		if (draft.exposure === 'internal' && sink.reachable.has(symbol.id)) {
			draft.exposure = 'reachable';
		}

		if (draft.exposure === 'internal' && sink.rootKeys.has(bindingKey(symbol.id, segments))) {
			draft.exposure = 'published';
		}
	}

	for (const [node, deferred] of runtime.collection.deferred) {
		if (!ts.isShorthandPropertyAssignment(node)) {
			continue;
		}

		const symbolId = runtime.symbolIdByCanonical.get(deferred.canonical);

		if (symbolId === undefined) {
			continue;
		}

		addSite(sink, {
			symbolId,
			segments: lexicalSegmentsOf(runtime, symbolId),
			kind: 'declared',
			pathName: deferred.path,
			range: rangeOfNode(deferred.sourceFile, deferred.nameNode),
		});
	}
};

/**
 * Adds lexical bindings and declared/default sites for every stored symbol.
 *
 * @param runtime - Extraction state.
 * @param sink - Fact sink.
 * @returns Definitions grouped by symbol and their definition name nodes.
 */
export const addDefinitionFacts = (
	runtime: ExtractionRuntimeType,
	sink: FactSinkType,
): Readonly<{definitionsBySymbol: Map<string, ExtractedOccurrenceType[]>; definitionNodes: Set<ts.Node>}> => {
	const definitionsBySymbol = new Map<string, ExtractedOccurrenceType[]>();
	const definitionNodes = new Set<ts.Node>();

	addCandidateDefinitions(runtime, definitionsBySymbol, definitionNodes);
	addDeferredDefinitions(runtime, definitionsBySymbol, definitionNodes);
	addLexicalBindings(runtime, sink, definitionsBySymbol);

	return {definitionsBySymbol, definitionNodes};
};

const aliasTargetOf = (runtime: ExtractionRuntimeType, symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
	if (symbol === undefined) {
		return undefined;
	}

	if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {
		return symbol;
	}

	try {
		return runtime.checker.getAliasedSymbol(symbol);
	} catch {
		return symbol;
	}
};

/**
 * Collects references that resolve to stored symbols.
 *
 * @param runtime - Extraction state.
 * @param definitionsBySymbol - Seeded definition occurrences.
 * @param definitionNodes - Definition name nodes to exclude from references.
 * @returns Reference occurrences and dropped-target counts.
 */
export const collectReferenceFacts = (
	runtime: ExtractionRuntimeType,
	definitionsBySymbol: ReadonlyMap<string, readonly ExtractedOccurrenceType[]>,
	definitionNodes: ReadonlySet<ts.Node>,
): OccurrenceFactsType => {
	const occurrences: ExtractedOccurrenceType[] = [...definitionsBySymbol.values()].flat();
	const dropped = {external_target: 0, ephemeral_target: 0};
	const seen = new Set<string>();
	runtime.promotionEnabled = false;

	for (const file of runtime.input.files) {
		const sourceFile = runtime.program.getSourceFile(file.absolutePath);

		if (sourceFile === undefined) {
			continue;
		}

		const visit = (node: ts.Node, enclosingId: string | null): void => {
			const declarationSymbol = runtime.symbolIdByDeclaration.get(node) ?? runtime.deferredIdByNode.get(node);
			const nextEnclosingId = declarationSymbol ?? enclosingId;

			if (ts.isIdentifier(node) && !definitionNodes.has(node)) {
				const raw = runtime.checker.getSymbolAtLocation(node);
				const symbolId =
					symbolForTsSymbol(runtime, raw) ??
					symbolForTsSymbol(runtime, resolveOccurrenceSymbol(runtime.checker, node)) ??
					symbolForTsSymbol(runtime, resolveCanonical(runtime.checker, node));

				if (symbolId === null) {
					const target = aliasTargetOf(runtime, raw);
					const authored = (target?.declarations ?? []).some((declaration) => runtime.authoredPaths.has(declaration.getSourceFile().fileName));
					dropped[authored ? 'ephemeral_target' : 'external_target'] += 1;
				} else {
					const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
					const end = sourceFile.getLineAndCharacterOfPosition(node.end);
					const key = `${symbolId}\u0000${file.path}\u0000${String(node.getStart(sourceFile))}\u0000reference`;

					if (!seen.has(key)) {
						seen.add(key);
						occurrences.push({
							symbolId,
							path: file.path,
							startLine: start.line + 1,
							startColumn: start.character + 1,
							endLine: end.line + 1,
							endColumn: end.character + 1,
							startOffset: node.getStart(sourceFile),
							endOffset: node.end,
							role: 'reference',
							enclosingId: nextEnclosingId,
							usage: usageOfReference(node),
							contexts: [runtime.input.context],
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

	occurrences.sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.startOffset - right.startOffset ||
			left.symbolId.localeCompare(right.symbolId) ||
			left.role.localeCompare(right.role),
	);

	return {occurrences, dropped};
};
