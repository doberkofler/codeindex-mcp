import {createHash} from 'node:crypto';
import {existsSync, realpathSync, readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {debugFor} from '../logging/debug.ts';

const {basename, dirname, isAbsolute, join, relative, resolve, sep} = path;
const debug = debugFor('config');

const DEFAULT_EXTRACTOR_ID = 'typescript';
const DEFAULT_PROJECT_FILE = 'tsconfig.json';

const ProjectEntrySchema = z.object({
	name: z.string().min(1).optional(),
	project: z.string().min(1),
});

const ExtractorSchema = z.object({
	id: z.string().min(1).optional(),
	project: z.string().min(1).optional(),
	projects: z.array(ProjectEntrySchema).min(1).optional(),
	options: z.record(z.string(), z.unknown()).optional(),
});

const ProjectSchema = z.object({
	name: z.string().min(1).optional(),
	id: z.string().min(1).optional(),
	root: z.string().min(1).optional(),
});

const StorageSchema = z.object({
	directory: z.string().min(1).optional(),
	database: z.string().min(1).optional(),
	analytics: z.string().min(1).optional(),
	analyticsEnabled: z.boolean().optional(),
});

const LimitsSchema = z.object({
	maxResultBytes: z.number().int().positive().max(4_194_304).optional(),
	maxReadLines: z.number().int().positive().max(2000).optional(),
});

const DiagnosticsSchema = z.object({
	semantic: z.boolean().optional(),
});

const FileConfigSchema = z.object({
	project: ProjectSchema.optional(),
	extractor: ExtractorSchema,
	storage: StorageSchema.optional(),
	limits: LimitsSchema.optional(),
	diagnostics: DiagnosticsSchema.optional(),
});

const EnvironmentSchema = z.object({
	CODE_INDEX_CONFIG: z.string().min(1).optional(),
	CODE_INDEX_ROOT: z.string().min(1).optional(),
	CODE_INDEX_EXTRACTOR: z.string().min(1).optional(),
	CODE_INDEX_PROJECT_FILE: z.string().min(1).optional(),
	CODE_INDEX_DATABASE: z.string().min(1).optional(),
	CODE_INDEX_ANALYTICS: z
		.string()
		.optional()
		.transform((value) => (value === undefined ? undefined : value !== '0' && value !== 'false')),
	CODE_INDEX_ANALYTICS_PATH: z.string().min(1).optional(),
	CODE_INDEX_LOG: z.string().min(1).optional(),
	CODE_INDEX_MAX_RESULT_BYTES: z.coerce.number().int().positive().max(4_194_304).optional(),
	CODE_INDEX_MAX_READ_LINES: z.coerce.number().int().positive().max(2000).optional(),
	CODE_INDEX_SEMANTIC_DIAGNOSTICS: z
		.string()
		.optional()
		.transform((value) => (value === undefined ? undefined : value === '1' || value === 'true')),
	CODE_INDEX_PROJECT_ID: z.string().min(1).optional(),
	CODE_INDEX_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

type FileConfigType = z.infer<typeof FileConfigSchema>;

/**
 * One TypeScript project context within the indexed workspace.
 *
 * Contexts share one workspace and one published generation but retain their
 * own project file, compiler options, and configuration digest.
 */
export type ProjectContextConfigType = Readonly<{
	readonly name: string;
	readonly projectFilePath: string;
}>;

export type ConfigType = Readonly<{
	readonly projectName: string;
	readonly rootDir: string;
	readonly extractorId: string;
	readonly extractorOptions: Readonly<Record<string, unknown>>;
	/** First configured project; retained for compatibility with single-project surfaces. */
	readonly projectFilePath: string;
	readonly projects: readonly ProjectContextConfigType[];
	/** Root holding one directory per indexed project. */
	readonly storageDirectory: string;
	readonly databasePath: string;
	readonly analyticsEnabled: boolean;
	readonly analyticsPath: string;
	readonly maxResultBytes: number;
	readonly maxReadLines: number;
	readonly semanticDiagnostics: boolean;
	readonly projectId: string;
	readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
	readonly configPath: string | null;
}>;

/** Resolved identity that both the workspace and storage resolvers share. */
type WorkspaceIdentityType = Pick<ConfigType, 'extractorId' | 'projectFilePath' | 'projects' | 'projectId' | 'projectName'> & Readonly<{storageKey: string}>;

const fail = (message: string): never => {
	debug('invalid configuration: %s', message);
	throw new Error(`Invalid code index configuration: ${message}`);
};

const isInside = (parent: string, candidate: string): boolean => {
	const relativePath = relative(parent, candidate);
	return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
};

const resolveWithin = (rootDir: string, baseDirectory: string, candidate: string, label: string): string => {
	const resolved = resolve(baseDirectory, candidate);

	if (!isAbsolute(resolved)) {
		return fail(`${label} must resolve to an absolute path`);
	}

	if (!existsSync(resolved)) {
		return fail(`${label} does not exist: ${resolved}`);
	}

	const realRoot = realpathSync(rootDir);
	const realCandidate = realpathSync(resolved);

	if (isInside(realRoot, realCandidate)) {
		return realCandidate;
	}

	return fail(`${label} must stay inside the configured root: ${resolved}`);
};

/**
 * Creates a stable, non-reversible identifier for one indexed project.
 *
 * The identifier is derived from real paths so tool results never leak absolute
 * filesystem locations. It is always used as the storage key and, unless the
 * project id is configured, as the project id.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @param extractorId - Selected language extractor.
 * @param projectFilePaths - Absolute extractor project files.
 * @returns A stable 16-character project identifier.
 */
const createProjectId = (rootDir: string, extractorId: string, projectFilePaths: readonly string[]): string => {
	const paths = [...projectFilePaths].sort();
	const identity = paths.length === 1 ? (paths[0] ?? '') : paths.join('\n');

	return createHash('sha256').update(`${rootDir}\n${extractorId}\n${identity}`).digest('hex').slice(0, 16);
};

/**
 * Returns the root holding one index database per indexed project.
 *
 * @returns Absolute index root directory.
 */
export const indexRootDirectory = (): string => join(homedir(), '.local', 'share', 'codeindex-mcp');

const defaultDatabasePath = (directory: string, projectId: string): string => join(directory, projectId, 'index.sqlite');

const defaultAnalyticsPath = (directory: string, projectId: string): string => join(directory, projectId, 'analytics', 'events.jsonl');

const assertFile = (filePath: string, label: string): void => {
	if (!existsSync(filePath)) {
		fail(`${label} does not exist: ${filePath}`);
	}

	if (!statSync(filePath).isFile()) {
		fail(`${label} is not a file: ${filePath}`);
	}
};

const canonicalisePath = (rawRootDir: string, realRootDir: string, candidatePath: string): string => {
	const absolutePath = resolve(candidatePath);

	if (isInside(rawRootDir, absolutePath)) {
		return join(realRootDir, relative(rawRootDir, absolutePath));
	}

	if (existsSync(absolutePath)) {
		return realpathSync(absolutePath);
	}

	let ancestor = dirname(absolutePath);

	while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) {
		ancestor = dirname(ancestor);
	}

	return join(realpathSync(ancestor), relative(ancestor, absolutePath));
};

const assertOutsideRoot = (rootDir: string, targetPath: string, label: string): void => {
	if (isInside(rootDir, targetPath)) {
		fail(`${label} must be outside the indexed working copy: ${targetPath}`);
	}
};

const fileConfigOf = (source: unknown, cwd: string): Readonly<{config: FileConfigType; directory: string; configPath: string | null}> => {
	const parsedEnvironment = EnvironmentSchema.safeParse(source);

	if (!parsedEnvironment.success) {
		return fail(z.prettifyError(parsedEnvironment.error));
	}

	const configuredPath = parsedEnvironment.data.CODE_INDEX_CONFIG;

	if (configuredPath === undefined) {
		return {
			config: FileConfigSchema.parse({extractor: {}}),
			directory: cwd,
			configPath: null,
		};
	}

	const configPath = resolve(cwd, configuredPath);
	assertFile(configPath, 'CODE_INDEX_CONFIG');

	let parsed: unknown;

	try {
		parsed = JSON.parse(readFileSync(configPath, 'utf8'));
	} catch (error) {
		return fail(`CODE_INDEX_CONFIG is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	const result = FileConfigSchema.safeParse(parsed);

	if (!result.success) {
		return fail(`CODE_INDEX_CONFIG failed validation:\n${z.prettifyError(result.error)}`);
	}

	return {config: result.data, directory: dirname(configPath), configPath};
};

type ParsedEnvironmentType = z.infer<typeof EnvironmentSchema>;
type FileConfigSourceType = Readonly<{environment: ParsedEnvironmentType; config: FileConfigType; directory: string; configPath: string | null}>;

const parseSource = (source: NodeJS.ProcessEnv, cwd: string): FileConfigSourceType => {
	const parsedEnvironment = EnvironmentSchema.safeParse(source);

	if (!parsedEnvironment.success) {
		return fail(z.prettifyError(parsedEnvironment.error));
	}

	const fileSource = fileConfigOf(source, cwd);
	return {environment: parsedEnvironment.data, ...fileSource};
};

const workspaceRoot = (
	environment: ParsedEnvironmentType,
	file: FileConfigType,
	directory: string,
	cwd: string,
): Readonly<{rawRootDir: string; realRootDir: string}> => {
	const rootSetting = environment.CODE_INDEX_ROOT ?? file.project?.root ?? '.';
	const rawRootDir = resolve(environment.CODE_INDEX_ROOT === undefined ? directory : cwd, rootSetting);

	if (!existsSync(rawRootDir) || !statSync(rawRootDir).isDirectory()) {
		return fail(`Indexed workspace root is not a directory: ${rawRootDir}`);
	}

	return {rawRootDir, realRootDir: realpathSync(rawRootDir)};
};

const derivedProjectName = (rootDir: string, projectFilePath: string): string => {
	const relativePath = relative(rootDir, projectFilePath).split(sep).join('/');
	const separator = relativePath.lastIndexOf('/');

	return separator === -1 ? 'root' : relativePath.slice(0, separator);
};

const resolveProjectContexts = (
	input: Readonly<{environment: ParsedEnvironmentType; file: FileConfigType; realRootDir: string; cwd: string; extractorId: string}>,
): readonly ProjectContextConfigType[] => {
	const {environment, file, realRootDir, cwd, extractorId} = input;
	if (environment.CODE_INDEX_PROJECT_FILE !== undefined) {
		const projectFilePath = resolveWithin(realRootDir, cwd, environment.CODE_INDEX_PROJECT_FILE, 'project file');
		assertFile(projectFilePath, 'project file');

		return [{name: derivedProjectName(realRootDir, projectFilePath), projectFilePath}];
	}

	if (file.extractor.project !== undefined && file.extractor.projects !== undefined) {
		return fail('extractor.project and extractor.projects are mutually exclusive');
	}

	if (extractorId === 'oracle' && file.extractor.project === undefined && file.extractor.projects === undefined) {
		return fail('the oracle extractor requires extractor.project or extractor.projects to name an Oracle manifest');
	}

	const entries = file.extractor.projects ?? [{project: file.extractor.project ?? DEFAULT_PROJECT_FILE} satisfies Readonly<{project: string; name?: string}>];
	const contexts = entries.map((entry) => {
		const projectFilePath = resolveWithin(realRootDir, realRootDir, entry.project, 'project file');

		assertFile(projectFilePath, 'project file');

		return {
			name: entry.name ?? derivedProjectName(realRootDir, projectFilePath),
			projectFilePath,
		};
	});
	const names = new Set<string>();
	const paths = new Set<string>();

	for (const context of contexts) {
		if (names.has(context.name)) {
			return fail(`project context name is duplicated: ${context.name}`);
		}

		if (paths.has(context.projectFilePath)) {
			return fail(`project file is configured more than once: ${context.projectFilePath}`);
		}

		names.add(context.name);
		paths.add(context.projectFilePath);
	}

	return contexts;
};

const projectIdentity = (environment: ParsedEnvironmentType, file: FileConfigType, realRootDir: string, cwd: string): WorkspaceIdentityType => {
	const extractorId = environment.CODE_INDEX_EXTRACTOR ?? file.extractor.id ?? DEFAULT_EXTRACTOR_ID;
	const projects = resolveProjectContexts({environment, file, realRootDir, cwd, extractorId});
	const [firstProject] = projects;

	if (firstProject === undefined) {
		return fail('at least one extractor project is required');
	}

	// The storage key always binds to the physical checkout, so a copy or a move
	// never reaches another checkout's database. A configured project id changes
	// only the reported logical identity.
	const storageKey = createProjectId(
		realRootDir,
		extractorId,
		projects.map((project) => project.projectFilePath),
	);
	const projectId = environment.CODE_INDEX_PROJECT_ID ?? file.project?.id ?? storageKey;

	return {
		extractorId,
		projectFilePath: firstProject.projectFilePath,
		projects,
		projectId,
		storageKey,
		projectName: file.project?.name ?? basename(realRootDir),
	};
};

const resolveWorkspace = (input: FileConfigSourceType, cwd: string): WorkspaceIdentityType & Readonly<{rawRootDir: string; realRootDir: string}> => {
	const {environment, config: file, directory} = input;
	const root = workspaceRoot(environment, file, directory, cwd);

	return {...root, ...projectIdentity(environment, file, root.realRootDir, cwd)};
};

const storagePath = (overridePath: string | undefined, filePath: string | undefined, defaultPath: string, baseDirectory: string): string => {
	const candidate = overridePath ?? filePath;

	if (candidate === undefined) {
		return defaultPath;
	}

	return resolve(baseDirectory, candidate);
};

const resolveStorage = (
	input: FileConfigSourceType,
	cwd: string,
	workspace: Readonly<{rawRootDir: string; realRootDir: string; storageKey: string}>,
): Readonly<{storageDirectory: string; databasePath: string; analyticsPath: string; analyticsEnabled: boolean}> => {
	const {environment, config: file, directory} = input;
	const storageDirectory = canonicalisePath(workspace.rawRootDir, workspace.realRootDir, resolve(directory, file.storage?.directory ?? indexRootDirectory()));
	const databasePath = canonicalisePath(
		workspace.rawRootDir,
		workspace.realRootDir,
		storagePath(
			environment.CODE_INDEX_DATABASE,
			file.storage?.database,
			defaultDatabasePath(storageDirectory, workspace.storageKey),
			environment.CODE_INDEX_DATABASE === undefined ? directory : cwd,
		),
	);
	assertOutsideRoot(workspace.realRootDir, databasePath, 'database path');

	const analyticsPath = canonicalisePath(
		workspace.rawRootDir,
		workspace.realRootDir,
		storagePath(
			environment.CODE_INDEX_ANALYTICS_PATH ?? environment.CODE_INDEX_LOG,
			file.storage?.analytics,
			defaultAnalyticsPath(storageDirectory, workspace.storageKey),
			environment.CODE_INDEX_ANALYTICS_PATH === undefined && environment.CODE_INDEX_LOG === undefined ? directory : cwd,
		),
	);
	assertOutsideRoot(workspace.realRootDir, analyticsPath, 'analytics path');

	return {
		storageDirectory,
		databasePath,
		analyticsPath,
		analyticsEnabled: environment.CODE_INDEX_ANALYTICS ?? file.storage?.analyticsEnabled ?? true,
	};
};

/**
 * Parses the environment and optional project configuration file.
 *
 * This is the only module that reads `process.env`. Every path is resolved and
 * validated once at startup so later modules can treat configuration as trusted.
 * Relative paths in the configuration file resolve against the file directory;
 * environment overrides resolve against the current working directory.
 *
 * @param source - Untrusted environment variables.
 * @param cwd - Directory used to resolve relative environment overrides.
 * @returns The resolved and validated configuration.
 * @throws {@link Error} When the configuration file, root, project file,
 * storage paths, or limits are invalid.
 */
export const loadConfig = (source: NodeJS.ProcessEnv, cwd = process.cwd()): ConfigType => {
	const environment = parseSource(source, cwd);
	const {rawRootDir, realRootDir, extractorId, projectFilePath, projects, projectId, storageKey, projectName} = resolveWorkspace(environment, cwd);
	const {storageDirectory, databasePath, analyticsPath, analyticsEnabled} = resolveStorage(environment, cwd, {rawRootDir, realRootDir, storageKey});

	debug('configuration resolved', {
		configPath: environment.configPath,
		rootDir: realRootDir,
		extractorId,
		projectFilePath,
		projects,
		databasePath,
		analyticsPath,
		projectId,
		storageKey,
	});

	return {
		projectName,
		rootDir: realRootDir,
		extractorId,
		extractorOptions: environment.config.extractor.options ?? {},
		projectFilePath,
		projects,
		storageDirectory,
		databasePath,
		analyticsEnabled,
		analyticsPath,
		maxResultBytes: environment.environment.CODE_INDEX_MAX_RESULT_BYTES ?? environment.config.limits?.maxResultBytes ?? 32_768,
		maxReadLines: environment.environment.CODE_INDEX_MAX_READ_LINES ?? environment.config.limits?.maxReadLines ?? 200,
		semanticDiagnostics: environment.environment.CODE_INDEX_SEMANTIC_DIAGNOSTICS ?? environment.config.diagnostics?.semantic ?? false,
		projectId,
		logLevel: environment.environment.CODE_INDEX_LOG_LEVEL,
		configPath: environment.configPath,
	};
};

/**
 * Converts an absolute path into a normalized repository-relative path.
 *
 * @param rootDir - Absolute indexed workspace root.
 * @param absolutePath - Absolute path inside the root.
 * @returns The repository-relative path with POSIX separators.
 * @throws {@link Error} When the path escapes the configured root.
 */
export const toRepositoryPath = (rootDir: string, absolutePath: string): string => {
	const relativePath = relative(rootDir, absolutePath);

	if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
		throw new Error(`Path is outside the indexed working copy: ${absolutePath}`);
	}

	return relativePath.split(sep).join('/');
};
