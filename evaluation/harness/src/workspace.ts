import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {hashOf} from './hash.ts';
import {type IsolationModeType} from './isolation.ts';
import {assertNoPathDisclosure} from './pathDisclosure.ts';
import {permissionRulesOf, type PermissionRuleType} from './surface.ts';
import {toolSurfaceOf, type ToolSurfaceType, type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';

/** Treatment-specific configuration file written into every workspace. */
export const TREATMENT_CONFIG = '.opencode/opencode.jsonc';
export const EVALUATOR_AGENT = '.opencode/agents/evaluator.md';
/** Generated multi-project CodeIndex configuration. */
export const INDEX_CONFIG = '.opencode/codeindex.json';
/** Project files every evaluation workspace indexes in one generation. */
export const EVALUATION_PROJECTS = [
	{name: 'root', projectFile: 'tsconfig.json', scopePrefix: ''},
	{
		name: 'controlled-typescript',
		projectFile: 'evaluation/fixtures/controlled-typescript/tsconfig.json',
		scopePrefix: 'evaluation/fixtures/controlled-typescript/',
	},
	{name: 'test', projectFile: 'tsconfig.test.json', scopePrefix: 'test/'},
] as const;
const INDEX_CONFIG_CONTENT = {
	project: {root: '..'},
	extractor: {
		id: 'typescript',
		projects: EVALUATION_PROJECTS.map((project) => ({name: project.name, project: project.projectFile})),
	},
	diagnostics: {semantic: false},
} as const;
/**
 * Ignored paths the harness owns and re-creates after restoration.
 *
 * An execution may use them, but their contents are not authored source and
 * their survival is required for the next execution to run at all.
 */
export const SUPPORT_PATHS: ReadonlySet<string> = new Set(['node_modules', 'dist']);
const AGENT_PREAMBLE = [
	'---',
	'description: Code location evaluator',
	'mode: primary',
	'---',
	'You are a code-location agent working in a repository checkout.',
	'',
	'Answer the question by locating the responsible source files. Never answer from memory or',
	'from general knowledge about the project.',
	'',
].join('\n');

/**
 * The single agent definition used by every treatment.
 *
 * The prompt is identical by construction: the only treatment difference is
 * whether a CodeIndex artifact is configured. Guidance is deliberately neutral
 * so the index must win on its own interface.
 */
const EVALUATOR_AGENT_CONTENT = `${AGENT_PREAMBLE}Use the available retrieval tools. When a code index is available, prefer it for symbol
lookup, references, dependencies, outlines, and bounded source reads; use grep or whole-file
reads only when the index cannot answer.
`;

/** Directories that never belong to a subject or workspace content manifest. */
const MANIFEST_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

/** Harness-generated files that are recreated after every restore. */
const MANIFEST_IGNORED_FILES = new Set([TREATMENT_CONFIG, EVALUATOR_AGENT, INDEX_CONFIG]);

/** Lock files whose content pins the installed dependency tree. */
const LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'] as const;

/** One file of a subject or workspace content manifest. */
export type ContentEntryType = Readonly<{path: string; digest: string}>;

/** Identity of the evaluated subject at the pinned revision. */
export type SubjectIdentityType = Readonly<{
	mode: IsolationModeType;
	/** Full commit hash with a version-control client, otherwise null. */
	revision: string | null;
	/** Revision text declared by the suite, recorded even when a copy is used. */
	declaredRevision: string;
	/** Digest over the subject file list; the pin when no VCS is available. */
	contentManifestHash: string;
	/** Digest over every configured extractor project file. */
	projectFilesHash: string;
	/** Digest of the dependency lock file, or null when the subject has none. */
	lockFileHash: string | null;
}>;

/** Result of comparing one workspace with the pinned subject. */
export type CheckoutVerificationType = Readonly<{
	checkoutClean: boolean;
	revisionMatch: boolean;
	/** Unexplained status lines or content differences. */
	changes: readonly string[];
	/** Null only when the workspace is clean and at the pinned revision. */
	reason: string | null;
}>;

/** Outcome of restoring one workspace after an execution. */
export type RestorationType = Readonly<{
	restored: boolean;
	verification: CheckoutVerificationType;
	reason: string | null;
}>;

/** Harness paths resolved from the external state root. */
export type WorkspaceContextType = Readonly<{
	/** Disposable state root outside the primary checkout. */
	root: string;
	/** Committed evaluation directory that owns suites, cases, and source artifacts. */
	evaluationRoot: string;
	/** Primary checkout that no generated state or request may disclose. */
	primaryCheckout: string;
	subjectRepo: string;
	/** Pinned subject identity. */
	subject: SubjectIdentityType;
	workspacePath: (treatment: TreatmentIdType) => string;
	/** Declared artifact tree under the committed evaluation directory. */
	declaredArtifactRoot: (treatment: TreatmentDefinitionType) => string;
	/** Staged artifact tree under the external state root. */
	artifactRoot: (treatment: TreatmentDefinitionType) => string;
	artifactPath: (treatment: TreatmentDefinitionType) => string;
	/** Treatment-local index database outside the workspace. */
	databasePath: (treatment: TreatmentDefinitionType) => string;
	/** Generated multi-project configuration inside the workspace. */
	codeIndexConfigPath: (treatment: TreatmentDefinitionType) => string;
	/** Exact CodeIndex environment for the staged artifact. */
	codeIndexEnvironment: (treatment: TreatmentDefinitionType) => Readonly<Record<string, string>>;
}>;

/** Generated OpenCode configuration for one treatment. */
export type TreatmentConfigType = Readonly<{
	$schema: string;
	/** Exact ordered allowlist; every undeclared tool is denied. */
	permissions: readonly PermissionRuleType[];
	mcp: Readonly<{
		servers: Readonly<Record<string, Readonly<{type: 'local'; command: readonly string[]; codemode: boolean; environment?: Readonly<Record<string, string>>}>>>;
	}>;
}>;

export const git = (repo: string, args: readonly string[]): string =>
	execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});

