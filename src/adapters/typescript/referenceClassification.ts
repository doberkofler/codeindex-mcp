import {type IndexedOccurrenceType} from '../../core/model.ts';
import {referenceLocationKey, type ReferenceLocationType} from './referenceLocations.ts';
import {type ReferenceUnmatchedClassType, type ReferenceUnmatchedLocationType} from './referenceGate.ts';

type StoredOccurrenceType = Readonly<{symbolId: string; role: 'definition' | 'reference'}>;

/** Index of every stored occurrence by exact range and role. */
export type StoredLocationIndexType = Readonly<{
	byKey: ReadonlyMap<string, StoredOccurrenceType>;
	definitionsByRange: ReadonlyMap<string, readonly StoredOccurrenceType[]>;
}>;

const rangeKey = (location: ReferenceLocationType): string => `${location.path}\u0000${location.startOffset}\u0000${location.endOffset}`;

/**
 * Builds the conservation index from the production occurrence set.
 *
 * @param occurrences - Occurrences emitted by the production extractor.
 * @returns Lookup tables for stored references and definitions.
 */
export const createStoredLocationIndex = (occurrences: readonly IndexedOccurrenceType[]): StoredLocationIndexType => {
	const byKey = new Map<string, StoredOccurrenceType>();
	const definitionsByRange = new Map<string, StoredOccurrenceType[]>();

	for (const occurrence of occurrences) {
		const stored = {symbolId: occurrence.symbolId, role: occurrence.role};
		const location = {
			path: occurrence.path,
			startOffset: occurrence.startOffset,
			endOffset: occurrence.endOffset,
			role: occurrence.role,
		};

		byKey.set(referenceLocationKey(location), stored);

		if (occurrence.role === 'definition') {
			const group = definitionsByRange.get(rangeKey(location)) ?? [];
			group.push(stored);
			definitionsByRange.set(rangeKey(location), group);
		}
	}

	return {byKey, definitionsByRange};
};

/**
 * Conserves one truth location that is absent from the tested partition.
 *
 * The order is deliberate: a location stored under another symbol is a
 * partition artifact, a stored definition is a role artifact, and only then do
 * external and namespace syntax explain an intentional omission. Anything else
 * is `unexplained` and must fail the gate.
 *
 * @param input - Truth location, stored index, and optional syntax classifier.
 * @returns The conservation class.
 */
export const classifyUnmatchedLocation = (
	input: Readonly<{
		location: ReferenceLocationType;
		symbolId: string;
		stored: StoredLocationIndexType;
		syntaxClass: 'direct_external' | 'namespace_import' | null;
	}>,
): ReferenceUnmatchedClassType => {
	const stored = input.stored.byKey.get(referenceLocationKey(input.location));

	if (stored !== undefined && stored.symbolId !== input.symbolId) {
		return stored.role === 'reference' ? 'stored_reference' : 'stored_definition';
	}

	if (input.location.role === 'definition') {
		const definitions = input.stored.definitionsByRange.get(rangeKey(input.location)) ?? [];

		if (definitions.some((definition) => definition.symbolId !== input.symbolId)) {
			return 'stored_definition';
		}
	}

	if (input.syntaxClass !== null) {
		return input.syntaxClass;
	}

	return 'unexplained';
};

/**
 * Classifies every missing truth location and retains the raw evidence.
 *
 * @param input - Missing locations, tested symbol, stored index, and syntax classifier.
 * @returns One classified entry per missing location.
 */
export const classifyUnmatchedLocations = (
	input: Readonly<{
		missing: readonly ReferenceLocationType[];
		symbolId: string;
		stored: StoredLocationIndexType;
		syntaxClassOf: (location: ReferenceLocationType) => 'direct_external' | 'namespace_import' | null;
	}>,
): readonly ReferenceUnmatchedLocationType[] =>
	input.missing.map((location) => ({
		location,
		classification: classifyUnmatchedLocation({
			location,
			symbolId: input.symbolId,
			stored: input.stored,
			syntaxClass: input.syntaxClassOf(location),
		}),
	}));
