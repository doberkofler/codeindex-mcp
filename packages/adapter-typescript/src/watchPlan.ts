import path from 'node:path';

import {
	defineAdapterWatchPlan,
	type AdapterConfigType,
	type AdapterWatchPlanType,
	type AdapterWatchRuleType,
	type ScanResultType,
} from '@codeindex/adapter-sdk';

import {
	collectConfigFiles,
	collectTypeScriptWatchSelection,
	PUBLISHABLE_EXTENSIONS,
	TYPESCRIPT_IGNORED_SEGMENTS,
	type TypeScriptWatchSelectionType,
} from './sourcePaths.ts';
import {TYPESCRIPT_EXTRACTOR_ID, TYPESCRIPT_EXTRACTOR_VERSION} from './scanProject.ts';

const {dirname, isAbsolute, relative, resolve, sep} = path;
const GLOB_MARKER = /[*?[\]{}()]/u;
const DECLARATION_SUFFIXES: readonly string[] = ['.d.ts', '.d.mts', '.d.cts'];

const uniqueSorted = (values: Iterable<string>): readonly string[] => [...new Set(values)].sort();

const repositoryPathOrNull = (rootDir: string, absolutePath: string): string | null => {
	const relativePath = relative(rootDir, absolutePath);

	if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return null;
	}

	return relativePath.split(sep).join('/');
};

const patternOf = (rootDir: string, list: Readonly<{baseDirectory: string; values: readonly string[]}>, value: string): string | null =>
	repositoryPathOrNull(rootDir, resolve(list.baseDirectory, value));

const directoryPattern = (pattern: string): string =>
	GLOB_MARKER.test(pattern) || PUBLISHABLE_EXTENSIONS.some((extension) => pattern.endsWith(extension)) ? pattern : `${pattern.replace(/\/+$/u, '')}/**/*`;

const candidateRootOf = (pattern: string): string => {
	const marker = pattern.search(GLOB_MARKER);
	const fixed = marker === -1 ? pattern : pattern.slice(0, marker);
	const trimmed = fixed.replace(/\/+$/u, '');

	if (trimmed === '') {
		return '';
	}

	if (marker === -1) {
		return PUBLISHABLE_EXTENSIONS.some((extension) => trimmed.endsWith(extension)) ? (dirname(trimmed) === '.' ? '' : dirname(trimmed)) : trimmed;
	}

	return fixed.endsWith('/') ? trimmed : dirname(trimmed) === '.' ? '' : dirname(trimmed);
};

const rulesOf = (
	rootDir: string,
	list: Readonly<{baseDirectory: string; values: readonly string[]}>,
	kind: 'include' | 'exclude',
): readonly AdapterWatchRuleType[] =>
	list.values.flatMap((value): readonly AdapterWatchRuleType[] => {
		const normalized = patternOf(rootDir, list, value);

		if (normalized === null) {
			return [];
		}

		if (kind === 'exclude' && !GLOB_MARKER.test(normalized)) {
			return [{kind: 'prefix', path: normalized}];
		}

		return [{kind: 'glob', pattern: directoryPattern(normalized)}];
	});

const scopeOf = (rootDir: string, projectFilePath: string): AdapterWatchPlanType['scopes'][number] => {
	const selection: TypeScriptWatchSelectionType = collectTypeScriptWatchSelection(projectFilePath);
	const defaultInclude = {baseDirectory: dirname(projectFilePath), values: ['**/*']} as const;
	const lists = [
		...(selection.files === undefined ? [] : [selection.files]),
		...(selection.include === undefined ? (selection.files === undefined ? [defaultInclude] : []) : [selection.include]),
	];
	const includeRules = lists.flatMap((list) => rulesOf(rootDir, list, 'include'));
	const candidateRoots = uniqueSorted(
		lists.flatMap((list) =>
			list.values.flatMap((value) => {
				const normalized = patternOf(rootDir, list, value);
				return normalized === null ? [] : [candidateRootOf(directoryPattern(normalized))];
			}),
		),
	);
	const configuredExcludes = selection.exclude === undefined ? [] : rulesOf(rootDir, selection.exclude, 'exclude');

	return {
		candidateRoots,
		includeRules,
		excludeRules: [
			...TYPESCRIPT_IGNORED_SEGMENTS.map((segment): AdapterWatchRuleType => ({kind: 'segment', segment, ignoreCase: true})),
			...DECLARATION_SUFFIXES.map((suffix): AdapterWatchRuleType => ({kind: 'suffix', suffix})),
			...configuredExcludes,
		],
		sourceRules: PUBLISHABLE_EXTENSIONS.map((suffix): AdapterWatchRuleType => ({kind: 'suffix', suffix})),
	};
};

/**
 * Produces the TypeScript adapter's bootstrap or scanned watch plan.
 *
 * @param config - Scoped TypeScript configuration.
 * @param scan - Authoritative scan, or null during startup bootstrap.
 * @returns Relative-path-only serializable plan.
 */
export const createTypeScriptWatchPlan = (config: AdapterConfigType, scan: ScanResultType | null): AdapterWatchPlanType => {
	const configFiles = config.projects.flatMap((project) => collectConfigFiles(project.projectFilePath, config.rootDir));
	const inputFiles = uniqueSorted([
		...configFiles.flatMap((file) => {
			const relativePath = repositoryPathOrNull(config.rootDir, file);
			return relativePath === null ? [] : [relativePath];
		}),
		...(scan?.discoveredInputFiles ?? []),
	]);

	return defineAdapterWatchPlan({
		adapterId: TYPESCRIPT_EXTRACTOR_ID,
		adapterVersion: TYPESCRIPT_EXTRACTOR_VERSION,
		knownSourceFiles: uniqueSorted(scan?.files.map((file) => file.path) ?? []),
		inputFiles,
		scopes: config.projects.map((project) => scopeOf(config.rootDir, project.projectFilePath)),
	});
};
