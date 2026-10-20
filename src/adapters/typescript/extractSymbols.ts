import {type ExtractedPublicationFactsType} from '../../core/facts/index.ts';
import {type ExtractionResultType} from '../../core/model.ts';
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
	projectPublishedRoots(runtime, sink);
	refreshEnclosing(runtime);
	const definitions = addDefinitionFacts(runtime, sink);
	const references = collectReferenceFacts(runtime, definitions.definitionsBySymbol, definitions.definitionNodes);

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
