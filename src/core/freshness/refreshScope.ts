export type RefreshReasonType = 'startup' | 'change' | 'reconcile' | 'manual';

/**
 * Adapters invalidated by one scheduling decision.
 *
 * `null` means every configured adapter: startup, reconciliation, manual
 * refreshes, shared configuration changes, and ambiguous filesystem events.
 */
export type RefreshAdapterScopeType = readonly string[] | null;
