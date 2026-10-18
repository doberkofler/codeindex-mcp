import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {type ConfigType} from '../config/config.ts';
import {type BuildReportType, type BuildStagesType, type GenerationStateType, type ScanResultType} from '../model.ts';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

const isGenerationState = (value: unknown): value is GenerationStateType =>
	value === 'building' || value === 'published' || value === 'superseded' || value === 'failed';

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
	if (!isRecord(value) || !isGenerationState(value['state'])) {
		return null;
	}

	const {generationId, reused, durationMs, fileCount, symbolCount, occurrenceCount, dependencyEdgeCount, dependencyBindingCount, diagnosticCount} = value;

	if (
		typeof generationId !== 'string' ||
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
		state: value['state'],
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

const workerMessageOf = (raw: unknown, fallback: string): string => (isRecord(raw) && typeof raw['message'] === 'string' ? raw['message'] : fallback);

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
	input: Readonly<{workerEntry: string; config: ConfigType; scan: ScanResultType; force: boolean; debug: boolean}>,
): Promise<BuildReportType> => {
	const worker = new Worker(input.workerEntry, {
		workerData: {kind: 'code-index-build', config: input.config, scan: input.scan, force: input.force, debug: input.debug},
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
		if (code !== 0) {
			state.failure = new Error(`Index build worker exited with code ${String(code)}`);
			complete();
		}
	});

	await once(completion, 'done');

	if (state.failure !== null) {
		throw state.failure;
	}

	const report = buildReportFromWorkerMessage(state.message);

	if (report === null) {
		throw new Error(workerMessageOf(state.message, 'Index build worker failed'));
	}

	return report;
};
