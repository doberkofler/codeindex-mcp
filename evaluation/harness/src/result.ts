import {closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync} from 'node:fs';
import path from 'node:path';
import {hashOf} from './hash.ts';
import {type RunResultType} from './runTypes.ts';

/** Required top-level discriminator for one stored execution result. */
export const RESULT_RECORD_TYPE = 'result' as const;

/** Closed set of harness-detected invalidity causes a record may carry. */
export const DEFECTS = [
	'artifact-mismatch',
	'model-mismatch',
	'prompt-agent-mismatch',
	'revision-case-mismatch',
	'configuration-mismatch',
	'treatment-mismatch',
	'missing-telemetry',
	'dirty-isolation',
	'external-path-attempt',
] as const;

export type DefectType = (typeof DEFECTS)[number];

/** Content digest and byte size of one stored record. */
export type IntegrityType = Readonly<{
	contentDigest: string;
	sizeBytes: number;
}>;

/** A result that passed every completeness, identity, and integrity check. */
export type StoredResultType = RunResultType & Readonly<{integrity: IntegrityType}>;

/** Effective validity of a complete record. */
export type EffectiveValidityType = 'valid' | 'invalid' | 'aborted';

/** Outcome of one resume lookup for a single slot. */
export type ResumeStateType = Readonly<{
	/** Reusable record, or null when the slot must run. */
	record: StoredResultType | null;
	/** Attempt of the reusable record, or null. */
	attempt: number | null;
	/** First attempt number that may be written without colliding. */
	nextAttempt: number;
}>;

const SUPPORTED_MAJOR = 1;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const ATTEMPT_FILE = /^attempt-(?<attempt>\d+)\.json$/u;
const SCHEMA_VERSION = /^(?<major>\d+)\.\d+$/u;

let temporaryCounter = 0;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const serializedOf = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`;

const majorVersionOf = (value: unknown): number | null => {
	if (typeof value !== 'string') {
		return null;
	}

	const major = SCHEMA_VERSION.exec(value)?.groups?.['major'];

	return major === undefined ? null : Number(major);
};

const flushDirectory = (directory: string): void => {
	if (process.platform === 'win32') {
		return;
	}

	const descriptor = openSync(directory, 'r');

	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
};

/**
 * Returns a same-directory temporary path for an atomic rename.
 *
 * @param file - Final destination.
 * @returns Unique temporary path.
 */
const temporaryPathOf = (file: string): string => {
	temporaryCounter += 1;

	return path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${temporaryCounter}`);
};

/**
 * Writes already-serialized JSON bytes atomically, refusing to overwrite.
 *
 * @param file - Destination path.
 * @param serialized - Exact document text.
 */
const writeJsonAtomicText = (file: string, serialized: string): void => {
	mkdirSync(path.dirname(file), {recursive: true});

	if (existsSync(file)) {
		throw new Error(`refusing to overwrite existing record: ${file}`);
	}

	const temporary = temporaryPathOf(file);
	const descriptor = openSync(temporary, 'wx');

	try {
		writeSync(descriptor, serialized, null, 'utf8');
		fsyncSync(descriptor);
	} catch (error) {
		closeSync(descriptor);
		rmSync(temporary, {force: true});
		throw error;
	}

	closeSync(descriptor);

	try {
		renameSync(temporary, file);
		flushDirectory(path.dirname(file));
	} catch (error) {
		rmSync(temporary, {force: true});
		throw error;
	}
};

const hasRequiredHeader = (record: Record<string, unknown>): boolean =>
	record['recordType'] === RESULT_RECORD_TYPE &&
	typeof record['campaignId'] === 'string' &&
	record['campaignId'].length > 0 &&
	typeof record['identityDigest'] === 'string' &&
	HEX_DIGEST.test(record['identityDigest']) &&
	typeof record['attempt'] === 'number' &&
	Number.isInteger(record['attempt']) &&
	record['attempt'] >= 1 &&
	typeof record['outcome'] === 'string' &&
	['completed', 'failed', 'timed-out', 'aborted'].includes(record['outcome']) &&
	Array.isArray(record['defects']) &&
	record['defects'].every((defect): defect is DefectType => typeof defect === 'string' && (DEFECTS as readonly string[]).includes(defect));

const hasValidIntegrity = (record: Record<string, unknown>): boolean => {
	if (!isRecord(record['identity']) || !isRecord(record['integrity'])) {
		return false;
	}

	const {integrity} = record;

	return (
		typeof integrity['contentDigest'] === 'string' &&
		HEX_DIGEST.test(integrity['contentDigest']) &&
		typeof integrity['sizeBytes'] === 'number' &&
		Number.isInteger(integrity['sizeBytes']) &&
		integrity['sizeBytes'] >= 0
	);
};

