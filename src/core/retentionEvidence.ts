import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {type RetentionDecisionType, type RetentionInputType, type RetentionPlanType, type RetentionTargetType} from './retentionPolicy.ts';
import {childDirectoriesOf, footprintBytes, protectedTarget} from './retentionSupport.ts';

const {basename, join, resolve} = path;

const ORACLE_LIVE_DIRECTORY = 'oracle-live';
const DescriptorSchema = z.object({evidence: z.object({externalRoot: z.string().min(1)})});

/**
 * Discovers committed Oracle evidence descriptors below the benchmark directory.
 *
 * @param repository - Repository root.
 * @returns Absolute descriptor paths, absent when the benchmark directory is missing.
 */
export const discoverOracleDescriptorPaths = (repository: string): readonly string[] => {
	const benchmarkRoot = join(repository, 'benchmark');

	if (!existsSync(benchmarkRoot)) {
		return [];
	}

	const direct = join(benchmarkRoot, 'corpus.json');
	const nested = childDirectoriesOf(benchmarkRoot)
		.map((directory) => join(directory, 'corpus.json'))
		.filter((filePath) => existsSync(filePath));

	return [...(existsSync(direct) ? [direct] : []), ...nested];
};

const oracleBundlesUnder = (root: string): readonly string[] => {
	if (basename(root) === ORACLE_LIVE_DIRECTORY) {
		return childDirectoriesOf(root);
	}

	const oracleRoot = join(root, ORACLE_LIVE_DIRECTORY);

	return existsSync(oracleRoot) ? childDirectoriesOf(oracleRoot) : [];
};

const externalRootOf = (descriptorPath: string): string | null => {
	try {
		const parsed = DescriptorSchema.safeParse(JSON.parse(readFileSync(descriptorPath, 'utf8')));

		if (!parsed.success) {
			return null;
		}

		const {externalRoot} = parsed.data.evidence;

		return externalRoot;
	} catch {
		return null;
	}
};

const requiredBundlesOf = (
	input: Readonly<{
		storageRoots: readonly string[];
		evidenceRoots: readonly string[];
		descriptorPaths: readonly string[];
	}>,
): ReadonlySet<string> => {
	const required = new Set<string>();

	for (const descriptorPath of input.descriptorPaths) {
		if (!existsSync(descriptorPath)) {
			continue;
		}

		const externalRoot = externalRootOf(descriptorPath);

		if (externalRoot === null) {
			continue;
		}

		for (const root of [...input.storageRoots, ...input.evidenceRoots]) {
			required.add(resolve(root, externalRoot));
		}
	}

	return required;
};

/**
 * Collects Oracle evidence bundles that no committed descriptor references.
 *
 * @param input - Storage and evidence roots, committed descriptors, protection, and clock.
 * @returns Superseded bundles, refusals, and retained required bundles.
 */
export const oracleEvidencePlan = (
	input: RetentionInputType &
		Readonly<{
			storageRoots: readonly string[];
			evidenceRoots: readonly string[];
			descriptorPaths: readonly string[];
		}>,
): RetentionPlanType => {
	const required = requiredBundlesOf(input);
	const candidates = new Set([
		...input.storageRoots.flatMap((root) => oracleBundlesUnder(root)),
		...input.evidenceRoots.flatMap((root) => oracleBundlesUnder(root)),
	]);
	const targets: RetentionTargetType[] = [];
	const refused: RetentionDecisionType[] = [];
	const retained: RetentionDecisionType[] = [];

	for (const bundle of candidates) {
		const absolute = resolve(bundle);
		const bytes = footprintBytes(absolute);

		if (protectedTarget(absolute, input.protectedPaths)) {
			refused.push({category: 'evidence_bundle', path: absolute, bytes, reason: 'protected_path'});
		} else if (required.has(absolute)) {
			retained.push({category: 'evidence_bundle', path: absolute, bytes, reason: 'required_bundle'});
		} else {
			targets.push({category: 'evidence_bundle', path: absolute, bytes});
		}
	}

	return {targets, refused, retained, worktreeRoots: []};
};
