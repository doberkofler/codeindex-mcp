import {type IndexedOccurrenceType} from '../../core/model.ts';
import {type OracleDeclarationType, type OracleReferenceSiteType} from './syntax.ts';

export type OutArgumentRangeType = Readonly<{
	readonly path: string;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly usage: number;
}>;

const outArgumentUsage = (site: OracleReferenceSiteType, declaration: OracleDeclarationType): ReadonlyMap<number, number> => {
	const modes = new Map<number, number>();

	if (site.kind !== 'call' || site.arguments === undefined || declaration.parameters.length === 0) {
		return modes;
	}

	for (const [index, argument] of site.arguments.entries()) {
		const parameter =
			argument.name === null ? declaration.parameters[index] : declaration.parameters.find((candidate) => candidate.name.canonical === argument.name);

		if (parameter?.mode === 'OUT') {
			modes.set(index, 4);
		} else if (parameter?.mode === 'IN OUT') {
			modes.set(index, 6);
		}
	}

	return modes;
};

/**
 * Derives OUT/IN OUT argument usage ranges for one resolved call-shaped site.
 *
 * @param site - Resolved reference site.
 * @param declaration - Target declaration with parameter modes.
 * @param path - Workspace-relative source path.
 * @returns Argument ranges whose read usage must be refined.
 */
export const outArgumentRangesOf = (site: OracleReferenceSiteType, declaration: OracleDeclarationType, path: string): readonly OutArgumentRangeType[] => {
	const ranges: OutArgumentRangeType[] = [];

	for (const [index, usage] of outArgumentUsage(site, declaration)) {
		const argument = site.arguments?.[index];

		if (argument !== undefined) {
			ranges.push({path, startOffset: argument.range.startOffset, endOffset: argument.range.endOffset, usage});
		}
	}

	return ranges;
};

const occurrenceKeyOf = (occurrence: IndexedOccurrenceType): string => `${occurrence.path}\u0000${String(occurrence.startOffset)}\u0000${occurrence.symbolId}`;

/**
 * Rewrites read occurrences inside OUT argument spans to write/read-write.
 *
 * @param occurrences - Resolved reference occurrences.
 * @param ranges - OUT argument spans from resolved calls.
 * @returns Occurrences with refined usage bits.
 */
export const refineOutArgumentUsage = (
	occurrences: readonly IndexedOccurrenceType[],
	ranges: readonly OutArgumentRangeType[],
): readonly IndexedOccurrenceType[] => {
	const refined = new Map<string, number>();
	const byPath = new Map<string, IndexedOccurrenceType[]>();

	for (const occurrence of occurrences) {
		const existing = byPath.get(occurrence.path) ?? [];

		existing.push(occurrence);
		byPath.set(occurrence.path, existing);
	}

	for (const group of byPath.values()) {
		group.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
	}

	for (const argument of ranges) {
		const group = byPath.get(argument.path) ?? [];
		let low = 0;
		let high = group.length;

		while (low < high) {
			const middle = Math.floor((low + high) / 2);

			if ((group[middle]?.startOffset ?? Number.POSITIVE_INFINITY) < argument.startOffset) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		for (let index = low; index < group.length; index += 1) {
			const occurrence = group[index];

			if (occurrence === undefined || occurrence.startOffset > argument.endOffset) {
				break;
			}

			if (occurrence.endOffset <= argument.endOffset && occurrence.usage === 2) {
				refined.set(occurrenceKeyOf(occurrence), argument.usage);
			}
		}
	}

	return occurrences.map((occurrence) => {
		const usage = refined.get(occurrenceKeyOf(occurrence));

		return usage === undefined ? occurrence : {...occurrence, usage};
	});
};
