import {createHash} from 'node:crypto';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Serializes a JSON value with recursively sorted object keys.
 *
 * Arrays keep their declared order. Only JSON values are accepted so two
 * semantically equal documents always produce the same bytes.
 *
 * @param value - JSON value.
 * @returns Canonical JSON text.
 */
const encodePrimitive = (value: string | number | boolean): string => {
	const encoded = JSON.stringify(value);

	return encoded;
};

export const canonicalJson = (value: unknown): string => {
	if (value === null) {
		return 'null';
	}

	if (typeof value === 'string' || typeof value === 'boolean') {
		return encodePrimitive(value);
	}

	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new TypeError('canonical JSON does not support non-finite numbers');
		}

		return encodePrimitive(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
	}

	if (isRecord(value)) {
		const entries = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);

		return `{${entries.join(',')}}`;
	}

	throw new Error(`canonical JSON does not support ${typeof value} values`);
};

/**
 * Hashes a JSON value deterministically for suites, cases, treatments, and run
 * identity.
 *
 * @param value - JSON-serializable value.
 * @returns Hex digest.
 */
export const hashOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
