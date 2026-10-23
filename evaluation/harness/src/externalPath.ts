/** Marker OpenCode emits when it denies access outside the workspace. */
export const EXTERNAL_DIRECTORY_MARKER = 'external_directory';

/** One denied external-path attempt retained as evidence. */
export type ExternalPathAttemptType = Readonly<{
	channel: 'stdout' | 'stderr';
	/** One-based line number within the captured channel. */
	line: number;
	/** Marker occurrences on this line. */
	count: number;
	/** Best-effort bounded target named by the event, never source text. */
	target: string | null;
}>;

const MAX_TARGET_LENGTH = 500;
const TARGET_PATTERNS = [
	/"path"\s*:\s*"(?<target>[^"]+)"/u,
	/"filePath"\s*:\s*"(?<target>[^"]+)"/u,
	/"pattern"\s*:\s*"(?<target>[^"]+)"/u,
	/"permission"\s*:\s*"(?<target>[^"]+)"/u,
] as const;

const targetOf = (line: string): string | null => {
	for (const pattern of TARGET_PATTERNS) {
		const target = pattern.exec(line)?.groups?.['target'];

		if (target !== undefined && target.length > 0) {
			return target.slice(0, MAX_TARGET_LENGTH);
		}
	}

	return null;
};

const attemptsInOf = (channel: ExternalPathAttemptType['channel'], text: string): readonly ExternalPathAttemptType[] =>
	text.split('\n').flatMap((line, index) => {
		const count = line.split(EXTERNAL_DIRECTORY_MARKER).length - 1;

		return count === 0
			? []
			: [
					{
						channel,
						line: index + 1,
						count,
						target: targetOf(line),
					},
				];
	});

/**
 * Finds every denied external-directory attempt in a captured stream.
 *
 * Both stdout and stderr are scanned because the denial can surface as a tool
 * error event or as a process diagnostic. The marker is never treated as a
 * harmless warning, and no retry may erase it from the slot record.
 *
 * @param stdout - Captured standard output.
 * @param stderr - Captured standard error.
 * @returns Ordered evidence with one entry per affected line.
 */
export const externalPathAttemptsOf = (stdout: string, stderr: string): readonly ExternalPathAttemptType[] => [
	...attemptsInOf('stdout', stdout),
	...attemptsInOf('stderr', stderr),
];

/**
 * Counts every denied external-path attempt, including repeated markers on one line.
 *
 * @param attempts - Evidence returned by {@link externalPathAttemptsOf}.
 * @returns Total attempted denials.
 */
export const externalPathAttemptCountOf = (attempts: readonly ExternalPathAttemptType[]): number =>
	attempts.reduce((total, attempt) => total + attempt.count, 0);
