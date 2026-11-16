import {type DatabaseSync} from 'node:sqlite';

import {parseAdapterWatchPlans, type AdapterWatchPlanType} from '@codeindex/adapter-sdk';

import {asString} from './databaseRows.ts';

const WATCH_PLANS_KEY = 'adapter_watch_plans';

/**
 * Reads the last installed adapter watch-plan roster.
 *
 * Invalid or absent derived metadata is treated as unavailable so startup can
 * replace it with conservative configuration-derived plans.
 *
 * @param reader - Database read connection.
 * @returns Validated plans, or an empty roster.
 */
export const readWatchPlans = (reader: DatabaseSync): readonly AdapterWatchPlanType[] => {
	const row = reader.prepare('select value from metadata where key = ?').get(WATCH_PLANS_KEY);

	if (row === undefined) {
		return [];
	}

	try {
		return parseAdapterWatchPlans(JSON.parse(asString(row, 'value')));
	} catch {
		return [];
	}
};

/**
 * Atomically replaces persisted adapter watch plans.
 *
 * @param writer - Database write connection.
 * @param plans - Complete validated roster.
 */
export const writeWatchPlans = (writer: DatabaseSync, plans: readonly AdapterWatchPlanType[]): void => {
	const validated = parseAdapterWatchPlans(plans);
	writer
		.prepare('insert into metadata (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
		.run(WATCH_PLANS_KEY, JSON.stringify(validated));
};
