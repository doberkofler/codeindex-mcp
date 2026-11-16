import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {parseAdapterWatchPlans} from '@codeindex/adapter-sdk';
import {z} from 'zod';
import {type ResolvedAdapterDescriptorType} from '../../adapters/loader.ts';
import {type ConfigType} from '../config/config.ts';
import {
	type AdapterActivityType,
	type BuildCheckpointType,
	type BuildPersistenceType,
	type BuildReportType,
	type BuildStagesType,
	type GenerationStateType,
} from '../model.ts';
import {type BuildWorkerRunResultType} from './buildWorker.ts';
import {cancelExecution, createCancellationBuffer} from './executionCancellation.ts';
import {BuildFailureEnvelopeError, buildFailureFromWorkerPayload, buildFailureOf, type BuildFailureType, type BuildProjectContextType} from './buildFailure.ts';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

const isGenerationState = (value: unknown): value is GenerationStateType =>
	value === 'building' || value === 'published' || value === 'superseded' || value === 'failed';

const isReportOutcome = (value: unknown): value is 'reused' | 'published' | 'superseded' =>
	value === 'reused' || value === 'published' || value === 'superseded';

const numericField = (value: Readonly<Record<string, unknown>>, key: string): number | null => {
	const field = value[key];
	return typeof field === 'number' ? field : null;
};

const asStages = (value: unknown): BuildStagesType | null => {
	if (!isRecord(value)) {
		return null;
	}

	const stages = {
		scanMs: numericField(value, 'scanMs'),
		compilerMs: numericField(value, 'compilerMs'),
		extractionMs: numericField(value, 'extractionMs'),
		insertionMs: numericField(value, 'insertionMs'),
		verificationMs: numericField(value, 'verificationMs'),
		publicationMs: numericField(value, 'publicationMs'),
	};

	if (Object.values(stages).some((stage) => stage === null)) {
		return null;
	}

	return {
		scanMs: stages.scanMs ?? 0,
		compilerMs: stages.compilerMs ?? 0,
		extractionMs: stages.extractionMs ?? 0,
		insertionMs: stages.insertionMs ?? 0,
		verificationMs: stages.verificationMs ?? 0,
		publicationMs: stages.publicationMs ?? 0,
	};
};

const BuildCheckpointSchema = z.object({
	durationMs: z.number(),
	mode: z.enum(['none', 'passive', 'truncate', 'failed']),
	busy: z.boolean(),
	logFrames: z.number(),
	checkpointedFrames: z.number(),
	truncated: z.boolean(),
	failed: z.boolean(),
}) satisfies z.ZodType<BuildCheckpointType>;

const BuildPersistenceSchema = z.object({
	queueWaitMs: z.number(),
	changedPathCount: z.number(),
	selectedRowCount: z.number(),
	deletedRowCount: z.number(),
	writtenRowCount: z.number(),
	insertionMs: z.number(),
	countValidationMs: z.number(),
	semanticValidationMs: z.number(),
	publicationMetadataMs: z.number(),
	contentGcMs: z.number(),
	plannerStatisticsMs: z.number(),
	commitMs: z.number(),
	publicationCheckpoint: BuildCheckpointSchema,
	artifactFlushMs: z.number(),
	artifactFlushFailures: z.number(),
	postArtifactCheckpoint: BuildCheckpointSchema,
	totalWallMs: z.number(),
}) satisfies z.ZodType<BuildPersistenceType>;

const asPersistence = (value: unknown): BuildPersistenceType | null => {
	const parsed = BuildPersistenceSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
};

const asAdapterActivity = (value: unknown): readonly AdapterActivityType[] | null => {
	if (!Array.isArray(value)) {
		return null;
	}

	const activity: AdapterActivityType[] = [];

	for (const entry of value) {
		if (!isRecord(entry) || typeof entry['adapterId'] !== 'string' || typeof entry['extractions'] !== 'number' || typeof entry['factWrites'] !== 'number') {
			return null;
		}

		activity.push({adapterId: entry['adapterId'], extractions: entry['extractions'], factWrites: entry['factWrites']});
	}

	return activity;
};

// The worker payload has many independently optional fields; each scalar guard
// is one branch and removing any would weaken the boundary check.
// oxlint-disable-next-line eslint/complexity -- Bounded worker payload validation is inherently branch-per-field.
const asBuildReport = (value: unknown): BuildReportType | null => {
	if (!isRecord(value) || !isGenerationState(value['state']) || !isReportOutcome(value['outcome'])) {
		return null;
	}

	const {generationId, revision, reused, durationMs, fileCount, symbolCount, occurrenceCount, dependencyEdgeCount, dependencyBindingCount, diagnosticCount} =
		value;

	if (
		typeof generationId !== 'string' ||
		typeof revision !== 'number' ||
		typeof reused !== 'boolean' ||
		typeof durationMs !== 'number' ||
		typeof fileCount !== 'number' ||
		typeof symbolCount !== 'number' ||
		typeof occurrenceCount !== 'number' ||
		typeof dependencyEdgeCount !== 'number' ||
		typeof dependencyBindingCount !== 'number' ||
		typeof diagnosticCount !== 'number'
	) {
		return null;
	}

	const adapterActivity = value['adapterActivity'] === undefined ? undefined : asAdapterActivity(value['adapterActivity']);
	const persistence = value['persistence'] === undefined ? undefined : asPersistence(value['persistence']);

	if (persistence === null) {
		return null;
	}

	return {
		generationId,
		revision,
		state: value['state'],
		outcome: value['outcome'],
		reused,
		durationMs,
		fileCount,
		symbolCount,
		occurrenceCount,
		dependencyEdgeCount,
		dependencyBindingCount,
		diagnosticCount,
		stages: asStages(value['stages']),
		...(persistence === undefined ? {} : {persistence}),
		...(adapterActivity === undefined || adapterActivity === null ? {} : {adapterActivity}),
	};
};

