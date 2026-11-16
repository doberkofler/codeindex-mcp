import {z} from 'zod';

import {type AdapterManifestType, type AdapterType} from './types.ts';
import {ADAPTER_WATCH_PLAN_VERSION, type AdapterWatchPlanType} from './watchPlanTypes.ts';

const isSafeRelativePath = (value: string, allowEmpty: boolean): boolean =>
	(allowEmpty || value.length > 0) &&
	!value.startsWith('/') &&
	!/^[A-Za-z]:\//u.test(value) &&
	!value.includes('\\') &&
	!value.split('/').includes('..') &&
	!value.includes('\0');

const RepositoryPathSchema = z
	.string()
	.max(4096)
	.refine((value) => isSafeRelativePath(value, false));
const RepositoryDirectorySchema = z
	.string()
	.max(4096)
	.refine((value) => isSafeRelativePath(value, true));
const WatchRuleSchema = z.discriminatedUnion('kind', [
	z.object({kind: z.literal('glob'), pattern: RepositoryPathSchema}),
	z.object({kind: z.literal('prefix'), path: RepositoryDirectorySchema}),
	z.object({
		kind: z.literal('suffix'),
		suffix: z
			.string()
			.min(1)
			.max(128)
			.refine((value) => !value.includes('/') && !value.includes('\\')),
	}),
	z.object({
		kind: z.literal('segment'),
		segment: z
			.string()
			.min(1)
			.max(255)
			.refine((value) => !value.includes('/') && !value.includes('\\')),
		ignoreCase: z.boolean().optional(),
	}),
]);
const AdapterWatchScopeSchema = z.object({
	candidateRoots: z.array(RepositoryDirectorySchema),
	includeRules: z.array(WatchRuleSchema),
	excludeRules: z.array(WatchRuleSchema),
	sourceRules: z.array(WatchRuleSchema).min(1),
});
const AdapterWatchPlanSchema = z.object({
	adapterId: z.string().regex(/^\w[\w.-]*$/u),
	adapterVersion: z.string().min(1).max(120),
	planVersion: z.literal(ADAPTER_WATCH_PLAN_VERSION),
	planId: z.string().min(1).max(128),
	knownSourceFiles: z.array(RepositoryPathSchema),
	inputFiles: z.array(RepositoryPathSchema),
	scopes: z.array(AdapterWatchScopeSchema).min(1),
});

const AdapterManifestSchema = z
	.object({
		protocolVersion: z.number().int().positive(),
		id: z.string().regex(/^\w[\w.-]*$/u),
		implementationVersion: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u),
		displayName: z.string().min(1).max(120),
	})
	.loose();

const callable = <FunctionType extends (...args: never[]) => unknown>(): z.ZodType<FunctionType> =>
	z.custom<FunctionType>((value) => typeof value === 'function');

const AdapterSurfaceSchema = z
	.object({
		id: z.string().min(1),
		version: z.string().min(1),
		displayName: z.string().min(1),
		discoveryText: z.string(),
		absenceReasons: z.array(z.string().min(1)).optional(),
		probe: callable<NonNullable<AdapterType['probe']>>().optional(),
		normalizeQueryName: callable<NonNullable<AdapterType['normalizeQueryName']>>().optional(),
		limitations: z.array(z.string()),
		createWatchPlan: callable<AdapterType['createWatchPlan']>(),
		scan: callable<AdapterType['scan']>(),
		build: callable<AdapterType['build']>(),
		canReusePublishedFacts: callable<NonNullable<AdapterType['canReusePublishedFacts']>>().optional(),
		dispose: callable<NonNullable<AdapterType['dispose']>>().optional(),
	})
	.loose();

/**
 * Validates an adapter manifest from an external module.
 *
 * @param value - Untrusted manifest export.
 * @returns The validated manifest.
 * @throws {@link z.ZodError} When the manifest is malformed.
 */
export const parseAdapterManifest = (value: unknown): AdapterManifestType => {
	const parsed = AdapterManifestSchema.parse(value);

	return {
		protocolVersion: parsed.protocolVersion,
		id: parsed.id,
		implementationVersion: parsed.implementationVersion,
		displayName: parsed.displayName,
	};
};

/**
 * Returns the runtime schema used to validate adapter manifests.
 *
 * @returns The manifest schema.
 */
export const adapterManifestSchema = (): typeof AdapterManifestSchema => AdapterManifestSchema;

/**
 * Validates one serializable adapter watch plan.
 *
 * @param value - Untrusted adapter or persisted plan data.
 * @returns A relative-path-only watch plan.
 * @throws {@link z.ZodError} When the plan is malformed or leaks an absolute path.
 */
export const parseAdapterWatchPlan = (value: unknown): AdapterWatchPlanType => AdapterWatchPlanSchema.parse(value);

/**
 * Validates a complete persisted watch-plan roster.
 *
 * @param value - Untrusted decoded persistence or worker data.
 * @returns Validated watch plans.
 * @throws {@link z.ZodError} When any plan is malformed.
 */
export const parseAdapterWatchPlans = (value: unknown): readonly AdapterWatchPlanType[] => z.array(AdapterWatchPlanSchema).parse(value);

/**
 * Validates the value returned by an adapter factory.
 *
 * @param value - Untrusted factory result.
 * @returns The validated adapter surface.
 * @throws {@link z.ZodError} When the surface is malformed.
 */
export const parseAdapterSurface = (value: unknown): AdapterType => {
	const parsed = AdapterSurfaceSchema.parse(value);

	return {
		id: parsed.id,
		version: parsed.version,
		displayName: parsed.displayName,
		discoveryText: parsed.discoveryText,
		...(parsed.absenceReasons === undefined ? {} : {absenceReasons: parsed.absenceReasons}),
		...(parsed.probe === undefined ? {} : {probe: parsed.probe}),
		...(parsed.normalizeQueryName === undefined ? {} : {normalizeQueryName: parsed.normalizeQueryName}),
		limitations: parsed.limitations,
		createWatchPlan: parsed.createWatchPlan,
		scan: parsed.scan,
		build: parsed.build,
		...(parsed.canReusePublishedFacts === undefined ? {} : {canReusePublishedFacts: parsed.canReusePublishedFacts}),
		...(parsed.dispose === undefined ? {} : {dispose: parsed.dispose}),
	};
};
