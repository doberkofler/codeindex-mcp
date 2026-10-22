/**
 * Closed cause for one failed index build.
 *
 * A cause names the stage that rejected the build, not the user-visible error
 * text. It is recorded with every `build_failed` analytics event so failures
 * stay queryable without persisting source text or absolute paths.
 */
export const BUILD_FAILURE_CAUSES = [
	'configuration',
	'source-read',
	'source-changed',
	'compiler',
	'extraction',
	'persistence',
	'verification',
	'publication',
	'lease',
	'worker',
	'unknown',
] as const;

export type BuildFailureCauseType = (typeof BUILD_FAILURE_CAUSES)[number];

const CAUSE_SET = new Set<string>(BUILD_FAILURE_CAUSES);

/**
 * Returns true when a value is one of the closed build-failure causes.
 *
 * @param value - Candidate analytics field value.
 * @returns True for a declared cause.
 */
export const isBuildFailureCause = (value: string): value is BuildFailureCauseType => CAUSE_SET.has(value);

type CauseRuleType = Readonly<{pattern: RegExp; cause: BuildFailureCauseType}>;

const CAUSE_RULES: readonly CauseRuleType[] = [
	{pattern: /lease was lost|lease.*taken over|build lease/iu, cause: 'lease'},
	{pattern: /source changed during index build/iu, cause: 'source-changed'},
	{pattern: /EISDIR|ENOENT|EACCES|EPERM|illegal operation on a directory|no such file or directory/iu, cause: 'source-read'},
	{pattern: /worker/iu, cause: 'worker'},
	{pattern: /SQLite integrity check failed|foreign-key check failed/iu, cause: 'verification'},
	{pattern: /invalid code index configuration|tsconfig|parseJsonConfig|compiler option/iu, cause: 'configuration'},
	{pattern: /SQLITE|disk I\/O|constraint failed|database is locked|readonly database/iu, cause: 'persistence'},
	{pattern: /publish|publication/iu, cause: 'publication'},
	{pattern: /extract/iu, cause: 'extraction'},
	{pattern: /compiler|typescript/iu, cause: 'compiler'},
];

const messageOf = (error: unknown): string => {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`;
	}

	return String(error);
};

/**
 * Classifies one failed build into the closed cause set.
 *
 * Classification is ordered from the most specific persisted failure to the
 * generic build stage. An unrecognised failure is `unknown`; it is never
 * silently reported as a successful build.
 *
 * @param error - Error thrown by scan, extraction, persistence, verification, or publication.
 * @returns The closed failure cause.
 */
export const buildFailureCauseOf = (error: unknown): BuildFailureCauseType => {
	const message = messageOf(error);

	for (const rule of CAUSE_RULES) {
		if (rule.pattern.test(message)) {
			return rule.cause;
		}
	}

	return 'unknown';
};
