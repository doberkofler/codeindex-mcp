import {readFileSync} from 'node:fs';
import {hashOf} from './hash.ts';
import {type CaseType, type SuiteType} from './schema.ts';

/** Version of the model-free route plan schema understood by this harness. */
export const ROUTE_PLAN_SCHEMA_VERSION = 1 as const;

/** Native CodeIndex tools a route may call. */
export const ROUTE_MCP_TOOLS = ['find_dependencies', 'find_references', 'find_symbol', 'index_status', 'outline', 'read_symbol', 'symbol_at'] as const;

export type RouteMcpToolType = (typeof ROUTE_MCP_TOOLS)[number];

/** How one step contributes files to the route's answer. */
export const ROUTE_COLLECTIONS = ['all-paths', 'definition-paths', 'exact-name-paths', 'none', 'reference-paths'] as const;

export type RouteCollectionType = (typeof ROUTE_COLLECTIONS)[number];

/** Resolves `symbolId` from an earlier `find_symbol` step. */
export type SymbolSelectionType = Readonly<{
	/** Step whose items supply the symbol. */
	fromStep: string;
	/** Optional exact definition path filter. */
	path?: string;
	/** Optional exact simple-name filter. */
	name?: string;
}>;

/** One ordinary retrieval step: a scoped regular-expression search or a file read. */
export type TextStepType =
	| Readonly<{
			kind: 'search';
			id: string;
			/** Regular-expression source, compiled with the Unicode flag. */
			pattern: string;
			/** Workspace-relative POSIX subtree to search. */
			path: string;
			/** File extensions searched; defaults to TypeScript and JavaScript. */
			extensions?: readonly string[];
			/** Workspace-relative POSIX files removed from the result. */
			excludePaths?: readonly string[];
			collect: boolean;
	  }>
	| Readonly<{
			kind: 'read';
			id: string;
			/** Workspace-relative POSIX file to read. */
			path: string;
			collect: boolean;
	  }>;

/** One native MCP step through the published artifact. */
export type McpStepType = Readonly<{
	kind: 'mcp';
	id: string;
	tool: RouteMcpToolType;
	arguments: Readonly<Record<string, unknown>>;
	collect: RouteCollectionType;
	/** Exact simple name used by `exact-name-paths`; defaults to the query argument. */
	exactName?: string;
	/** Follow `nextCursor` until the result is complete. */
	followCursor?: boolean;
	/** Resolve the `symbolId` argument from an earlier `find_symbol` result. */
	symbolFrom?: SymbolSelectionType;
	/** Workspace-relative POSIX files removed from the result. */
	excludePaths?: readonly string[];
	/** Keep collected files whose complete source matches this regular expression. */
	keepFilesMatching?: string;
}>;

export type RouteStepType = TextStepType | McpStepType;

/** One complete route for one case and one kind of treatment. */
export type RouteType = Readonly<{
	caseId: string;
	/** Ordinary-tool route used by the no-index treatment. */
	text: readonly TextStepType[];
	/** Route used by an accepted or candidate CodeIndex treatment. */
	codeindex: readonly RouteStepType[];
	/** Optional project file the artifact indexes for this route. */
	projectFile?: string;
}>;

/** Generic interface-contract probes executed against one artifact. */
export type ContractPlanType = Readonly<{
	pagination: Readonly<{
		tool: RouteMcpToolType;
		arguments: Readonly<Record<string, unknown>>;
		/** Hard bound that prevents a broken cursor from looping forever. */
		maxPages: number;
	}>;
	truncation: Readonly<{
		/** Artifact response budget used for this probe only. */
		maxResultBytes: number;
		tool: RouteMcpToolType;
		arguments: Readonly<Record<string, unknown>>;
	}>;
	staleFile: Readonly<{
		/** Exact symbol query that resolves one indexed declaration. */
		query: string;
		/** Expected definition path of that symbol. */
		path: string;
	}>;
	failure: Readonly<{
		tool: RouteMcpToolType;
		arguments: Readonly<Record<string, unknown>>;
		expectedErrorCode: string;
	}>;
}>;

/** A model-free route plan pinned to one suite version. */
export type RoutePlanType = Readonly<{
	schemaVersion: typeof ROUTE_PLAN_SCHEMA_VERSION;
	id: string;
	suite: Readonly<{id: string; version: number}>;
	routes: readonly RouteType[];
	contract: ContractPlanType;
}>;