const digestOfFile = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

const isGitWorkTree = (repo: string): boolean => {
	try {
		return git(repo, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
	} catch {
		return false;
	}
};

export const contentEntriesOf = (root: string, relative = ''): readonly ContentEntryType[] => {
	const directory = relative === '' ? root : path.join(root, relative);
	const entries: ContentEntryType[] = [];

	for (const name of readdirSync(directory).sort()) {
		const child = relative === '' ? name : `${relative}/${name}`;

		if (MANIFEST_IGNORED_DIRECTORIES.has(name) || MANIFEST_IGNORED_FILES.has(child)) {
			continue;
		}

		const absolute = path.join(root, child);
		const stats = lstatSync(absolute);

		if (stats.isDirectory()) {
			entries.push(...contentEntriesOf(root, child));

			continue;
		}

		const digest = stats.isSymbolicLink() ? hashOf({symlink: readlinkSync(absolute)}) : digestOfFile(absolute);

		entries.push({path: child, digest});
	}

	return entries;
};

/**
 * Hashes the content of one directory tree.
 *
 * Generated treatment files are excluded so the digest describes the subject
 * content, not the harness's own configuration.
 *
 * @param root - Absolute directory root.
 * @returns Digest over sorted relative paths and file digests.
 */
export const contentManifestHashOf = (root: string): string => hashOf(contentEntriesOf(root));

/**
 * Hashes the commit tree of one revision.
 *
 * @param repo - Git repository.
 * @param revision - Full commit hash.
 * @returns Digest over sorted tracked path and blob pairs.
 */
const treeManifestHashOf = (repo: string, revision: string): string => {
	const entries = git(repo, ['ls-tree', '-r', '--full-tree', revision])
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const [metadata, file] = line.split('\t');
			const digest = metadata?.split(' ')[2] ?? '';

			return {path: file ?? '', digest};
		});

	return hashOf(entries);
};

const lockFileHashOf = (repo: string): string | null => {
	for (const name of LOCK_FILES) {
		const file = path.join(repo, name);

		if (existsSync(file)) {
			return digestOfFile(file);
		}
	}

	return null;
};

/**
 * Hashes the configured project files that determine indexed coverage.
 *
 * @param repo - Subject or workspace root.
 * @returns Digest over the present project files.
 */
export const projectFilesHashOf = (repo: string): string =>
	hashOf(
		EVALUATION_PROJECTS.flatMap((project) => {
			const file = path.join(repo, project.projectFile);

			return existsSync(file) && statSync(file).isFile() ? [{path: project.projectFile, digest: digestOfFile(file)}] : [];
		}),
	);

