import {parseAdapterWatchPlan, type AdapterWatchPlanType} from '@codeindex/adapter-sdk';

import {adapterConfigFor, type ConfigType} from '../config/config.ts';
import {AdapterContractError, type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';

const validatePlanIdentity = (target: AdapterTargetType, value: unknown): AdapterWatchPlanType => {
	const plan = parseAdapterWatchPlan(value);

	if (plan.adapterId !== target.adapter.id || plan.adapterVersion !== target.extractor.version) {
		throw new AdapterContractError(`Adapter ${target.adapter.id} returned a watch plan with mismatched identity`);
	}

	return plan;
};

/**
 * Builds adapter-owned plans for a bootstrap or authoritative scan set.
 *
 * @param config - Resolved workspace configuration.
 * @param targets - Configured adapter targets.
 * @param scans - Partial authoritative scans, or null for a full bootstrap.
 * @returns Validated plans in configured adapter order.
 */
export const createAdapterWatchPlans = (
	config: ConfigType,
	targets: readonly AdapterTargetType[],
	scans: readonly AdapterScanPlanType[] | null,
): readonly AdapterWatchPlanType[] => {
	const selected = scans === null ? targets : targets.filter((target) => scans.some((scan) => scan.adapterId === target.adapter.id));

	return selected.map((target) => {
		const scan = scans?.find((candidate) => candidate.adapterId === target.adapter.id)?.scan ?? null;
		const scoped = adapterConfigFor(config, target.adapter);
		return validatePlanIdentity(target, target.extractor.createWatchPlan(scoped, scan));
	});
};

/**
 * Reports whether persisted plans exactly match the configured adapter roster.
 *
 * @param plans - Persisted plans.
 * @param targets - Current adapter targets.
 * @returns True only for one identity-compatible plan per target.
 */
export const watchPlansMatchTargets = (plans: readonly AdapterWatchPlanType[], targets: readonly AdapterTargetType[]): boolean =>
	plans.length === targets.length &&
	targets.every((target) => plans.filter((plan) => plan.adapterId === target.adapter.id && plan.adapterVersion === target.extractor.version).length === 1);

/**
 * Replaces scanned adapters while preserving untouched logical plans.
 *
 * @param current - Previously installed roster.
 * @param updates - Plans produced by the latest scoped scan.
 * @param targets - Configured adapter order and identity.
 * @returns Complete roster in configured order.
 */
export const mergeAdapterWatchPlans = (
	current: readonly AdapterWatchPlanType[],
	updates: readonly AdapterWatchPlanType[],
	targets: readonly AdapterTargetType[],
): readonly AdapterWatchPlanType[] => {
	const byId = new Map(current.map((plan) => [plan.adapterId, plan]));

	for (const plan of updates) {
		byId.set(plan.adapterId, plan);
	}

	const merged = targets.flatMap((target) => {
		const plan = byId.get(target.adapter.id);
		return plan === undefined ? [] : [plan];
	});

	if (!watchPlansMatchTargets(merged, targets)) {
		throw new AdapterContractError('Watch-plan roster does not cover every configured adapter');
	}

	return merged;
};
