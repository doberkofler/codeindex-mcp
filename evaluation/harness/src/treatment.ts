import {hashOf} from './hash.ts';
import {callableToolsOf} from './surface.ts';

/** The accepted three-treatment model. Order defines plan order. */
export const TREATMENT_IDS = ['no-index', 'accepted', 'candidate'] as const;

export type TreatmentIdType = (typeof TREATMENT_IDS)[number];

/** A treatment either withholds CodeIndex or presents one artifact of it. */
export const TREATMENT_KINDS = ['no-index', 'codeindex'] as const;

export type TreatmentKindType = (typeof TREATMENT_KINDS)[number];

/**
 * Generic `execute` is removed from every treatment.
 *
 * Keeping it identical would require recording every unknown-tool outcome and
 * would route native MCP tools through a second interface, so v1 removes it.
 */
export const CODE_MODE_POLICY = 'absent' as const;

export type CodeModePolicyType = typeof CODE_MODE_POLICY;

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
	codemode: false;
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
	codeIndex: readonly string[];
	execute: 'absent';
	/** Declared ordinary and CodeIndex names in one sorted list. */
	tools: readonly string[];
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
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

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
	const digest = record['digest'];

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

	if (record['codemode'] !== false) {
		throw new Error(`${context} field "mcp.codemode" must be false; evaluation uses native MCP tools only`);
	}

	return {
		server: requireString(record['server'], 'mcp.server', context),
		codemode: false,
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
export const treatmentHashOf = (definition: Omit<TreatmentDefinitionType, 'definitionHash'> | unknown): string => hashOf(definition);

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

	if (!(TREATMENT_IDS as readonly string[]).includes(id)) {
		throw new Error(`${context} field "id" must be one of ${TREATMENT_IDS.join(', ')}`);
	}

	const kind = requireString(record['kind'], 'kind', context);

	if (kind !== 'no-index' && kind !== 'codeindex') {
		throw new Error(`${context} field "kind" must be one of ${TREATMENT_KINDS.join(', ')}`);
	}

	if (record['codeMode'] !== CODE_MODE_POLICY) {
		throw new Error(`${context} field "codeMode" must be "${CODE_MODE_POLICY}"`);
	}

	const artifact = record['artifact'] === null || record['artifact'] === undefined ? null : artifactOf(record['artifact'], context);
	const mcp = record['mcp'] === null || record['mcp'] === undefined ? null : mcpOf(record['mcp'], context);

	if (id === 'no-index') {
		if (kind !== 'no-index' || artifact !== null || mcp !== null) {
			throw new Error('no-index treatment must use kind "no-index" and declare neither artifact nor mcp');
		}
	} else if (kind !== 'codeindex' || artifact === null || mcp === null) {
		throw new Error(`${id} treatment must use kind "codeindex" and declare both artifact and mcp`);
	}

	const normalized = {
		id: id as TreatmentIdType,
		kind,
		ordinaryTools: requireToolNames(record['ordinaryTools'], 'ordinaryTools', context),
		codeMode: CODE_MODE_POLICY,
		artifact,
		mcp,
	} as const;

	return {...normalized, definitionHash: treatmentHashOf(normalized)};
};

/**
 * Describes every non-equivalent difference in a treatment set.
 *
 * Accepted and candidate may differ only by artifact and the resulting
 * CodeIndex interface. Ordinary tools, the generic `execute` policy, and the
 * MCP configuration must be identical across every treatment.
 *
 * @param treatments - Validated treatment definitions.
 * @returns Human-readable differences; empty when the set is equivalent.
 */