const resolveRevision = (repo: string, revision: string): string => {
	try {
		return git(repo, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
	} catch {
		throw new Error(`subject repository has no commit "${revision}"`);
	}
};

/**
 * Resolves the pinned subject and refuses a checkout that is not reproducible.
 *
 * With a version-control client the subject must be clean and exactly at the
 * declared revision. Without one the subject is identified by a content
 * manifest and the declared revision remains a recorded declaration only.
 *
 * @param subjectRepo - Subject checkout path.
 * @param revision - Revision declared by the suite.
 * @returns The pinned subject identity.
 */
export const subjectIdentityOf = (subjectRepo: string, revision: string): SubjectIdentityType => {
	const repo = path.resolve(subjectRepo);

	if (!existsSync(repo)) {
		throw new Error(`subject repository is missing: ${repo}`);
	}

	const lockFileHash = lockFileHashOf(repo);

	if (!isGitWorkTree(repo)) {
		return {
			mode: 'disposable-copy',
			revision: null,
			declaredRevision: revision,
			contentManifestHash: contentManifestHashOf(repo),
			projectFilesHash: projectFilesHashOf(repo),
			lockFileHash,
		};
	}

	const resolved = resolveRevision(repo, revision);
	const head = git(repo, ['rev-parse', 'HEAD']).trim();

	if (head !== resolved) {
		throw new Error(`subject repository is at ${head.slice(0, 7)}, expected ${resolved.slice(0, 7)}`);
	}

	const dirty = git(repo, ['status', '--porcelain', '--untracked-files=normal'])
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);

	if (dirty.length > 0) {
		throw new Error(`subject repository has uncommitted change(s): ${dirty.slice(0, 5).join('; ')}`);
	}

	return {
		mode: 'detached-worktree',
		revision: resolved,
		declaredRevision: revision,
		contentManifestHash: treeManifestHashOf(repo, resolved),
		projectFilesHash: projectFilesHashOf(repo),
		lockFileHash,
	};
};

/**
 * Resolves harness paths from the disposable state root.
 *
 * @param root - External state root for workspaces, databases, staged artifacts, and results.
 * @param settings - Subject repository, pinned identity, and committed evaluation root.
 * @returns Path helpers for one harness run.
 */
export const workspaceContextOf = (
	root: string,
	settings: Readonly<{subjectRepo: string; subject: SubjectIdentityType; evaluationRoot?: string; primaryCheckout?: string}>,
): WorkspaceContextType => {
	const evaluationRoot = path.resolve(settings.evaluationRoot ?? root);
	const primaryCheckout = path.resolve(
		settings.primaryCheckout ?? (path.basename(evaluationRoot) === 'evaluation' ? path.dirname(evaluationRoot) : evaluationRoot),
	);
	const declaredArtifactRoot = (treatment: TreatmentDefinitionType): string => {
		if (treatment.artifact === null) {
			throw new Error(`${treatment.id} treatment declares no CodeIndex artifact`);
		}

		return path.join(evaluationRoot, treatment.artifact.root);
	};
	const artifactRoot = (treatment: TreatmentDefinitionType): string => {
		if (treatment.artifact === null) {
			throw new Error(`${treatment.id} treatment declares no CodeIndex artifact`);
		}

		return path.join(root, 'artifacts', treatment.artifact.id);
	};
	const databasePath = (treatment: TreatmentDefinitionType): string => path.join(root, 'databases', `${treatment.id}.sqlite`);

	return {
		root,
		evaluationRoot,
		primaryCheckout,
		subjectRepo: settings.subjectRepo,
		subject: settings.subject,
		workspacePath: (treatment) => path.join(root, 'workspaces', treatment),
		declaredArtifactRoot,
		artifactRoot,
		artifactPath: (treatment) => path.join(artifactRoot(treatment), treatment.artifact?.entryPoint ?? ''),
		databasePath,
		codeIndexConfigPath: (treatment) => path.join(root, 'workspaces', treatment.id, INDEX_CONFIG),
		codeIndexEnvironment: (treatment) => ({
			CODE_INDEX_CONFIG: INDEX_CONFIG,
			CODE_INDEX_DATABASE: databasePath(treatment),
			CODE_INDEX_ANALYTICS: 'false',
			CODE_INDEX_LOG_LEVEL: 'error',
		}),
	};
};

