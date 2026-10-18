import {type IndexedSymbolType} from '../../core/model.ts';
import {REFERENCE_CONSTRUCT_QUOTA, REFERENCE_CONSTRUCT_TAGS, type ReferenceConstructTagType} from './referenceConstructs.ts';

export const REFERENCE_SAMPLE_TARGET = 200;

export type ReferenceSampleCandidateType = Readonly<{
	readonly symbol: IndexedSymbolType;
	readonly tags: readonly ReferenceConstructTagType[];
}>;

const sampleKey = (candidate: ReferenceSampleCandidateType): string =>
	[candidate.symbol.kind, candidate.symbol.path, String(candidate.symbol.startOffset), candidate.symbol.qualifiedName].join('\u0000');

const byStableKey = (left: ReferenceSampleCandidateType, right: ReferenceSampleCandidateType): number => sampleKey(left).localeCompare(sampleKey(right));

const selectConstructQuotas = (sorted: readonly ReferenceSampleCandidateType[], selected: Map<string, ReferenceSampleCandidateType>): void => {
	for (const tag of REFERENCE_CONSTRUCT_TAGS) {
		const members = sorted.filter((candidate) => candidate.tags.includes(tag));

		for (const candidate of members.slice(0, REFERENCE_CONSTRUCT_QUOTA)) {
			selected.set(sampleKey(candidate), candidate);
		}
	}
};

const groupByKind = (sorted: readonly ReferenceSampleCandidateType[]): ReadonlyMap<string, readonly ReferenceSampleCandidateType[]> => {
	const byKind = new Map<string, ReferenceSampleCandidateType[]>();

	for (const candidate of sorted) {
		const group = byKind.get(candidate.symbol.kind) ?? [];
		group.push(candidate);
		byKind.set(candidate.symbol.kind, group);
	}

	return byKind;
};

const selectRoundRobin = (
	byKind: ReadonlyMap<string, readonly ReferenceSampleCandidateType[]>,
	selected: Map<string, ReferenceSampleCandidateType>,
	target: number,
): void => {
	const kinds = [...byKind.keys()].sort((left, right) => left.localeCompare(right));

	for (let round = 0; selected.size < target; round += 1) {
		let added = false;

		for (const kind of kinds) {
			if (selected.size >= target) {
				break;
			}

			const candidate = byKind.get(kind)?.[round];

			if (candidate !== undefined) {
				selected.set(sampleKey(candidate), candidate);
				added = true;
			}
		}

		if (!added) {
			break;
		}
	}
};

const fillRemaining = (sorted: readonly ReferenceSampleCandidateType[], selected: Map<string, ReferenceSampleCandidateType>, target: number): void => {
	for (const candidate of sorted) {
		if (selected.size >= target) {
			break;
		}

		selected.set(sampleKey(candidate), candidate);
	}
};

/**
 * Selects a deterministic, stratified sample of indexed symbols.
 *
 * The algorithm fulfils each required construct quota, then round-robins across
 * symbol kinds, then fills the remainder by stable key. Input order never
 * changes the result.
 *
 * @param candidates - Eligible symbols with their inferred construct tags.
 * @param target - Required sample size.
 * @returns Selected candidates sorted by stable key.
 */
export const selectReferenceSample = (
	candidates: readonly ReferenceSampleCandidateType[],
	target: number = REFERENCE_SAMPLE_TARGET,
): readonly ReferenceSampleCandidateType[] => {
	const sorted = [...candidates].sort(byStableKey);
	const selected = new Map<string, ReferenceSampleCandidateType>();

	selectConstructQuotas(sorted, selected);
	selectRoundRobin(groupByKind(sorted), selected, target);
	fillRemaining(sorted, selected, target);

	return [...selected.values()].sort(byStableKey);
};
