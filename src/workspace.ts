import {execFileSync} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {type ArmNameType} from './schema.ts';

/** Arm-specific configuration file that carries the index MCP server. */
const ARM_CONFIG = path.join('.opencode', 'opencode.jsonc');
const DISABLED_CONFIG = path.join('.opencode', 'opencode.jsonc.arm-disabled');
const EVALUATOR_AGENT = path.join('.opencode', 'agents', 'evaluator.md');
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
 * The single agent definition used by both arms.
 *
 * The prompt is identical by construction: the only treatment difference is
 * whether the codeindex MCP server is configured. Guidance is deliberately
 * neutral so the index must win on its own interface.
 */
const EVALUATOR_AGENT_CONTENT = `${AGENT_PREAMBLE}Use the available retrieval tools. When a code index is available, prefer it for symbol
lookup, references, dependencies, outlines, and bounded source reads; use grep or whole-file
reads only when the index cannot answer.
`;

/** Indexed arm configuration: the project config plus retrieval guidance. */
const INDEXED_CONFIG_CONTENT = JSON.stringify(
	{
		$schema: 'https://opencode.ai/config.json',
		mcp: {servers: {codeindex: {type: 'local', command: ['node', 'dist/mcp.mjs'], codemode: false}}},
	},
	null,
	'\t',
);

/** Harness paths resolved from the repository root. */
export type WorkspaceContextType = Readonly<{
	root: string;
	subjectRepo: string;
	revision: string;
	workspacePath: (arm: ArmNameType) => string;
}>;

/**
 * Resolves harness paths from the repository root.
 *
 * @param root - Private harness directory.
 * @param settings - Subject repository path and pinned revision.
 * @returns Path helpers for one harness run.
 */
export const workspaceContextOf = (
	root: string,
	settings: Readonly<{subjectRepo: string; revision: string}>,
): WorkspaceContextType => ({
	root,
	subjectRepo: settings.subjectRepo,
	revision: settings.revision,
	workspacePath: (arm) => path.join(root, 'workspaces', arm),
});

const git = (repo: string, args: readonly string[]): string => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'});

/**
 * Creates both arm workspaces at the pinned revision when they are absent.
 *
 * Both arms receive the same tracked content, the same `node_modules` link, and
 * the same built `dist`. Only the arm configuration differs at run time.
 *
 * @param context - Workspace paths.
 */
export const ensureWorkspaces = (context: WorkspaceContextType): void => {
	const subject = context.subjectRepo;
	const head = git(subject, ['rev-parse', 'HEAD']).trim();

	if (!head.startsWith(context.revision)) {
		throw new Error(`subject repository is at ${head.slice(0, 7)}, expected ${context.revision}`);
	}

	for (const arm of ['baseline', 'indexed'] as const) {
		const workspace = context.workspacePath(arm);

		if (!existsSync(workspace)) {
			mkdirSync(path.dirname(workspace), {recursive: true});
			git(subject, ['worktree', 'add', '--detach', workspace, context.revision]);
		}

		linkSupportFiles(context, workspace);
		excludeSupportFiles(context);
	}

	applyArm(context, 'indexed');
	applyArm(context, 'baseline');
};

const writeAgent = (workspace: string, content: string): void => {
	const file = path.join(workspace, EVALUATOR_AGENT);
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, content, 'utf8');
};

const excludeSupportFiles = (context: WorkspaceContextType): void => {
	// A symlinked `node_modules` is not matched by the `node_modules/` ignore rule,
	// which only matches directories, so the shared exclude file ignores it.
	const commonDir = execFileSync('git', ['-C', context.subjectRepo, 'rev-parse', '--git-common-dir'], {encoding: 'utf8'}).trim();
	const exclude = path.resolve(context.subjectRepo, commonDir, 'info', 'exclude');
	const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';

	if (!current.split('\n').includes('node_modules')) {
		appendFileSync(exclude, `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}node_modules\n`, 'utf8');
	}
};

const linkSupportFiles = (context: WorkspaceContextType, workspace: string): void => {
	const modules = path.join(workspace, 'node_modules');

	if (!existsSync(modules)) {
		execFileSync('ln', ['-s', path.join(context.subjectRepo, 'node_modules'), modules]);
	}

	const distSource = path.join(context.subjectRepo, 'dist');
	const distTarget = path.join(workspace, 'dist');

	if (!existsSync(distTarget)) {
		execFileSync('cp', ['-R', distSource, distTarget]);
	}
};

/**
 * Applies the arm's configuration to its workspace.
 *
 * The indexed arm keeps the project MCP server entry; the baseline arm moves it
 * aside so the index tools are not configured at all.
 *
 * @param context - Workspace paths.
 * @param arm - Arm to prepare.
 */
export const applyArm = (context: WorkspaceContextType, arm: ArmNameType): void => {
	const workspace = context.workspacePath(arm);
	const config = path.join(workspace, ARM_CONFIG);
	const disabled = path.join(workspace, DISABLED_CONFIG);

	if (arm === 'baseline') {
		if (existsSync(config)) {
			renameSync(config, disabled);
		}

		writeAgent(workspace, EVALUATOR_AGENT_CONTENT);

		return;
	}

	if (!existsSync(config) && existsSync(disabled)) {
		renameSync(disabled, config);
	}

	if (!existsSync(config)) {
		throw new Error(`indexed workspace is missing ${ARM_CONFIG}`);
	}

	writeFileSync(config, `${INDEXED_CONFIG_CONTENT}\n`, 'utf8');
	writeAgent(workspace, EVALUATOR_AGENT_CONTENT);
};

/**
 * Restores the workspace to the pinned revision and re-applies the arm.
 *
 * @param context - Workspace paths.
 * @param arm - Arm to restore.
 */
export const restoreWorkspace = (context: WorkspaceContextType, arm: ArmNameType): void => {
	const workspace = context.workspacePath(arm);

	if (existsSync(path.join(workspace, DISABLED_CONFIG))) {
		renameSync(path.join(workspace, DISABLED_CONFIG), path.join(workspace, ARM_CONFIG));
	}

	git(workspace, ['checkout', '--', '.']);
	git(workspace, ['clean', '-fd']);
	applyArm(context, arm);
};

/**
 * Asserts that the workspace contains no authored change outside the arm config.
 *
 * @param context - Workspace paths.
 * @param arm - Arm under test.
 * @returns Porcelain status lines that are not explained by the arm.
 */
export const unexpectedChanges = (context: WorkspaceContextType, arm: ArmNameType): readonly string[] => {
	const status = git(context.workspacePath(arm), ['status', '--porcelain']);

	return status
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.filter((line) => !line.includes('.opencode/'));
};

/**
 * Removes both arm workspaces and their registrations.
 *
 * @param context - Workspace paths.
 */
export const removeWorkspaces = (context: WorkspaceContextType): void => {
	for (const arm of ['baseline', 'indexed'] as const) {
		const workspace = context.workspacePath(arm);

		if (existsSync(workspace)) {
			rmSync(path.join(workspace, 'node_modules'), {force: true});
			git(context.subjectRepo, ['worktree', 'remove', '--force', workspace]);
		}
	}
};
