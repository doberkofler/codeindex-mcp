import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {artifactIdentityOf, artifactRefOf, type ArtifactIdentityType, type ArtifactRefType} from './artifact.ts';
import {assertEnvironmentMatches, environmentProbeOf, type EnvironmentManifestType} from './environment.ts';
import {catalogOf} from './mcp.ts';
import {type ReportMetadataType} from './report.ts';
import {writeJsonAtomic} from './result.ts';
import {canonicalTreatmentsOf, toolSurfaceOf, type ToolSurfaceType, type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';

/** Harness schema version recorded in every run identity. */
export const HARNESS_VERSION = 11;

/** Pause between executions to stay inside the provider's rolling window. */
export const PACE_MS = Number(process.env['EVAL_PACE_MS'] ?? 5000);

/** Directory containing the harness package. */
export const harnessRoot = path.resolve(import.meta.dirname, '..');

/** Directory holding suites, cases, reports, and generated run artifacts. */
export const evaluationRoot = path.resolve(process.env['EVALUATION_ROOT'] ?? path.join(harnessRoot, '..'));

export const argsOf = (argv: readonly string[]): Readonly<{command: string; flags: Map<string, string[]>}> => {
	const [command = 'help', ...rest] = argv;
	const flags = new Map<string, string[]>();

	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];

		if (token?.startsWith('--') !== true) {
			continue;
		}

		const next = rest[index + 1];
		const value = next === undefined || next.startsWith('--') ? 'true' : next;

		if (value !== 'true') {
			index += 1;
		}

		flags.set(token.slice(2), [...(flags.get(token.slice(2)) ?? []), value]);
	}

	return {command, flags};
};

export const flagOf = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.[0];
export const allOf = (flags: Map<string, string[]>, name: string): readonly string[] => flags.get(name) ?? [];

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const settingsOf = (): Readonly<{subjectRepo: string}> => {
	const file = path.join(harnessRoot, 'harness.json');
	const fallback = path.resolve(evaluationRoot, '..');

	if (!existsSync(file)) {
		return {subjectRepo: fallback};
	}

	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));

	if (!isRecord(parsed) || typeof parsed['subjectRepo'] !== 'string') {
		throw new TypeError('harness.json must declare "subjectRepo"');
	}

	return {subjectRepo: path.resolve(harnessRoot, parsed['subjectRepo'])};
};

export const throwManifestShape = (field: string): never => {
	throw new Error(`manifest field "${field}" has an invalid shape`);
};

export const componentsOf = (value: unknown): Readonly<Record<string, string | number>> => {
	if (!isRecord(value)) {
		throw new Error('manifest field "components" must be an object');
	}

	const components: Record<string, string | number> = {};

	for (const [key, component] of Object.entries(value)) {
		if (typeof component !== 'string' && typeof component !== 'number') {
			throw new TypeError('manifest field "components" may contain only string or number values');
		}

		components[key] = component;
	}

	return components;
};

/**
 * Reads the declared campaign facts a report must state.
 *
 * A report without a manifest cannot name its campaign, suite, component
 * versions, and claim class, so it is not written at all.
 *
 * @param directory - Campaign result directory.
 * @returns Manifest fields required by the report.
 */
export const manifestMetadataOf = (directory: string): ReportMetadataType => {
	const file = path.join(directory, 'manifest.json');

	if (!existsSync(file)) {
		throw new Error(`no campaign manifest at ${file}; a report requires declared campaign identity`);
	}

	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
	const record = isRecord(parsed) ? parsed : throwManifestShape('root');
	const suite = isRecord(record['suite']) ? record['suite'] : throwManifestShape('suite');
	const {campaignId} = record;
	const {schemaVersion} = record;
	const {claimClass} = record;
	const suiteId = suite['id'];
	const suiteVersion = suite['version'];
	const suiteHash = suite['hash'];
	const suiteStatus = suite['status'];

	if (typeof campaignId !== 'string' || typeof schemaVersion !== 'string' || typeof claimClass !== 'string') {
		throw new TypeError('manifest field "campaignId, schemaVersion, or claimClass" has an invalid shape');
	}

	if (typeof suiteId !== 'string' || typeof suiteVersion !== 'number' || typeof suiteHash !== 'string' || typeof suiteStatus !== 'string') {
		throw new TypeError('manifest field "suite" has an invalid shape');
	}

	return {
		campaignId,
		schemaVersion,
		suite: {id: suiteId, version: suiteVersion, hash: suiteHash, status: suiteStatus},
		components: componentsOf(record['components']),
		claimClass,
	};
};

export const treatmentsOf = (value: string | undefined, all: readonly TreatmentDefinitionType[]): readonly TreatmentDefinitionType[] => {
	const canonical = canonicalTreatmentsOf(all);

	if (value === undefined || value === 'all') {
		return canonical;
	}

	const requested = value.split(',').map((item) => item.trim());

	for (const id of requested) {
		if (!(canonical.map((treatment) => treatment.id) as readonly string[]).includes(id)) {
			throw new Error(`unsupported treatment "${id}"`);
		}
	}

	return canonical.filter((treatment) => requested.includes(treatment.id));
};

