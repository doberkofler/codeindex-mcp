import {assertionOf, resultOf, type AssertionType, type CheckResultType} from './assertions.ts';
import {type CaseType} from './schema.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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

	return normalized.replace(/^\/+/u, '');
};

const extractJson = (text: string): string | null => {
	const start = text.indexOf('{');

	if (start === -1) {
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
	_testCase: CaseType,
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
 * Asserts that the final answer contained one parsable JSON object.
 *
 * @param result - Assertion result.
 * @param observed - Observed answer shape or failure reason.
 * @returns The single answer-shape assertion.
 */
const parseAssertionOf = (result: CheckResultType, observed: unknown): readonly AssertionType[] => [
	assertionOf({
		id: 'answer.parsed',
		kind: 'answer',
		expected: 'one JSON object',
		observed,
		result,
	}),
];

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
/** Answer envelope: either the parsed object or the reason it is unusable. */
type AnswerEnvelopeType = Readonly<{record: Record<string, unknown>} | {reason: string}>;

/** One answer field: either its validated value or the reason it is unusable. */
type FieldResultType<T> = Readonly<{value: T} | {reason: string}>;

const isFieldValue = <T>(result: FieldResultType<T>): result is Readonly<{value: T}> => 'value' in result;

/** Outcome fields used when the answer never produced a graded file set. */
type EmptyOutcomeType = Readonly<{
	parsed: false;
	files: readonly string[];
	absent: false;
	missing: readonly string[];
	forbidden: readonly string[];
	extra: readonly string[];
	falseAbsence: false;
}>;

const emptyOutcomeOf = (testCase: CaseType): EmptyOutcomeType => ({
	parsed: false,
	files: [] as readonly string[],
	absent: false,
	missing: testCase.expectedFiles,
	forbidden: [] as readonly string[],
	extra: [] as readonly string[],
	falseAbsence: false,
});

const failedGradeOf = (testCase: CaseType, assertions: readonly AssertionType[], reason: string): GradeType =>
	baseGrade(testCase, assertions, {...emptyOutcomeOf(testCase), reason});

const envelopeOf = (finalText: string): AnswerEnvelopeType => {
	const json = extractJson(finalText);

	if (json === null) {
		return {reason: 'answer did not contain a JSON object'};
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(json) as unknown;
	} catch {
		return {reason: 'answer JSON did not parse'};
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return {reason: 'answer JSON was not an object'};
	}

	return {record: isRecord(parsed) ? parsed : {}};
};

const filesFieldOf = (record: Record<string, unknown>, assertions: AssertionType[]): FieldResultType<readonly string[]> => {
	const rawFiles = record['files'];

	if (!Array.isArray(rawFiles) || !rawFiles.every((item) => typeof item === 'string')) {
		assertions.push(
			assertionOf({
				id: 'answer.files',
				kind: 'answer',
				expected: 'array of repository-relative paths',
				observed: rawFiles === undefined ? 'missing' : typeof rawFiles,
				result: 'fail',
			}),
		);

		return {reason: 'answer "files" was not an array of strings'};
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

	return {value: rawFiles};
};

const absentFieldOf = (record: Record<string, unknown>, assertions: AssertionType[]): FieldResultType<boolean> => {
	const rawAbsent = record['absent'];

	if (typeof rawAbsent !== 'boolean') {
		assertions.push(
			assertionOf({
				id: 'answer.absent',
				kind: 'answer',
				expected: 'boolean',
				observed: rawAbsent === undefined ? 'missing' : typeof rawAbsent,
				result: 'fail',
			}),
		);

		return {reason: 'answer "absent" was not a boolean'};
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

	return {value: rawAbsent};
};

const failureReasonOf = (
	outcome: Readonly<{consistent: boolean; falseAbsence: boolean; missing: readonly string[]; forbidden: readonly string[]; extra: readonly string[]}>,
): string => {
	if (!outcome.consistent) {
		return 'claimed absence while naming files';
	}

	if (outcome.falseAbsence) {
		return 'claimed absence for a case with expected files';
	}

	if (outcome.missing.length > 0) {
		return `missing ${outcome.missing.length} expected file(s)`;
	}

	if (outcome.forbidden.length > 0) {
		return `named ${outcome.forbidden.length} forbidden file(s)`;
	}

	if (outcome.extra.length > 0) {
		return `named ${outcome.extra.length} file(s) outside expected and context`;
	}

	return 'all expected files named';
};

/** Graded file-set outcome and its assertions. */
type FileSetOutcomeType = Readonly<{
	assertions: readonly AssertionType[];
	missing: readonly string[];
	forbidden: readonly string[];
	extra: readonly string[];
	falseAbsence: boolean;
	reason: string;
}>;

const fileSetOutcomeOf = (testCase: CaseType, files: readonly string[], absent: boolean): FileSetOutcomeType => {
	const allowed = new Set([...testCase.expectedFiles, ...testCase.contextFiles]);
	const missing = testCase.expectedFiles.filter((expected) => !files.includes(expected));
	const forbidden = testCase.forbiddenFiles.filter((blocked) => files.includes(blocked));
	const extra = files.filter((file) => !allowed.has(file));
	const falseAbsence = absent && testCase.expectedFiles.length > 0;
	const consistent = !absent || files.length === 0;

	const assertions: readonly AssertionType[] = [
		assertionOf({
			id: 'answer.absence-consistency',
			kind: 'answer',
			expected: 'absent implies no files',
			observed: {absent, fileCount: files.length},
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
			observed: absent,
			result: falseAbsence ? 'fail' : 'pass',
		}),
	];

	return {assertions, missing, forbidden, extra, falseAbsence, reason: failureReasonOf({consistent, falseAbsence, missing, forbidden, extra})};
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
	const envelope = envelopeOf(finalText);

	if (!('record' in envelope)) {
		return failedGradeOf(testCase, parseAssertionOf('fail', envelope.reason), envelope.reason);
	}

	const assertions: AssertionType[] = [
		assertionOf({
			id: 'answer.parsed',
			kind: 'answer',
			expected: 'one JSON object',
			observed: 'object',
			result: 'pass',
		}),
	];
	const files = filesFieldOf(envelope.record, assertions);

	if (!isFieldValue(files)) {
		return failedGradeOf(testCase, assertions, files.reason);
	}

	const absent = absentFieldOf(envelope.record, assertions);

	if (!isFieldValue(absent)) {
		return failedGradeOf(testCase, assertions, absent.reason);
	}

	const normalizedFiles = [...new Set(files.value.map((item) => normalizePath(item)))];
	const outcome = fileSetOutcomeOf(testCase, normalizedFiles, absent.value);
	assertions.push(...outcome.assertions);

	return baseGrade(testCase, assertions, {
		parsed: true,
		files: normalizedFiles,
		absent: absent.value,
		missing: outcome.missing,
		forbidden: outcome.forbidden,
		extra: outcome.extra,
		falseAbsence: outcome.falseAbsence,
		reason: outcome.reason,
	});
};