const ROUTE_PLAN_KEYS = new Set(['schemaVersion', 'id', 'suite', 'routes', 'contract']);
const SUITE_KEYS = new Set(['id', 'version']);
const ROUTE_KEYS = new Set(['caseId', 'text', 'codeindex', 'projectFile']);
const TEXT_SEARCH_KEYS = new Set(['kind', 'id', 'pattern', 'path', 'extensions', 'excludePaths', 'collect']);
const TEXT_READ_KEYS = new Set(['kind', 'id', 'path', 'collect']);
const MCP_KEYS = new Set(['kind', 'id', 'tool', 'arguments', 'collect', 'exactName', 'followCursor', 'symbolFrom', 'excludePaths', 'keepFilesMatching']);
const SYMBOL_SELECTION_KEYS = new Set(['fromStep', 'path', 'name']);
const CONTRACT_KEYS = new Set(['pagination', 'truncation', 'staleFile', 'failure']);
const PAGINATION_KEYS = new Set(['tool', 'arguments', 'maxPages']);
const TRUNCATION_KEYS = new Set(['maxResultBytes', 'tool', 'arguments']);
const STALE_FILE_KEYS = new Set(['query', 'path']);
const FAILURE_KEYS = new Set(['tool', 'arguments', 'expectedErrorCode']);

const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const WINDOWS_SEPARATOR = /\\/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Rejects fields outside the declared route schema.
 *
 * @param value - Parsed object.
 * @param allowed - Exact permitted field names.
 * @param context - Document scope used in the error.
 */
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

const requireString = (value: unknown, context: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${context} must be a non-empty string`);
	}

	return value;
};

const requireStableId = (value: unknown, context: string): string => {
	const id = requireString(value, context);

	if (!STABLE_ID.test(id)) {
		throw new Error(`${context} must match ${STABLE_ID}`);
	}

	return id;
};

const requirePositiveInteger = (value: unknown, context: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${context} must be a positive integer`);
	}

	return value;
};

const requireBoolean = (value: unknown, context: string): boolean => {
	if (typeof value !== 'boolean') {
		throw new Error(`${context} must be a boolean`);
	}

	return value;
};

const requireStringArray = (value: unknown, context: string): readonly string[] => {
	if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)) {
		throw new Error(`${context} must be an array of non-empty strings`);
	}

	if (new Set(value).size !== value.length) {
		throw new Error(`${context} must not contain duplicates`);
	}

	return value;
};

const requirePath = (value: unknown, context: string): string => {
	const path = requireString(value, context);

	if (path.startsWith('/') || WINDOWS_SEPARATOR.test(path) || path.split('/').includes('..')) {
		throw new Error(`${context} must be a workspace-relative POSIX path without parent segments`);
	}

	return path;
};

const requirePattern = (value: unknown, context: string): string => {
	const pattern = requireString(value, context);

	try {
		new RegExp(pattern, 'u');
	} catch (error) {
		throw new Error(`${context} is not a valid Unicode regular expression: ${error instanceof Error ? error.message : String(error)}`);
	}

	return pattern;
};

const requireTool = (value: unknown, context: string): RouteMcpToolType => {
	const tool = requireString(value, context);

	if (!(ROUTE_MCP_TOOLS as readonly string[]).includes(tool)) {
		throw new Error(`${context} must be one of ${ROUTE_MCP_TOOLS.join(', ')}`);
	}

	return tool as RouteMcpToolType;
};

const requireCollection = (value: unknown, context: string): RouteCollectionType => {
	const collect = requireString(value, context);

	if (!(ROUTE_COLLECTIONS as readonly string[]).includes(collect)) {
		throw new Error(`${context} must be one of ${ROUTE_COLLECTIONS.join(', ')}`);
	}

	return collect as RouteCollectionType;
};

const requireArguments = (value: unknown, context: string): Readonly<Record<string, unknown>> => {
	const args = requireObject(value, context);

	for (const key of Object.keys(args)) {
		const item = args[key];

		if (item !== undefined && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && !Array.isArray(item)) {
			throw new Error(`${context}.${key} must be a JSON scalar or array`);
		}
	}

	return args;
};

const textStepOf = (value: unknown, context: string): TextStepType => {
	const record = requireObject(value, context);
	const kind = requireString(record['kind'], `${context}.kind`);

	if (kind === 'read') {
		rejectUnknownKeys(record, TEXT_READ_KEYS, context);

		return {
			kind: 'read',
			id: requireStableId(record['id'], `${context}.id`),
			path: requirePath(record['path'], `${context}.path`),
			collect: requireBoolean(record['collect'], `${context}.collect`),
		};
	}

	if (kind !== 'search') {
		throw new Error(`${context}.kind must be "search" or "read"`);
	}

	rejectUnknownKeys(record, TEXT_SEARCH_KEYS, context);

	const rawExtensions = record['extensions'];
	const extensions = rawExtensions === undefined ? undefined : requireStringArray(rawExtensions, `${context}.extensions`);

	if (extensions !== undefined && extensions.some((extension) => !extension.startsWith('.'))) {
		throw new Error(`${context}.extensions entries must start with "."`);
	}

	return {
		kind: 'search',
		id: requireStableId(record['id'], `${context}.id`),
		pattern: requirePattern(record['pattern'], `${context}.pattern`),
		path: requirePath(record['path'], `${context}.path`),
		...(extensions === undefined ? {} : {extensions}),
		...(record['excludePaths'] === undefined
			? {}
			: {excludePaths: requireStringArray(record['excludePaths'], `${context}.excludePaths`).map((item) => requirePath(item, `${context}.excludePaths`))}),
		collect: requireBoolean(record['collect'], `${context}.collect`),
	};
};

