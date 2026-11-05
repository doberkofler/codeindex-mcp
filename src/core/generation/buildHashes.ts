import {type GenerationAdapterType} from '../model.ts';
import {type AdapterHashEntryType, type AdapterScanPlanType, type AdapterTargetType, AdapterContractError} from './adapterBuild.ts';
import {adapterMatchesScan} from './adapterCommit.ts';

const absentHashEntry = (adapterId: string, reason: string | null): AdapterHashEntryType => {
	const marker = `absent:${reason ?? 'unknown'}`;
	return {adapterId, coverage: 'absent', reason, sourceHash: marker, configHash: marker, inputHash: marker};
};

/**
 * Combines scanned adapter inputs with persisted inputs for unscanned adapters.
 *
 * A targeted refresh captures only the invalidated adapters. The combined
 * generation fingerprint must still describe every configured adapter, so an
 * untouched adapter contributes its persisted hash unchanged.
 *
 * @param scans - Captured scan plans.
 * @param previousAdapters - Persisted adapter rows for the published generation.
 * @param targets - Every configured adapter.
 * @returns Combined source, configuration, and input hashes.
 * @throws {@link AdapterContractError} When an unscanned adapter has no persisted row.
 */
export const hashEntriesOf = (
	scans: readonly AdapterScanPlanType[],
	previousAdapters: readonly GenerationAdapterType[],
	targets: readonly AdapterTargetType[],
): readonly AdapterHashEntryType[] => {
	const scanned = new Map(scans.map((plan) => [plan.adapterId, plan]));
	const previous = new Map(previousAdapters.map((adapter) => [adapter.adapterId, adapter]));

	return targets.map((target) => {
		const adapterId = target.adapter.id;
		const plan = scanned.get(adapterId);

		if (plan !== undefined) {
			if (plan.coverage === 'absent' || plan.scan === null) {
				return absentHashEntry(adapterId, plan.absenceReason);
			}

			return {
				adapterId,
				coverage: 'present',
				reason: null,
				sourceHash: plan.scan.sourceHash,
				configHash: plan.scan.configHash,
				inputHash: plan.scan.inputHash ?? plan.scan.configHash,
			};
		}

		const stored = previous.get(adapterId);

		if (stored === undefined) {
			throw new AdapterContractError(`A targeted refresh has no persisted adapter row for ${adapterId}`);
		}

		return {
			adapterId,
			coverage: stored.coverage,
			reason: stored.absenceReason,
			sourceHash: stored.sourceHash,
			configHash: stored.configHash,
			inputHash: stored.inputHash,
		};
	});
};

/**
 * Rebuilds hash entries for adapters whose contribution was preserved.
 *
 * @param targets - Every configured adapter.
 * @param extracted - Adapter identifiers already contributed by this attempt.
 * @param previous - Persisted adapter rows keyed by identifier.
 * @returns Hash entries for the untouched adapters.
 * @throws {@link AdapterContractError} When a preserved adapter has no stored row.
 */
export const preservedHashEntries = (
	targets: readonly AdapterTargetType[],
	extracted: ReadonlySet<string>,
	previous: ReadonlyMap<string, GenerationAdapterType>,
): readonly AdapterHashEntryType[] =>
	targets
		.filter((target) => !extracted.has(target.adapter.id))
		.map((target) => {
			const stored = previous.get(target.adapter.id);

			if (stored === undefined) {
				throw new AdapterContractError(`A targeted refresh omitted adapter ${target.adapter.id} without a persisted row`);
			}

			return {
				adapterId: stored.adapterId,
				coverage: stored.coverage,
				reason: stored.absenceReason,
				sourceHash: stored.sourceHash,
				configHash: stored.configHash,
				inputHash: stored.inputHash,
			};
		});

const planMatchesPrevious = (plan: AdapterScanPlanType, previous: GenerationAdapterType | undefined, target: AdapterTargetType): boolean => {
	if (plan.coverage === 'absent' || plan.scan === null) {
		return previous?.coverage === 'absent' && previous.absenceReason === plan.absenceReason;
	}

	return previous !== undefined && adapterMatchesScan(previous, plan.scan, target);
};

/**
 * Reports whether every scanned adapter still matches its persisted row.
 *
 * @param plans - Scanned adapter plans.
 * @param previousAdapters - Persisted adapter rows for the published generation.
 * @param targets - Every configured adapter.
 * @returns True when a targeted refresh has nothing to publish.
 */
export const plansMatchPrevious = (
	plans: readonly AdapterScanPlanType[],
	previousAdapters: readonly GenerationAdapterType[],
	targets: readonly AdapterTargetType[],
): boolean => {
	const previous = new Map(previousAdapters.map((adapter) => [adapter.adapterId, adapter]));
	const targetById = new Map(targets.map((target) => [target.adapter.id, target]));

	return plans.every((plan) => {
		const target = targetById.get(plan.adapterId);
		return target !== undefined && planMatchesPrevious(plan, previous.get(plan.adapterId), target);
	});
};
