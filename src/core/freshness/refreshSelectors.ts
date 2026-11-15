import {type QueryFreshnessType, type RefreshStateType} from '../model.ts';
import {type AdapterRefreshStateType, type RefreshReducerStateType} from './refreshReducer.ts';
import {type RefreshAdapterScopeType} from './refreshScope.ts';

const adapterIsDirty = (adapter: AdapterRefreshStateType): boolean => adapter.confirmedEpoch < adapter.dirtyEpoch;

const retryAt = (adapter: AdapterRefreshStateType): number => Math.max(adapter.dueAt ?? 0, adapter.backoffDeadline ?? 0, adapter.retryDeadline ?? 0);

const selectedAdapterIds = (state: RefreshReducerStateType, adapterIds: RefreshAdapterScopeType): readonly string[] => {
	if (adapterIds === null || adapterIds.length === 0) {
		return state.adapterOrder;
	}

	const selected = new Set(adapterIds);
	return state.adapterOrder.filter((adapterId) => selected.has(adapterId));
};

const selectedAdapters = (state: RefreshReducerStateType, adapterIds: RefreshAdapterScopeType): readonly AdapterRefreshStateType[] =>
	selectedAdapterIds(state, adapterIds).flatMap((adapterId) => {
		const adapter = state.adapters.get(adapterId);
		return adapter === undefined ? [] : [adapter];
	});

const freshnessStateOf = (adapters: readonly AdapterRefreshStateType[]): QueryFreshnessType['state'] => {
	if (adapters.some((adapter) => adapterIsDirty(adapter) && adapter.lastError !== null)) {
		return 'stale';
	}

	if (adapters.some((adapter) => adapterIsDirty(adapter))) {
		return 'updating';
	}

	if (adapters.every((adapter) => adapter.established)) {
		return 'current';
	}

	return 'unknown';
};

export const nextRefreshDeadline = (state: RefreshReducerStateType): number | null => {
	if (state.closed || state.active !== null) {
		return null;
	}

	const deadlines = [...state.adapters.values()].filter((adapter) => adapterIsDirty(adapter)).map((adapter) => retryAt(adapter));
	return deadlines.length === 0 ? null : Math.min(...deadlines);
};

export const dirtyFileCount = (state: RefreshReducerStateType, adapterIds: RefreshAdapterScopeType = null): number | null => {
	const adapters = selectedAdapters(state, adapterIds);

	if (adapters.some((adapter) => adapter.projectWideEpoch !== null && adapter.projectWideEpoch > adapter.confirmedEpoch)) {
		return null;
	}

	const paths = new Set<string>();

	for (const adapter of adapters) {
		for (const [path, epoch] of adapter.dirtyPaths) {
			if (epoch > adapter.confirmedEpoch) {
				paths.add(path);
			}
		}
	}

	return paths.size;
};

export const freshnessFor = (state: RefreshReducerStateType, adapterIds: RefreshAdapterScopeType = null): QueryFreshnessType => ({
	state: freshnessStateOf(selectedAdapters(state, adapterIds)),
	checkedAt: new Date(state.checkedAt).toISOString(),
	dirtyFileCount: dirtyFileCount(state, adapterIds),
});

export const refreshStateOf = (state: RefreshReducerStateType): RefreshStateType => {
	if (state.closed) {
		return 'stopping';
	}

	const freshness = freshnessStateOf([...state.adapters.values()]);

	if (freshness === 'stale') {
		return 'failed';
	}

	if (state.active !== null) {
		return 'building';
	}

	if (freshness === 'updating') {
		return 'dirty';
	}

	return freshness === 'current' ? 'current' : 'unknown';
};

export const projectWideInvalidation = (state: RefreshReducerStateType, adapterIds: RefreshAdapterScopeType = null): boolean =>
	selectedAdapters(state, adapterIds).some((adapter) => adapter.projectWideEpoch !== null && adapter.projectWideEpoch > adapter.confirmedEpoch);

export const refreshAgain = (state: RefreshReducerStateType): boolean => {
	const {active} = state;

	if (active === null) {
		return false;
	}

	return (
		state.pendingRequests.length > 0 ||
		active.selectedAdapterIds.some((adapterId) => {
			const adapter = state.adapters.get(adapterId);
			const capturedEpoch = active.capturedEpochs.get(adapterId);
			return adapter !== undefined && capturedEpoch !== undefined && adapter.dirtyEpoch > capturedEpoch;
		}) ||
		[...state.adapters.values()].some((adapter) => adapterIsDirty(adapter) && !active.selectedAdapterIds.includes(adapter.id))
	);
};

export const lastErrorOf = (state: RefreshReducerStateType, adapterIds: RefreshAdapterScopeType = null): string | null => {
	const adapters = selectedAdapters(state, adapterIds);
	const errors = adapters
		.flatMap((adapter) => (adapter.lastError === null ? [] : [{id: adapter.id, message: adapter.lastError}]))
		.sort((left, right) => left.id.localeCompare(right.id));

	if (errors.length === 0) {
		return null;
	}

	if (errors.length === 1) {
		return errors[0]?.message ?? null;
	}

	return errors.map((error) => `${error.id}: ${error.message}`).join('; ');
};

export const isDirtyPath = (state: RefreshReducerStateType, path: string, adapterIds: RefreshAdapterScopeType = null): boolean =>
	selectedAdapters(state, adapterIds).some(
		(adapter) =>
			(adapter.projectWideEpoch !== null && adapter.projectWideEpoch > adapter.confirmedEpoch) || (adapter.dirtyPaths.get(path) ?? 0) > adapter.confirmedEpoch,
	);
