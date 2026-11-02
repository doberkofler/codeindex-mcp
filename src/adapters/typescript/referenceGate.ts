import {type ReferenceLocationType} from './referenceLocations.ts';
import {REFERENCE_CONSTRUCT_QUOTA, REFERENCE_CONSTRUCT_TAGS, type ReferenceConstructTagType} from './referenceConstructs.ts';
import {REFERENCE_SAMPLE_TARGET} from './referenceSampling.ts';

const GATE_MIN_SAMPLES = REFERENCE_SAMPLE_TARGET;
const GATE_PRECISION = 1;

export type ReferenceSkipReasonType = 'declaration_not_located' | 'reference_lookup_failed' | 'definition_outside_authored_files';

/**
 * Conservation class for one truth location absent from the tested partition.
 *
 * A location can be legitimately absent from one symbol's occurrence list while
 * still being stored under another symbol, or classified as an external or
 * namespace binding. Only `unexplained` is a correctness failure.
 */
export type ReferenceUnmatchedClassType = 'stored_reference' | 'stored_definition' | 'direct_external' | 'namespace_import' | 'unexplained';

export type ReferenceUnmatchedLocationType = Readonly<{
	readonly location: ReferenceLocationType;
	readonly classification: ReferenceUnmatchedClassType;
}>;

export type ReferenceComparisonType = Readonly<{
	readonly symbolId: string;
	readonly name: string;
	readonly kind: string;
	readonly path: string;
	readonly tags: readonly ReferenceConstructTagType[];
	readonly expectedCount: number;
	readonly actualCount: number;
	readonly matchedCount: number;
	readonly expectedReferenceCount: number;
	/** Every language-service location, retained as raw evidence. */
	readonly expectedLocations: readonly ReferenceLocationType[];
	/** Every persisted occurrence returned through paginated `find_references`. */
	readonly actualLocations: readonly ReferenceLocationType[];
	readonly missing: readonly ReferenceLocationType[];
	readonly extra: readonly ReferenceLocationType[];
	readonly unmatched: readonly ReferenceUnmatchedLocationType[];
	readonly skip: ReferenceSkipReasonType | null;
}>;

type ReferenceAliasGroupCoverageType = Readonly<{
	/** Truth locations over every verified comparison. */
	readonly expected: number;
	/** Truth locations matched inside the tested partition. */
	readonly matched: number;
	/** Truth locations stored under a sibling symbol. */
	readonly sibling: number;
	/** Truth locations explained as direct external or namespace bindings. */
	readonly directExternal: number;
	readonly namespaceImport: number;
	readonly unexplained: number;
	/**
	 * Coverage of the union partition: matched plus sibling-stored locations
	 * divided by all truth locations. External and namespace classifications are
	 * reported beside this ratio, never added to it. This is deliberately not
	 * extraction recall and is never presented as a complement to a partition.
	 */
	readonly ratio: number;
}>;

type ReferenceSkipType = Readonly<{
	readonly symbolId: string;
	readonly name: string;
	readonly path: string;
	readonly reason: ReferenceSkipReasonType;
}>;

export type ReferenceCoverageType = Readonly<{
	readonly indexedSymbols: number;
	readonly locatedSymbols: number;
	readonly unlocatedSymbols: number;
	readonly sampledSymbols: number;
	readonly symbolsWithNonDefinitionReferences: number;
	readonly skipped: readonly ReferenceSkipType[];
	readonly byKind: Readonly<Record<string, number>>;
	readonly byTag: Readonly<Record<string, number>>;
	readonly referencedByTag: Readonly<Record<string, number>>;
}>;

export type ReferenceAccuracyType = Readonly<{
	readonly expected: number;
	readonly actual: number;
	readonly matched: number;
	readonly missing: number;
	readonly extra: number;
	/** Occurrence-level recall against the default one-symbol partition. */
	readonly recall: number;
	/** Explicit micro-recall name for new consumers. */
	readonly microRecall: number;
	/** Mean per-symbol recall; symbols with no truth locations are excluded. */
	readonly macroRecall: number;
	readonly precision: number;
	readonly unexplained: number;
	readonly storedReference: number;
	readonly storedDefinition: number;
	readonly directExternal: number;
	readonly namespaceImport: number;
	readonly aliasGroupCoverage: ReferenceAliasGroupCoverageType;
}>;

type ReferenceGateFailureKindType =
	| 'insufficient_samples'
	| 'unlocated_symbols'
	| 'skipped_symbols'
	| 'missing_construct'
	| 'unreferenced_construct'
	| 'unclassified_mismatch'
	| 'unexplained_truth'
	| 'alias_group_mismatch'
	| 'precision_below_target';

type ReferenceGateFailureType = Readonly<{
	readonly kind: ReferenceGateFailureKindType;
	readonly detail: string;
}>;

export type ReferenceGateResultType = Readonly<{
	readonly ok: boolean;
	readonly failures: readonly ReferenceGateFailureType[];
	readonly targets: Readonly<{readonly samples: number; readonly precision: number}>;
}>;

export type ReferencePersistenceType = Readonly<{
	/** Page size requested from the persisted `find_references` query. */
	readonly pageLimit: number;
	/** Pages consumed across every verified symbol. */
	readonly pages: number;
	/** Symbols read back through the persisted query. */
	readonly symbols: number;
}>;

