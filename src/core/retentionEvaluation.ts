import path from 'node:path';
import {RETENTION_POLICY, type RetentionDecisionType, type RetentionInputType, type RetentionPlanType, type RetentionTargetType} from './retentionPolicy.ts';
import {
	ageBoundTargets,
	childDirectoriesOf,
	childFilesOf,
	DAY_MS,
	footprintBytes,
	gitCommonRootOf,
	gitStateOf,
	HOUR_MS,
	mtimeOf,
	protectedTarget,
} from './retentionSupport.ts';

const {basename, join} = path;

const evaluationStateRootsOf = (evaluationRoots: readonly string[]): readonly string[] =>
	evaluationRoots.flatMap((root) => (basename(root) === 'codeindex-evaluation' ? childDirectoriesOf(root) : [root]));

type StatePlanType = Readonly<{
	targets: RetentionTargetType[];
	refused: RetentionDecisionType[];
	retained: RetentionDecisionType[];
	worktreeRoots: readonly string[];
}>;

const workspacePlanOf = (
	input: Readonly<{
		stateRoot: string;
		now: Date;
		protectedPaths: readonly string[];
		discardDirty: boolean;
	}>,
): StatePlanType => {
	const plan = ageBoundTargets({
		category: 'evaluation_workspace',
		paths: childDirectoriesOf(join(input.stateRoot, 'workspaces')),
		maxEntries: RETENTION_POLICY.evaluation_workspace.maxEntries,
		maxAgeMs: RETENTION_POLICY.evaluation_workspace.maxAgeHours * HOUR_MS,
		now: input.now,
		protectedPaths: input.protectedPaths,
	});
	const targets: RetentionTargetType[] = [];
	const refused: RetentionDecisionType[] = [...plan.refused];
	const worktreeRoots: string[] = [];

	for (const target of plan.targets) {
		const common = gitCommonRootOf(target.path);

		if (common !== null) {
			worktreeRoots.push(common);
		}

		if (gitStateOf(target.path) === 'dirty' && !input.discardDirty) {
			refused.push({...target, reason: 'dirty_worktree'});
		} else {
			targets.push(target);
		}
	}

	return {targets, refused, retained: [...plan.retained], worktreeRoots};
};

const reportPlanOf = (
	input: Readonly<{
		stateRoot: string;
		now: Date;
		protectedPaths: readonly string[];
	}>,
): StatePlanType => {
	const databasePlan = ageBoundTargets({
		category: 'evaluation_workspace',
		paths: childFilesOf(join(input.stateRoot, 'databases')),
		maxEntries: Number.MAX_SAFE_INTEGER,
		maxAgeMs: RETENTION_POLICY.evaluation_workspace.maxAgeHours * HOUR_MS,
		now: input.now,
		protectedPaths: input.protectedPaths,
	});
	const reportPlan = ageBoundTargets({
		category: 'evaluation_report',
		paths: childDirectoriesOf(join(input.stateRoot, 'results')),
		maxEntries: RETENTION_POLICY.evaluation_report.maxEntries,
		maxAgeMs: RETENTION_POLICY.evaluation_report.maxAgeDays * DAY_MS,
		now: input.now,
		protectedPaths: input.protectedPaths,
	});
	const targets = [...databasePlan.targets, ...reportPlan.targets];
	const refused = [...databasePlan.refused, ...reportPlan.refused];
	const retained = [...databasePlan.retained, ...reportPlan.retained];
	const temporary = join(input.stateRoot, 'tmp');

	if (mtimeOf(temporary) > 0 && input.now.getTime() - mtimeOf(temporary) > RETENTION_POLICY.evaluation_workspace.maxAgeHours * HOUR_MS) {
		const bytes = footprintBytes(temporary);

		if (protectedTarget(temporary, input.protectedPaths)) {
			refused.push({category: 'evaluation_workspace', path: temporary, bytes, reason: 'protected_path'});
		} else {
			targets.push({category: 'evaluation_workspace', path: temporary, bytes});
		}
	}

	return {targets, refused, retained, worktreeRoots: []};
};

/**
 * Collects stale evaluation workspaces, databases, temporary directories, and superseded reports.
 *
 * @param input - Evaluation roots, protection, discard approval, and clock.
 * @returns Removable evaluation state, refusals, retained state, and worktree roots.
 */
export const evaluationPlan = (
	input: RetentionInputType &
		Readonly<{
			evaluationRoots: readonly string[];
		}>,
): RetentionPlanType => {
	const now = input.now ?? new Date();
	const statePlans = evaluationStateRootsOf(input.evaluationRoots).map((stateRoot) => {
		const workspaces = workspacePlanOf({stateRoot, now, protectedPaths: input.protectedPaths, discardDirty: input.discardDirty === true});
		const reports = reportPlanOf({stateRoot, now, protectedPaths: input.protectedPaths});

		return {
			targets: [...workspaces.targets, ...reports.targets],
			refused: [...workspaces.refused, ...reports.refused],
			retained: [...workspaces.retained, ...reports.retained],
			worktreeRoots: workspaces.worktreeRoots,
		};
	});

	return {
		targets: statePlans.flatMap((plan) => plan.targets),
		refused: statePlans.flatMap((plan) => plan.refused),
		retained: statePlans.flatMap((plan) => plan.retained),
		worktreeRoots: [...new Set(statePlans.flatMap((plan) => plan.worktreeRoots))],
	};
};
