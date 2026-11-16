import path from 'node:path';

import {
	defineAdapterWatchPlan,
	type AdapterConfigType,
	type AdapterWatchPlanType,
	type AdapterWatchRuleType,
	type ScanResultType,
	toRepositoryPath,
} from '@codeindex/adapter-sdk';

import {readOracleManifest} from './manifest.ts';
import {ORACLE_EXTRACTOR_ID, ORACLE_EXTRACTOR_VERSION, ORACLE_IGNORED_SEGMENTS} from './scanProject.ts';

const {dirname} = path;
const GLOB_MARKER = /[*?[\]{}()]/u;

const uniqueSorted = (values: Iterable<string>): readonly string[] => [...new Set(values)].sort();

const candidateRootOf = (pattern: string, extensions: readonly string[]): string => {
	const marker = pattern.search(GLOB_MARKER);
	const fixed = marker === -1 ? pattern : pattern.slice(0, marker);
	const trimmed = fixed.replace(/\/+$/u, '');

	if (trimmed === '') {
		return '';
	}

	if (marker === -1) {
		return extensions.some((extension) => trimmed.endsWith(extension)) ? (dirname(trimmed) === '.' ? '' : dirname(trimmed)) : trimmed;
	}

	return fixed.endsWith('/') ? trimmed : dirname(trimmed) === '.' ? '' : dirname(trimmed);
};

const globRule = (pattern: string): AdapterWatchRuleType => ({
	kind: 'glob',
	pattern,
});

/**
 * Produces the Oracle adapter's bootstrap or scanned watch plan.
 *
 * @param config - Scoped Oracle manifest configuration.
 * @param scan - Authoritative scan, or null during startup bootstrap.
 * @returns Relative-path-only serializable plan.
 */
export const createOracleWatchPlan = (config: AdapterConfigType, scan: ScanResultType | null): AdapterWatchPlanType => {
	const manifests = config.projects.map((project) => readOracleManifest(project.projectFilePath));

	return defineAdapterWatchPlan({
		adapterId: ORACLE_EXTRACTOR_ID,
		adapterVersion: ORACLE_EXTRACTOR_VERSION,
		knownSourceFiles: uniqueSorted(scan?.files.map((file) => file.path) ?? []),
		inputFiles: uniqueSorted(
			manifests.flatMap((manifest) => {
				try {
					return [toRepositoryPath(config.rootDir, manifest.manifestPath)];
				} catch {
					return [];
				}
			}),
		),
		scopes: manifests.map(({manifest}) => ({
			candidateRoots: uniqueSorted(manifest.include.map((pattern) => candidateRootOf(pattern, manifest.extensions))),
			includeRules: manifest.include.map(globRule),
			excludeRules: [
				...ORACLE_IGNORED_SEGMENTS.map((segment): AdapterWatchRuleType => ({kind: 'segment', segment, ignoreCase: true})),
				...manifest.exclude.map(globRule),
			],
			sourceRules: manifest.extensions.map((suffix): AdapterWatchRuleType => ({kind: 'suffix', suffix})),
		})),
	});
};