/**
 * Copies a declared artifact tree into the external state root.
 *
 * The staged tree is the one every MCP process runs. Staging is deterministic:
 * an existing target is replaced, and `node_modules` links keep their target
 * text so the artifact digest is unchanged by the move.
 *
 * @param context - Workspace paths.
 * @param treatment - CodeIndex treatment that loads the artifact.
 * @returns The staged artifact root.
 */
export const stageArtifactOf = (context: Pick<WorkspaceContextType, 'declaredArtifactRoot' | 'artifactRoot'>, treatment: TreatmentDefinitionType): string => {
	const source = context.declaredArtifactRoot(treatment);
	const target = context.artifactRoot(treatment);

	if (!existsSync(source)) {
		throw new Error(`artifact ${treatment.artifact?.id ?? treatment.id} is not staged at ${source}`);
	}

	if (path.resolve(source) === path.resolve(target)) {
		return target;
	}

	rmSync(target, {recursive: true, force: true});
	mkdirSync(path.dirname(target), {recursive: true});
	cpSync(source, target, {recursive: true, preserveTimestamps: true, verbatimSymlinks: true});

	return target;
};

/**
 * Builds the generated multi-project CodeIndex configuration.
 *
 * Both the repository root and the controlled semantic fixture are configured
 * in one workspace generation. Project paths stay relative, so the generated
 * file never discloses a checkout location.
 *
 * @returns The configuration document.
 */
export const indexConfigOf = (): unknown => structuredClone(INDEX_CONFIG_CONTENT);

const writeIndexConfig = (workspace: string): void => {
	const file = path.join(workspace, INDEX_CONFIG);
	const serialized = `${JSON.stringify(INDEX_CONFIG_CONTENT, null, '\t')}\n`;

	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, serialized, 'utf8');
};

/**
 * Builds the exact configuration for one treatment.
 *
 * Accepted and candidate differ only in the artifact entry point. Every other
 * value is shared. A leading deny-all permission rule removes every built-in
 * tool that was not declared; the ordinary names and the captured native MCP
 * names are the only permitted actions. The MCP server receives the external
 * index database and the generated multi-project configuration explicitly.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment definition.
 * @param surface - Captured surface; defaults to the ordinary tools only.
 * @returns The generated configuration and its digest.
 */
export const treatmentConfigOf = (
	context: WorkspaceContextType,
	treatment: TreatmentDefinitionType,
	surface?: Pick<ToolSurfaceType, 'tools'>,
): Readonly<{config: TreatmentConfigType; digest: string}> => {
	const declared = surface ?? toolSurfaceOf(treatment);
	const servers =
		treatment.mcp === null
			? {}
			: {
					[treatment.mcp.server]: {
						type: 'local' as const,
						command: ['node', context.artifactPath(treatment)] as const,
						codemode: treatment.mcp.codemode,
						environment: context.codeIndexEnvironment(treatment),
					},
				};
	const config: TreatmentConfigType = {
		$schema: 'https://opencode.ai/config.json',
		permissions: permissionRulesOf(declared),
		mcp: {servers},
	};
	const serialized = JSON.stringify(config);

	if (path.resolve(context.root) !== path.resolve(context.primaryCheckout)) {
		assertNoPathDisclosure(serialized, [context.primaryCheckout], `${treatment.id} generated configuration`);
		assertNoPathDisclosure(JSON.stringify(indexConfigOf()), [context.primaryCheckout], `${treatment.id} index configuration`);
	}

	return {config, digest: hashOf(config)};
};

const writeAgent = (workspace: string): void => {
	const file = path.join(workspace, EVALUATOR_AGENT);
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, EVALUATOR_AGENT_CONTENT, 'utf8');
};

/**
 * Writes the treatment's configuration into its workspace.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment definition.
 * @param surface - Captured surface; defaults to the ordinary tools only.
 */
export const applyTreatment = (context: WorkspaceContextType, treatment: TreatmentDefinitionType, surface?: Pick<ToolSurfaceType, 'tools'>): void => {
	const workspace = context.workspacePath(treatment.id);
	const {config} = treatmentConfigOf(context, treatment, surface);
	const configPath = path.join(workspace, TREATMENT_CONFIG);

	writeIndexConfig(workspace);
	mkdirSync(path.dirname(configPath), {recursive: true});
	writeFileSync(configPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
	writeAgent(workspace);
};