/**
 * Captures the exact tool-name list presented for every selected treatment.
 *
 * The ordinary list comes from the validated definition. The CodeIndex list
 * comes from the artifact's native MCP catalog. No model process starts before
 * every catalog has been captured.
 *
 * @param context - Workspace paths.
 * @param treatments - Selected treatment definitions.
 * @returns Surfaces keyed by treatment id and the artifact catalogs.
 */
export type WorkspacePathsType = Readonly<{
	artifactPath: (treatment: TreatmentDefinitionType) => string;
	artifactRoot: (treatment: TreatmentDefinitionType) => string;
	workspacePath: (treatment: TreatmentIdType) => string;
}>;

export const surfacesOf = async (
	context: WorkspacePathsType,
	treatments: readonly TreatmentDefinitionType[],
): Promise<ReadonlyMap<TreatmentIdType, ToolSurfaceType>> => {
	const surfaces = new Map<TreatmentIdType, ToolSurfaceType>();

	for (const treatment of treatments) {
		if (treatment.kind === 'no-index') {
			surfaces.set(treatment.id, toolSurfaceOf(treatment));
			continue;
		}

		const catalog = await catalogOf(context.artifactPath(treatment), context.workspacePath(treatment.id));

		if (catalog.tools.length === 0) {
			throw new Error(`treatment ${treatment.id} artifact presented an empty MCP tool catalog`);
		}

		const surface = toolSurfaceOf(treatment, catalog.tools);

		if (!surface.native || surface.tools.includes('execute')) {
			throw new Error(`treatment ${treatment.id} did not present a native MCP tool surface`);
		}

		surfaces.set(treatment.id, surface);
	}

	return surfaces;
};

export type ArtifactMapType = ReadonlyMap<TreatmentIdType, ArtifactIdentityType | null>;

/**
 * Verifies every selected artifact before any model starts.
 *
 * A CodeIndex treatment must present a complete package: a resolvable entry
 * point, every declared dependency, and a content digest that matches the
 * suite when the suite pins one. Every artifact is hashed so its identity can
 * be recorded even when no digest is declared.
 *
 * @param context - Workspace paths.
 * @param treatments - Selected treatment definitions.
 * @returns Verified identities keyed by treatment id, null for no-index.
 */
export const artifactsOf = (context: WorkspacePathsType, treatments: readonly TreatmentDefinitionType[]): ArtifactMapType => {
	const artifacts = new Map<TreatmentIdType, ArtifactIdentityType | null>();

	for (const treatment of treatments) {
		artifacts.set(treatment.id, treatment.artifact === null ? null : artifactIdentityOf(context.artifactRoot(treatment), treatment));
	}

	return artifacts;
};

/**
 * Builds the artifact references recorded with every result.
 *
 * @param artifacts - Verified identities for the selected treatments.
 * @param treatment - Treatment whose artifact the execution loads.
 * @returns Accepted, candidate, and loaded references.
 */
export const runArtifactsOf = (
	artifacts: ArtifactMapType,
	treatment: TreatmentDefinitionType,
): Readonly<{accepted: ArtifactRefType | null; candidate: ArtifactRefType | null; loaded: ArtifactRefType | null}> => ({
	accepted: artifactRefOf(artifacts.get('accepted') ?? null),
	candidate: artifactRefOf(artifacts.get('candidate') ?? null),
	loaded: artifactRefOf(artifacts.get(treatment.id) ?? null),
});

/**
 * Writes the campaign manifest once and verifies it on resume.
 *
 * A manifest change that alters the campaign identity defines a different
 * campaign; it must never rewrite an existing manifest in place.
 *
 * @param file - Manifest path.
 * @param manifest - Campaign manifest.
 */
export const ensureManifestAt = (file: string, manifest: Readonly<{campaignId: string; identityDigest: string}>): void => {
	if (!existsSync(file)) {
		writeJsonAtomic(file, manifest, false);
		return;
	}

	const existing: unknown = JSON.parse(readFileSync(file, 'utf8'));

	if (!isRecord(existing) || existing['campaignId'] !== manifest.campaignId || existing['identityDigest'] !== manifest.identityDigest) {
		throw new Error(`campaign manifest at ${file} describes a different campaign; use a new campaign directory`);
	}
};

/**
 * Resolves a manifest path against the evaluation root.
 *
 * @param flags - Parsed CLI flags.
 * @param name - Flag holding the path.
 * @returns Absolute manifest path.
 */
export const manifestPathOf = (flags: Map<string, string[]>, name: string): string => {
	const value = flagOf(flags, name);

	if (value === undefined || value === 'true') {
		throw new Error(`--${name} is required`);
	}

	return path.resolve(evaluationRoot, value);
};

/**
 * Measures the live environment and refuses a mismatch.
 *
 * @param environment - Committed environment manifest.
 */
export const verifiedEnvironmentOf = async (environment: EnvironmentManifestType): Promise<void> => {
	const probe = await environmentProbeOf({model: environment.model.reference, endpoint: environment.runtime.ollamaEndpoint});

	assertEnvironmentMatches(environment, probe);
};
