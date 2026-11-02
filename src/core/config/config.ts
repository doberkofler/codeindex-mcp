import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {debugFor} from '../logging/debug.ts';
import {type AdapterConfigType, type ConfigType, type ProjectContextConfigType} from './adapterConfig.ts';
import {resolveAdapters} from './adapterResolution.ts';
import {DEFAULT_EXTRACTOR_ID, assertFile, createStorageKey, fail, indexRootDirectory, isInside} from './configSupport.ts';

const {basename, dirname, isAbsolute, join, relative, resolve, sep} = path;
const debug = debugFor('config');

export type {AdapterConfigType, ConfigType, ProjectContextConfigType} from './adapterConfig.ts';
export {adapterConfigFor, configuredAdapters} from './adapterConfig.ts';
export {indexRootDirectory} from './configSupport.ts';

const ProjectEntrySchema = z.object({
	name: z.string().min(1).optional(),
	project: z.string().min(1),
});

const ExtractorSchema = z.object({
	id: z.string().min(1).optional(),
	required: z.boolean().optional(),
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

const FileConfigSchema = z
	.object({
		project: ProjectSchema.optional(),
		extractor: ExtractorSchema.optional(),
		extractors: z.array(ExtractorSchema).min(1).optional(),
		storage: StorageSchema.optional(),
		limits: LimitsSchema.optional(),
		diagnostics: DiagnosticsSchema.optional(),
	})
	.superRefine((value, context) => {
		const declared = Number(value.extractor !== undefined) + Number(value.extractors !== undefined);

		if (declared !== 1) {
			context.addIssue({
				code: 'custom',
				message: 'exactly one of extractor or extractors must be configured',
			});
		}
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

/** Resolved identity that both the workspace and storage resolvers share. */
type WorkspaceIdentityType = Readonly<{
	adapters: readonly AdapterConfigType[];
	extractorId: string;
	extractorOptions: Readonly<Record<string, unknown>>;
	projectFilePath: string;
	projects: readonly ProjectContextConfigType[];
	projectId: string;
	storageKey: string;
	projectName: string;
}>;

const defaultDatabasePath = (directory: string, projectId: string): string => join(directory, projectId, 'index.sqlite');

const defaultAnalyticsPath = (directory: string, projectId: string): string => join(directory, projectId, 'analytics', 'events.jsonl');

const parseConfigFile = (configPath: string, label: string): FileConfigType => {
	assertFile(configPath, label);

	let parsed: unknown;

	try {
		parsed = JSON.parse(readFileSync(configPath, 'utf8'));
	} catch (error) {
		return fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	const result = FileConfigSchema.safeParse(parsed);

	if (!result.success) {
		return fail(`${label} failed validation:\n${z.prettifyError(result.error)}`);
	}

	return result.data;
};

/**
 * Reads the first configured extractor from a CodeIndex configuration file.
 *
 * @param configPath - Absolute configuration path, or undefined when none is configured.
 * @returns The configured extractor identifier, or the default extractor.
 * @throws {@link Error} When the file is missing, is not valid JSON, or fails validation.
 */
export const extractorIdOfConfig = (configPath: string | undefined): string => {
	if (configPath === undefined) {
		return DEFAULT_EXTRACTOR_ID;
	}

	const file = parseConfigFile(configPath, 'CodeIndex configuration');

	return file.extractors?.[0]?.id ?? file.extractor?.id ?? DEFAULT_EXTRACTOR_ID;
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

type FileConfigSourceType = Readonly<{
	environment: z.infer<typeof EnvironmentSchema>;
	config: FileConfigType;
	directory: string;
	configPath: string | null;
}>;

const fileConfigOf = (source: unknown, cwd: string): Readonly<{config: FileConfigType; directory: string; configPath: string | null}> => {
	const parsedEnvironment = EnvironmentSchema.safeParse(source);

	if (!parsedEnvironment.success) {
		return fail(z.prettifyError(parsedEnvironment.error));
	}

	const configuredPath = parsedEnvironment.data.CODE_INDEX_CONFIG;

	if (configuredPath === undefined) {
		return {config: FileConfigSchema.parse({extractor: {}}), directory: cwd, configPath: null};
	}

	const configPath = resolve(cwd, configuredPath);

	return {config: parseConfigFile(configPath, 'CODE_INDEX_CONFIG'), directory: dirname(configPath), configPath};
};

const parseSource = (source: NodeJS.ProcessEnv, cwd: string): FileConfigSourceType => {
	const parsedEnvironment = EnvironmentSchema.safeParse(source);

	if (!parsedEnvironment.success) {
		return fail(z.prettifyError(parsedEnvironment.error));
	}

	const fileSource = fileConfigOf(source, cwd);
	return {environment: parsedEnvironment.data, ...fileSource};
};

const workspaceRoot = (
	environment: z.infer<typeof EnvironmentSchema>,
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

const projectIdentity = (
	input: Readonly<{
		environment: z.infer<typeof EnvironmentSchema>;
		file: FileConfigType;
		realRootDir: string;
		cwd: string;
		configPath: string | null;
	}>,
): WorkspaceIdentityType => {
	const {environment, file, realRootDir, cwd, configPath} = input;
	const adapters = resolveAdapters({
		environment,
		...(file.extractor === undefined ? {} : {extractor: file.extractor}),
		...(file.extractors === undefined ? {} : {extractors: file.extractors}),
		realRootDir,
		cwd,
	});
	const [primary] = adapters;

	if (primary === undefined) {
		return fail('at least one adapter is required');
	}

	// The storage key always binds to the physical checkout, so a copy or a move
	// never reaches another checkout's database. A configured project id changes
	// only the reported logical identity.
	const storageKey = createStorageKey(realRootDir, configPath, adapters);
	const projectId = environment.CODE_INDEX_PROJECT_ID ?? file.project?.id ?? storageKey;

	return {
		adapters,
		extractorId: primary.id,
		extractorOptions: primary.options,
		projectFilePath: primary.projectFilePath,
		projects: primary.projects,
		projectId,
		storageKey,
		projectName: file.project?.name ?? basename(realRootDir),
	};
};

const resolveWorkspace = (input: FileConfigSourceType, cwd: string): WorkspaceIdentityType & Readonly<{rawRootDir: string; realRootDir: string}> => {
	const {environment, config: file, directory, configPath} = input;
	const root = workspaceRoot(environment, file, directory, cwd);

	return {...root, ...projectIdentity({environment, file, realRootDir: root.realRootDir, cwd, configPath})};
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
	const {rawRootDir, realRootDir, adapters, extractorId, extractorOptions, projectFilePath, projects, projectId, storageKey, projectName} = resolveWorkspace(
		environment,
		cwd,
	);
	const {storageDirectory, databasePath, analyticsPath, analyticsEnabled} = resolveStorage(environment, cwd, {rawRootDir, realRootDir, storageKey});

	debug('configuration resolved', {
		configPath: environment.configPath,
		rootDir: realRootDir,
		adapters: adapters.map((adapter) => adapter.id),
		databasePath,
		analyticsPath,
		projectId,
		storageKey,
	});

	return {
		projectName,
		rootDir: realRootDir,
		adapters,
		extractorId,
		extractorOptions,
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
