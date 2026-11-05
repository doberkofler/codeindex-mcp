import {type AdapterType} from '@codeindex/adapter-sdk';
import {type ConfigType} from '../config/config.ts';
import {collectStatus} from '../freshness/indexStatus.ts';
import {debugFor} from '../logging/debug.ts';
import {type GenerationRowType, type IndexStatusType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {type RefreshCoordinatorSnapshotType} from '../freshness/refreshTypes.ts';

const debug = debugFor('index');

/**
 * Reads one consistent status snapshot and its published generation.
 *
 * @param input - Configuration, adapters, database, and refresh state.
 * @returns Status plus the published generation observed by the same snapshot.
 */
export const readIndexStatus = (
	input: Readonly<{
		config: ConfigType;
		adapters: ReadonlyMap<string, AdapterType>;
		database: IndexDatabase;
		refresh: RefreshCoordinatorSnapshotType;
	}>,
): Readonly<{status: IndexStatusType; published: GenerationRowType | null}> =>
	input.database.readSnapshot(() => {
		const published = input.database.getPublishedGeneration();
		const status = collectStatus({
			config: input.config,
			adapters: input.adapters,
			database: input.database,
			published,
			refresh: input.refresh,
			workingCopyId: input.database.getWorkingCopy()?.id ?? null,
			lastError: null,
		});
		debug('status', {state: status.state, refresh: status.refresh, published: published?.id ?? null, dirtyFiles: status.freshness.dirtyFileCount});
		return {status, published};
	});
