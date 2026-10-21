import {type CaseType} from './schema.ts';

/** Graded outcome of one answer. */
export type GradeType = Readonly<{
	parsed: boolean;
	files: readonly string[];
	absent: boolean;
	success: boolean;
	missing: readonly string[];
	forbidden: readonly string[];
	/** Claimed absence while the case has expected files. */
	falseAbsence: boolean;
	reason: string;
}>;

const normalizePath = (value: string): string => value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');

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

const matchesFile = (answer: readonly string[], expected: string): boolean =>
	answer.some((candidate) => candidate === expected || candidate.endsWith(`/${expected}`));

/**
 * Grades one final answer against a case's declared ground truth.
 *
 * @param testCase - Case under evaluation.
 * @param finalText - Final assistant text.
 * @returns The graded outcome.
 */
export const gradeOf = (testCase: CaseType, finalText: string): GradeType => {
	const json = extractJson(finalText);
	const empty = {parsed: false, files: [], absent: false, success: false, missing: testCase.expectedFiles, forbidden: [], falseAbsence: false} as const;

	if (json === null) {
		return {...empty, reason: 'answer did not contain a JSON object'};
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(json) as unknown;
	} catch {
		return {...empty, reason: 'answer JSON did not parse'};
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return {...empty, reason: 'answer JSON was not an object'};
	}

	const record = parsed as Record<string, unknown>;
	const rawFiles = record['files'];
	const absent = record['absent'] === true;

	if (!Array.isArray(rawFiles) || !rawFiles.every((item) => typeof item === 'string')) {
		return {...empty, absent, reason: 'answer "files" was not an array of strings'};
	}

	const files = [...new Set(rawFiles.map((item) => normalizePath(item)))];
	const missing = testCase.expectedFiles.filter((expected) => !matchesFile(files, expected));
	const forbidden = testCase.forbiddenFiles.filter((blocked) => matchesFile(files, blocked));
	const falseAbsence = absent && testCase.expectedFiles.length > 0;
	const success = !absent && missing.length === 0 && forbidden.length === 0;

	const reason = falseAbsence
		? 'claimed absence for a case with expected files'
		: success
			? 'all expected files named'
			: missing.length > 0
				? `missing ${missing.length} expected file(s)`
				: `named ${forbidden.length} forbidden file(s)`;

	return {parsed: true, files, absent, success, missing, forbidden, falseAbsence, reason};
};
