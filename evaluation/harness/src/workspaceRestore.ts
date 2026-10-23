import {execFileSync} from 'node:child_process';
import {appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {type TreatmentDefinitionType, type ToolSurfaceType} from './treatment.ts';
import {
	type CheckoutVerificationType,
	type RestorationType,
	type WorkspaceContextType,
	applyTreatment,
	contentManifestHashOf,
	EVALUATOR_AGENT,
	git,
	INDEX_CONFIG,
	SUPPORT_PATHS,
	TREATMENT_CONFIG,
} from './workspace.ts';

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
		.filter((entry) => entry.length > 0 && !SUPPORT_PATHS.has(entry.split('/')[0] ?? ''))
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
			.filter((line) => !line.endsWith(TREATMENT_CONFIG) && !line.endsWith(EVALUATOR_AGENT) && !line.endsWith(INDEX_CONFIG)),
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
