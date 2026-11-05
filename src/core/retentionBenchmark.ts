import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {RETENTION_POLICY, type RetentionDecisionType, type RetentionInputType, type RetentionPlanType, type RetentionTargetType} from './retentionPolicy.ts';
import {ageBoundTargets, childDirectoriesOf, footprintBytes, gitOutput, gitStateOf, HOUR_MS, protectedTarget} from './retentionSupport.ts';

const {basename, join} = path;

const BENCHMARK_WORKSPACE_PREFIX = 'codeindex-benchmark-workspace-';
const BENCHMARK_DATABASE_PREFIX = 'codeindex-benchmark-database-';
const ORACLE_BENCHMARK_PREFIX = '.oracle-antlr-benchmark-';
const BENCHMARK_PROJECTS_DIRECTORY = 'projects';
const PREPARE_MANIFEST = 'prepare.json';

/**
 * Collects benchmark workspace, scratch-database, and Oracle benchmark residue.
 *
 * @param input - Temporary and repository roots, protection, and clock.
 * @returns Removable residue, refusals, and retained entries.
 */
export const benchmarkResiduePlan = (
	input: RetentionInputType &
		Readonly<{
			temporaryDirectory?: string | undefined;
			repository?: string | undefined;
		}>,
): RetentionPlanType => {
	const now = input.now ?? new Date();
	const temporary = input.temporaryDirectory;
	const categories: readonly Readonly<{
		category: 'benchmark_workspace' | 'benchmark_scratch_database';
		prefix: string;
		directory: string;
		maxEntries: number;
		maxAgeHours: number;
	}>[] = [
		...(temporary === undefined
			? []
			: [
					{
						category: 'benchmark_workspace' as const,
						prefix: BENCHMARK_WORKSPACE_PREFIX,
						directory: temporary,
						maxEntries: RETENTION_POLICY.benchmark_workspace.maxEntries,
						maxAgeHours: RETENTION_POLICY.benchmark_workspace.maxAgeHours,
					},
					{
						category: 'benchmark_scratch_database' as const,
						prefix: BENCHMARK_DATABASE_PREFIX,
						directory: temporary,
						maxEntries: RETENTION_POLICY.benchmark_scratch_database.maxEntries,
						maxAgeHours: RETENTION_POLICY.benchmark_scratch_database.maxAgeHours,
					},
				]),
		...(input.repository === undefined
			? []
			: [
					{
						category: 'benchmark_workspace' as const,
						prefix: ORACLE_BENCHMARK_PREFIX,
						directory: input.repository,
						maxEntries: RETENTION_POLICY.benchmark_workspace.maxEntries,
						maxAgeHours: RETENTION_POLICY.benchmark_workspace.maxAgeHours,
					},
				]),
	];
	const targets: RetentionTargetType[] = [];
	const refused: RetentionDecisionType[] = [];
	const retained: RetentionDecisionType[] = [];

	for (const definition of categories) {
		const paths = childDirectoriesOf(definition.directory).filter((entry) => basename(entry).startsWith(definition.prefix));
		const plan = ageBoundTargets({
			category: definition.category,
			paths,
			maxEntries: definition.maxEntries,
			maxAgeMs: definition.maxAgeHours * HOUR_MS,
			now,
			protectedPaths: input.protectedPaths,
		});
		targets.push(...plan.targets);
		refused.push(...plan.refused);
		retained.push(...plan.retained);
	}

	return {targets, refused, retained, worktreeRoots: []};
};

const PrepareManifestSchema = z.object({
	projects: z.array(
		z.object({
			name: z.string().min(1),
			directory: z.string().min(1).optional(),
			revision: z.string().min(1).optional(),
		}),
	),
});

type PreparedProjectType = z.infer<typeof PrepareManifestSchema>['projects'][number];

const readPrepareManifest = (projectsRoot: string): readonly PreparedProjectType[] | null => {
	const filePath = join(projectsRoot, PREPARE_MANIFEST);

	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const parsed = PrepareManifestSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));

		return parsed.success ? parsed.data.projects : null;
	} catch {
		return null;
	}
};

const checkoutClassOf = (
	input: Readonly<{
		checkout: string;
		project: PreparedProjectType | undefined;
		removeAll: boolean;
		discardDirty: boolean;
		protectedPaths: readonly string[];
	}>,
): Readonly<{target?: RetentionTargetType; refused?: RetentionDecisionType; retained?: RetentionDecisionType}> => {
	const bytes = footprintBytes(input.checkout);
	const state = gitStateOf(input.checkout);
	const currentRevision = gitOutput(input.checkout, ['rev-parse', 'HEAD']);
	const superseded = input.project?.revision !== undefined && currentRevision !== null && currentRevision !== input.project.revision;
	const removable = input.removeAll || input.project === undefined || superseded;

	if (protectedTarget(input.checkout, input.protectedPaths)) {
		return {refused: {category: 'benchmark_project_checkout', path: input.checkout, bytes, reason: 'protected_path'}};
	}

	if (state === 'dirty' && !input.discardDirty) {
		return {refused: {category: 'benchmark_project_checkout', path: input.checkout, bytes, reason: 'dirty_worktree'}};
	}

	return removable
		? {target: {category: 'benchmark_project_checkout', path: input.checkout, bytes}}
		: {retained: {category: 'benchmark_project_checkout', path: input.checkout, bytes, reason: 'suite_needs_checkout'}};
};

/**
 * Collects benchmark project checkouts that are stale, superseded, or explicitly discarded.
 *
 * A checkout is retained while `prepare.json` names it at its pinned revision.
 * A checkout that the manifest does not name, or that is at another revision, is
 * stale. Dirty checkouts are refused unless discard is explicitly approved.
 *
 * @param input - Cache roots, protection, explicit removal, and discard approval.
 * @returns Removable checkouts, refusals, retained checkouts, and worktree roots.
 */
export const benchmarkCheckoutPlan = (
	input: RetentionInputType &
		Readonly<{
			cacheRoots: readonly string[];
			removeAll: boolean;
		}>,
): RetentionPlanType => {
	const targets: RetentionTargetType[] = [];
	const refused: RetentionDecisionType[] = [];
	const retained: RetentionDecisionType[] = [];

	for (const cacheRoot of input.cacheRoots) {
		const projectsRoot = join(cacheRoot, BENCHMARK_PROJECTS_DIRECTORY);

		if (!existsSync(projectsRoot)) {
			continue;
		}

		const prepared = readPrepareManifest(projectsRoot);

		for (const checkout of childDirectoriesOf(projectsRoot)) {
			const name = basename(checkout);
			const project = prepared?.find((entry) => (entry.directory ?? entry.name) === name);
			const classified = checkoutClassOf({
				checkout,
				project,
				removeAll: input.removeAll,
				discardDirty: input.discardDirty === true,
				protectedPaths: input.protectedPaths,
			});

			if (classified.target !== undefined) {
				targets.push(classified.target);
			}

			if (classified.refused !== undefined) {
				refused.push(classified.refused);
			}

			if (classified.retained !== undefined) {
				retained.push(classified.retained);
			}
		}

		const manifestPath = join(projectsRoot, PREPARE_MANIFEST);

		if (input.removeAll && existsSync(manifestPath) && !protectedTarget(manifestPath, input.protectedPaths)) {
			targets.push({category: 'benchmark_project_checkout', path: manifestPath, bytes: footprintBytes(manifestPath)});
		}
	}

	return {targets, refused, retained, worktreeRoots: []};
};