const symbolSelectionOf = (value: unknown, context: string): SymbolSelectionType => {
	const record = requireObject(value, context);
	rejectUnknownKeys(record, SYMBOL_SELECTION_KEYS, context);

	return {
		fromStep: requireStableId(record['fromStep'], `${context}.fromStep`),
		...(record['path'] === undefined ? {} : {path: requirePath(record['path'], `${context}.path`)}),
		...(record['name'] === undefined ? {} : {name: requireString(record['name'], `${context}.name`)}),
	};
};

const mcpStepOf = (value: unknown, context: string): McpStepType => {
	const record = requireObject(value, context);
	rejectUnknownKeys(record, MCP_KEYS, context);

	if (record['kind'] !== 'mcp') {
		throw new Error(`${context}.kind must be "mcp"`);
	}

	return {
		kind: 'mcp',
		id: requireStableId(record['id'], `${context}.id`),
		tool: requireTool(record['tool'], `${context}.tool`),
		arguments: requireArguments(record['arguments'], `${context}.arguments`),
		collect: requireCollection(record['collect'], `${context}.collect`),
		...(record['exactName'] === undefined ? {} : {exactName: requireString(record['exactName'], `${context}.exactName`)}),
		...(record['followCursor'] === undefined ? {} : {followCursor: requireBoolean(record['followCursor'], `${context}.followCursor`)}),
		...(record['symbolFrom'] === undefined ? {} : {symbolFrom: symbolSelectionOf(record['symbolFrom'], `${context}.symbolFrom`)}),
		...(record['excludePaths'] === undefined
			? {}
			: {excludePaths: requireStringArray(record['excludePaths'], `${context}.excludePaths`).map((item) => requirePath(item, `${context}.excludePaths`))}),
		...(record['keepFilesMatching'] === undefined ? {} : {keepFilesMatching: requirePattern(record['keepFilesMatching'], `${context}.keepFilesMatching`)}),
	};
};

