import {appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {debugFor} from '../logging/debug.ts';
import {
	ANALYTICS_MAX_AGE_DAYS,
	ANALYTICS_MAX_BYTES,
	ANALYTICS_MAX_FILES,
	ANALYTICS_SCHEMA_VERSION,
	assertAnalyticsFields,
	type AnalyticsEventType,
} from './events.ts';

const {basename, dirname, join} = path;
const debug = debugFor('analytics');
const DAY_MS = 24 * 60 * 60 * 1000;

export type AnalyticsRecorderType = Readonly<{
	readonly enabled: boolean;
	readonly path: string;
	record: (event: string, fields?: Readonly<Record<string, unknown>>) => AnalyticsEventType | null;
	close: () => void;
}>;

export type AnalyticsRecorderOptionsType = Readonly<{
	enabled: boolean;
	path: string;
	projectId: string;
	program: string;
	programVersion: string;
	workingCopyId?: string | null;
}>;

const eventFiles = (directory: string): readonly string[] =>
	readdirSync(directory)
		.filter((name) => name.endsWith('.jsonl'))
		.sort();

const prune = (directory: string, keepPath: string): void => {
	const files = eventFiles(directory);
	const cutoff = Date.now() - ANALYTICS_MAX_AGE_DAYS * DAY_MS;
	const kept: string[] = [];

	for (const name of files) {
		const filePath = join(directory, name);

		try {
			if (filePath !== keepPath && statSync(filePath).mtimeMs < cutoff) {
				rmSync(filePath, {force: true});
				continue;
			}
		} catch {
			continue;
		}

		kept.push(filePath);
	}

	for (const filePath of kept.slice(0, Math.max(0, kept.length - ANALYTICS_MAX_FILES))) {
		if (filePath !== keepPath) {
			rmSync(filePath, {force: true});
		}
	}
};

const rotateIfNeeded = (filePath: string): void => {
	try {
		if (statSync(filePath).size < ANALYTICS_MAX_BYTES) {
			return;
		}
	} catch {
		return;
	}

	const rotated = join(dirname(filePath), `${basename(filePath, '.jsonl')}-${Date.now()}.jsonl`);

	try {
		rmSync(rotated, {force: true});
		renameSync(filePath, rotated);
		debug('analytics rotated', {filePath: rotated});
	} catch (error) {
		debug('analytics rotation failed', {message: error instanceof Error ? error.message : String(error)});
	}
};

const noop = (): void => {
	// Analytics are disabled; the recorder performs no filesystem access.
};

/**
 * Creates the bounded local analytics writer.
 *
 * Analytics are enabled by default. When disabled, every record call is a no-op
 * that performs no filesystem access. Write failures never affect indexing.
 *
 * @param options - Runtime identity and destination path.
 * @returns The analytics recorder.
 */
export const createAnalyticsRecorder = (options: AnalyticsRecorderOptionsType): AnalyticsRecorderType => {
	if (!options.enabled) {
		return {enabled: false, path: options.path, record: () => null, close: noop};
	}

	const directory = dirname(options.path);
	let initialized = false;

	const initialize = (): void => {
		if (initialized) {
			return;
		}

		initialized = true;
		mkdirSync(directory, {recursive: true});
		prune(directory, options.path);
	};

	return {
		enabled: true,
		path: options.path,
		record: (event, fields = {}) => {
			try {
				initialize();
				rotateIfNeeded(options.path);
				const record: AnalyticsEventType = {
					schema: ANALYTICS_SCHEMA_VERSION,
					id: randomUUID(),
					timestamp: new Date().toISOString(),
					program: options.program,
					programVersion: options.programVersion,
					projectId: options.projectId,
					workingCopyId: options.workingCopyId ?? null,
					event,
					...assertAnalyticsFields(fields),
				};
				appendFileSync(options.path, `${JSON.stringify(record)}\n`, {encoding: 'utf8'});
				return record;
			} catch (error) {
				debug('analytics write failed', {message: error instanceof Error ? error.message : String(error)});
				return null;
			}
		},
		close: () => {
			prune(directory, options.path);
		},
	};
};
