import {type ExtractedFactSetType} from '../../facts/index.ts';
import {type FinalizedFactSetType} from '../../facts/types.ts';
import {countBy, sourceLinesRepresented} from './distribution.ts';
import {m1Of, m2Of, m4Of, m6Of, m7Of, m11Of, m12Of} from './factMetrics.ts';
import {measureInvariants, type PublicationViolationExampleType} from './invariants.ts';
import {type M13ReportType, type M14ReportType, type P3ReportType, type PublicationMeasurementsType, type R1ReportType} from './types.ts';

const KIND_PRECEDENCE = ['class', 'interface', 'enum', 'namespace', 'type', 'function', 'variable', 'method', 'property', 'accessor', 'enum_member'] as const;

export type MeasurementsResultType = Readonly<{
	readonly measurements: PublicationMeasurementsType;
	readonly violationExamples: readonly PublicationViolationExampleType[];
	readonly truncatedViolations: boolean;
}>;

const m13Of = (prototype: Readonly<{unionCases: number; intersectionCases: number}> | null): M13ReportType =>
	prototype === null
		? {
				status: 'blocked',
				unionCases: 0,
				intersectionCases: 0,
				selectedSemantics: 'undecided',
				note: 'Union/intersection measurement requires the TypeScript prototype program.',
			}
		: {
				status: 'measured',
				unionCases: prototype.unionCases,
				intersectionCases: prototype.intersectionCases,
				selectedSemantics: 'constituent_reachability',
			};

const m14Of = (facts: ExtractedFactSetType, finalized: FinalizedFactSetType): M14ReportType => {
	const kindsBySymbol = new Map<string, Set<string>>();

	for (const occurrence of facts.occurrences) {
		if (occurrence.role !== 'definition' || occurrence.declarationKind === undefined) {
			continue;
		}

		const kinds = kindsBySymbol.get(occurrence.symbolId) ?? new Set<string>();
		kinds.add(occurrence.declarationKind);
		kindsBySymbol.set(occurrence.symbolId, kinds);
	}

	const merged = [...kindsBySymbol.entries()].filter(([, kinds]) => kinds.size > 1);
	const kindsets = countBy(merged.map(([, kinds]) => [...kinds].sort().join('+')));
	const currentKinds = new Map(finalized.symbols.map((symbol) => [symbol.id, symbol.kind]));
	let changes = 0;

	for (const [symbolId, kinds] of merged) {
		const current = currentKinds.get(symbolId);
		const proposed = KIND_PRECEDENCE.find((kind) => kinds.has(kind));

		if (current !== undefined && proposed !== undefined && current !== proposed) {
			changes += 1;
		}
	}

	return {
		status: facts.symbols.length === 0 ? 'blocked' : 'partial',
		mergedSymbols: merged.length,
		kindsets,
		proposedPrecedence: [...KIND_PRECEDENCE],
		kindChangesUnderProposedPrecedence: changes,
		note: 'No fixed precedence is selected; this count is the rejected illustrative effect.',
	};
};

const r1Of = (facts: ExtractedFactSetType, finalized: FinalizedFactSetType): R1ReportType => {
	const symbolsByExposureAndKind: Record<string, Record<string, number>> = {};

	for (const symbol of finalized.symbols) {
		const kinds = symbolsByExposureAndKind[symbol.exposure] ?? {};
		kinds[symbol.kind] = (kinds[symbol.kind] ?? 0) + 1;
		symbolsByExposureAndKind[symbol.exposure] = kinds;
	}

	const byOwner: Record<'null' | 'present', Record<'definition' | 'reference', number>> = {
		null: {definition: 0, reference: 0},
		present: {definition: 0, reference: 0},
	};

	for (const occurrence of facts.occurrences) {
		byOwner[occurrence.enclosingId === null ? 'null' : 'present'][occurrence.role] += 1;
	}

	return {
		status: facts.occurrences.some((occurrence) => occurrence.role === 'reference') ? 'partial' : 'measured',
		symbolsByExposureAndKind,
		occurrencesByRole: countBy(facts.occurrences.map((occurrence) => occurrence.role)),
		usageStatus: 'not_emitted',
		occurrencesByOwner: byOwner,
		sourceLinesRepresented: sourceLinesRepresented(facts.occurrences),
	};
};

/**
 * Derives the complete Phase 2 measurement set from one report-only fact run.
 *
 * The output contains aggregate counts only. Source text, symbol names, query
 * text, credentials, and absolute paths never appear in the report.
 *
 * @param input - Extracted and finalized facts plus runtime and adapter statistics.
 * @returns Measurements and bounded diagnostic examples.
 */
export const measurePublicationFacts = (
	input: Readonly<{
		readonly extractorId: string;
		readonly facts: ExtractedFactSetType;
		readonly finalized: FinalizedFactSetType;
		readonly runtimeMs: number;
		readonly peakRssBytes: number;
		readonly provisionalCeiling: number;
		readonly prototypeUnions: Readonly<{unionCases: number; intersectionCases: number}> | null;
		readonly projection: P3ReportType | null;
	}>,
): MeasurementsResultType => {
	const invariants = measureInvariants(input.facts, input.finalized, input.extractorId);

	return {
		measurements: {
			m1: m1Of(input.facts),
			m2: m2Of(input.facts.files),
			m4: m4Of(input.facts, input.finalized),
			m6: m6Of(input.projection, input.runtimeMs, input.peakRssBytes),
			m7: m7Of(input.facts.adapterStats),
			m11: m11Of(input.projection),
			m12: m12Of(input.projection, input.provisionalCeiling),
			m13: m13Of(input.prototypeUnions),
			m14: m14Of(input.facts, input.finalized),
			r1: r1Of(input.facts, input.finalized),
			r2: invariants.report,
		},
		violationExamples: invariants.examples,
		truncatedViolations: invariants.truncated,
	};
};
