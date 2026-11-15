import {type RefreshAdapterScopeType, type RefreshReasonType} from './refreshScope.ts';

export type RefreshAdapterDefinitionType = Readonly<{
	id: string;
	debounceMs: number;
}>;

export type AdapterRefreshStateType = Readonly<{
	id: string;
	debounceMs: number;
	dirtyEpoch: number;
	confirmedEpoch: number;
	capturedEpoch: number | null;
	dirtyPaths: ReadonlyMap<string, number>;
	projectWideEpoch: number | null;
	firstDirtyAt: number | null;
	lastEventAt: number | null;
	dueAt: number | null;
	supersessionCount: number;
	backoffDeadline: number | null;
	failureCount: number;
	retryDeadline: number | null;
	lastError: string | null;
	reason: RefreshReasonType | null;
	established: boolean;
}>;

type PendingRequestType = Readonly<{
	id: string;
	adapterIds: RefreshAdapterScopeType;
	force: boolean;
}>;

export type ActiveRefreshAttemptType = Readonly<{
	id: number;
	reason: RefreshReasonType;
	adapterIds: RefreshAdapterScopeType;
	selectedAdapterIds: readonly string[];
	capturedEpochs: ReadonlyMap<string, number>;
	requestIds: readonly string[];
	force: boolean;
	startedAt: number;
	firstDirtyAt: number;
}>;

export type RefreshReducerStateType = Readonly<{
	adapterOrder: readonly string[];
	adapters: ReadonlyMap<string, AdapterRefreshStateType>;
	active: ActiveRefreshAttemptType | null;
	pendingRequests: readonly PendingRequestType[];
	nextAttemptId: number;
	closed: boolean;
	checkedAt: number;
	lastRefreshStartedAt: number | null;
	lastRefreshCompletedAt: number | null;
	lastReason: RefreshReasonType | null;
	lastAdapterIds: RefreshAdapterScopeType;
}>;

export type RefreshReducerActionType =
	| Readonly<{
			type: 'request';
			now: number;
			reason: RefreshReasonType;
			adapterIds: RefreshAdapterScopeType;
			paths: readonly string[] | null;
			force: boolean;
			requestId: string | null;
			immediate: boolean;
			onlyIfClean: boolean;
	  }>
	| Readonly<{type: 'capture'; now: number}>
	| Readonly<{type: 'published'; now: number; attemptId: number}>
	| Readonly<{type: 'superseded'; now: number; attemptId: number; maximumBackoffMs: number}>
	| Readonly<{type: 'failed'; now: number; attemptId: number; adapterId: string | null; error: string; maximumRetryMs: number}>
	| Readonly<{type: 'close'; now: number}>;

const selectedAdapterIds = (state: RefreshReducerStateType, adapterIds: RefreshAdapterScopeType): readonly string[] => {
	if (adapterIds === null || adapterIds.length === 0) {
		return state.adapterOrder;
	}

	const selected = new Set(adapterIds);
	return state.adapterOrder.filter((adapterId) => selected.has(adapterId));
};

const scopeCovers = (attemptAdapterIds: RefreshAdapterScopeType, requestAdapterIds: RefreshAdapterScopeType): boolean => {
	if (attemptAdapterIds === null) {
		return true;
	}

	if (requestAdapterIds === null) {
		return false;
	}

	return requestAdapterIds.every((adapterId) => attemptAdapterIds.includes(adapterId));
};

const attemptCovers = (attempt: ActiveRefreshAttemptType, adapterIds: RefreshAdapterScopeType, force: boolean): boolean =>
	(!force || attempt.force) && scopeCovers(attempt.adapterIds, adapterIds);

const adapterIsDirty = (adapter: AdapterRefreshStateType): boolean => adapter.confirmedEpoch < adapter.dirtyEpoch;

const retryAt = (adapter: AdapterRefreshStateType): number => Math.max(adapter.dueAt ?? 0, adapter.backoffDeadline ?? 0, adapter.retryDeadline ?? 0);

