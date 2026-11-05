import {type AdapterCountersType, type MultiAdapterDiscardedAttemptType, type MultiAdapterSupersessionType} from './multiAdapterTypes.ts';

export type AdapterIdType = 'typescript' | 'oracle';

export type RecordedEventType = Readonly<{event: string; fields: Readonly<Record<string, unknown>>}>;

type AttemptStateType = {
	lastOperation: Readonly<{adapterId: string; stage: 'probe' | 'scan'}> | null;
	watcher: Readonly<{projectWide: boolean; adapterIds: readonly string[] | null}> | null;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const zeroCounters = (): AdapterCountersType => ({probes: 0, scans: 0, extractions: 0, factWrites: 0});

export const adapterIdOf = (value: string): AdapterIdType => (value === 'oracle' ? 'oracle' : 'typescript');

export const addCounters = (target: AdapterCountersType, source: AdapterCountersType): AdapterCountersType => ({
	probes: target.probes + source.probes,
	scans: target.scans + source.scans,
	extractions: target.extractions + source.extractions,
	factWrites: target.factWrites + source.factWrites,
});

export const numberField = (fields: Readonly<Record<string, unknown>>, key: string): number | null => {
	const {[key]: value} = fields;
	return typeof value === 'number' ? value : null;
};

const stringArrayOf = (value: unknown): readonly string[] | null =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null;

/**
 * Reads per-adapter activity from one `build_complete` analytics event.
 *
 * @param fields - Event fields.
 * @returns Counters keyed by adapter; unknown adapters are ignored.
 */
export const activityCountersOf = (fields: Readonly<Record<string, unknown>>): Readonly<Record<AdapterIdType, AdapterCountersType>> => {
	const result = {typescript: zeroCounters(), oracle: zeroCounters()};
	const {adapterActivity: activity} = fields;

	if (!Array.isArray(activity)) {
		return result;
	}

	for (const entry of activity) {
		if (!isRecord(entry)) {
			continue;
		}

		const {adapterId, extractions, factWrites} = entry;

		if (typeof adapterId !== 'string' || typeof extractions !== 'number' || typeof factWrites !== 'number') {
			continue;
		}

		const key = adapterIdOf(adapterId);
		result[key] = addCounters(result[key], {probes: 0, scans: 0, extractions, factWrites});
	}

	return result;
};

const watcherOf = (fields: Readonly<Record<string, unknown>>): AttemptStateType['watcher'] => {
	const {projectWide, adapterIds} = fields;

	return {projectWide: projectWide === true, adapterIds: stringArrayOf(adapterIds)};
};

const startedAdapterIdsOf = (fields: Readonly<Record<string, unknown>>): readonly string[] | null => {
	const {adapterIds} = fields;
	return stringArrayOf(adapterIds);
};

/**
 * In-memory analytics sink that preserves the refresh chain for the benchmark.
 *
 * It consumes only bounded adapter identifiers, counts, and timings. It never
 * stores source text or absolute paths.
 */
export class MultiAdapterRecorder {
	public readonly enabled = true;
	public readonly path = '';
	readonly #events: RecordedEventType[] = [];
	readonly #discarded: MultiAdapterDiscardedAttemptType[] = [];
	#startedAttempts = 0;
	#lastPublishedDurationMs = 0;
	#lastWatcher: AttemptStateType['watcher'] = null;
	#attempt: AttemptStateType = {lastOperation: null, watcher: null};

	public readonly record = (event: string, fields: Readonly<Record<string, unknown>> = {}): null => {
		this.#events.push({event, fields});
		this.#apply(event, fields);
		return null;
	};

	public readonly close = (): void => {
		// Nothing is persisted; the benchmark owns the report.
		this.#events.length = 0;
	};

	public markOperation(adapterId: string, stage: 'probe' | 'scan'): void {
		this.#attempt.lastOperation = {adapterId, stage};
	}

	public get length(): number {
		return this.#events.length;
	}

	public eventsSince(index: number): readonly RecordedEventType[] {
		return this.#events.slice(index);
	}

	public supersession(): MultiAdapterSupersessionType {
		return {
			startedAttempts: this.#startedAttempts,
			attempts: this.#discarded.length,
			discarded: this.#discarded,
			discardedDurationMs: this.#discarded.reduce((sum, entry) => sum + entry.durationMs, 0),
			finalPublishedDurationMs: this.#lastPublishedDurationMs,
		};
	}

	#apply(event: string, fields: Readonly<Record<string, unknown>>): void {
		if (event === 'refresh_started') {
			this.#startedAttempts += 1;
			this.#attempt = {lastOperation: null, watcher: null};
			return;
		}

		if (event === 'watcher_event') {
			const watcher = watcherOf(fields);
			this.#lastWatcher = watcher;
			this.#attempt.watcher = watcher;
			return;
		}

		if (event === 'refresh_superseded') {
			this.#discarded.push(this.#discardedOf(fields));
			return;
		}

		if (event === 'refresh_published') {
			this.#lastPublishedDurationMs = numberField(fields, 'durationMs') ?? 0;
		}
	}

	#discardedOf(fields: Readonly<Record<string, unknown>>): MultiAdapterDiscardedAttemptType {
		const durationMs = numberField(fields, 'durationMs') ?? 0;
		const {reason} = fields;
		const watcher = this.#attempt.watcher ?? this.#lastWatcher;
		const cause: MultiAdapterDiscardedAttemptType['cause'] =
			watcher === null ? (reason === 'manual' ? 'manual' : 'unknown') : watcher.projectWide ? 'project-wide' : 'adapter-change';
		const {lastOperation} = this.#attempt;
		const stage: MultiAdapterDiscardedAttemptType['stage'] = lastOperation === null ? 'scan' : lastOperation.stage === 'probe' ? 'scan' : 'extraction';

		return {
			attempt: this.#discarded.length + 1,
			cause,
			stage,
			adapterId: lastOperation?.adapterId ?? startedAdapterIdsOf(fields)?.at(0) ?? null,
			durationMs,
		};
	}
}
