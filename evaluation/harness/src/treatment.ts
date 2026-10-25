import {exposureDifferencesOf} from './exposureEquivalence.ts';
import {hashOf} from './hash.ts';

/** The accepted three-treatment frontier model. Order defines plan order. */
export const TREATMENT_IDS = ['no-index', 'accepted', 'candidate'] as const;

/**
 * The independent local-model qualification model: one plain baseline and one
 * fixed canonical CodeIndex artifact. It never contains a moving candidate.
 */
export const QUALIFICATION_TREATMENT_IDS = ['no-index', 'canonical'] as const;

/**
 * The paired exposure comparison model: one artifact presented natively and
 * the same artifact reached through OpenCode's Code Mode `execute` boundary.
 */
export const EXPOSURE_TREATMENT_IDS = ['direct-mcp', 'code-mode'] as const;

/** Every treatment id the harness understands, in canonical plan order. */
export const ALL_TREATMENT_IDS = [...TREATMENT_IDS, 'canonical', ...EXPOSURE_TREATMENT_IDS] as const;

export type TreatmentIdType = (typeof ALL_TREATMENT_IDS)[number];

/** A treatment either withholds CodeIndex or presents one artifact of it. */
export const TREATMENT_KINDS = ['no-index', 'codeindex'] as const;

export type TreatmentKindType = (typeof TREATMENT_KINDS)[number];

/**
 * Native MCP tools are presented directly, or reached through the generic
 * Code Mode `execute` tool. The standard frontier and qualification models stay
 * direct only.
 */
export const CODE_MODE_POLICIES = ['absent', 'present'] as const;

export type CodeModePolicyType = (typeof CODE_MODE_POLICIES)[number];

/** One CodeIndex artifact presented by a treatment. */
export type ArtifactType = Readonly<{
	id: string;
	/** Directory relative to the harness root. */
	root: string;
	/** Entry point relative to `root`. */
	entryPoint: string;
	/** Optional declared digest, verified by the artifact-verification stage. */
	digest: string | null;
}>;

/** The MCP surface a CodeIndex treatment presents. */
export type McpType = Readonly<{
	server: string;
	/** Native tool presentation when true; Code Mode wrapping when false. */
	codemode: boolean;
}>;

/** A fully validated treatment definition. */
export type TreatmentDefinitionType = Readonly<{
	id: TreatmentIdType;
	kind: TreatmentKindType;
	/** Exact ordinary tool names presented to the model, sorted. */
	ordinaryTools: readonly string[];
	codeMode: CodeModePolicyType;
	artifact: ArtifactType | null;
	mcp: McpType | null;
	definitionHash: string;
}>;

/** The exact tool-name surface presented to the model for one treatment. */
export type ToolSurfaceType = Readonly<{
	treatmentId: TreatmentIdType;
	/** Declared ordinary tool names, sorted. */
	ordinary: readonly string[];
	/** Native MCP names the artifact presents, with the OpenCode server prefix. */
	codeIndex: readonly string[];
	execute: CodeModePolicyType;
	/** Names presented on agent request 1, sorted. */
	tools: readonly string[];
	/** Every name the treatment's permission rules admit, sorted. */
	permitted?: readonly string[];
	/**
	 * Every name the model can call for the declared ordinary tools.
	 *
	 * `edit` also makes `write` and `patch` callable, and `bash` is emitted as
	 * `shell`, so routing must accept those aliases even though the treatment
	 * declares one permission each.
	 */
	callable: readonly string[];
	/** True when every CodeIndex tool is a native `<server>_<tool>` name. */
	native: boolean;
	digest: string;
}>;

/** Observed routing for one execution. */
export type RoutingType = Readonly<{
	ordinaryCalls: number;
	codeIndexCalls: number;
	executeCalls: number;
	/** Tool names that are not in the captured surface. */
	unknownTools: readonly string[];
	/** True when no generic `execute` call was made. */
	native: boolean;
}>;