const withRequestedAdapter = (
	adapter: AdapterRefreshStateType,
	action: Extract<RefreshReducerActionType, {type: 'request'}>,
	dueAt: number,
): AdapterRefreshStateType => {
	const dirtyEpoch = adapter.dirtyEpoch + 1;
	const dirtyPaths = new Map(adapter.dirtyPaths);

	for (const changedPath of action.paths ?? []) {
		dirtyPaths.set(changedPath, dirtyEpoch);
	}

	return {
		...adapter,
		dirtyEpoch,
		dirtyPaths,
		projectWideEpoch: action.paths === null ? dirtyEpoch : adapter.projectWideEpoch,
		firstDirtyAt: adapterIsDirty(adapter) ? adapter.firstDirtyAt : action.now,
		lastEventAt: action.now,
		dueAt,
		backoffDeadline: action.immediate ? action.now : adapter.backoffDeadline,
		retryDeadline: action.immediate ? action.now : adapter.retryDeadline,
		reason: action.reason,
	};
};

const requestShouldBeIgnored = (state: RefreshReducerStateType, action: Extract<RefreshReducerActionType, {type: 'request'}>): boolean =>
	state.closed || (action.onlyIfClean && (state.active !== null || [...state.adapters.values()].some((adapter) => adapterIsDirty(adapter))));

const sharedDeadline = (
	state: RefreshReducerStateType,
	action: Extract<RefreshReducerActionType, {type: 'request'}>,
	adapterIds: readonly string[],
): number | null => {
	if (action.immediate || (action.adapterIds !== null && action.adapterIds.length > 0)) {
		return null;
	}

	return action.now + Math.max(0, ...adapterIds.map((adapterId) => state.adapters.get(adapterId)?.debounceMs ?? 0));
};

const request = (state: RefreshReducerStateType, action: Extract<RefreshReducerActionType, {type: 'request'}>): RefreshReducerStateType => {
	if (requestShouldBeIgnored(state, action)) {
		return state;
	}

	if (action.requestId !== null && state.active !== null && attemptCovers(state.active, action.adapterIds, action.force)) {
		return {
			...state,
			checkedAt: action.now,
			active: {...state.active, requestIds: [...state.active.requestIds, action.requestId]},
		};
	}

	const adapters = new Map(state.adapters);
	const requestedAdapterIds = selectedAdapterIds(state, action.adapterIds);
	const sharedDueAt = sharedDeadline(state, action, requestedAdapterIds);

	for (const adapterId of requestedAdapterIds) {
		const adapter = adapters.get(adapterId);

		if (adapter !== undefined) {
			const dueAt = action.immediate ? action.now : (sharedDueAt ?? action.now + adapter.debounceMs);
			adapters.set(adapterId, withRequestedAdapter(adapter, action, dueAt));
		}
	}

	const pendingRequests =
		action.requestId === null ? state.pendingRequests : [...state.pendingRequests, {id: action.requestId, adapterIds: action.adapterIds, force: action.force}];

	return {...state, adapters, pendingRequests, checkedAt: action.now};
};

const requestIsCovered = (requestValue: PendingRequestType, selected: readonly string[], force: boolean, state: RefreshReducerStateType): boolean => {
	const adapterIds = selected.length === state.adapterOrder.length ? null : selected;
	return (!requestValue.force || force) && scopeCovers(adapterIds, requestValue.adapterIds);
};

const reasonPriority = (reason: RefreshReasonType | null): number => {
	if (reason === null) {
		return 0;
	}

	switch (reason) {
		case 'manual': {
			return 4;
		}
		case 'startup': {
			return 3;
		}
		case 'reconcile': {
			return 2;
		}
		case 'change': {
			return 1;
		}
		default: {
			return 0;
		}
	}
};

const reasonOf = (adapters: readonly AdapterRefreshStateType[]): RefreshReasonType => {
	let selected: RefreshReasonType = 'change';
	let priority = 0;

	for (const adapter of adapters) {
		const adapterPriority = reasonPriority(adapter.reason);

		if (adapter.reason !== null && adapterPriority > priority) {
			selected = adapter.reason;
			priority = adapterPriority;
		}
	}

	return selected;
};

