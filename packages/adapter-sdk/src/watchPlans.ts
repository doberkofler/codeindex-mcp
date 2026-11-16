import {createHash} from 'node:crypto';

import {parseAdapterWatchPlan} from './schema.ts';
import {ADAPTER_WATCH_PLAN_VERSION, type AdapterWatchPlanType} from './watchPlanTypes.ts';

type WatchPlanInputType = Omit<AdapterWatchPlanType, 'planId' | 'planVersion'>;

/**
 * Validates and identifies one deterministic adapter watch plan.
 *
 * @param input - Relative-path-only plan contents.
 * @returns Validated plan with its representation and content identities.
 */
export const defineAdapterWatchPlan = (input: WatchPlanInputType): AdapterWatchPlanType => {
	const planId = createHash('sha256').update(JSON.stringify(input)).digest('hex');
	return parseAdapterWatchPlan({...input, planVersion: ADAPTER_WATCH_PLAN_VERSION, planId});
};