const buildReportFromWorkerMessage = (raw: unknown): BuildReportType | null => (isRecord(raw) ? asBuildReport(raw['report']) : null);

const watchPlansFromWorker = (value: unknown): BuildWorkerRunResultType['watchPlans'] | null => {
	try {
		return parseAdapterWatchPlans(value);
	} catch {
		return null;
	}
};

const compilerDriftsFromWorker = (value: unknown): BuildWorkerRunResultType['compilerDrifts'] | null => {
	if (!Array.isArray(value)) {
		return null;
	}

	const drifts: BuildWorkerRunResultType['compilerDrifts'][number][] = [];

	for (const entry of value) {
		if (
			!isRecord(entry) ||
			typeof entry['compilerVersion'] !== 'string' ||
			(entry['declaredCompilerVersion'] !== null && typeof entry['declaredCompilerVersion'] !== 'string')
		) {
			return null;
		}

		drifts.push({compilerVersion: entry['compilerVersion'], declaredCompilerVersion: entry['declaredCompilerVersion']});
	}

	return drifts;
};

const resourcesFromWorker = (value: unknown): Readonly<Record<string, number>> | null => {
	if (!isRecord(value) || Object.keys(value).length > 64) {
		return null;
	}

	const resources: Record<string, number> = {};

	for (const [key, metric] of Object.entries(value)) {
		if (!/^[a-z][A-Za-z0-9]{0,63}$/u.test(key) || typeof metric !== 'number' || !Number.isFinite(metric)) {
			return null;
		}

		resources[key] = metric;
	}

	return resources;
};

/**
 * Validates one complete retained-worker success payload.
 *
 * @param raw - Untrusted worker message.
 * @returns Validated result, or null for a malformed payload.
 */
export const buildWorkerRunResultFromMessage = (raw: unknown): BuildWorkerRunResultType | null => {
	if (!isRecord(raw)) {
		return null;
	}

	const payload = raw['result'];

	if (!isRecord(payload)) {
		return null;
	}

	const report = buildReportFromWorkerMessage(payload);
	const watchPlans = watchPlansFromWorker(payload['watchPlans']);
	const compilerDrifts = compilerDriftsFromWorker(payload['compilerDrifts']);
	const resources = resourcesFromWorker(payload['resources']);

	return report === null || watchPlans === null || compilerDrifts === null || resources === null ? null : {report, watchPlans, compilerDrifts, resources};
};

const workerFailureOf = (error: unknown, project: BuildProjectContextType | null): BuildFailureType => buildFailureOf(error, 'worker', project);

/**
 * Builds one generation in a background worker thread.
 *
 * The MCP transport remains responsive while the worker runs.
 *
 * @param input - Worker entry, resolved configuration, scan, and debug flag.
 * @returns The worker's build report.
 * @throws {@link Error} When the worker exits or reports a failure.
 */
export const runBuildWorkerThread = async (
	input: Readonly<{
		workerEntry: string;
		config: ConfigType;
		adapterIds: readonly string[] | null;
		descriptors: readonly ResolvedAdapterDescriptorType[];
		force: boolean;
		ownerId: string;
		startedAtEpoch: number;
		debug: boolean;
		/** Cooperative cancellation; the worker discards the candidate at a safe checkpoint. */
		signal?: AbortSignal | undefined;
	}>,
): Promise<BuildReportType> => {
	const cancellationBuffer = createCancellationBuffer();
	const worker = new Worker(input.workerEntry, {
		workerData: {
			kind: 'code-index-build',
			config: input.config,
			adapterIds: input.adapterIds,
			descriptors: input.descriptors,
			force: input.force,
			ownerId: input.ownerId,
			cancellationBuffer,
			startedAtEpoch: input.startedAtEpoch,
			debug: input.debug,
		},
	});
	const completion = new EventTarget();
	const state: {message: unknown; failure: Error | null} = {message: null, failure: null};
	const complete = (): void => {
		completion.dispatchEvent(new Event('done'));
	};
	const cancel = (): void => {
		cancelExecution(cancellationBuffer);
	};
	const {signal} = input;

	if (signal !== undefined) {
		if (signal.aborted) {
			cancel();
		} else {
			signal.addEventListener('abort', cancel, {once: true});
		}
	}

	worker.once('message', (value: unknown) => {
		state.message = value;
		complete();
	});

	worker.once('error', (error) => {
		state.failure = error instanceof Error ? error : new Error(String(error));
		complete();
	});

	worker.once('exit', (code) => {
		// A worker error, including ERR_WORKER_OUT_OF_MEMORY, is richer than the
		// exit code and arrives before this event. Never replace it.
		if (code !== 0 && state.failure === null) {
			state.failure = new Error(`Index build worker exited with code ${String(code)}`);
		}

		complete();
	});

	await once(completion, 'done');
	signal?.removeEventListener('abort', cancel);
	const project = null;

	if (state.failure !== null) {
		throw new BuildFailureEnvelopeError(workerFailureOf(state.failure, project));
	}

	const result = buildWorkerRunResultFromMessage(state.message);

	if (result !== null) {
		return result.report;
	}

	const failure = isRecord(state.message) ? buildFailureFromWorkerPayload(state.message['failure']) : null;

	throw new BuildFailureEnvelopeError(failure ?? {outcome: 'failed', cause: 'worker', stage: 'worker', errno: null, project, adapter: null});
};