const validRequiredFields = (record: Record<string, unknown>): boolean => hasRequiredHeader(record) && hasValidIntegrity(record);

/**
 * Writes one JSON document atomically.
 *
 * The bytes are written to a temporary file in the destination directory,
 * flushed, and renamed over the final name. A reader never observes a partial
 * document, and a failed write leaves no final file behind.
 *
 * @param file - Destination path.
 * @param value - JSON-serializable document.
 * @param overwrite - Whether an existing destination may be replaced.
 * @returns The serialized document that was written.
 */
export const writeJsonAtomic = (file: string, value: unknown, overwrite = false): string => {
	mkdirSync(path.dirname(file), {recursive: true});

	if (!overwrite && existsSync(file)) {
		throw new Error(`refusing to overwrite existing record: ${file}`);
	}

	const serialized = serializedOf(value);
	const temporary = temporaryPathOf(file);
	const descriptor = openSync(temporary, 'wx');

	try {
		writeSync(descriptor, serialized, null, 'utf8');
		fsyncSync(descriptor);
	} catch (error) {
		closeSync(descriptor);
		rmSync(temporary, {force: true});
		throw error;
	}

	closeSync(descriptor);

	try {
		renameSync(temporary, file);
		flushDirectory(path.dirname(file));
	} catch (error) {
		rmSync(temporary, {force: true});
		throw error;
	}

	return serialized;
};

/**
 * Computes the integrity block of one result.
 *
 * `contentDigest` covers the canonical JSON of the record without its
 * `integrity` field. `sizeBytes` is the exact byte length of the serialized
 * document, so a truncated or extended file is rejected on read.
 *
 * @param result - Complete result without its integrity block.
 * @returns The integrity block and the serialized document.
 */
const integrityOf = (result: RunResultType): Readonly<{integrity: IntegrityType; serialized: string}> => {
	const record: Record<string, unknown> = {...result};

	delete record['integrity'];

	const contentDigest = hashOf(record);
	let sizeBytes = 0;
	let serialized = '';

	// `sizeBytes` is part of its own document. Iterate to the fixed point when a
	// digit-count change alters the serialized length.
	for (let iteration = 0; iteration < 4; iteration += 1) {
		const candidate = {...record, integrity: {contentDigest, sizeBytes}};
		const nextSerialized = serializedOf(candidate);
		const nextSize = Buffer.byteLength(nextSerialized, 'utf8');

		serialized = nextSerialized;

		if (nextSize === sizeBytes) {
			return {integrity: {contentDigest, sizeBytes}, serialized};
		}

		sizeBytes = nextSize;
	}

	return {integrity: {contentDigest, sizeBytes}, serialized};
};

/**
 * Persists one immutable execution result.
 *
 * A complete write for an existing attempt is a harness defect, not an
 * overwrite: the caller must reserve the next attempt ordinal instead.
 *
 * @param file - Attempt path.
 * @param result - Complete result.
 * @returns The stored record, including its integrity block.
 */
export const writeResult = (file: string, result: RunResultType): StoredResultType => {
	if (hashOf(result.identity) !== result.identityDigest) {
		throw new Error('refusing to write a result whose identity digest does not match its identity');
	}

	const {integrity, serialized} = integrityOf(result);
	const stored: StoredResultType = {...result, integrity};

	writeJsonAtomicText(file, serialized);

	return stored;
};

/**
 * Reads and verifies one stored result.
 *
 * A missing, partial, truncated, re-serialized, or identity-mismatched document
 * is not evidence: the function returns null so a resume plans the slot as
 * missing instead of failing the campaign.
 *
 * @param file - Attempt path.
 * @returns The verified record, or null when the document is not a valid result.
 */
export const readResult = (file: string): StoredResultType | null => {
	let text: string;

	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return null;
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return null;
	}

	if (!isRecord(parsed) || !validRequiredFields(parsed)) {
		return null;
	}

	if (majorVersionOf(parsed['schemaVersion']) !== SUPPORTED_MAJOR) {
		return null;
	}

	const {integrity} = parsed;

	if (!isRecord(integrity) || typeof integrity['sizeBytes'] !== 'number' || typeof integrity['contentDigest'] !== 'string') {
		return null;
	}

	if (Buffer.byteLength(text, 'utf8') !== integrity['sizeBytes']) {
		return null;
	}

	const record: Record<string, unknown> = {...parsed};

	delete record['integrity'];

	if (hashOf(record) !== integrity['contentDigest']) {
		return null;
	}

	if (hashOf(parsed['identity']) !== parsed['identityDigest']) {
		return null;
	}

	// The stored record is written by this harness and validated above for
	// record type, version, attempt, outcome, defects, identity, and integrity.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The remaining fields are producer-controlled; a full structural validator would duplicate StoredResultType.
	return parsed as StoredResultType;
};

