import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {type ResolvedAdapterDescriptorType} from '../../adapters/loader.ts';
import {type ConfigType} from '../config/config.ts';
import {type BuildReportType, type BuildStagesType, type GenerationStateType} from '../model.ts';
import {type AdapterScanPlanType} from './adapterBuild.ts';
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
	};
};

const buildReportFromWorkerMessage = (raw: unknown): BuildReportType | null => (isRecord(raw) ? asBuildReport(raw['report']) : null);

const projectContextOf = (plans: readonly AdapterScanPlanType[]): BuildProjectContextType | null => {
	const project = plans.find((plan) => plan.scan !== null)?.scan?.projects.at(0);
	return project === undefined ? null : {name: project.name, file: project.projectFile};
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
		scans: readonly AdapterScanPlanType[];
		descriptors: readonly ResolvedAdapterDescriptorType[];
		force: boolean;
		ownerId: string;
		startedAtEpoch: number;
		debug: boolean;
	}>,
): Promise<BuildReportType> => {
	const worker = new Worker(input.workerEntry, {
		workerData: {
			kind: 'code-index-build',
			config: input.config,
			scans: input.scans,
			descriptors: input.descriptors,
			force: input.force,
			ownerId: input.ownerId,
			startedAtEpoch: input.startedAtEpoch,
			debug: input.debug,
		},
	});
	const completion = new EventTarget();
	const state: {message: unknown; failure: Error | null} = {message: null, failure: null};
	const complete = (): void => {
		completion.dispatchEvent(new Event('done'));
	};

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
	const project = projectContextOf(input.scans);

	if (state.failure !== null) {
		throw new BuildFailureEnvelopeError(workerFailureOf(state.failure, project));
	}

	const report = buildReportFromWorkerMessage(state.message);

	if (report !== null) {
		return report;
	}

	const failure = isRecord(state.message) ? buildFailureFromWorkerPayload(state.message['failure']) : null;

	throw new BuildFailureEnvelopeError(failure ?? {outcome: 'failed', cause: 'worker', stage: 'worker', errno: null, project, adapter: null});
};
