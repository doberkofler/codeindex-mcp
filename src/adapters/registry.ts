import {type ExtractorType} from './types.ts';
import {typeScriptExtractor} from './typescript/index.ts';

const EXTRACTORS: readonly ExtractorType[] = [typeScriptExtractor];

/**
 * Resolves a configured extractor by identifier.
 *
 * @param id - Extractor identifier from configuration.
 * @returns The registered extractor.
 * @throws {@link Error} When no adapter with that identifier is available.
 */
export const extractorFor = (id: string): ExtractorType => {
	const extractor = EXTRACTORS.find((candidate) => candidate.id === id);

	if (extractor === undefined) {
		const available = EXTRACTORS.map((candidate) => candidate.id).join(', ');
		throw new Error(`Unknown code index extractor: ${id}. Available extractors: ${available}`);
	}

	return extractor;
};

/**
 * Lists the registered extractors.
 *
 * @returns Every built-in extractor in display order.
 */
export const availableExtractors = (): readonly ExtractorType[] => EXTRACTORS;
