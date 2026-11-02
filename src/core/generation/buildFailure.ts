import {type ScanProjectResultType, type ScanResultType} from '../model.ts';
import {type BuildFailureCauseType, buildFailureCauseOf, isBuildFailureCause} from './buildFailureCause.ts';

/**
 * Closed stage set for one failed build.
 *
 * A stage names where the build stopped; a cause names why. Both are persisted
 * with failure telemetry so a failure stays diagnosable without stack traces,
 * source text, or absolute paths.
 */
const BUILD_FAILURE_STAGES = [
	'configuration',
	'scan',
	'compiler',
	'extraction',
	'validation',
	'persistence',
	'verification',
	'publication',
	'lease',
	'worker',
	'unknown',
] as const;

export type BuildFailureStageType = (typeof BUILD_FAILURE_STAGES)[number];

const STAGE_SET = new Set<string>(BUILD_FAILURE_STAGES);

/** One project identity safe for telemetry; the file is workspace-relative. */
export type BuildProjectContextType = Readonly<{
	readonly name: string;
	readonly file: string;
}>;

/**
 * Bounded failure envelope for one build attempt.
 *
 * The envelope deliberately omits the raw error text: messages can contain
 * absolute paths, and stack traces never belong in telemetry or worker frames.
 */
export type BuildFailureType = Readonly<{
	readonly outcome: 'failed';
	readonly cause: BuildFailureCauseType;
	readonly stage: BuildFailureStageType;
	readonly errno: string | null;
	readonly project: BuildProjectContextType | null;
	/** Adapter that failed, or null when the failure is not adapter-specific. */
	readonly adapter: string | null;
}>;

const errorStages = new WeakMap<object, BuildFailureStageType>();

/**
 * Attaches one build stage to the error an action throws.
 *
 * The error object is rethrown unchanged so callers keep its type, message, and
 * stack. The stage is recorded out of band and read by {@link buildFailureOf}.
 *
 * @param stage - Stage that owns the action.
 * @param action - Work to run.
 * @returns The action's value.
 * @throws {Error} Whatever the action throws, annotated with the stage.
 */
export const runBuildStage = <ValueType>(stage: BuildFailureStageType, action: () => ValueType): ValueType => {
	try {
		return action();
	} catch (error) {
		if (typeof error === 'object' && error !== null && !errorStages.has(error)) {
			errorStages.set(error, stage);
		}

		throw error;
	}
};

const fieldOf = (value: object, key: string): unknown => Reflect.get(value, key) as unknown;

const isStage = (value: unknown): value is BuildFailureStageType => typeof value === 'string' && STAGE_SET.has(value);

const isProjectContext = (value: unknown): value is BuildProjectContextType => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const name = fieldOf(value, 'name');
	const file = fieldOf(value, 'file');

	return typeof name === 'string' && name.length > 0 && typeof file === 'string' && file.length > 0;
};

const errnoOf = (error: unknown): string | null => {
	if (typeof error !== 'object' || error === null) {
		return null;
	}

	const code = fieldOf(error, 'code');

	if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code)) {
		return code;
	}

	const errno = fieldOf(error, 'errno');

	return typeof errno === 'number' && Number.isFinite(errno) ? String(errno) : null;
};

const stageOf = (error: unknown, fallback: BuildFailureStageType): BuildFailureStageType => {
	if (typeof error === 'object' && error !== null) {
		return errorStages.get(error) ?? fallback;
	}

	return fallback;
};

/**
 * Returns the first project identity in workspace-relative form.
 *
 * @param projects - Project contexts recorded by the scan.
 * @returns The telemetry-safe project context, or null when the scan had none.
 */
export const buildProjectContextOf = (projects: readonly ScanProjectResultType[]): BuildProjectContextType | null => {
	const project = projects.at(0);
	return project === undefined ? null : {name: project.name, file: project.projectFile};
};

/**
 * Returns the first project identity from one scan.
 *
 * @param scan - Scan result, or null before scanning has completed.
 * @returns The telemetry-safe project context, or null.
 */
export const buildProjectContextOfScan = (scan: ScanResultType | null): BuildProjectContextType | null =>
	scan === null ? null : buildProjectContextOf(scan.projects);

const buildFailureMessage = (failure: BuildFailureType): string => {
	const location = `${failure.cause} at ${failure.stage}`;
	const errno = failure.errno === null ? '' : `, ${failure.errno}`;
	const adapter = failure.adapter === null ? '' : `, adapter ${failure.adapter}`;
	const project = failure.project === null ? '' : `, ${failure.project.name} (${failure.project.file})`;

	return `Index build failed (${location}${errno}${adapter}${project})`;
};

/**
 * Error carrying a structured build-failure envelope.
 *
 * The message is derived from the envelope only, so a worker failure cannot leak
 * a raw message or an absolute path to the parent process.
 */
export class BuildFailureEnvelopeError extends Error {
	public readonly failure: BuildFailureType;

	public constructor(failure: BuildFailureType) {
		super(buildFailureMessage(failure));
		this.name = 'BuildFailureEnvelopeError';
		this.failure = failure;
	}
}

/**
 * Builds the bounded failure envelope for one thrown value.
 *
 * @param error - Value thrown by a build stage.
 * @param fallbackStage - Stage to use when the error was not annotated.
 * @param project - Workspace-relative project context, when known.
 * @param adapter - Adapter that failed, or null when not adapter-specific.
 * @returns The closed failure envelope.
 */
export const buildFailureOf = (
	error: unknown,
	fallbackStage: BuildFailureStageType = 'unknown',
	project: BuildProjectContextType | null = null,
	adapter: string | null = null,
): BuildFailureType => {
	if (error instanceof BuildFailureEnvelopeError) {
		return error.failure;
	}

	return {
		outcome: 'failed',
		cause: buildFailureCauseOf(error),
		stage: stageOf(error, fallbackStage),
		errno: errnoOf(error),
		project,
		adapter,
	};
};

const isWorkerErrno = (errno: unknown): boolean => errno === null || (typeof errno === 'string' && /^[A-Z0-9_]{1,32}$/u.test(errno));

const isWorkerAdapter = (adapter: unknown): boolean =>
	adapter === undefined || adapter === null || (typeof adapter === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(adapter));

/**
 * Validates a worker failure envelope received across the thread boundary.
 *
 * @param value - Decoded worker message field.
 * @returns The envelope, or null when any field is outside the closed sets.
 */
export const buildFailureFromWorkerPayload = (value: unknown): BuildFailureType | null => {
	if (typeof value !== 'object' || value === null) {
		return null;
	}

	const outcome = fieldOf(value, 'outcome');
	const cause = fieldOf(value, 'cause');
	const stage = fieldOf(value, 'stage');
	const errno = fieldOf(value, 'errno');
	const project = fieldOf(value, 'project');
	const adapter = fieldOf(value, 'adapter');

	if (outcome !== 'failed' || typeof cause !== 'string' || !isBuildFailureCause(cause) || !isStage(stage)) {
		return null;
	}

	if (!isWorkerErrno(errno) || (project !== null && !isProjectContext(project)) || !isWorkerAdapter(adapter)) {
		return null;
	}

	return {
		outcome: 'failed',
		cause,
		stage,
		errno: typeof errno === 'string' ? errno : null,
		project,
		adapter: typeof adapter === 'string' ? adapter : null,
	};
};