const capture = (state: RefreshReducerStateType, now: number): RefreshReducerStateType => {
	if (state.closed || state.active !== null) {
		return state;
	}

	const eligible = state.adapterOrder
		.map((adapterId) => state.adapters.get(adapterId))
		.filter((adapter): adapter is AdapterRefreshStateType => adapter !== undefined && adapterIsDirty(adapter) && retryAt(adapter) <= now);

	if (eligible.length === 0) {
		return state;
	}

	const selected = eligible.map((adapter) => adapter.id);
	const force = state.pendingRequests.some((pending) => pending.force && requestIsCovered(pending, selected, true, state));
	const requestIds = state.pendingRequests.filter((pending) => requestIsCovered(pending, selected, force, state)).map((pending) => pending.id);
	const capturedEpochs = new Map<string, number>();
	const adapters = new Map(state.adapters);

	for (const adapter of eligible) {
		capturedEpochs.set(adapter.id, adapter.dirtyEpoch);
		adapters.set(adapter.id, {...adapter, capturedEpoch: adapter.dirtyEpoch});
	}

	const firstDirtyAt = Math.min(...eligible.map((adapter) => adapter.firstDirtyAt ?? now));
	const adapterIds = selected.length === state.adapterOrder.length ? null : selected;
	const reason = reasonOf(eligible);
	const active: ActiveRefreshAttemptType = {
		id: state.nextAttemptId,
		reason,
		adapterIds,
		selectedAdapterIds: selected,
		capturedEpochs,
		requestIds,
		force,
		startedAt: now,
		firstDirtyAt,
	};
	const requestIdSet = new Set(requestIds);

	return {
		...state,
		adapters,
		active,
		pendingRequests: state.pendingRequests.filter((pending) => !requestIdSet.has(pending.id)),
		nextAttemptId: state.nextAttemptId + 1,
		lastRefreshStartedAt: now,
		lastReason: reason,
		lastAdapterIds: adapterIds,
	};
};

const cleanCapturedFacts = (adapter: AdapterRefreshStateType, confirmedEpoch: number): Pick<AdapterRefreshStateType, 'dirtyPaths' | 'projectWideEpoch'> => {
	const dirtyPaths = new Map([...adapter.dirtyPaths].filter((entry) => entry[1] > confirmedEpoch));
	const projectWideEpoch = adapter.projectWideEpoch !== null && adapter.projectWideEpoch > confirmedEpoch ? adapter.projectWideEpoch : null;
	return {dirtyPaths, projectWideEpoch};
};

const completePublished = (state: RefreshReducerStateType, attempt: ActiveRefreshAttemptType, now: number): RefreshReducerStateType => {
	const adapters = new Map(state.adapters);

	for (const adapterId of attempt.selectedAdapterIds) {
		const adapter = adapters.get(adapterId);
		const capturedEpoch = attempt.capturedEpochs.get(adapterId);

		if (adapter === undefined || capturedEpoch === undefined) {
			continue;
		}

		const confirmedEpoch = Math.max(adapter.confirmedEpoch, capturedEpoch);
		const stillDirty = confirmedEpoch < adapter.dirtyEpoch;
		adapters.set(adapterId, {
			...adapter,
			...cleanCapturedFacts(adapter, confirmedEpoch),
			confirmedEpoch,
			capturedEpoch: null,
			firstDirtyAt: stillDirty ? adapter.firstDirtyAt : null,
			dueAt: stillDirty ? adapter.dueAt : null,
			supersessionCount: 0,
			backoffDeadline: null,
			failureCount: 0,
			retryDeadline: null,
			lastError: null,
			reason: stillDirty ? adapter.reason : null,
			established: true,
		});
	}

	return {...state, adapters, active: null, lastRefreshCompletedAt: now};
};

