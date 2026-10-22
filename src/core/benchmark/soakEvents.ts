import {mkdirSync, renameSync, rmSync} from 'node:fs';
import path from 'node:path';
import {type LoggerType} from '../logging/logger.ts';
import {isCodeIndexError} from '../errors/errors.ts';
import {buildFailureCauseOf} from '../generation/buildFailureCause.ts';
import {createCodeIndex} from '../generation/codeIndex.ts';
import {IndexDatabase} from '../storage/database.ts';
import {startResourceSampler} from './resources.ts';
import {
	EDIT_TARGETS,
	FAILURE_TARGET,
	STALE_TARGET,
	appendEdit,
	databaseContextOf,
	failureDetailOf,
	freshStatusOf,
	eventOf,
	observedBuildOverlap,
	markInjectedFailure,
	noteStatus,
	queriesServedWhileFailed,
	storageOf,
	waitFor,
	waitForRecovery,
	type SoakStateType,
} from './soakSupport.ts';
import {type SoakEventType, type SoakFailureType, type SoakRestartType, type SoakStaleRefusalType} from './soakTypes.ts';

const FAILURE_BACKUP = '.soak-failure-backup.ts';

const runSingleEvent = async (state: SoakStateType, sequence: number): Promise<SoakEventType> => {
	const previousGeneration = state.index.getStatus().generationId;
	const sampler = startResourceSampler();
	const startedAt = performance.now();
	const target = EDIT_TARGETS[(sequence - 1) % EDIT_TARGETS.length] ?? EDIT_TARGETS[0];
	const edit = appendEdit(state.config.rootDir, target, sequence, 1);
	const status = await freshStatusOf(state, previousGeneration, state.plan.timeoutMs, `single event ${String(sequence)}`);

	return eventOf({
		sequence,
		kind: 'single',
		edits: [edit],
		startedAt,
		status,
		resources: sampler.stop(),
		storage: storageOf(state.database, state.config.databasePath),
		overlappedBuild: false,
	});
};

const runBurstEvent = async (state: SoakStateType, sequence: number): Promise<SoakEventType> => {
	const previousGeneration = state.index.getStatus().generationId;
	const sampler = startResourceSampler();
	const startedAt = performance.now();
	const firstTarget = EDIT_TARGETS[(sequence - 1) % EDIT_TARGETS.length] ?? EDIT_TARGETS[0];
	const edits = [appendEdit(state.config.rootDir, firstTarget, sequence, 1)];
	const overlappedBuild = await observedBuildOverlap(state, sequence);

	for (let slot = 2; slot <= state.plan.burstEdits; slot += 1) {
		const target = EDIT_TARGETS[(slot - 1) % EDIT_TARGETS.length] ?? firstTarget;
		edits.push(appendEdit(state.config.rootDir, target, sequence, slot));
	}

	const status = await freshStatusOf(state, previousGeneration, state.plan.timeoutMs, `burst event ${String(sequence)}`);

	return eventOf({
		sequence,
		kind: 'burst',
		edits,
		startedAt,
		status,
		resources: sampler.stop(),
		storage: storageOf(state.database, state.config.databasePath),
		overlappedBuild,
	});
};

const staleProbeOf = async (state: SoakStateType, sequence: number): Promise<Readonly<{event: SoakEventType; stale: SoakStaleRefusalType}>> => {
	const previousGeneration = state.index.getStatus().generationId;
	const sampler = startResourceSampler();
	const startedAt = performance.now();
	const symbol = state.index.getOutline({path: STALE_TARGET, limit: 1}).items.at(0);
	const edit = appendEdit(state.config.rootDir, STALE_TARGET, sequence, 1);
	let refused = false;
	let errorCode: string | null = null;

	if (symbol !== undefined) {
		try {
			state.index.readSymbol({symbolId: symbol.id, mode: 'text', contextLines: 0});
		} catch (error) {
			refused = isCodeIndexError(error) && error.code === 'stale_file';
			errorCode = isCodeIndexError(error) ? error.code : null;
		}
	}

	const status = await freshStatusOf(state, previousGeneration, state.plan.timeoutMs, `stale event ${String(sequence)}`);

	return {
		event: eventOf({
			sequence,
			kind: 'stale-probe',
			edits: [edit],
			startedAt,
			status,
			resources: sampler.stop(),
			storage: storageOf(state.database, state.config.databasePath),
			overlappedBuild: false,
		}),
		stale: {
			path: edit.path,
			beforeSha256: edit.beforeSha256,
			afterSha256: edit.afterSha256,
			contentChanged: edit.contentChanged,
			refused,
			errorCode,
			eventToFreshMs: Math.round(performance.now() - startedAt),
			generationId: status.generationId ?? '',
		},
	};
};

const injectFailureOf = async (state: SoakStateType): Promise<SoakFailureType> => {
	const target = path.resolve(state.config.rootDir, FAILURE_TARGET);
	const backup = path.resolve(state.config.rootDir, FAILURE_BACKUP);
	const before = state.index.getStatus();
	const startedAt = performance.now();

	renameSync(target, backup);
	mkdirSync(target);
	const failed = await waitFor({
		attempt: () => {
			const current = state.index.getStatus();
			noteStatus(state, current);
			return current.refresh === 'failed' ? current : null;
		},
		timeoutMs: state.plan.timeoutMs,
		label: 'injected source-read failure',
	});
	const servedWhileFailed = queriesServedWhileFailed(state.index);
	const afterFailure = state.index.getStatus();
	const cause = buildFailureCauseOf(failed.lastError ?? 'unknown build failure');

	rmSync(target, {recursive: true, force: true});
	renameSync(backup, target);
	const recovered = await waitForRecovery(state, state.plan.timeoutMs);
	const failure: SoakFailureType = {
		cause,
		injected: 'source-read',
		detail: failureDetailOf(failed.lastError ?? 'unknown build failure', state.config.rootDir),
		publishedGenerationBefore: before.generationId,
		publishedGenerationAfter: afterFailure.generationId,
		publicationPreserved: before.generationId === afterFailure.generationId,
		queriesServedWhileFailed: servedWhileFailed,
		recovered: recovered.refresh === 'current',
		recoveryMs: Math.round(performance.now() - startedAt),
		manualIntervention: false,
	};
	markInjectedFailure(state, failure);

	return failure;
};

const restartOf = async (
	state: SoakStateType,
	indexNumber: number,
	logger: LoggerType,
): Promise<Readonly<{restart: SoakRestartType; state: SoakStateType}>> => {
	const generationBefore = state.index.getStatus().generationId;
	const startedAt = performance.now();
	await state.index.close();
	const database = IndexDatabase.open(state.config.databasePath, databaseContextOf(state.config));
	const index = createCodeIndex(state.config, database, logger, {
		watch: false,
		...(state.workerEntry === undefined ? {} : {workerEntry: state.workerEntry}),
	});

	try {
		const report = await index.ensureReady();

		return {
			restart: {
				index: indexNumber,
				generationBefore,
				generationAfter: report.generationId,
				reused: report.reused,
				sameGeneration: report.generationId === generationBefore,
				durationMs: Math.round(performance.now() - startedAt),
			},
			state: {...state, index, database},
		};
	} catch (error) {
		await index.close();
		throw error;
	}
};

export {injectFailureOf, restartOf, runBurstEvent, runSingleEvent, staleProbeOf};