const TREATMENT_KEYS = new Set(['id', 'kind', 'ordinaryTools', 'codeMode', 'artifact', 'mcp']);
const ARTIFACT_KEYS = new Set(['id', 'root', 'entryPoint', 'digest']);
const MCP_KEYS = new Set(['server', 'codemode']);
const TOOL_NAME = /^\w[\w.:-]*$/iu;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const rejectUnknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void => {
	const unknown = Object.keys(value)
		.filter((key) => !allowed.has(key))
		.sort();

	if (unknown.length > 0) {
		throw new Error(`${context} has unknown field(s): ${unknown.join(', ')}`);
	}
};

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

const requireToolNames = (value: unknown, field: string, context: string): readonly string[] => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${context} field "${field}" must be a non-empty array of tool names`);
	}

	const names = value.map((item) => requireString(item, field, context));

	for (const name of names) {
		if (!TOOL_NAME.test(name)) {
			throw new Error(`${context} field "${field}" contains invalid tool name "${name}"`);
		}
	}

	if (new Set(names).size !== names.length) {
		throw new Error(`${context} field "${field}" must not contain duplicates`);
	}

	return [...names].sort();
};

const requireHexDigest = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || !HEX_DIGEST.test(value)) {
		throw new Error(`${context} field "${field}" must be a 64-character lowercase hex digest`);
	}

	return value;
};

const artifactOf = (value: unknown, context: string): ArtifactType => {
	const record = requireObject(value, `${context} field "artifact"`);
	rejectUnknownKeys(record, ARTIFACT_KEYS, `${context} field "artifact"`);
	const {digest} = record;

	return {
		id: requireString(record['id'], 'artifact.id', context),
		root: requireRelativePath(record['root'], 'artifact.root', context),
		entryPoint: requireRelativePath(record['entryPoint'], 'artifact.entryPoint', context),
		digest: digest === undefined || digest === null ? null : requireHexDigest(digest, 'artifact.digest', context),
	};
};

const mcpOf = (value: unknown, context: string): McpType => {
	const record = requireObject(value, `${context} field "mcp"`);
	rejectUnknownKeys(record, MCP_KEYS, `${context} field "mcp"`);

	if (typeof record['codemode'] !== 'boolean') {
		throw new TypeError(`${context} field "mcp.codemode" must be a boolean`);
	}

	return {
		server: requireString(record['server'], 'mcp.server', context),
		codemode: record['codemode'],
	};
};

/**
 * Computes the hash of one normalized treatment definition.
 *
 * The definition is data: every field that can change the model's environment
 * participates, so a changed artifact, tool list, or MCP configuration cannot
 * retain the previous identity.
 *
 * @param definition - Normalized definition without its hash.
 * @returns Hex digest.
 */
export const treatmentHashOf = (definition: unknown): string => hashOf(definition);

/**
 * Rejects a treatment whose kind, artifact, and MCP declaration disagree.
 *
 * @param input - Validated treatment facts.
 */
const assertTreatmentShapeOf = (
	input: Readonly<{
		id: TreatmentIdType;
		kind: string;
		codeMode: CodeModePolicyType;
		artifact: ArtifactType | null;
		mcp: McpType | null;
	}>,
): void => {
	const {id, kind, codeMode, artifact, mcp} = input;

	if (id === 'no-index') {
		if (kind !== 'no-index' || codeMode !== 'absent' || artifact !== null || mcp !== null) {
			throw new Error('no-index treatment must use kind "no-index", codeMode "absent", and declare neither artifact nor mcp');
		}

		return;
	}

	if (kind !== 'codeindex' || artifact === null || mcp === null) {
		throw new Error(`${id} treatment must use kind "codeindex" and declare both artifact and mcp`);
	}

	if (id === 'code-mode') {
		if (codeMode !== 'present' || !mcp.codemode) {
			throw new Error('code-mode treatment must declare codeMode "present" and mcp.codemode true');
		}

		return;
	}

	if (codeMode !== 'absent' || mcp.codemode) {
		throw new Error(`${id} treatment must declare codeMode "absent" and mcp.codemode false`);
	}
};

/**
 * Validates and hashes one treatment definition.
 *
 * @param value - Parsed JSON value.
 * @param context - Document scope used in error messages.
 * @returns The validated definition with its hash.
 */
export const treatmentOf = (value: unknown, context = 'treatment'): TreatmentDefinitionType => {
	const record = requireObject(value, context);
	rejectUnknownKeys(record, TREATMENT_KEYS, context);

	const id = requireString(record['id'], 'id', context);
	const treatmentId = ALL_TREATMENT_IDS.find((candidate) => candidate === id);

	if (treatmentId === undefined) {
		throw new Error(`${context} field "id" must be one of ${ALL_TREATMENT_IDS.join(', ')}`);
	}

	const kind = requireString(record['kind'], 'kind', context);

	if (kind !== 'no-index' && kind !== 'codeindex') {
		throw new Error(`${context} field "kind" must be one of ${TREATMENT_KINDS.join(', ')}`);
	}

	if (record['codeMode'] === undefined) {
		throw new TypeError(`${context} field "codeMode" is required`);
	}

	const codeMode = CODE_MODE_POLICIES.find((candidate) => candidate === record['codeMode']);

	if (codeMode === undefined) {
		throw new Error(`${context} field "codeMode" must be one of ${CODE_MODE_POLICIES.join(', ')}`);
	}

	const artifact = record['artifact'] === null || record['artifact'] === undefined ? null : artifactOf(record['artifact'], context);
	const mcp = record['mcp'] === null || record['mcp'] === undefined ? null : mcpOf(record['mcp'], context);

	assertTreatmentShapeOf({id: treatmentId, kind, codeMode, artifact, mcp});

	const normalized = {
		id: treatmentId,
		kind,
		ordinaryTools: requireToolNames(record['ordinaryTools'], 'ordinaryTools', context),
		codeMode,
		artifact,
		mcp,
	} as const;

	return {...normalized, definitionHash: treatmentHashOf(normalized)};
};

/**
 * Returns the complete treatment set a declared list must equal.
 *
 * The presence of the canonical arm selects the independent two-arm
 * qualification model. Every other set is the three-arm frontier model. The two
 * models are never mixed, so a qualification campaign can never acquire a
 * moving accepted or candidate artifact.
 *
 * @param ids - Declared treatment ids.
 * @returns The one complete set the list must match.
 */
/**
 * Returns the complete treatment set a declared list must equal.
 *
 * The canonical arm selects the independent two-arm qualification model, the
 * exposure arms select the paired direct/Code-Mode model, and every other set
 * is the three-arm frontier model. The models are never mixed.
 *
 * @param ids - Declared treatment ids.
 * @returns The one complete set the list must match.
 */
const expectedTreatmentIdsOf = (ids: readonly TreatmentIdType[]): readonly TreatmentIdType[] => {
	if (ids.includes('canonical')) {
		return QUALIFICATION_TREATMENT_IDS;
	}

	if (ids.includes('direct-mcp') || ids.includes('code-mode')) {
		return EXPOSURE_TREATMENT_IDS;
	}

	return TREATMENT_IDS;
};

const identityDifferencesOf = (ids: readonly TreatmentIdType[]): readonly string[] => {
	const differences: string[] = [];
	const expected = expectedTreatmentIdsOf(ids);
	const missing = expected.filter((id) => !ids.includes(id));
	const unexpected = ids.filter((id) => !expected.includes(id));

	if (ids.length !== expected.length) {
		differences.push(`expected ${expected.length} treatments, found ${ids.length}`);
	}

	if (new Set(ids).size !== ids.length) {
		differences.push('treatment ids must be unique');
	}

	if (missing.length > 0) {
		differences.push(`missing treatment(s): ${missing.join(', ')}`);
	}

	if (unexpected.length > 0) {
		differences.push(`unknown treatment(s): ${unexpected.join(', ')}`);
	}

	return differences;
};

const sharedMcpDifferencesOf = (indexed: readonly TreatmentDefinitionType[]): readonly string[] => {
	const [accepted] = indexed;

	if (accepted === undefined) {
		return [];
	}

	const differences: string[] = [];

	for (const treatment of indexed.slice(1)) {
		if (treatment.mcp?.server !== accepted.mcp?.server) {
			differences.push(`MCP server differs between ${accepted.id} and ${treatment.id}`);
		}

		if (treatment.mcp?.codemode !== accepted.mcp?.codemode) {
			differences.push(`MCP codemode policy differs between ${accepted.id} and ${treatment.id}`);
		}
	}

	return differences;
};

/**
 * Describes every non-equivalent difference in a treatment set.
 *
 * Accepted and candidate may differ only by artifact and the resulting
 * CodeIndex interface. Ordinary tools, the generic `execute` policy, and the
 * MCP configuration must be identical across every treatment. The exposure
 * pair is the one deliberate exception: its MCP Code Mode policy is the
 * measured variable, so only that policy may differ.
 *
 * @param treatments - Validated treatment definitions.
 * @returns Human-readable differences; empty when the set is equivalent.
 */
export const treatmentDifferencesOf = (treatments: readonly TreatmentDefinitionType[]): readonly string[] => {
	const ids = treatments.map((treatment) => treatment.id);
	const differences = [...identityDifferencesOf(ids)];
	const [first] = treatments;

	if (first === undefined) {
		return differences;
	}

	for (const treatment of treatments.slice(1)) {
		if (treatment.ordinaryTools.join('\u0000') !== first.ordinaryTools.join('\u0000')) {
			differences.push(`ordinary tools differ between ${first.id} and ${treatment.id}`);
		}
	}

	const exposure = ids.includes('direct-mcp') || ids.includes('code-mode');

	if (exposure) {
		differences.push(...exposureDifferencesOf(treatments));
	} else {
		differences.push(...sharedMcpDifferencesOf(treatments.filter((treatment) => treatment.kind === 'codeindex')));
	}

	return differences;
};

/**
 * Rejects a treatment set that would measure more than the declared variable.
 *
 * @param treatments - Validated treatment definitions.
 * @returns The same treatments when equivalent.
 */
export const validateTreatmentSet = (treatments: readonly TreatmentDefinitionType[]): readonly TreatmentDefinitionType[] => {
	const differences = treatmentDifferencesOf(treatments);

	if (differences.length > 0) {
		throw new Error(`treatment set is not equivalent: ${differences.join('; ')}`);
	}

	return treatments;
};

/**
 * Returns treatments in the canonical accepted order.
 *
 * @param treatments - Validated treatment definitions.
 * @returns Definitions ordered by {@link ALL_TREATMENT_IDS}.
 */
export const canonicalTreatmentsOf = (treatments: readonly TreatmentDefinitionType[]): readonly TreatmentDefinitionType[] =>
	[...validateTreatmentSet(treatments)].sort((left, right) => ALL_TREATMENT_IDS.indexOf(left.id) - ALL_TREATMENT_IDS.indexOf(right.id));

/**
 * Hashes a treatment set for run identity.
 *
 * @param treatments - Validated treatment definitions.
 * @returns Hex digest over the canonical definition list.
 */
export const treatmentSetHashOf = (treatments: readonly TreatmentDefinitionType[]): string =>
	hashOf(
		canonicalTreatmentsOf(treatments).map((treatment) => ({
			id: treatment.id,
			definitionHash: treatment.definitionHash,
		})),
	);
export {routingOf, toolSurfaceOf} from './surfaceCapture.ts';
