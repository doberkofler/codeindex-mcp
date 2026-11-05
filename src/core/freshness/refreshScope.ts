import {type RefreshStateType} from '../model.ts';

export type RefreshReasonType = 'startup' | 'change' | 'reconcile' | 'manual';

/**
 * Adapters invalidated by one scheduling decision.
 *
 * `null` means every configured adapter: startup, reconciliation, manual
 * refreshes, shared configuration changes, and ambiguous filesystem events.
 */
export type RefreshAdapterScopeType = readonly string[] | null;

export const isFullScope = (scope: RefreshAdapterScopeType): scope is null => scope === null;

/**
 * Reports whether an event invalidates the adapters captured by the running attempt.
 *
 * @param active - Adapter scope captured when the attempt started, or null for all.
 * @param fullScope - Whether the event invalidates every adapter.
 * @param adapterIds - Adapters named by the event, or null for all.
 * @returns True when the running attempt is obsolete.
 */
/**
 * Selects the adapter scope captured by the next attempt.
 *
 * Explicit full-refresh reasons always cover every adapter. A `change` event
 * uses the adapters accumulated since the previous capture, and falls back to
 * the previous scope when a supersession produced no new filesystem event.
 *
 * @param reason - Why the attempt is running.
 * @param allDirty - Whether pending invalidation covers every adapter.
 * @param dirtyAdapters - Adapters accumulated since the previous capture.
 * @param active - Scope of the previous attempt.
 * @returns Adapter identifiers, or null for every adapter.
 */
export const scopeFor = (
	reason: RefreshReasonType,
	allDirty: boolean,
	dirtyAdapters: ReadonlySet<string>,
	active: RefreshAdapterScopeType,
): RefreshAdapterScopeType => {
	if (reason === 'startup' || reason === 'reconcile' || reason === 'manual') {
		return null;
	}

	if (allDirty) {
		return null;
	}

	if (dirtyAdapters.size > 0) {
		return [...dirtyAdapters].sort();
	}

	return active;
};

export const adapterScopeIsAffected = (active: RefreshAdapterScopeType, fullScope: boolean, adapterIds: RefreshAdapterScopeType): boolean => {
	if (fullScope || active === null) {
		return true;
	}

	return adapterIds === null || adapterIds.some((adapterId) => active.includes(adapterId));
};

/**
 * Reports whether all indexed paths are currently considered dirty.
 *
 * @param pending - Whether the next attempt covers every adapter.
 * @param active - Whether the running attempt covered every adapter.
 * @param state - Current coordinator state.
 * @returns True when path-level freshness cannot be narrowed.
 */
export const projectWideInvalidationOf = (pending: boolean, active: boolean, state: RefreshStateType): boolean => pending || (state === 'building' && active);

/**
 * Counts distinct dirty paths without collapsing a full invalidation to zero.
 *
 * @param input - Pending and active invalidation state and path sets.
 * @returns Distinct dirty path count, or null for a full invalidation.
 */
export const dirtyFileCountOf = (
	input: Readonly<{
		pendingProjectWide: boolean;
		activeProjectWide: boolean;
		state: RefreshStateType;
		pending: ReadonlySet<string>;
		active: ReadonlySet<string>;
	}>,
): number | null => {
	if (projectWideInvalidationOf(input.pendingProjectWide, input.activeProjectWide, input.state)) {
		return null;
	}

	if (input.state !== 'building') {
		return input.pending.size;
	}

	return new Set([...input.active, ...input.pending]).size;
};
