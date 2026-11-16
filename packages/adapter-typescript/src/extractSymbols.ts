import {type ExtractedPublicationFactsType, type ExtractionResultType} from '@codeindex/adapter-sdk';
import {createExtractionRuntime, type ExtractionInputType, refreshEnclosing} from './extractionRuntime.ts';
import {addDefinitionFacts, collectReferenceFacts} from './extractionOccurrences.ts';
import {adapterStatsOf, publicationFactsOf, sortedSymbols} from './extractionPublication.ts';
import {addPublishedRoots, createFactSink} from './extractionRoots.ts';
import {projectPublishedRoots} from './extractionProjection.ts';

export {nameNodeOf as candidateNameNode} from './publicationAddress.ts';

/** Symbol facts with the finalized publication facts for one context. */
export type TypeScriptSymbolFactsType = ExtractionResultType &
	Readonly<{
		readonly publication: ExtractedPublicationFactsType;
		readonly adapterStats: ReturnType<typeof adapterStatsOf>;
	}>;

/**
 * Extracts indexed declarations, references, and publication facts from a loaded TypeScript program.
 *
 * The adapter owns compiler semantics: declaration eligibility, aliases,
 * default roots, external aliases, surface projection, reachability, and usage.
 * Only serializable facts cross the adapter seam.
 *
 * @param input - Loaded project, authored files, project identity, and context.
 * @returns Indexed symbols, occurrences, publication facts, and statistics.
 */
export const extractSymbolFacts = (input: ExtractionInputType): TypeScriptSymbolFactsType => {
	const runtime = createExtractionRuntime(input);
	const sink = createFactSink();

	addPublishedRoots(runtime, sink);
	runtime.checkpoint();
	projectPublishedRoots(runtime, sink);
	runtime.checkpoint();
	refreshEnclosing(runtime);
	runtime.checkpoint();
	const definitions = addDefinitionFacts(runtime, sink);
	runtime.checkpoint();
	const references = collectReferenceFacts(runtime, definitions.definitionsBySymbol, definitions.definitionNodes);
	runtime.checkpoint();

	return {
		symbols: sortedSymbols(runtime),
		occurrences: references.occurrences,
		diagnostics: [],
		diagnosticCount: 0,
		publication: publicationFactsOf(sink, input.context),
		adapterStats: adapterStatsOf(runtime, sink, references.dropped),
	};
};

export type {ExtractionInputType} from './extractionRuntime.ts';
