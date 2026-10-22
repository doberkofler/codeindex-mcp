import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {hashOf} from './hash.ts';
import {type IsolationModeType} from './isolation.ts';
import {permissionRulesOf, type PermissionRuleType} from './surface.ts';
import {toolSurfaceOf, type ToolSurfaceType, type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';

/** Treatment-specific configuration file written into every workspace. */
const TREATMENT_CONFIG = '.opencode/opencode.jsonc';
const EVALUATOR_AGENT = '.opencode/agents/evaluator.md';
/**
 * Ignored paths the harness owns and re-creates after restoration.
 *
 * An execution may use them, but their contents are not authored source and
 * their survival is required for the next execution to run at all.
 */
const SUPPORT_PATHS: readonly string[] = ['node_modules', 'dist'];
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
const MANIFEST_IGNORED_FILES = new Set([TREATMENT_CONFIG, EVALUATOR_AGENT]);

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

/** Harness paths resolved from the repository root. */
export type WorkspaceContextType = Readonly<{
	root: string;
	subjectRepo: string;
	/** Pinned subject identity. */
	subject: SubjectIdentityType;
	workspacePath: (treatment: TreatmentIdType) => string;
	artifactRoot: (treatment: TreatmentDefinitionType) => string;
	artifactPath: (treatment: TreatmentDefinitionType) => string;
}>;

/** Generated OpenCode configuration for one treatment. */
export type TreatmentConfigType = Readonly<{
	$schema: string;
	/** Exact ordered allowlist; every undeclared tool is denied. */
	permissions: readonly PermissionRuleType[];
	mcp: Readonly<{servers: Readonly<Record<string, Readonly<{type: 'local'; command: readonly string[]; codemode: false}>>>}>;
}>;

const git = (repo: string, args: readonly string[]): string =>
	execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});

const digestOfFile = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

const isGitWorkTree = (repo: string): boolean => {
	try {
		return git(repo, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
	} catch {
		return false;
	}
};

const contentEntriesOf = (root: string, relative = ''): readonly ContentEntryType[] => {
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
		lockFileHash,
	};
};

/**
 * Resolves harness paths from the repository root.
 *
 * @param root - Private harness directory.
 * @param settings - Subject repository path and pinned subject identity.
 * @returns Path helpers for one harness run.
 */
export const workspaceContextOf = (root: string, settings: Readonly<{subjectRepo: string; subject: SubjectIdentityType}>): WorkspaceContextType => ({
	root,
	subjectRepo: settings.subjectRepo,
	subject: settings.subject,
	workspacePath: (treatment) => path.join(root, 'workspaces', treatment),
	artifactRoot: (treatment) => {
		if (treatment.artifact === null) {
			throw new Error(`${treatment.id} treatment declares no CodeIndex artifact`);
		}

		return path.join(root, treatment.artifact.root);
	},
	artifactPath: (treatment) => {
		if (treatment.artifact === null) {
			throw new Error(`${treatment.id} treatment declares no CodeIndex artifact`);
		}

		return path.join(root, treatment.artifact.root, treatment.artifact.entryPoint);
	},
});

