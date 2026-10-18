import {z} from 'zod';

export const ANALYTICS_SCHEMA_VERSION = 1;
export const ANALYTICS_MAX_BYTES = 10 * 1024 * 1024;
export const ANALYTICS_MAX_FILES = 10;
export const ANALYTICS_MAX_AGE_DAYS = 30;

/**
 * Field names that must never enter analytics.
 *
 * The writer rejects them before serialization so a careless call site fails a
 * test instead of leaking source, prompts, queries, or absolute paths.
 */
export const PROHIBITED_ANALYTICS_FIELDS: readonly string[] = [
	'source',
	'sourceText',
	'prompt',
	'prompts',
	'response',
	'responses',
	'query',
	'queryText',
	'symbol',
	'symbolName',
	'qualifiedName',
	'path',
	'absolutePath',
	'rootDir',
	'credentials',
	'token',
	'apiKey',
];

const BaseEventSchema = z.looseObject({
	schema: z.literal(ANALYTICS_SCHEMA_VERSION),
	id: z.string().min(1),
	timestamp: z.string().min(1),
	program: z.string().min(1),
	programVersion: z.string().min(1),
	projectId: z.string().min(1),
	workingCopyId: z.string().nullable(),
	event: z.string().min(1),
});

export type AnalyticsEventType = z.infer<typeof BaseEventSchema>;

const findProhibitedField = (value: unknown, seen: ReadonlySet<object>): string | null => {
	if (typeof value !== 'object' || value === null || seen.has(value)) {
		return null;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findProhibitedField(item, seen);

			if (found !== null) {
				return found;
			}
		}

		return null;
	}

	const nextSeen = new Set(seen).add(value);

	for (const [key, entry] of Object.entries(value)) {
		if (PROHIBITED_ANALYTICS_FIELDS.includes(key)) {
			return key;
		}

		const found = findProhibitedField(entry, nextSeen);

		if (found !== null) {
			return found;
		}
	}

	return null;
};

/**
 * Rejects fields that would leak source, prompts, queries, or filesystem paths.
 *
 * @param fields - Event-specific analytics fields.
 * @returns The same fields when they contain no prohibited key.
 * @throws {@link Error} When a prohibited field is present.
 */
export const assertAnalyticsFields = (fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
	const prohibited = findProhibitedField(fields, new Set());

	if (prohibited !== null) {
		throw new Error(`Analytics field is prohibited: ${prohibited}`);
	}

	return fields;
};

export const parseAnalyticsEvent = (value: unknown): AnalyticsEventType | null => {
	const parsed = BaseEventSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
};