/**
 * Returns the effective validity of a complete result.
 *
 * A completed, failed, or timed-out execution carries usable evidence. An
 * aborted execution is inspectable but does not satisfy its slot, and any
 * recorded defect makes the result invalid.
 *
 * @param result - Complete stored result.
 * @returns `valid`, `invalid`, or `aborted`.
 */
export const effectiveValidityOf = (result: Pick<RunResultType, 'outcome' | 'defects'>): EffectiveValidityType => {
	if (result.outcome === 'aborted') {
		return 'aborted';
	}

	return result.defects.length === 0 ? 'valid' : 'invalid';
};

/**
 * Returns the attempt path for one slot.
 *
 * @param slotDirectory - Directory holding every attempt for one slot.
 * @param attempt - One-based attempt ordinal.
 * @returns Absolute attempt path.
 */
export const resultPathOf = (slotDirectory: string, attempt: number): string => path.join(slotDirectory, `attempt-${attempt}.json`);

/**
 * Lists one slot's attempt files in ascending attempt order.
 *
 * @param slotDirectory - Directory holding every attempt for one slot.
 * @returns Attempt numbers and paths.
 */
export const attemptFilesOf = (slotDirectory: string): readonly Readonly<{attempt: number; file: string}>[] => {
	if (!existsSync(slotDirectory)) {
		return [];
	}

	return readdirSync(slotDirectory)
		.map((name) => {
			const attempt = ATTEMPT_FILE.exec(name)?.groups?.['attempt'];

			return attempt === undefined ? null : {attempt: Number(attempt), file: path.join(slotDirectory, name)};
		})
		.filter((entry): entry is Readonly<{attempt: number; file: string}> => entry !== null)
		.sort((left, right) => left.attempt - right.attempt);
};

/**
 * Decision to reuse a stored slot or send it back to execution.
 *
 * `retryingTimedOut` is true only when an explicit timed-out replay overrode an
 * otherwise reusable attempt.
 */
export type ResumeDecisionType = Readonly<{
	record: RunResultType | null;
	attempt: number | null;
	nextAttempt: number;
	retryingTimedOut: boolean;
}>;

/**
 * Applies the campaign flags to one slot's stored state.
 *
 * A timed-out attempt is valid evidence, so only `--retry-timed-out` sends it
 * back to execution.
 *
 * @param state - Stored-attempt state for the slot.
 * @param flags - Parsed campaign flags.
 * @returns The reusable record and the timeout-replay marker.
 */
export const resumeDecisionOf = (state: ResumeStateType, flags: Readonly<{has: (name: string) => boolean}>): ResumeDecisionType => {
	const retryingTimedOut = flags.has('retry-timed-out') && state.record?.timedOut === true;
	const reusable = flags.has('resume') && state.record !== null && !retryingTimedOut;

	return {record: reusable ? state.record : null, attempt: state.attempt, nextAttempt: state.nextAttempt, retryingTimedOut};
};

/**
 * Persists every attempt of one slot, with the final result replacing its
 * in-flight copy.
 *
 * @param slotDirectory - Directory holding the slot's attempts.
 * @param attempts - Attempts produced during execution.
 * @param result - Final result of the slot.
 */
export const storeAttemptsOf = (slotDirectory: string, attempts: readonly RunResultType[], result: RunResultType): void => {
	for (const [index, attempt] of attempts.entries()) {
		const stored = index === attempts.length - 1 ? result : attempt;

		writeResult(resultPathOf(slotDirectory, stored.attempt), stored);
	}
};

/**
 * Resolves whether a slot may resume from a stored attempt.
 *
 * Only a complete, readable, effectively valid record with exactly the planned
 * identity digest is reusable. A record for a different identity is retained
 * untouched and never blocks the new identity's attempt.
 *
 * @param slotDirectory - Directory holding every attempt for one slot.
 * @param identityDigest - Planned complete identity digest.
 * @returns The reusable record, its attempt, and the next free attempt ordinal.
 */
export const resumeStateOf = (slotDirectory: string, identityDigest: string): ResumeStateType => {
	const files = attemptFilesOf(slotDirectory);
	const nextAttempt = (files.at(-1)?.attempt ?? 0) + 1;
	let reusable: Readonly<{record: StoredResultType; attempt: number}> | null = null;

	for (const entry of [...files].toReversed()) {
		const record = readResult(entry.file);

		if (record === null || record.identityDigest !== identityDigest) {
			continue;
		}

		if (effectiveValidityOf(record) === 'valid') {
			reusable = {record, attempt: entry.attempt};
		}

		// The highest readable attempt for this identity decides: a later aborted
		// or invalid attempt leaves the slot pending rather than silently falling
		// back to older evidence.
		break;
	}

	return {record: reusable?.record ?? null, attempt: reusable?.attempt ?? null, nextAttempt};
};
