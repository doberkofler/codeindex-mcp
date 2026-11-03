import {addressIssue} from './address.ts';
import {bindingIdFor, type BindingEntryType} from './bindings.ts';
import {serializeAddress} from './canonical.ts';
import {addIssue} from './issues.ts';
import {
	type ExtractedFactSetType,
	type ExtractedSurfaceOriginType,
	type FactIssueType,
	type FinalizationPolicyType,
	type FinalizedSurfaceOriginType,
} from './types.ts';

export type OriginCollectionType = Readonly<{
	readonly origins: readonly FinalizedSurfaceOriginType[];
	readonly maxSurfaceBindingsPerRoot: number;
}>;

const invalidOriginReason = (origin: ExtractedSurfaceOriginType): string | null =>
	addressIssue(origin.segments) ??
	addressIssue(origin.rootSegments) ??
	addressIssue(origin.relativeSegments) ??
	(origin.relativeSegments.length === 0 ? 'surface origin has an empty relative path' : null) ??
	(serializeAddress(origin.segments) === serializeAddress([...origin.rootSegments, ...origin.relativeSegments])
		? null
		: 'surface origin is not the root address followed by the relative address');

/**
 * Validates surface origins and applies the per-root binding ceiling.
 *
 * @param facts - Extracted fact bundle.
 * @param entries - Canonical bindings.
 * @param policy - Finalization controls.
 * @param issues - Accumulated issues.
 * @returns Origin rows and the observed maximum per root.
 * @throws {@link Error} When one root exceeds the configured ceiling.
 */
export const collectOrigins = (
	facts: ExtractedFactSetType,
	entries: ReadonlyMap<string, BindingEntryType>,
	policy: FinalizationPolicyType,
	issues: FactIssueType[],
): OriginCollectionType => {
	const origins: FinalizedSurfaceOriginType[] = [];
	const counts = new Map<string, number>();
	const seen = new Set<string>();

	for (const origin of facts.surfaceOrigins) {
		const reason = invalidOriginReason(origin);

		if (reason !== null) {
			addIssue(issues, 'invalid_address', reason, {symbolId: origin.symbolId});
			continue;
		}

		const entry = bindingIdFor(entries, origin.symbolId, origin.segments);
		const root = bindingIdFor(entries, origin.rootSymbolId, origin.rootSegments);

		if (entry === undefined || root === undefined) {
			addIssue(issues, 'invalid_surface_origin', 'surface origin references no emitted binding', {symbolId: origin.symbolId});
			continue;
		}

		const identity = `${entry.bindingId}\u0000${origin.context}`;

		if (seen.has(identity)) {
			continue;
		}

		seen.add(identity);
		origins.push({
			bindingId: entry.bindingId,
			context: origin.context,
			rootBindingId: root.bindingId,
			rootKey: serializeAddress(origin.rootSegments),
			relativeKey: serializeAddress(origin.relativeSegments),
		});
		counts.set(root.bindingId, (counts.get(root.bindingId) ?? 0) + 1);
	}

	let maxSurfaceBindingsPerRoot = 0;

	for (const [rootBindingId, count] of counts) {
		maxSurfaceBindingsPerRoot = Math.max(maxSurfaceBindingsPerRoot, count);

		if (count > policy.maxBindingsPerRoot) {
			addIssue(
				issues,
				'ceiling_exceeded',
				`published root ${rootBindingId} emitted ${String(count)} surface bindings above the ${String(policy.maxBindingsPerRoot)} ceiling`,
				{bindingId: rootBindingId},
			);
		}
	}

	return {origins, maxSurfaceBindingsPerRoot};
};
