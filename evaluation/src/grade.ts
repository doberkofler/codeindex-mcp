import {assertionOf, resultOf, type AssertionType, type CheckResultType} from './assertions.ts';
import {type CaseType} from './schema.ts';

/** Graded outcome of one answer against exact case truth. */
export type GradeType = Readonly<{
	parsed: boolean;
	files: readonly string[];
	absent: boolean;
	/** True only when every correctness assertion passed. */
	success: boolean;
	missing: readonly string[];
	forbidden: readonly string[];
	/** Files outside the expected and bounded-context set. */
	extra: readonly string[];
	/** Claimed absence while the case has expected files. */
	falseAbsence: boolean;
	reason: string;
	result: CheckResultType;
	assertions: readonly AssertionType[];
}>;

const normalizePath = (value: string): string => {
	let normalized = value.trim().replaceAll('\\', '/');

	while (normalized.startsWith('./')) {
		normalized = normalized.slice(2);
	}

	return normalized.replace(/^\/+/, '');
};

const extractJson = (text: string): string | null => {
	const start = text.indexOf('{');

	if (start < 0) {
		return null;
	}

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = start; index < text.length; index += 1) {
		const character = text[index];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (character === '\\') {
			escaped = true;
			continue;
		}

		if (character === '"') {
			inString = !inString;
			continue;
		}

		if (inString) {
			continue;
		}

		if (character === '{') {
			depth += 1;
		} else if (character === '}') {
			depth -= 1;

			if (depth === 0) {
				return text.slice(start, index + 1);
			}
		}
	}

	return null;
};

const baseGrade = (
	testCase: CaseType,
	assertions: readonly AssertionType[],
	input: Readonly<{
		parsed: boolean;
		files: readonly string[];
		absent: boolean;
		missing: readonly string[];
		forbidden: readonly string[];
		extra: readonly string[];
		falseAbsence: boolean;
		reason: string;
	}>,
): GradeType => {
	const result = resultOf(assertions);

	return {
		...input,
		success: result === 'pass',
		result,
		assertions,
	};
};

/**
 * Grades one final answer against a case's exact ground truth.
 *
 * Correctness is exact: every expected file must be named, no forbidden file
 * may be named, and no file outside the expected set or the bounded context set
 * may be named. A malformed or self-contradictory answer is a failure and keeps
 * its reason, never a silent zero.
 *
 * @param testCase - Case under evaluation.
 * @param finalText - Final assistant text.
 * @returns The graded outcome and its auditable assertions.
 */
export const gradeOf = (testCase: CaseType, finalText: string): GradeType => {
	const json = extractJson(finalText);
	const parseAssertion = (result: CheckResultType, observed: unknown): readonly AssertionType[] => [
		assertionOf({
			id: 'answer.parsed',
			kind: 'answer',
			expected: 'one JSON object',
			observed,
			result,
		}),
	];
	const empty = {
		parsed: false,
		files: [],
		absent: false,
		missing: testCase.expectedFiles,
		forbidden: [],
		extra: [],
		falseAbsence: false,
	} as const;

	if (json === null) {
		const reason = 'answer did not contain a JSON object';

		return baseGrade(testCase, parseAssertion('fail', reason), {...empty, reason});
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(json) as unknown;
	} catch {
		const reason = 'answer JSON did not parse';

		return baseGrade(testCase, parseAssertion('fail', reason), {...empty, reason});
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		const reason = 'answer JSON was not an object';

		return baseGrade(testCase, parseAssertion('fail', reason), {...empty, reason});
	}

	const record = parsed as Record<string, unknown>;
	const assertions: AssertionType[] = [
		assertionOf({
			id: 'answer.parsed',
			kind: 'answer',
			expected: 'one JSON object',
			observed: 'object',
			result: 'pass',
		}),
	];
	const rawFiles = record['files'];

	if (!Array.isArray(rawFiles) || !rawFiles.every((item) => typeof item === 'string')) {
		const reason = 'answer "files" was not an array of strings';
		assertions.push(
			assertionOf({
				id: 'answer.files',
				kind: 'answer',
				expected: 'array of repository-relative paths',
				observed: rawFiles === undefined ? 'missing' : typeof rawFiles,
				result: 'fail',
			}),
		);

		return baseGrade(testCase, assertions, {...empty, reason});
	}

	assertions.push(
		assertionOf({
			id: 'answer.files',
			kind: 'answer',
			expected: 'array of repository-relative paths',
			observed: rawFiles.length,
			result: 'pass',
		}),
	);

	const rawAbsent = record['absent'];

	if (typeof rawAbsent !== 'boolean') {
		const reason = 'answer "absent" was not a boolean';
		assertions.push(
			assertionOf({
				id: 'answer.absent',
				kind: 'answer',
				expected: 'boolean',
				observed: rawAbsent === undefined ? 'missing' : typeof rawAbsent,
				result: 'fail',
			}),
		);

		return baseGrade(testCase, assertions, {...empty, reason});
	}

	assertions.push(
		assertionOf({
			id: 'answer.absent',
			kind: 'answer',
			expected: 'boolean',
			observed: rawAbsent,
			result: 'pass',
		}),
	);

	const files = [...new Set(rawFiles.map((item) => normalizePath(item)))];
	const allowed = new Set([...testCase.expectedFiles, ...testCase.contextFiles]);
	const missing = testCase.expectedFiles.filter((expected) => !files.includes(expected));
	const forbidden = testCase.forbiddenFiles.filter((blocked) => files.includes(blocked));
	const extra = files.filter((file) => !allowed.has(file));
	const falseAbsence = rawAbsent && testCase.expectedFiles.length > 0;
	const consistent = !rawAbsent || files.length === 0;

	assertions.push(
		assertionOf({
			id: 'answer.absence-consistency',
			kind: 'answer',
			expected: 'absent implies no files',
			observed: {absent: rawAbsent, fileCount: files.length},
			result: consistent ? 'pass' : 'fail',
		}),
		assertionOf({
			id: 'files.expected',
			kind: 'file-set',
			expected: testCase.expectedFiles,
			observed: missing,
			result: missing.length === 0 ? 'pass' : 'fail',
		}),
		assertionOf({
			id: 'files.forbidden',
			kind: 'file-set',
			expected: [],
			observed: forbidden,
			result: forbidden.length === 0 ? 'pass' : 'fail',
		}),
		assertionOf({
			id: 'files.bounded',
			kind: 'file-set',
			expected: [...allowed].sort(),
			observed: extra,
			result: extra.length === 0 ? 'pass' : 'fail',
		}),
		assertionOf({
			id: 'files.absent',
			kind: 'file-set',
			expected: false,
			observed: rawAbsent,
			result: falseAbsence ? 'fail' : 'pass',
		}),
	);

	const reason = !consistent
		? 'claimed absence while naming files'
		: falseAbsence
			? 'claimed absence for a case with expected files'
			: missing.length > 0
				? `missing ${missing.length} expected file(s)`
				: forbidden.length > 0
					? `named ${forbidden.length} forbidden file(s)`
					: extra.length > 0
						? `named ${extra.length} file(s) outside expected and context`
						: 'all expected files named';

	return baseGrade(testCase, assertions, {
		parsed: true,
		files,
		absent: rawAbsent,
		missing,
		forbidden,
		extra,
		falseAbsence,
		reason,
	});
};
