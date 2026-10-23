import {existsSync, readFileSync} from 'node:fs';
import {hashOf} from './hash.ts';
import {type TreatmentDefinitionType} from './treatment.ts';

/** Version of the committed canonical-artifact manifest. */
export const CANONICAL_ARTIFACT_SCHEMA_VERSION = 1 as const;

/**
 * One pinned CodeIndex artifact used as the fixed reference for local-model
 * qualification.
 *
 * The artifact is identified by a content digest, never by a moving tag,
 * branch, directory, or release name. Once selected, the same manifest and the
 * same digest are reused by every comparable model campaign, so a model
 * comparison changes only the pinned local environment.
 */
export type CanonicalArtifactType = Readonly<{
	schemaVersion: typeof CANONICAL_ARTIFACT_SCHEMA_VERSION;
	/** Artifact identifier recorded in the suite, manifest, and results. */
	id: string;
	/** Released package version the digest was taken from. */
	version: string;
	/** Artifact directory relative to the evaluation root. */
	root: string;
	/** Entry point relative to `root`. */
	entryPoint: string;
	/** Lowercase-hex SHA-256 over the sorted artifact file list. */
	digest: string;
	/** ISO 8601 date on which the digest was selected. */
	selectedAt: string;
	/** Why this artifact is a stable model-comparison reference. */
	rationale: string;
	/** Where the pinned files came from. Never a moving build directory. */
	source: string;
}>;

const CANONICAL_KEYS = new Set(['schemaVersion', 'id', 'version', 'root', 'entryPoint', 'digest', 'selectedAt', 'rationale', 'source']);

/**
 * Identifiers and roots owned by the moving frontier baseline.
 *
 * A qualification campaign must never present one of them as canonical, even
 * with a pinned digest: that would reintroduce the moving product candidate the
 * gate exists to exclude.
 */
const MOVING_ARTIFACT_IDS = new Set(['codeindex-mcp-accepted', 'codeindex-mcp-candidate']);
const MOVING_ARTIFACT_ROOTS = new Set(['artifacts/accepted', 'artifacts/candidate']);
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const requireObject = (value: unknown, context: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new Error(`${context} must be a JSON object`);
	}

	return value;
};

const requireString = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${context} field "${field}" must be a non-empty string`);
	}

	return value;
};

const requireRelativePath = (value: unknown, field: string, context: string): string => {
	const text = requireString(value, field, context);

	if (text.startsWith('/') || text.includes('\\') || text.split('/').includes('..')) {
		throw new Error(`${context} field "${field}" must be a relative POSIX path`);
	}

	return text;
};

/**
 * Validates one canonical-artifact manifest.
 *
 * A missing digest, an unpinned identifier, or a non-relative root is rejected:
 * no default can silently make a moving artifact look canonical.
 *
 * @param value - Parsed JSON value.
 * @returns The validated manifest.
 */
export const canonicalArtifactOf = (value: unknown): CanonicalArtifactType => {
	const record = requireObject(value, 'canonical artifact');
	const unknown = Object.keys(record)
		.filter((key) => !CANONICAL_KEYS.has(key))
		.sort();

	if (unknown.length > 0) {
		throw new Error(`canonical artifact has unknown field(s): ${unknown.join(', ')}`);
	}

	if (record['schemaVersion'] !== CANONICAL_ARTIFACT_SCHEMA_VERSION) {
		throw new Error(`canonical artifact field "schemaVersion" must be ${CANONICAL_ARTIFACT_SCHEMA_VERSION}`);
	}

	const id = requireString(record['id'], 'id', 'canonical artifact');

	if (!STABLE_ID.test(id)) {
		throw new Error(`canonical artifact field "id" must match ${STABLE_ID}`);
	}

	if (MOVING_ARTIFACT_IDS.has(id)) {
		throw new Error(`canonical artifact must not reuse the moving artifact id "${id}"`);
	}

	const root = requireRelativePath(record['root'], 'root', 'canonical artifact');

	if (MOVING_ARTIFACT_ROOTS.has(root)) {
		throw new Error(`canonical artifact must not reuse the moving artifact root "${root}"`);
	}

	const digest = requireString(record['digest'], 'digest', 'canonical artifact');

	if (!HEX_DIGEST.test(digest)) {
		throw new Error('canonical artifact field "digest" must be a 64-character lowercase hex digest');
	}

	const selectedAt = requireString(record['selectedAt'], 'selectedAt', 'canonical artifact');

	if (Number.isNaN(Date.parse(selectedAt))) {
		throw new TypeError('canonical artifact field "selectedAt" must be an ISO 8601 timestamp');
	}

	return {
		schemaVersion: CANONICAL_ARTIFACT_SCHEMA_VERSION,
		id,
		version: requireString(record['version'], 'version', 'canonical artifact'),
		root,
		entryPoint: requireRelativePath(record['entryPoint'], 'entryPoint', 'canonical artifact'),
		digest,
		selectedAt,
		rationale: requireString(record['rationale'], 'rationale', 'canonical artifact'),
		source: requireString(record['source'], 'source', 'canonical artifact'),
	};
};

/**
 * Reads and validates the committed canonical-artifact manifest.
 *
 * @param file - Absolute manifest path.
 * @returns The validated manifest.
 */
export const loadCanonicalArtifact = (file: string): CanonicalArtifactType => {
	if (!existsSync(file)) {
		throw new Error(`canonical artifact manifest is missing: ${file}`);
	}

	return canonicalArtifactOf(JSON.parse(readFileSync(file, 'utf8')) as unknown);
};

/**
 * Hashes the complete canonical-artifact manifest.
 *
 * @param artifact - Validated manifest.
 * @returns Lowercase hex SHA-256 digest.
 */
export const canonicalArtifactHashOf = (artifact: CanonicalArtifactType): string => hashOf(artifact);

/**
 * Requires the suite's canonical treatment to present exactly the pinned
 * artifact.
 *
 * A changed root, entry point, identifier, or missing digest is a different
 * artifact and is rejected before any workspace or model process starts.
 *
 * @param artifact - Committed canonical-artifact manifest.
 * @param treatment - The suite's canonical treatment definition.
 */
export const assertCanonicalTreatmentOf = (artifact: CanonicalArtifactType, treatment: TreatmentDefinitionType): void => {
	if (treatment.id !== 'canonical') {
		throw new Error(`expected the canonical treatment, found "${treatment.id}"`);
	}

	if (treatment.artifact === null) {
		throw new Error(`canonical treatment ${treatment.id} declares no artifact`);
	}

	const declared = treatment.artifact;

	if (declared.id !== artifact.id) {
		throw new Error(`canonical artifact identity mismatch: suite declares "${declared.id}", manifest pins "${artifact.id}"`);
	}

	if (declared.root !== artifact.root) {
		throw new Error(`canonical artifact root mismatch: suite declares "${declared.root}", manifest pins "${artifact.root}"`);
	}

	if (declared.entryPoint !== artifact.entryPoint) {
		throw new Error(`canonical artifact entry point mismatch: suite declares "${declared.entryPoint}", manifest pins "${artifact.entryPoint}"`);
	}

	if (declared.digest === null) {
		throw new Error(`canonical treatment ${treatment.id} does not pin an artifact digest`);
	}

	if (declared.digest !== artifact.digest) {
		throw new Error(`canonical artifact digest mismatch: suite declares ${declared.digest}, manifest pins ${artifact.digest}`);
	}
};
