import {execFileSync} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {hashOf} from './hash.ts';
import {type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';

/** Treatment-specific configuration file written into every workspace. */
const TREATMENT_CONFIG = path.join('.opencode', 'opencode.jsonc');
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

/** Harness paths resolved from the repository root. */
export type WorkspaceContextType = Readonly<{
	root: string;
	subjectRepo: string;
	revision: string;
	workspacePath: (treatment: TreatmentIdType) => string;
	artifactPath: (treatment: TreatmentDefinitionType) => string;
}>;

/** Generated OpenCode configuration for one treatment. */
export type TreatmentConfigType = Readonly<{
	$schema: string;
	tools: Readonly<Record<string, boolean>>;
	mcp: Readonly<{servers: Readonly<Record<string, Readonly<{type: 'local'; command: readonly string[]; codemode: false}>>>}>;
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
	workspacePath: (treatment) => path.join(root, 'workspaces', treatment),
	artifactPath: (treatment) => {
		if (treatment.artifact === null) {
			throw new Error(`${treatment.id} treatment declares no CodeIndex artifact`);
		}

		return path.join(root, treatment.artifact.root, treatment.artifact.entryPoint);
	},
});

const git = (repo: string, args: readonly string[]): string => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'});

/**
 * Builds the exact configuration for one treatment.
 *
 * Accepted and candidate differ only in the artifact entry point. Every other
 * value, including the ordinary tool map and the generic `execute` removal, is
 * shared.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment definition.
 * @returns The generated configuration and its digest.
 */
export const treatmentConfigOf = (
	context: WorkspaceContextType,
	treatment: TreatmentDefinitionType,
): Readonly<{config: TreatmentConfigType; digest: string}> => {
	const tools = Object.fromEntries([
		...treatment.ordinaryTools.map((name) => [name, true] as const),
		['execute', false] as const,
		['search', false] as const,
	]);
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
		tools,
		mcp: {servers},
	};

	return {config, digest: hashOf(config)};
};

/**
 * Creates every treatment workspace at the pinned revision when absent.
 *
 * Every treatment receives the same tracked content, the same `node_modules`
 * link, and the same agent definition. Only the generated treatment
 * configuration differs.
 *
 * @param context - Workspace paths.
 * @param treatments - Validated treatment definitions.
 */
export const ensureWorkspaces = (context: WorkspaceContextType, treatments: readonly TreatmentDefinitionType[]): void => {
	const subject = context.subjectRepo;
	const head = git(subject, ['rev-parse', 'HEAD']).trim();

	if (!head.startsWith(context.revision)) {
		throw new Error(`subject repository is at ${head.slice(0, 7)}, expected ${context.revision}`);
	}

	for (const treatment of treatments) {
		assertArtifact(context, treatment);
		const workspace = context.workspacePath(treatment.id);

		if (!existsSync(workspace)) {
			mkdirSync(path.dirname(workspace), {recursive: true});
			git(subject, ['worktree', 'add', '--detach', workspace, context.revision]);
		}

		linkSupportFiles(context, workspace);
		excludeSupportFiles(context);
		applyTreatment(context, treatment);
	}
};

/**
 * Rejects a missing artifact or entry point before any model starts.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment definition.
 */
export const assertArtifact = (context: WorkspaceContextType, treatment: TreatmentDefinitionType): void => {
	if (treatment.artifact === null) {
		return;
	}

	const entryPoint = context.artifactPath(treatment);

	if (!existsSync(entryPoint)) {
		throw new Error(`treatment ${treatment.id} artifact entry point is missing: ${entryPoint}`);
	}
};

const writeAgent = (workspace: string): void => {
	const file = path.join(workspace, EVALUATOR_AGENT);
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, EVALUATOR_AGENT_CONTENT, 'utf8');
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
 * Writes the treatment's configuration into its workspace.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment definition.
 */
export const applyTreatment = (context: WorkspaceContextType, treatment: TreatmentDefinitionType): void => {
	const workspace = context.workspacePath(treatment.id);
	const {config} = treatmentConfigOf(context, treatment);
	const configPath = path.join(workspace, TREATMENT_CONFIG);

	mkdirSync(path.dirname(configPath), {recursive: true});
	writeFileSync(configPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
	writeAgent(workspace);
};

/**
 * Restores the workspace to the pinned revision and re-applies the treatment.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment definition.
 */
export const restoreWorkspace = (context: WorkspaceContextType, treatment: TreatmentDefinitionType): void => {
	const workspace = context.workspacePath(treatment.id);

	git(workspace, ['checkout', '--', '.']);
	git(workspace, ['clean', '-fd']);
	applyTreatment(context, treatment);
};

/**
 * Asserts that the workspace contains no authored change outside the generated
 * treatment configuration.
 *
 * @param context - Workspace paths.
 * @param treatment - Treatment under test.
 * @returns Porcelain status lines that are not explained by the treatment.
 */
export const unexpectedChanges = (context: WorkspaceContextType, treatment: TreatmentDefinitionType): readonly string[] => {
	const status = git(context.workspacePath(treatment.id), ['status', '--porcelain']);

	return status
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.filter((line) => !line.includes('.opencode/'));
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

		if (existsSync(workspace)) {
			rmSync(path.join(workspace, 'node_modules'), {force: true});
			git(context.subjectRepo, ['worktree', 'remove', '--force', workspace]);
		}
	}
};
