import {z} from 'zod';

import {type AdapterManifestType, type AdapterType} from './types.ts';

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
		sourceExtensions: z.array(z.string().min(1)).min(1),
		sourceExtensionsFor: callable<NonNullable<AdapterType['sourceExtensionsFor']>>().optional(),
		ignoredSegments: z.array(z.string()),
		limitations: z.array(z.string()),
		scan: callable<AdapterType['scan']>(),
		build: callable<AdapterType['build']>(),
		canReusePublishedFacts: callable<NonNullable<AdapterType['canReusePublishedFacts']>>().optional(),
		configFiles: callable<AdapterType['configFiles']>(),
		isSourceFile: callable<AdapterType['isSourceFile']>(),
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
		sourceExtensions: parsed.sourceExtensions,
		...(parsed.sourceExtensionsFor === undefined ? {} : {sourceExtensionsFor: parsed.sourceExtensionsFor}),
		ignoredSegments: parsed.ignoredSegments,
		limitations: parsed.limitations,
		scan: parsed.scan,
		build: parsed.build,
		...(parsed.canReusePublishedFacts === undefined ? {} : {canReusePublishedFacts: parsed.canReusePublishedFacts}),
		configFiles: parsed.configFiles,
		isSourceFile: parsed.isSourceFile,
	};
};
