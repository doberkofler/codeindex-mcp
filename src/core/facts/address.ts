import {type FactAddressSegmentType, type FactAddressType, type FactRangeType, type ExtractedOccurrenceType} from './types.ts';

// True for a non-negative safe integer.
const isSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isAddressSegment = (value: unknown): value is FactAddressSegmentType =>
	Array.isArray(value) &&
	value.length === 2 &&
	typeof value[0] === 'string' &&
	value[0].length > 0 &&
	(typeof value[1] === 'string' || value[1] === null || isSafeInteger(value[1]));

/**
 * Validates the generic canonical address shape.
 *
 * @param segments - Candidate address vector.
 * @returns A stable reason when invalid, otherwise null.
 */
export const addressIssue = (segments: FactAddressType): string | null => {
	if (!Array.isArray(segments) || segments.length === 0) {
		return 'address must contain at least one segment';
	}

	for (const segment of segments) {
		if (!Array.isArray(segment) || segment.length !== 2) {
			return 'every address segment must contain exactly two elements';
		}

		if (!isAddressSegment(segment)) {
			return 'address segment kind must be non-empty and its value must be a string, a non-negative safe integer, or null';
		}
	}

	return null;
};

// Builds the natural identity of one binding before hashing.
export const bindingIdentity = (symbolId: string, bindingKey: string): string => `${symbolId}\u0000${bindingKey}`;

// Builds the natural identity of one binding site.
export const siteIdentity = (symbolId: string, path: string, startOffset: number, kind: string): string =>
	`${symbolId}\u0000${path}\u0000${String(startOffset)}\u0000${kind}`;

// Compares two ranges by start, end, line, then column.
export const compareRanges = (left: FactRangeType, right: FactRangeType): number =>
	left.startOffset - right.startOffset || left.endOffset - right.endOffset || left.startLine - right.startLine || left.startColumn - right.startColumn;

// Extracts the name range from one occurrence.
export const occurrenceRange = (occurrence: ExtractedOccurrenceType): FactRangeType => ({
	startLine: occurrence.startLine,
	startColumn: occurrence.startColumn,
	endLine: occurrence.endLine,
	endColumn: occurrence.endColumn,
	startOffset: occurrence.startOffset,
	endOffset: occurrence.endOffset,
});