export const treatmentDifferencesOf = (treatments: readonly TreatmentDefinitionType[]): readonly string[] => {
	const differences: string[] = [];
	const ids = treatments.map((treatment) => treatment.id);
	const missing = TREATMENT_IDS.filter((id) => !ids.includes(id));
	const unexpected = ids.filter((id) => !(TREATMENT_IDS as readonly string[]).includes(id));

	if (treatments.length !== TREATMENT_IDS.length) {
		differences.push(`expected ${TREATMENT_IDS.length} treatments, found ${treatments.length}`);
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

	const [first] = treatments;

	if (first === undefined) {
		return differences;
	}

	for (const treatment of treatments.slice(1)) {
		if (treatment.ordinaryTools.join('\u0000') !== first.ordinaryTools.join('\u0000')) {
			differences.push(`ordinary tools differ between ${first.id} and ${treatment.id}`);
		}

		if (treatment.codeMode !== first.codeMode) {
			differences.push(`generic execute policy differs between ${first.id} and ${treatment.id}`);
		}
	}

	const indexed = treatments.filter((treatment) => treatment.kind === 'codeindex');
	const [accepted] = indexed;

	if (accepted !== undefined) {
		for (const treatment of indexed.slice(1)) {
			if (treatment.mcp?.server !== accepted.mcp?.server) {
				differences.push(`MCP server differs between ${accepted.id} and ${treatment.id}`);
			}

			if (treatment.mcp?.codemode !== accepted.mcp?.codemode) {
				differences.push(`MCP codemode policy differs between ${accepted.id} and ${treatment.id}`);
			}
		}
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
 * @returns Definitions ordered by {@link TREATMENT_IDS}.
 */
export const canonicalTreatmentsOf = (treatments: readonly TreatmentDefinitionType[]): readonly TreatmentDefinitionType[] =>
	validateTreatmentSet(treatments)
		.slice()
		.sort((left, right) => TREATMENT_IDS.indexOf(left.id) - TREATMENT_IDS.indexOf(right.id));

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

/**
 * Captures the exact tool-name list presented to the model.
 *
 * Native MCP catalog names are prefixed with the configured server name, which
 * is the name OpenCode presents and the model must call.
 *
 * @param treatment - Treatment definition.
 * @param catalog - CodeIndex tool names reported by the artifact's MCP catalog.
 * @returns The sorted surface and its digest.
 */
export const toolSurfaceOf = (treatment: TreatmentDefinitionType, catalog: readonly string[] = []): ToolSurfaceType => {
	const codeIndex =
		treatment.kind === 'codeindex' && treatment.mcp !== null ? [...new Set(catalog.map((name) => `${treatment.mcp?.server}_${name}`))].sort() : [];
	const ordinary = [...treatment.ordinaryTools];
	const tools = [...new Set([...ordinary, ...codeIndex])].sort();
	const callable = [...new Set([...callableToolsOf(ordinary), ...codeIndex])].sort();
	const native = treatment.kind === 'no-index' || codeIndex.every((name) => name.startsWith(`${treatment.mcp?.server}_`));

	return {
		treatmentId: treatment.id,
		ordinary,
		codeIndex,
		execute: CODE_MODE_POLICY,
		tools,
		callable,
		native,
		digest: hashOf({id: treatment.id, ordinary, codeIndex, execute: CODE_MODE_POLICY}),
	};
};

/**
 * Derives observed routing and every unknown-tool outcome.
 *
 * @param surface - Tool surface captured before execution.
 * @param calls - Normalized tool names observed in the event stream.
 * @returns Counts and the sorted list of names outside the captured surface.
 */
export const routingOf = (surface: ToolSurfaceType, calls: readonly string[]): RoutingType => {
	const ordinary = new Set(surface.callable);
	const codeIndex = new Set(surface.codeIndex);
	const known = new Set([...surface.callable, ...surface.codeIndex]);
	const unknown = [...new Set(calls.filter((name) => !known.has(name)))].sort();

	return {
		ordinaryCalls: calls.filter((name) => ordinary.has(name)).length,
		codeIndexCalls: calls.filter((name) => codeIndex.has(name)).length,
		executeCalls: calls.filter((name) => name === 'execute').length,
		unknownTools: unknown,
		native: calls.every((name) => name !== 'execute'),
	};
};
