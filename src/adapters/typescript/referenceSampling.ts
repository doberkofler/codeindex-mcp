import {createHash} from 'node:crypto';
import {type IndexedSymbolType} from '../../core/model.ts';
import {REFERENCE_CONSTRUCT_QUOTA, REFERENCE_CONSTRUCT_TAGS, type ReferenceConstructTagType} from './referenceConstructs.ts';

export const REFERENCE_SAMPLE_TARGET = 200;

/**
 * Fixed seed for the post-quota sample.
 *
 * Changing the seed changes which symbols are audited, so it is part of the
 * verifier's contract and must be changed only with the acceptance baseline.
 */
const REFERENCE_SAMPLE_SEED = 'codeindex-typescript-reference-sample-v1';

export type ReferenceSampleCandidateType = Readonly<{
	readonly symbol: IndexedSymbolType;
	readonly tags: readonly ReferenceConstructTagType[];
}>;

const sampleKey = (candidate: ReferenceSampleCandidateType): string =>
	[candidate.symbol.kind, candidate.symbol.path, String(candidate.symbol.startOffset), candidate.symbol.qualifiedName].join('\u0000');

const hashKey = (candidate: ReferenceSampleCandidateType): string =>
	createHash('sha256')
		.update(`${REFERENCE_SAMPLE_SEED}\u0000${sampleKey(candidate)}`, 'utf8')
		.digest('hex');

const byStableKey = (left: ReferenceSampleCandidateType, right: ReferenceSampleCandidateType): number => sampleKey(left).localeCompare(sampleKey(right));

/**
 * Orders candidates by a fixed-seed hash.
 *
 * Hashing is independent of input order and distributes symbols across paths and
 * kinds, so the post-quota remainder is a sample rather than an alphabetical
 * prefix.
 *
 * @param candidates - Eligible symbols.
 * @returns Candidates ordered by fixed-seed hash, then stable key.
 */
const hashOrder = (candidates: readonly ReferenceSampleCandidateType[]): readonly ReferenceSampleCandidateType[] => {
	const hashes = new Map(candidates.map((candidate) => [sampleKey(candidate), hashKey(candidate)]));

	return [...candidates].sort((left, right) => {
		const leftHash = hashes.get(sampleKey(left)) ?? '';
		const rightHash = hashes.get(sampleKey(right)) ?? '';
		return leftHash.localeCompare(rightHash) || byStableKey(left, right);
	});
};

const selectConstructQuotas = (ordered: readonly ReferenceSampleCandidateType[], selected: Map<string, ReferenceSampleCandidateType>): void => {
	for (const tag of REFERENCE_CONSTRUCT_TAGS) {
		const members = ordered.filter((candidate) => candidate.tags.includes(tag));

		for (const candidate of members.slice(0, REFERENCE_CONSTRUCT_QUOTA)) {
			selected.set(sampleKey(candidate), candidate);
		}
	}
};

const groupByKind = (ordered: readonly ReferenceSampleCandidateType[]): ReadonlyMap<string, readonly ReferenceSampleCandidateType[]> => {
	const byKind = new Map<string, ReferenceSampleCandidateType[]>();

	for (const candidate of ordered) {
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

const fillRemaining = (ordered: readonly ReferenceSampleCandidateType[], selected: Map<string, ReferenceSampleCandidateType>, target: number): void => {
	for (const candidate of ordered) {
		if (selected.size >= target) {
			break;
		}

		selected.set(sampleKey(candidate), candidate);
	}
};

/**
 * Selects a deterministic, stratified sample of indexed symbols.
 *
 * The algorithm fulfils each required construct quota first, then round-robins
 * across symbol kinds, then fills the remainder in fixed-seed hash order. Input
 * order never changes the result.
 *
 * @param candidates - Eligible symbols with their inferred construct tags.
 * @param target - Required sample size.
 * @returns Selected candidates sorted by stable key.
 */
export const selectReferenceSample = (
	candidates: readonly ReferenceSampleCandidateType[],
	target: number = REFERENCE_SAMPLE_TARGET,
): readonly ReferenceSampleCandidateType[] => {
	const stable = [...candidates].sort(byStableKey);
	const ordered = hashOrder(candidates);
	const selected = new Map<string, ReferenceSampleCandidateType>();

	selectConstructQuotas(stable, selected);
	selectRoundRobin(groupByKind(ordered), selected, target);
	fillRemaining(ordered, selected, target);

	return [...selected.values()].sort(byStableKey);
};
