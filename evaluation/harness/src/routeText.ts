import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {type TextStepType} from './routePlan.ts';

/** Default extensions for an ordinary text search. */
const DEFAULT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'] as const;

/** Shared empty exclusion list; a fresh empty array would only add noise. */
const NO_PATHS: readonly string[] = [];

/** Directories that never belong to a bounded route search. */
const IGNORED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);

/** One matching source line, retained for the route report. */
export type TextMatchType = Readonly<{path: string; line: number; text: string}>;

/** Observed effect of one ordinary retrieval step. */
export type TextStepResultType = Readonly<{
	paths: readonly string[];
	bytes: number;
	calls: number;
	matches: readonly TextMatchType[];
}>;

const isWithin = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const resolveWithin = (workspace: string, relative: string): string => {
	const root = path.resolve(workspace);
	const target = path.resolve(root, relative);

	if (!isWithin(root, target)) {
		throw new Error(`route path escapes the workspace: ${relative}`);
	}

	return target;
};

const filesOf = (workspace: string, relative: string, extensions: readonly string[]): readonly string[] => {
	const root = resolveWithin(workspace, relative);
	const entries: string[] = [];
	const walk = (directory: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const absolute = path.join(directory, name);

			if (IGNORED_DIRECTORIES.has(name)) {
				continue;
			}

			const stats = statSync(absolute);

			if (stats.isDirectory()) {
				walk(absolute);
				continue;
			}

			if (stats.isFile() && extensions.some((extension) => name.endsWith(extension))) {
				entries.push(absolute);
			}
		}
	};

	walk(root);

	return entries;
};

const posixRelativeOf = (workspace: string, absolute: string): string => path.relative(path.resolve(workspace), absolute).split(path.sep).join('/');

/**
 * Executes one ordinary search step over one workspace.
 *
 * The step counts as one retrieval call. Its response bytes are the matching
 * source lines, matching the payload an ordinary grep tool returns. File
 * scanning is local work, not a second tool call.
 *
 * @param input - Workspace, step, and interpreted pattern.
 * @returns Matching paths, retained matches, call count, and response bytes.
 */
export const runSearchStep = (input: Readonly<{workspace: string; step: Extract<TextStepType, {kind: 'search'}>}>): TextStepResultType => {
	const extensions = input.step.extensions ?? DEFAULT_EXTENSIONS;
	const excluded = new Set(input.step.excludePaths ?? NO_PATHS);
	const regex = new RegExp(input.step.pattern, 'u');
	const matches: TextMatchType[] = [];
	const paths = new Set<string>();
	let bytes = 0;

	for (const absolute of filesOf(input.workspace, input.step.path, extensions)) {
		const relative = posixRelativeOf(input.workspace, absolute);

		if (excluded.has(relative)) {
			continue;
		}

		const text = readFileSync(absolute, 'utf8');
		const lines = text.split('\n');

		for (const [index, line] of lines.entries()) {
			if (!regex.test(line)) {
				continue;
			}

			matches.push({path: relative, line: index + 1, text: line});
			paths.add(relative);
			bytes += Buffer.byteLength(line, 'utf8') + 1;
		}
	}

	return {paths: [...paths].sort(), bytes, calls: 1, matches};
};

/**
 * Executes one ordinary file-read step over one workspace.
 *
 * @param input - Workspace and read step.
 * @returns The read path when it exists, its UTF-8 byte length, and one call.
 * @throws {@link Error} When the declared file does not exist.
 */
export const runReadStep = (input: Readonly<{workspace: string; step: Extract<TextStepType, {kind: 'read'}>}>): TextStepResultType => {
	const absolute = resolveWithin(input.workspace, input.step.path);
	const text = readFileSync(absolute, 'utf8');

	return {paths: [input.step.path], bytes: Buffer.byteLength(text, 'utf8'), calls: 1, matches: []};
};

/**
 * Executes one ordinary retrieval step.
 *
 * @param input - Workspace and declared step.
 * @returns The observed paths, response bytes, call count, and matches.
 */
export const runTextStep = (input: Readonly<{workspace: string; step: TextStepType}>): TextStepResultType =>
	input.step.kind === 'search' ? runSearchStep({workspace: input.workspace, step: input.step}) : runReadStep({workspace: input.workspace, step: input.step});

/**
 * Reads one workspace file for a source-content contract check.
 *
 * @param workspace - Workspace root.
 * @param relative - Workspace-relative POSIX path.
 * @returns The complete UTF-8 source and its byte length.
 */
export const readWorkspaceSource = (workspace: string, relative: string): Readonly<{text: string; bytes: number}> => {
	const text = readFileSync(resolveWithin(workspace, relative), 'utf8');

	return {text, bytes: Buffer.byteLength(text, 'utf8')};
};
