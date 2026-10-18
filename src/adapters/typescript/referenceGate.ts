import {type ReferenceLocationType} from './referenceLocations.ts';
import {REFERENCE_CONSTRUCT_QUOTA, REFERENCE_CONSTRUCT_TAGS, type ReferenceConstructTagType} from './referenceConstructs.ts';
import {REFERENCE_SAMPLE_TARGET} from './referenceSampling.ts';

const GATE_MIN_SAMPLES = REFERENCE_SAMPLE_TARGET;
const GATE_MIN_RECALL = 0.995;
const GATE_PRECISION = 1;

export type ReferenceSkipReasonType = 'declaration_not_located' | 'reference_lookup_failed' | 'definition_outside_authored_files';

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
	readonly missing: readonly ReferenceLocationType[];
	readonly extra: readonly ReferenceLocationType[];
	readonly skip: ReferenceSkipReasonType | null;
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
	readonly recall: number;
	readonly precision: number;
}>;

type ReferenceGateFailureKindType =
	| 'insufficient_samples'
	| 'unlocated_symbols'
	| 'skipped_symbols'
	| 'missing_construct'
	| 'unreferenced_construct'
	| 'unclassified_mismatch'
	| 'recall_below_target'
	| 'precision_below_target';

type ReferenceGateFailureType = Readonly<{
	readonly kind: ReferenceGateFailureKindType;
	readonly detail: string;
}>;

export type ReferenceGateResultType = Readonly<{
	readonly ok: boolean;
	readonly failures: readonly ReferenceGateFailureType[];
	readonly targets: Readonly<{readonly samples: number; readonly recall: number; readonly precision: number}>;
}>;

export type ReferenceVerificationFactsType = Readonly<{
	readonly coverage: ReferenceCoverageType;
	readonly accuracy: ReferenceAccuracyType;
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

	if (report.accuracy.recall < GATE_MIN_RECALL) {
		failures.push(gateFailure('recall_below_target', `recall ${String(report.accuracy.recall)} is below ${String(GATE_MIN_RECALL)}`));
	}

	if (report.accuracy.precision !== GATE_PRECISION) {
		failures.push(gateFailure('precision_below_target', `precision ${String(report.accuracy.precision)} is not ${String(GATE_PRECISION)}`));
	}

	return {
		ok: failures.length === 0,
		failures,
		targets: {samples: GATE_MIN_SAMPLES, recall: GATE_MIN_RECALL, precision: GATE_PRECISION},
	};
};
