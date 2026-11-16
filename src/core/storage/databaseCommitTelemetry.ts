import {type DatabaseSync} from 'node:sqlite';
import {type BuildCheckpointType, type BuildPersistenceType} from '../model.ts';
import {debugFor} from '../logging/debug.ts';
import {checkpointWal} from './databaseWal.ts';

const debug = debugFor('database');

const failedCheckpoint = (durationMs: number): BuildCheckpointType => ({
	durationMs,
	mode: 'failed',
	busy: false,
	logFrames: 0,
	checkpointedFrames: 0,
	truncated: false,
	failed: true,
});

/**
 * Attempts the post-COMMIT checkpoint without changing publication success.
 *
 * @param writer - Writer connection after a successful COMMIT.
 * @returns Bounded checkpoint timing and frame state.
 */
export const checkpointAfterPublication = (writer: DatabaseSync): BuildCheckpointType => {
	const startedAt = performance.now();

	try {
		const state = checkpointWal(writer);
		debug('publication wal checkpoint', state);
		return {...state, durationMs: Math.round(performance.now() - startedAt), failed: false};
	} catch (error) {
		debug('publication wal checkpoint skipped', {message: error instanceof Error ? error.message : String(error)});
		return failedCheckpoint(Math.round(performance.now() - startedAt));
	}
};

/**
 * Creates complete publication attribution before derived artifact work.
 *
 * @param input - Measured stages, row counts, checkpoint, and total wall time.
 * @returns Privacy-safe publication telemetry.
 */
export const buildPersistence = (
	input: Readonly<Omit<BuildPersistenceType, 'artifactFlushMs' | 'artifactFlushFailures' | 'postArtifactCheckpoint'>>,
): BuildPersistenceType => ({
	...input,
	artifactFlushMs: 0,
	artifactFlushFailures: 0,
	postArtifactCheckpoint: {
		durationMs: 0,
		mode: 'none',
		busy: false,
		logFrames: 0,
		checkpointedFrames: 0,
		truncated: false,
		failed: false,
	},
});