const completeSuperseded = (
	state: RefreshReducerStateType,
	attempt: ActiveRefreshAttemptType,
	now: number,
	maximumBackoffMs: number,
): RefreshReducerStateType => {
	const adapters = new Map(state.adapters);

	for (const adapterId of attempt.selectedAdapterIds) {
		const adapter = adapters.get(adapterId);

		if (adapter === undefined) {
			continue;
		}

		const supersessionCount = adapter.supersessionCount + 1;
		const backoffMs = Math.min(adapter.debounceMs * 2 ** (supersessionCount - 1), maximumBackoffMs);
		adapters.set(adapterId, {
			...adapter,
			capturedEpoch: null,
			supersessionCount,
			backoffDeadline: now + backoffMs,
		});
	}

	return {...state, adapters, active: null, lastRefreshCompletedAt: now};
};

const completeFailed = (
	input: Readonly<{
		state: RefreshReducerStateType;
		attempt: ActiveRefreshAttemptType;
		now: number;
		failedAdapterId: string | null;
		error: string;
		maximumRetryMs: number;
	}>,
): RefreshReducerStateType => {
	const {state, attempt, now, failedAdapterId, error, maximumRetryMs} = input;
	const adapters = new Map(state.adapters);

	for (const adapterId of attempt.selectedAdapterIds) {
		const adapter = adapters.get(adapterId);

		if (adapter === undefined) {
			continue;
		}

		if (failedAdapterId !== null && adapterId !== failedAdapterId) {
			adapters.set(adapterId, {...adapter, capturedEpoch: null});
			continue;
		}

		const failureCount = adapter.failureCount + 1;
		const retryMs = Math.min(adapter.debounceMs * 2 ** (failureCount - 1), maximumRetryMs);
		adapters.set(adapterId, {
			...adapter,
			capturedEpoch: null,
			supersessionCount: 0,
			backoffDeadline: null,
			failureCount,
			retryDeadline: now + retryMs,
			lastError: error,
		});
	}

	return {...state, adapters, active: null, lastRefreshCompletedAt: now};
};

export const createRefreshReducerState = (
	adapters: readonly RefreshAdapterDefinitionType[],
	now: number,
	initiallyCurrent: boolean,
): RefreshReducerStateType => ({
	adapterOrder: adapters.map((adapter) => adapter.id),
	adapters: new Map(
		adapters.map((adapter) => [
			adapter.id,
			{
				id: adapter.id,
				debounceMs: adapter.debounceMs,
				dirtyEpoch: 0,
				confirmedEpoch: 0,
				capturedEpoch: null,
				dirtyPaths: new Map(),
				projectWideEpoch: null,
				firstDirtyAt: null,
				lastEventAt: null,
				dueAt: null,
				supersessionCount: 0,
				backoffDeadline: null,
				failureCount: 0,
				retryDeadline: null,
				lastError: null,
				reason: null,
				established: initiallyCurrent,
			},
		]),
	),
	active: null,
	pendingRequests: [],
	nextAttemptId: 1,
	closed: false,
	checkedAt: now,
	lastRefreshStartedAt: null,
	lastRefreshCompletedAt: null,
	lastReason: null,
	lastAdapterIds: null,
});

export const reduceRefresh = (state: RefreshReducerStateType, action: RefreshReducerActionType): RefreshReducerStateType => {
	switch (action.type) {
		case 'request': {
			return request(state, action);
		}
		case 'capture': {
			return capture(state, action.now);
		}
		case 'published': {
			return state.active?.id === action.attemptId ? completePublished(state, state.active, action.now) : state;
		}
		case 'superseded': {
			return state.active?.id === action.attemptId ? completeSuperseded(state, state.active, action.now, action.maximumBackoffMs) : state;
		}
		case 'failed': {
			return state.active?.id === action.attemptId
				? completeFailed({
						state,
						attempt: state.active,
						now: action.now,
						failedAdapterId: action.adapterId,
						error: action.error,
						maximumRetryMs: action.maximumRetryMs,
					})
				: state;
		}
		case 'close': {
			return {...state, closed: true, pendingRequests: [], checkedAt: action.now};
		}
		default: {
			return state;
		}
	}
};