/**
 * Builds the exact configuration for one treatment.
 *
 * Accepted and candidate differ only in the artifact entry point. Every other
 * value is shared. A leading deny-all permission rule removes every built-in
 * tool that was not declared; the ordinary names and the captured native MCP
 * names are the only permitted actions.
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
						codemode: false as const,
					},
				};
	const config: TreatmentConfigType = {
		$schema: 'https://opencode.ai/config.json',
		permissions: permissionRulesOf(declared),
		mcp: {servers},
	};

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

	mkdirSync(path.dirname(configPath), {recursive: true});
	writeFileSync(configPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
	writeAgent(workspace);
};

const excludeSupportFiles = (context: WorkspaceContextType): void => {
	// A symlinked `node_modules` is not matched by the `node_modules/` ignore rule,
	// which only matches directories, so the shared exclude file ignores it.
	const commonDir = git(context.subjectRepo, ['rev-parse', '--git-common-dir']).trim();
	const exclude = path.resolve(context.subjectRepo, commonDir, 'info', 'exclude');
	const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';

	if (!current.split('\n').includes('node_modules')) {
		appendFileSync(exclude, `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}node_modules\n`, 'utf8');
	}
};

const pathExists = (target: string): boolean => {
	try {
		lstatSync(target);

		return true;
	} catch {
		return false;
	}
};

const linkSupportFiles = (context: WorkspaceContextType, workspace: string): void => {
	const modules = path.join(workspace, 'node_modules');

	if (!pathExists(modules)) {
		execFileSync('ln', ['-s', path.join(context.subjectRepo, 'node_modules'), modules]);
	}

	const distSource = path.join(context.subjectRepo, 'dist');
	const distTarget = path.join(workspace, 'dist');

	if (!pathExists(distTarget) && existsSync(distSource)) {
		execFileSync('cp', ['-R', distSource, distTarget]);
	}
};

const copySubject = (source: string, target: string): void => {
	cpSync(source, target, {
		recursive: true,
		filter: (entry) => {
			const name = path.basename(entry);

			return name !== '.git' && name !== 'node_modules';
		},
	});
};

const createWorkspace = (context: WorkspaceContextType, treatment: TreatmentDefinitionType): void => {
	const workspace = context.workspacePath(treatment.id);

	if (existsSync(workspace)) {
		return;
	}

	mkdirSync(path.dirname(workspace), {recursive: true});

	if (context.subject.mode === 'detached-worktree') {
		if (context.subject.revision === null) {
			throw new Error('detached-worktree isolation requires a resolved subject revision');
		}

		git(context.subjectRepo, ['worktree', 'add', '--detach', workspace, context.subject.revision]);
		excludeSupportFiles(context);
	} else {
		copySubject(context.subjectRepo, workspace);
	}
};

/**
 * Lists ignored paths an execution created that the harness does not own.
 *
 * `git status` omits ignored files by default, so an execution could leave
 * build output or a local database behind and still look clean. Support paths
 * are excluded because restoration re-creates them.
 *
 * @param workspace - Treatment workspace.
 * @returns Workspace-relative ignored paths, sorted.
 */
const authoredIgnoredPathsOf = (workspace: string): readonly string[] =>
	git(workspace, ['status', '--porcelain', '--ignored=matching', '--untracked-files=all'])
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.startsWith('!! '))
		.map((line) => line.slice(3).replace(/\/$/u, ''))
		.filter((entry) => entry.length > 0 && !SUPPORT_PATHS.includes(entry.split('/')[0] ?? ''))
		.sort();

/**
 * Verifies that one workspace is a clean checkout at the pinned subject.
 *
 * The check runs before every execution. A dirty workspace, a staged change, an
 * untracked non-ignored file, an authored ignored file, a different revision, or
 * (without VCS) a content manifest that differs from the pinned subject is a
 * rejection, never a silent repair.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment under test.
 * @returns Cleanliness, revision match, and every unexplained difference.
 */
export const checkoutVerificationOf = (context: WorkspaceContextType, treatment: TreatmentDefinitionType): CheckoutVerificationType => {
	const workspace = context.workspacePath(treatment.id);

	if (!existsSync(workspace)) {
		return {
			checkoutClean: false,
			revisionMatch: false,
			changes: [],
			reason: 'workspace is missing',
		};
	}

	if (context.subject.mode === 'disposable-copy') {
		const actual = contentManifestHashOf(workspace);
		const revisionMatch = actual === context.subject.contentManifestHash;

		return {
			checkoutClean: revisionMatch,
			revisionMatch,
			changes: revisionMatch ? [] : ['workspace content differs from the pinned content manifest'],
			reason: revisionMatch ? null : 'workspace content differs from the pinned content manifest',
		};
	}

	const head = git(workspace, ['rev-parse', 'HEAD']).trim();
	const revisionMatch = head === context.subject.revision;
	const changes = [
		...git(workspace, ['status', '--porcelain', '--untracked-files=all'])
			.split('\n')
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0)
			.filter((line) => !line.endsWith(TREATMENT_CONFIG) && !line.endsWith(EVALUATOR_AGENT)),
		...authoredIgnoredPathsOf(workspace).map((entry) => `!! ${entry}`),
	];
	const reasons: string[] = [];

	if (!revisionMatch) {
		reasons.push(`workspace is at ${head.slice(0, 7)}, expected ${context.subject.revision?.slice(0, 7) ?? 'unknown'}`);
	}

	if (changes.length > 0) {
		reasons.push(`workspace has ${changes.length} authored change(s): ${changes.slice(0, 5).join('; ')}`);
	}

	return {
		checkoutClean: changes.length === 0,
		revisionMatch,
		changes,
		reason: reasons.length === 0 ? null : reasons.join('; '),
	};
};