/**
 * One verified external alias group.
 *
 * `definitions` and `references` describe the alias-group partition returned by
 * `scope: external_alias_group`. `directExternalSites` counts sampled truth
 * locations classified as direct external calls; those sites stay outside
 * occurrence results and are never added to either total.
 */
export type ReferenceAliasGroupVerificationType = Readonly<{
	readonly externalTarget: string;
	readonly externalName: string;
	readonly memberSymbols: number;
	readonly siblingSymbols: number;
	readonly definitions: number;
	readonly references: number;
	readonly completeness: 'complete' | 'bounded';
	/** Whether one alias-group query returned exactly the union of its members. */
	readonly matches: boolean;
	readonly sampledMembers: number;
	readonly directExternalSites: number;
}>;

export type ReferenceVerificationFactsType = Readonly<{
	readonly coverage: ReferenceCoverageType;
	readonly accuracy: ReferenceAccuracyType;
	readonly persistence: ReferencePersistenceType;
	readonly aliasGroups: readonly ReferenceAliasGroupVerificationType[];
	readonly comparisons: readonly ReferenceComparisonType[];
}>;

export type ReferenceVerificationReportType = ReferenceVerificationFactsType &
	Readonly<{
		readonly gate: ReferenceGateResultType;
	}>;

const gateFailure = (kind: ReferenceGateFailureKindType, detail: string): ReferenceGateFailureType => ({kind, detail});

/**
 * Evaluates the production reference gate.
 *
 * Thresholds are fixed on purpose: callers cannot weaken sampling, recall, or
 * precision. Coverage failures are fatal even when the arithmetic happens to
 * look perfect.
 *
 * @param report - Coverage, accuracy, and comparisons.
 * @returns Gate outcome with every failure reason.
 */
export const evaluateReferenceGate = (report: ReferenceVerificationFactsType): ReferenceGateResultType => {
	const failures: ReferenceGateFailureType[] = [];

	if (report.coverage.sampledSymbols < GATE_MIN_SAMPLES) {
		failures.push(gateFailure('insufficient_samples', `sampled ${String(report.coverage.sampledSymbols)} of ${String(GATE_MIN_SAMPLES)} required symbols`));
	}

	if (report.coverage.unlocatedSymbols > 0) {
		failures.push(gateFailure('unlocated_symbols', `${String(report.coverage.unlocatedSymbols)} indexed symbols have no locatable declaration`));
	}

	if (report.coverage.skipped.length > 0) {
		failures.push(
			gateFailure(
				'skipped_symbols',
				`${String(report.coverage.skipped.length)} sampled symbols were skipped: ${report.coverage.skipped.map((skip) => skip.reason).join(', ')}`,
			),
		);
	}

	for (const tag of REFERENCE_CONSTRUCT_TAGS) {
		const selected = report.coverage.byTag[tag] ?? 0;
		const referenced = report.coverage.referencedByTag[tag] ?? 0;

		if (selected < REFERENCE_CONSTRUCT_QUOTA) {
			failures.push(gateFailure('missing_construct', `${String(selected)} sampled symbols cover ${tag}; ${String(REFERENCE_CONSTRUCT_QUOTA)} required`));
		}

		if (referenced < REFERENCE_CONSTRUCT_QUOTA) {
			failures.push(
				gateFailure(
					'unreferenced_construct',
					`${String(referenced)} sampled symbols with authored references cover ${tag}; ${String(REFERENCE_CONSTRUCT_QUOTA)} required`,
				),
			);
		}
	}

	const unclassified = report.comparisons.filter((comparison) => comparison.skip === null && (comparison.missing.length > 0 || comparison.extra.length > 0));

	if (unclassified.length > 0) {
		failures.push(
			gateFailure(
				'unclassified_mismatch',
				`${String(unclassified.length)} comparisons disagree: ${unclassified
					.slice(0, 10)
					.map((comparison) => `${comparison.kind} ${comparison.name} (${comparison.path})`)
					.join('; ')}`,
			),
		);
	}

	if (report.accuracy.unexplained > 0) {
		const unexplained = report.comparisons
			.flatMap((comparison) => comparison.unmatched)
			.filter((entry) => entry.classification === 'unexplained')
			.slice(0, 10);

		failures.push(
			gateFailure(
				'unexplained_truth',
				`${String(report.accuracy.unexplained)} truth locations are unexplained: ${unexplained
					.map((entry) => `${entry.location.path}:${String(entry.location.startOffset)}:${entry.location.role}`)
					.join('; ')}`,
			),
		);
	}

	const aliasGroupMismatches = report.aliasGroups.filter((group) => !group.matches);

	if (aliasGroupMismatches.length > 0) {
		failures.push(
			gateFailure(
				'alias_group_mismatch',
				`${String(aliasGroupMismatches.length)} alias groups disagree with the union of their member partitions: ${aliasGroupMismatches
					.slice(0, 10)
					.map((group) => `${group.externalTarget}:${group.externalName}`)
					.join('; ')}`,
			),
		);
	}

	if (report.accuracy.precision !== GATE_PRECISION) {
		failures.push(gateFailure('precision_below_target', `precision ${String(report.accuracy.precision)} is not ${String(GATE_PRECISION)}`));
	}

	return {
		ok: failures.length === 0,
		failures,
		targets: {samples: GATE_MIN_SAMPLES, precision: GATE_PRECISION},
	};
};
