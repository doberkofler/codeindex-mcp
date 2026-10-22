import {existsSync, readFileSync} from 'node:fs';
import {generationOf, rejectUnknownKeys, requireObject, requireStableId, requireString} from './environmentFields.ts';
import {type GenerationSettingsType} from './environment.ts';
import {hashOf} from './hash.ts';

/** Version of the hosted-reference manifest understood by the harness. */
export const HOSTED_REFERENCE_SCHEMA_VERSION = 1 as const;

/** Exact client runtime that submitted the hosted requests. */
export type HostedRuntimeType = Readonly<{
	opencode: string;
}>;

/**
 * Immutable identity of one hosted reference model.
 *
 * A hosted provider exposes no local artifact digest. The exact provider,
 * model ID, release date, client runtime, and generation settings are therefore
 * pinned together and hashed into one identity. A change to any of them is a
 * different reference and starts a new paired baseline.
 */
export type HostedReferenceType = Readonly<{
	schemaVersion: typeof HOSTED_REFERENCE_SCHEMA_VERSION;
	id: string;
	recordedAt: string;
	provider: string;
	modelId: string;
	/** Suite model reference, always `<provider>/<modelId>`. */
	reference: string;
	/** Provider release date of the exact model ID. */
	releasedAt: string;
	runtime: HostedRuntimeType;
	generation: GenerationSettingsType;
}>;

const HOSTED_REFERENCE_KEYS = new Set(['schemaVersion', 'id', 'recordedAt', 'provider', 'modelId', 'reference', 'releasedAt', 'runtime', 'generation']);
const HOSTED_RUNTIME_KEYS = new Set(['opencode']);

const requireTimestamp = (value: unknown, field: string): string => {
	const text = requireString(value, field, 'hosted reference');

	if (Number.isNaN(Date.parse(text))) {
		throw new TypeError(`hosted reference field "${field}" must be an ISO 8601 timestamp`);
	}

	return text;
};

const runtimeOf = (value: unknown): HostedRuntimeType => {
	const record = requireObject(value, 'hosted reference field "runtime"');

	rejectUnknownKeys(record, HOSTED_RUNTIME_KEYS, 'hosted reference field "runtime"');

	return {opencode: requireString(record['opencode'], 'runtime.opencode', 'hosted reference')};
};

/**
 * Validates one hosted-reference manifest.
 *
 * Every identity field is required. A missing field is rejected instead of
 * defaulted, because a default would silently describe a different model.
 *
 * @param value - Parsed JSON value.
 * @returns The validated hosted reference.
 */
export const hostedReferenceOf = (value: unknown): HostedReferenceType => {
	const record = requireObject(value, 'hosted reference');

	rejectUnknownKeys(record, HOSTED_REFERENCE_KEYS, 'hosted reference');

	if (record['schemaVersion'] !== HOSTED_REFERENCE_SCHEMA_VERSION) {
		throw new Error(`hosted reference field "schemaVersion" must be ${HOSTED_REFERENCE_SCHEMA_VERSION}`);
	}

	const provider = requireString(record['provider'], 'provider', 'hosted reference');
	const modelId = requireString(record['modelId'], 'modelId', 'hosted reference');
	const reference = requireString(record['reference'], 'reference', 'hosted reference');

	if (reference !== `${provider}/${modelId}`) {
		throw new Error(`hosted reference "${reference}" must equal provider/modelId "${provider}/${modelId}"`);
	}

	return {
		schemaVersion: HOSTED_REFERENCE_SCHEMA_VERSION,
		id: requireStableId(record['id'], 'id', 'hosted reference'),
		recordedAt: requireTimestamp(record['recordedAt'], 'recordedAt'),
		provider,
		modelId,
		reference,
		releasedAt: requireTimestamp(record['releasedAt'], 'releasedAt'),
		runtime: runtimeOf(record['runtime']),
		generation: generationOf(record['generation'], 'hosted reference'),
	};
};

/**
 * Reads and validates one committed hosted reference.
 *
 * @param file - Absolute manifest path.
 * @returns The validated hosted reference.
 */
export const loadHostedReference = (file: string): HostedReferenceType => {
	if (!existsSync(file)) {
		throw new Error(`hosted reference is missing: ${file}`);
	}

	return hostedReferenceOf(JSON.parse(readFileSync(file, 'utf8')) as unknown);
};

/**
 * Hashes the complete hosted identity.
 *
 * The digest participates in campaign identity, so a changed provider, model
 * ID, release, client runtime, or generation setting plans a new campaign and
 * can never reuse a historical paired baseline.
 *
 * @param reference - Validated hosted reference.
 * @returns Lowercase hex SHA-256 digest.
 */
export const hostedReferenceHashOf = (reference: HostedReferenceType): string => hashOf(reference);

/**
 * Requires the suite to declare exactly the pinned hosted reference.
 *
 * @param reference - Validated hosted reference.
 * @param model - Suite model reference.
 */
export const assertHostedModel = (reference: HostedReferenceType, model: string): void => {
	if (reference.reference !== model) {
		throw new Error(`hosted reference pins "${reference.reference}" but the suite declares "${model}"`);
	}
};
