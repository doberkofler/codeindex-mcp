import {createHash} from 'node:crypto';
import {appendFileSync, mkdtempSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {type ConfigType} from '../config/config.ts';
import {type BuildFailureCauseType, buildFailureCauseOf} from '../generation/buildFailureCause.ts';
import {createCodeIndex, type CodeIndex} from '../generation/codeIndex.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type IndexStatusType} from '../model.ts';
import {IndexDatabase} from '../storage/database.ts';
import {readStorage} from './resources.ts';
import {
	type SoakEditType,
	type SoakEventKindType,
	type SoakEventType,
	type SoakBuildFailureType,
	type SoakFailureType,
	type SoakPlanType,
	type SoakResourceType,
	type SoakRetentionObservationType,
	type SoakRetentionType,
	type SoakStorageType,
} from './soakTypes.ts';

const POLL_INTERVAL_MS = 5;
export const FAILURE_TARGET = 'src/features/feature00003.ts';
export const STALE_TARGET = 'src/features/feature00004.ts';
export const EDIT_TARGETS = ['src/features/feature00001.ts', 'src/features/feature00002.ts', 'src/shared/util0001.ts'] as const;

type BuildFailureRecordType = {
	cause: BuildFailureCauseType;
	detail: string;
	injected: boolean;
	recovered: boolean;
};

export type SoakStateType = Readonly<{
	config: ConfigType;
	plan: SoakPlanType;
	index: CodeIndex;
	database: IndexDatabase;
	requireBuildOverlap: boolean;
	workerEntry?: string | undefined;
	observedFailures: BuildFailureRecordType[];
}>;

type EventInputType = Readonly<{
	sequence: number;
	kind: SoakEventKindType;
	edits: readonly SoakEditType[];
	startedAt: number;
	status: IndexStatusType;
	resources: SoakResourceType;
	storage: SoakStorageType;
	overlappedBuild: boolean;
}>;

const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex');

const hashFile = (filePath: string): string => hashOf(readFileSync(filePath, 'utf8'));

export const waitFor = async <ValueType>(
	input: Readonly<{attempt: () => ValueType | null; timeoutMs: number; label: string; intervalMs?: number}>,
): Promise<ValueType> => {
	const deadline = performance.now() + input.timeoutMs;
	const poll = async (): Promise<ValueType> => {
		const value = input.attempt();

		if (value !== null) {
			return value;
		}

		if (performance.now() >= deadline) {
			throw new Error(`Timed out waiting for ${input.label}`);
		}

		await delay(input.intervalMs ?? POLL_INTERVAL_MS);

		return poll();
	};
	const result = await poll();

	return result;
};

export const storageOf = (database: IndexDatabase, databasePath: string): SoakStorageType => {
	const storage = readStorage(database, databasePath);

	return {
		generations: database.generationCount(),
		contentVersions: storage.contentVersions,
		extractionArtifacts: storage.extractionArtifacts,
		databaseBytes: storage.databaseBytes,
		walBytes: storage.walBytes,
		shmBytes: storage.shmBytes,
		totalBytes: storage.totalBytes,
	};
};

export const databaseContextOf = (config: ConfigType): Readonly<{rootDir: string; projectFilePath: string; extractorId: string; projectId: string}> => ({
	rootDir: config.rootDir,
	projectFilePath: config.projectFilePath,
	extractorId: config.extractorId,
	projectId: config.projectId,
});

export const openState = (
	input: Readonly<{
		config: ConfigType;
		plan: SoakPlanType;
		logger: LoggerType;
		watch: boolean;
		requireBuildOverlap: boolean;
		workerEntry?: string | undefined;
	}>,
): SoakStateType => {
	const database = IndexDatabase.open(input.config.databasePath, databaseContextOf(input.config));
	const index = createCodeIndex(input.config, database, input.logger, {
		watch: input.watch,
		...(input.workerEntry === undefined ? {} : {workerEntry: input.workerEntry}),
	});

	return {
		config: input.config,
		plan: input.plan,
		index,
		database,
		requireBuildOverlap: input.requireBuildOverlap,
		workerEntry: input.workerEntry,
		observedFailures: [],
	};
};

const editLineOf = (sequence: number, slot: number): string =>
	`\nexport const soakEvent${String(sequence).padStart(3, '0')}_${String(slot)} = ${String(sequence * 10 + slot)};\n`;

export const appendEdit = (rootDir: string, relativePath: string, sequence: number, slot: number): SoakEditType => {
	const absolutePath = path.resolve(rootDir, relativePath);
	const beforeSha256 = hashFile(absolutePath);
	appendFileSync(absolutePath, editLineOf(sequence, slot), 'utf8');
	const afterSha256 = hashFile(absolutePath);

	if (beforeSha256 === afterSha256) {
		throw new Error(`Soak edit did not change ${relativePath}`);
	}

	return {path: relativePath, beforeSha256, afterSha256, contentChanged: true};
};

/**
 * Returns a bounded, workspace-free failure detail.
 *
 * @param message - Observed failure message.
 * @param rootDir - Workspace root replaced with a placeholder.
 * @returns Sanitized detail.
 */
export const failureDetailOf = (message: string, rootDir: string): string =>
	message
		.replaceAll(rootDir, '<workspace>')
		.replaceAll(/\n\s+at\s+[^\n]+/gu, '')
		.slice(0, 500);

/**
 * Records one observed failure transition exactly once.
 *
 * @param state - Soak state owning the failure journal.
 * @param status - Status sampled during a wait.
 */
export const noteStatus = (state: SoakStateType, status: IndexStatusType): void => {
	if (status.lastError !== null) {
		const detail = failureDetailOf(status.lastError, state.config.rootDir);
		const existing = state.observedFailures.at(-1);

		if (existing === undefined || existing.detail !== detail || existing.recovered) {
			state.observedFailures.push({cause: buildFailureCauseOf(status.lastError), detail, injected: false, recovered: false});
		}

		return;
	}

	for (const failure of state.observedFailures) {
		failure.recovered = true;
	}
};

export const markInjectedFailure = (state: SoakStateType, failure: SoakFailureType): void => {
	const existing = state.observedFailures.at(-1);

	if (existing === undefined) {
		state.observedFailures.push({cause: failure.cause, detail: failure.detail, injected: true, recovered: failure.recovered});
		return;
	}

	existing.injected = true;
	existing.recovered = failure.recovered;
};

export const freshStatusOf = async (state: SoakStateType, previousGeneration: string | null, timeoutMs: number, label: string): Promise<IndexStatusType> => {
	const status = await waitFor({
		attempt: () => {
			const current = state.index.getStatus();
			noteStatus(state, current);
			return current.refresh === 'current' && current.generationId !== previousGeneration ? current : null;
		},
		timeoutMs,
		label,
	});

	return status;
};

export const eventOf = (input: EventInputType): SoakEventType => ({
	sequence: input.sequence,
	kind: input.kind,
	edits: input.edits,
	startedAt: new Date(performance.timeOrigin + input.startedAt).toISOString(),
	freshAt: new Date().toISOString(),
	eventToFreshMs: Math.round(performance.now() - input.startedAt),
	generationId: input.status.generationId ?? '',
	overlappedBuild: input.overlappedBuild,
	coalesced: input.overlappedBuild,
	build: input.status.build.durationMs === null ? null : {durationMs: input.status.build.durationMs, stages: input.status.build.stages},
	resources: input.resources,
	storage: input.storage,
});

const isBuilding = (index: CodeIndex): boolean => {
	const status = index.getStatus();
	return status.building || status.refresh === 'building';
};

export const observedBuildOverlap = async (state: SoakStateType, sequence: number): Promise<boolean> => {
	if (!state.requireBuildOverlap) {
		return false;
	}

	try {
		await waitFor({
			attempt: () => (isBuilding(state.index) ? true : null),
			timeoutMs: Math.min(state.plan.timeoutMs, 5000),
			label: `burst ${String(sequence)} build`,
		});
		return true;
	} catch {
		// An in-process build can finish before the event loop observes `building`.
		// The burst is still applied and recorded; the report states whether overlap
		// was observed instead of claiming it.
		return false;
	}
};

export const waitForRecovery = async (state: SoakStateType, timeoutMs: number): Promise<IndexStatusType> => {
	const status = await waitFor({
		attempt: () => {
			const current = state.index.getStatus();
			noteStatus(state, current);
			return current.refresh === 'current' && current.lastError === null ? current : null;
		},
		timeoutMs,
		label: 'automatic recovery',
	});

	return status;
};

export const queriesServedWhileFailed = (index: CodeIndex): boolean => {
	try {
		return index.findSymbols({query: 'hubSymbol', limit: 1}).items.length > 0;
	} catch {
		return false;
	}
};

export const retentionOf = (input: Readonly<{observations: readonly SoakRetentionObservationType[]; fileCount: number}>): SoakRetentionType => {
	const bounds = {
		generations: 2,
		contentVersions: input.fileCount * 2,
		extractionArtifacts: input.fileCount * 2 * 2,
	};
	const maxima = {
		generations: Math.max(0, ...input.observations.map((entry) => entry.generations)),
		contentVersions: Math.max(0, ...input.observations.map((entry) => entry.contentVersions)),
		extractionArtifacts: Math.max(0, ...input.observations.map((entry) => entry.extractionArtifacts)),
		databaseBytes: Math.max(0, ...input.observations.map((entry) => entry.databaseBytes)),
	};
	const satisfied =
		maxima.generations <= bounds.generations && maxima.contentVersions <= bounds.contentVersions && maxima.extractionArtifacts <= bounds.extractionArtifacts;

	return {
		policy: {
			publishedGenerations: 1,
			supersededGenerations: 1,
			contentVersionsPerGeneration: input.fileCount,
			extractionArtifactsPerContentVersion: 2,
		},
		observations: input.observations,
		maxima,
		bounds,
		satisfied,
	};
};

export const planHashOf = (plan: SoakPlanType, targets: readonly string[]): string =>
	createHash('sha256').update(JSON.stringify({plan, targets})).digest('hex');

export const editScriptHashOf = (plan: SoakPlanType): string => {
	const lines: string[] = [];

	for (let sequence = 1; sequence <= plan.rounds; sequence += 1) {
		lines.push(`${EDIT_TARGETS[(sequence - 1) % EDIT_TARGETS.length] ?? EDIT_TARGETS[0]}:${editLineOf(sequence, 1)}`);
	}

	for (let slot = 1; slot <= plan.burstEdits; slot += 1) {
		lines.push(`${EDIT_TARGETS[(slot - 1) % EDIT_TARGETS.length] ?? EDIT_TARGETS[0]}:${editLineOf(plan.rounds + 1, slot)}`);
	}

	lines.push(`${STALE_TARGET}:${editLineOf(plan.rounds + 2, 1)}`);

	return hashOf(lines.join(''));
};

export const failureCausesOf = (failures: readonly SoakBuildFailureType[]): Partial<Record<BuildFailureCauseType, number>> => {
	const counts: Partial<Record<BuildFailureCauseType, number>> = {};

	for (const failure of failures) {
		counts[failure.cause] = (counts[failure.cause] ?? 0) + 1;
	}

	return counts;
};

export const observationOf = (sequence: number, database: IndexDatabase, databasePath: string): SoakRetentionObservationType => {
	const storage = storageOf(database, databasePath);

	return {
		sequence,
		generations: storage.generations,
		contentVersions: storage.contentVersions,
		extractionArtifacts: storage.extractionArtifacts,
		databaseBytes: storage.databaseBytes,
		totalBytes: storage.totalBytes,
	};
};

export const databaseDirectoryOf = (): string => mkdtempSync(path.join(os.tmpdir(), 'codeindex-soak-db-'));

/**
 * Runs one asynchronous action per index in order.
 *
 * Sequential execution is the measurement: the next soak event must not start
 * before the previous publication completed.
 *
 * @param count - Number of actions to run.
 * @param action - Action receiving the zero-based index.
 * @returns Results in declared order.
 */
export const runSequential = async <ValueType>(count: number, action: (index: number) => Promise<ValueType>): Promise<ValueType[]> => {
	const step = async (index: number): Promise<ValueType[]> => {
		if (index >= count) {
			return [];
		}

		const current = await action(index);
		const rest = await step(index + 1);

		return [current, ...rest];
	};
	const results = await step(0);

	return results;
};