const stepsOf = (value: unknown, context: string): readonly RouteStepType[] => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${context} must be a non-empty array`);
	}

	const steps = value.map((item, index) => {
		const record = requireObject(item, `${context}[${index}]`);
		const kind = requireString(record['kind'], `${context}[${index}].kind`);

		return kind === 'mcp' ? mcpStepOf(item, `${context}[${index}]`) : textStepOf(item, `${context}[${index}]`);
	});
	const ids = new Set<string>();

	for (const step of steps) {
		if (ids.has(step.id)) {
			throw new Error(`${context} repeats step id "${step.id}"`);
		}

		ids.add(step.id);
	}

	for (const step of steps) {
		if (step.kind === 'mcp' && step.symbolFrom !== undefined && !steps.some((candidate) => candidate.id === step.symbolFrom?.fromStep)) {
			throw new Error(`${context} step "${step.id}" resolves a symbol from unknown step "${step.symbolFrom.fromStep}"`);
		}
	}

	if (!steps.some((step) => step.collect)) {
		throw new Error(`${context} must contain at least one answer-collecting step`);
	}

	return steps;
};

const routeOf = (value: unknown, context: string): RouteType => {
	const record = requireObject(value, context);
	rejectUnknownKeys(record, ROUTE_KEYS, context);

	const text = record['text'];

	if (!Array.isArray(text) || text.length === 0) {
		throw new Error(`${context}.text must be a non-empty array`);
	}

	const textSteps = text.map((item, index) => textStepOf(item, `${context}.text[${index}]`));

	if (!textSteps.some((step) => step.collect)) {
		throw new Error(`${context}.text must contain at least one answer-collecting step`);
	}

	const codeindex = stepsOf(record['codeindex'], `${context}.codeindex`);

	return {
		caseId: requireStableId(record['caseId'], `${context}.caseId`),
		text: textSteps,
		codeindex,
		...(record['projectFile'] === undefined ? {} : {projectFile: requirePath(record['projectFile'], `${context}.projectFile`)}),
	};
};

const contractOf = (value: unknown): ContractPlanType => {
	const record = requireObject(value, 'route plan field "contract"');
	rejectUnknownKeys(record, CONTRACT_KEYS, 'route plan field "contract"');
	const pagination = requireObject(record['pagination'], 'route plan field "contract.pagination"');
	const truncation = requireObject(record['truncation'], 'route plan field "contract.truncation"');
	const staleFile = requireObject(record['staleFile'], 'route plan field "contract.staleFile"');
	const failure = requireObject(record['failure'], 'route plan field "contract.failure"');

	rejectUnknownKeys(pagination, PAGINATION_KEYS, 'route plan field "contract.pagination"');
	rejectUnknownKeys(truncation, TRUNCATION_KEYS, 'route plan field "contract.truncation"');
	rejectUnknownKeys(staleFile, STALE_FILE_KEYS, 'route plan field "contract.staleFile"');
	rejectUnknownKeys(failure, FAILURE_KEYS, 'route plan field "contract.failure"');

	return {
		pagination: {
			tool: requireTool(pagination['tool'], 'contract.pagination.tool'),
			arguments: requireArguments(pagination['arguments'], 'contract.pagination.arguments'),
			maxPages: requirePositiveInteger(pagination['maxPages'], 'contract.pagination.maxPages'),
		},
		truncation: {
			maxResultBytes: requirePositiveInteger(truncation['maxResultBytes'], 'contract.truncation.maxResultBytes'),
			tool: requireTool(truncation['tool'], 'contract.truncation.tool'),
			arguments: requireArguments(truncation['arguments'], 'contract.truncation.arguments'),
		},
		staleFile: {
			query: requireString(staleFile['query'], 'contract.staleFile.query'),
			path: requirePath(staleFile['path'], 'contract.staleFile.path'),
		},
		failure: {
			tool: requireTool(failure['tool'], 'contract.failure.tool'),
			arguments: requireArguments(failure['arguments'], 'contract.failure.arguments'),
			expectedErrorCode: requireString(failure['expectedErrorCode'], 'contract.failure.expectedErrorCode'),
		},
	};
};

/**
 * Validates one route plan document.
 *
 * @param value - Parsed JSON value.
 * @returns The validated plan.
 */
export const routePlanOf = (value: unknown): RoutePlanType => {
	const record = requireObject(value, 'route plan');
	rejectUnknownKeys(record, ROUTE_PLAN_KEYS, 'route plan');

	if (record['schemaVersion'] !== ROUTE_PLAN_SCHEMA_VERSION) {
		throw new Error(`route plan field "schemaVersion" must be ${ROUTE_PLAN_SCHEMA_VERSION}`);
	}

	const suite = requireObject(record['suite'], 'route plan field "suite"');
	rejectUnknownKeys(suite, SUITE_KEYS, 'route plan field "suite"');

	const rawRoutes = record['routes'];

	if (!Array.isArray(rawRoutes) || rawRoutes.length === 0) {
		throw new Error('route plan field "routes" must be a non-empty array');
	}

	const routes = rawRoutes.map((item, index) => routeOf(item, `route plan routes[${index}]`));
	const caseIds = new Set(routes.map((route) => route.caseId));

	if (caseIds.size !== routes.length) {
		throw new Error('route plan repeats a case id');
	}

	return {
		schemaVersion: ROUTE_PLAN_SCHEMA_VERSION,
		id: requireStableId(record['id'], 'route plan field "id"'),
		suite: {
			id: requireStableId(suite['id'], 'route plan field "suite.id"'),
			version: requirePositiveInteger(suite['version'], 'route plan field "suite.version"'),
		},
		routes,
		contract: contractOf(record['contract']),
	};
};

/**
 * Loads and validates one route plan file.
 *
 * @param file - Absolute plan path.
 * @returns The validated plan.
 */
export const loadRoutePlan = (file: string): RoutePlanType => routePlanOf(JSON.parse(readFileSync(file, 'utf8')));

/**
 * Checks that a plan covers exactly the declared suite cases.
 *
 * @param plan - Validated route plan.
 * @param suite - Loaded suite.
 * @param cases - Loaded suite cases.
 */
export const validateRoutePlan = (plan: RoutePlanType, suite: SuiteType, cases: readonly CaseType[]): void => {
	if (plan.suite.id !== suite.id || plan.suite.version !== suite.version) {
		throw new Error(`route plan pins ${plan.suite.id} v${plan.suite.version}, but the suite is ${suite.id} v${suite.version}`);
	}

	const planned = [...plan.routes.map((route) => route.caseId)].sort();
	const expected = [...cases.map((testCase) => testCase.id)].sort();

	if (planned.length !== expected.length || planned.some((id, index) => id !== expected[index])) {
		throw new Error(`route plan must cover exactly the ${expected.length} suite cases`);
	}
};

/**
 * Hashes the complete route plan so a changed route cannot reuse evidence.
 *
 * @param plan - Validated route plan.
 * @returns Hex digest of the canonical plan.
 */
export const routePlanHashOf = (plan: RoutePlanType): string => hashOf(plan);