/**
 * Rejects a workspace that is not a clean checkout at the pinned revision.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment under test.
 * @returns The verification that passed.
 */
export const assertCheckout = (context: WorkspaceContextType, treatment: TreatmentDefinitionType): CheckoutVerificationType => {
	const verification = checkoutVerificationOf(context, treatment);

	if (verification.reason !== null) {
		throw new Error(
			`workspace ${treatment.id} is not a clean checkout: ${verification.reason}; restore it or remove workspaces/${treatment.id} before evaluating`,
		);
	}

	return verification;
};

/**
 * Creates every treatment workspace at the pinned subject when absent.
 *
 * Every treatment receives the same tracked content, the same `node_modules`
 * link, and the same agent definition. Only the generated treatment
 * configuration differs. An existing workspace is verified before it is used.
 *
 * @param context - Workspace paths.
 * @param treatments - Validated treatment definitions.
 */
export const ensureWorkspaces = (context: WorkspaceContextType, treatments: readonly TreatmentDefinitionType[]): void => {
	for (const treatment of treatments) {
		const exists = existsSync(context.workspacePath(treatment.id));

		if (exists) {
			assertCheckout(context, treatment);
		}

		createWorkspace(context, treatment);
		linkSupportFiles(context, context.workspacePath(treatment.id));
		applyTreatment(context, treatment);
	}
};

/**
 * Restores one workspace to the pinned subject after an execution.
 *
 * Tracked edits are discarded, staged changes are reset, every untracked
 * non-ignored file is removed, and every authored ignored file is removed while
 * the harness-owned support paths survive. The next execution therefore starts
 * from the pinned content without re-installing dependencies.
 *
 * A disposable copy is recreated from the subject and verified against the
 * pinned content manifest.
 *
 * Failure is reported, never thrown: the caller records an inspectable failed
 * result and stops the campaign.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment under test.
 * @param surface - Captured surface to regenerate after restoration.
 * @returns Whether the workspace is back at the pinned subject and why not.
 */
export const restoreWorkspace = (
	context: WorkspaceContextType,
	treatment: TreatmentDefinitionType,
	surface?: Pick<ToolSurfaceType, 'tools'>,
): RestorationType => {
	const workspace = context.workspacePath(treatment.id);

	try {
		if (!existsSync(workspace)) {
			createWorkspace(context, treatment);
		} else if (context.subject.mode === 'detached-worktree') {
			if (context.subject.revision === null) {
				throw new Error('detached-worktree isolation requires a resolved subject revision');
			}

			git(workspace, ['reset', '--hard', context.subject.revision]);
			git(workspace, ['clean', '-fd']);

			// `git clean -fd` keeps ignored files. An execution may have written
			// them, so remove everything ignored that the harness does not own.
			for (const entry of authoredIgnoredPathsOf(workspace)) {
				rmSync(path.join(workspace, entry), {recursive: true, force: true});
			}
		} else {
			rmSync(workspace, {recursive: true, force: true});
			createWorkspace(context, treatment);
		}

		linkSupportFiles(context, workspace);
		applyTreatment(context, treatment, surface);

		const verification = checkoutVerificationOf(context, treatment);

		return {restored: verification.reason === null, verification, reason: verification.reason};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);

		return {
			restored: false,
			verification: {checkoutClean: false, revisionMatch: false, changes: [], reason},
			reason,
		};
	}
};

/**
 * Removes every treatment workspace and its registration.
 *
 * @param context - Workspace paths.
 * @param treatments - Treatment definitions.
 */
export const removeWorkspaces = (context: WorkspaceContextType, treatments: readonly TreatmentDefinitionType[]): void => {
	for (const treatment of treatments) {
		const workspace = context.workspacePath(treatment.id);

		if (!existsSync(workspace)) {
			continue;
		}

		if (context.subject.mode === 'detached-worktree') {
			rmSync(path.join(workspace, 'node_modules'), {force: true});
			git(context.subjectRepo, ['worktree', 'remove', '--force', workspace]);
		} else {
			rmSync(workspace, {recursive: true, force: true});
		}
	}
};
