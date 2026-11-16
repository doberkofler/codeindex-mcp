import {type AdapterModuleType} from './types.ts';

export {ADAPTER_PROTOCOL_VERSION} from './types.ts';
export {ADAPTER_WATCH_PLAN_VERSION} from './watchPlanTypes.ts';
export {parseAdapterWatchPlan, parseAdapterWatchPlans} from './schema.ts';
export type * from './types.ts';
export * from './debug.ts';
export * from './paths.ts';
export * from './sourceFiles.ts';
export {defineAdapterWatchPlan} from './watchPlans.ts';

/**
 * Declares one adapter module with author-time type checking.
 *
 * The envelope is frozen, but the host still validates external modules at
 * runtime. `create()` must return a fresh instance on every call.
 *
 * @param adapterModule - Manifest and factory.
 * @returns The frozen module envelope.
 */
export const defineAdapter = (adapterModule: AdapterModuleType): AdapterModuleType => ({
	manifest: Object.freeze({...adapterModule.manifest}),
	create: adapterModule.create,
});
