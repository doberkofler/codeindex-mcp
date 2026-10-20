import {type ExtractedFactSetType, type ExtractedOccurrenceType} from '../../facts/index.ts';
import {type FinalizedFactSetType} from '../../facts/types.ts';
import {type R2ReportType, type ViolationSummaryType} from './types.ts';

const MAX_VIOLATION_EXAMPLES = 200;
const ROUTINE_KINDS = new Set(['procedure', 'function', 'cursor']);

export type PublicationViolationExampleType = Readonly<{
	readonly invariant: 'S3' | 'O2' | 'L1' | 'F1';
	readonly class: string;
	readonly path: string;
	readonly startOffset: number;
	readonly symbolId: string;
	readonly bindingId: string | null;
}>;

type ViolationCollectorType = {
	readonly classes: Record<string, number>;
	readonly examples: PublicationViolationExampleType[];
	truncated: boolean;
};

type IntervalType = Readonly<{
	readonly symbolId: string;
	readonly path: string;
	readonly startOffset: number;
	readonly endOffset: number;
}>;

const violationCollector = (): ViolationCollectorType => ({classes: {}, examples: [], truncated: false});

const addViolation = (
	collector: ViolationCollectorType,
	input: Readonly<{
		invariant: 'S3' | 'O2' | 'L1' | 'F1';
		class: string;
		path: string;
		startOffset: number;
		symbolId: string;
		bindingId?: string | null;
	}>,
): void => {
	collector.classes[input.class] = (collector.classes[input.class] ?? 0) + 1;

	if (collector.examples.length < MAX_VIOLATION_EXAMPLES) {
		collector.examples.push({
			invariant: input.invariant,
			class: input.class,
			path: input.path,
			startOffset: input.startOffset,
			symbolId: input.symbolId,
			bindingId: input.bindingId ?? null,
		});
	} else {
		collector.truncated = true;
	}
};

const summaryOf = (collector: ViolationCollectorType, checked: number, note?: string): ViolationSummaryType => ({
	status: 'measured',
	checked,
	violations: Object.values(collector.classes).reduce((total, value) => total + value, 0),
	classes: collector.classes,
	...(note === undefined ? {} : {note}),
});

type SymbolIntervalsType = ReadonlyMap<string, readonly IntervalType[]>;

const definitionIntervals = (facts: ExtractedFactSetType, finalized: FinalizedFactSetType): readonly IntervalType[] => {
	const symbols = new Map(finalized.symbols.map((symbol) => [symbol.id, symbol]));
	const intervals: IntervalType[] = [];

	for (const occurrence of facts.occurrences) {
		if (occurrence.role !== 'definition') {
			continue;
		}

		const {extent} = occurrence;
		const symbol = symbols.get(occurrence.symbolId);

		intervals.push({
			symbolId: occurrence.symbolId,
			path: occurrence.path,
			startOffset: extent?.startOffset ?? occurrence.startOffset,
			endOffset: extent?.endOffset ?? symbol?.endOffset ?? occurrence.endOffset,
		});
	}

	return intervals;
};

const intervalsBySymbol = (facts: ExtractedFactSetType, finalized: FinalizedFactSetType): SymbolIntervalsType => {
	const map = new Map<string, IntervalType[]>();

	for (const interval of definitionIntervals(facts, finalized)) {
		const intervals = map.get(interval.symbolId) ?? [];
		intervals.push(interval);
		map.set(interval.symbolId, intervals);
	}

	return map;
};

const symbolIntervalsOf = (symbol: ExtractedFactSetType['symbols'][number], intervals: SymbolIntervalsType): readonly IntervalType[] => {
	const definitions = intervals.get(symbol.id);

	return definitions === undefined || definitions.length === 0
		? [{symbolId: symbol.id, path: symbol.path, startOffset: symbol.startOffset, endOffset: symbol.endOffset}]
		: definitions;
};

const s3Of = (
	facts: ExtractedFactSetType,
	finalized: FinalizedFactSetType,
): Readonly<{summary: ViolationSummaryType; examples: PublicationViolationExampleType[]; truncated: boolean}> => {
	const collector = violationCollector();
	const symbols = new Map(finalized.symbols.map((symbol) => [symbol.id, symbol]));
	const intervals = intervalsBySymbol(facts, finalized);

	for (const symbol of finalized.symbols) {
		if (symbol.enclosingId === null) {
			continue;
		}

		const parent = symbols.get(symbol.enclosingId);

		if (parent === undefined) {
			addViolation(collector, {invariant: 'S3', class: 'missing_enclosing', path: symbol.path, startOffset: symbol.startOffset, symbolId: symbol.id});
			continue;
		}

		const parentIntervals = symbolIntervalsOf(parent, intervals);

		for (const child of symbolIntervalsOf(symbol, intervals)) {
			const samePath = parentIntervals.filter((interval) => interval.path === child.path);

			if (samePath.length === 0) {
				addViolation(collector, {invariant: 'S3', class: 'path_mismatch', path: child.path, startOffset: child.startOffset, symbolId: symbol.id});
				continue;
			}

			if (!samePath.some((interval) => interval.startOffset <= child.startOffset && interval.endOffset >= child.endOffset)) {
				addViolation(collector, {invariant: 'S3', class: 'outside_parent_extent', path: child.path, startOffset: child.startOffset, symbolId: symbol.id});
			}
		}
	}

	for (const symbol of finalized.symbols) {
		const seen = new Set<string>();
		let current: string | null = symbol.id;

		while (current !== null && !seen.has(current)) {
			seen.add(current);
			current = symbols.get(current)?.enclosingId ?? null;
		}

		if (current !== null) {
			addViolation(collector, {invariant: 'S3', class: 'enclosing_cycle', path: symbol.path, startOffset: symbol.startOffset, symbolId: symbol.id});
		}
	}

	return {summary: summaryOf(collector, finalized.symbols.length), examples: collector.examples, truncated: collector.truncated};
};

const containingIntervals = (byPath: ReadonlyMap<string, readonly IntervalType[]>, occurrence: ExtractedOccurrenceType): readonly IntervalType[] =>
	(byPath.get(occurrence.path) ?? []).filter(
		(candidate) =>
			candidate.startOffset <= occurrence.startOffset &&
			candidate.endOffset >= occurrence.endOffset &&
			(occurrence.role !== 'definition' || candidate.symbolId !== occurrence.symbolId),
	);

const innermostIntervals = (candidates: readonly IntervalType[]): readonly IntervalType[] => {
	let minimumSpan = Number.MAX_SAFE_INTEGER;
	let innermost: IntervalType[] = [];

	for (const candidate of candidates) {
		const span = candidate.endOffset - candidate.startOffset;

		if (span < minimumSpan) {
			minimumSpan = span;
			innermost = [candidate];
		} else if (span === minimumSpan) {
			innermost.push(candidate);
		}
	}

	return innermost;
};

const o2Class = (occurrence: ExtractedOccurrenceType, expected: string | null, expectedKind: string | null): string | null => {
	if (occurrence.role === 'definition') {
		return occurrence.enclosingId === expected ? null : 'definition_owner_mismatch';
	}

	if (occurrence.enclosingId === expected) {
		return null;
	}

	if (expected === null) {
		return 'spurious_owner';
	}

	if (occurrence.enclosingId === null) {
		return 'missing_owner';
	}

	return expectedKind === 'parameter' ? 'parameter_type_reference_owner' : 'wrong_owner';
};

const o2Of = (
	facts: ExtractedFactSetType,
	finalized: FinalizedFactSetType,
): Readonly<{summary: ViolationSummaryType; examples: PublicationViolationExampleType[]; truncated: boolean}> => {
	const collector = violationCollector();
	const symbols = new Map(finalized.symbols.map((symbol) => [symbol.id, symbol]));
	const byPath = new Map<string, IntervalType[]>();
	const seen = new Set<string>();

	for (const interval of definitionIntervals(facts, finalized)) {
		const identity = `${interval.symbolId}\u0000${interval.path}\u0000${String(interval.startOffset)}\u0000${String(interval.endOffset)}`;

		if (seen.has(identity)) {
			continue;
		}

		seen.add(identity);
		const intervals = byPath.get(interval.path) ?? [];
		intervals.push(interval);
		byPath.set(interval.path, intervals);
	}

	for (const occurrence of facts.occurrences) {
		const innermost = innermostIntervals(containingIntervals(byPath, occurrence));

		if (innermost.length > 1) {
			addViolation(collector, {
				invariant: 'O2',
				class: 'ambiguous_innermost',
				path: occurrence.path,
				startOffset: occurrence.startOffset,
				symbolId: occurrence.symbolId,
			});
			continue;
		}

		const expectedId = innermost[0]?.symbolId ?? null;
		const violationClass = o2Class(occurrence, expectedId, expectedId === null ? null : (symbols.get(expectedId)?.kind ?? null));

		if (violationClass !== null) {
			addViolation(collector, {
				invariant: 'O2',
				class: violationClass,
				path: occurrence.path,
				startOffset: occurrence.startOffset,
				symbolId: occurrence.symbolId,
			});
		}

		if (occurrence.role === 'definition' && symbols.get(occurrence.symbolId)?.enclosingId !== occurrence.enclosingId) {
			addViolation(collector, {
				invariant: 'O2',
				class: 'definition_enclosing_mismatch',
				path: occurrence.path,
				startOffset: occurrence.startOffset,
				symbolId: occurrence.symbolId,
			});
		}
	}

	return {
		summary: summaryOf(collector, facts.occurrences.length, 'Definition extents are used where emitted; otherwise the primary symbol extent is the fallback.'),
		examples: collector.examples,
		truncated: collector.truncated,
	};
};

const compareL1 = (collector: ViolationCollectorType, interval: IntervalType, candidate: IntervalType): void => {
	if (candidate.symbolId === interval.symbolId) {
		return;
	}

	if (candidate.startOffset === interval.startOffset && candidate.endOffset === interval.endOffset) {
		addViolation(collector, {
			invariant: 'L1',
			class: 'identical_extent',
			path: interval.path,
			startOffset: interval.startOffset,
			symbolId: interval.symbolId,
		});
		return;
	}

	if (candidate.startOffset < interval.startOffset && interval.endOffset > candidate.endOffset) {
		addViolation(collector, {
			invariant: 'L1',
			class: 'crossing_extent',
			path: interval.path,
			startOffset: interval.startOffset,
			symbolId: interval.symbolId,
		});
	}
};

const l1Of = (
	facts: ExtractedFactSetType,
	finalized: FinalizedFactSetType,
): Readonly<{summary: ViolationSummaryType; examples: PublicationViolationExampleType[]; truncated: boolean}> => {
	const collector = violationCollector();
	const intervals = definitionIntervals(facts, finalized);
	const byPath = new Map<string, IntervalType[]>();

	for (const interval of intervals) {
		const group = byPath.get(interval.path) ?? [];
		group.push(interval);
		byPath.set(interval.path, group);
	}

	for (const group of byPath.values()) {
		const sorted = [...group].sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset);
		let active: IntervalType[] = [];

		for (const interval of sorted) {
			active = active.filter((candidate) => candidate.endOffset >= interval.startOffset);

			for (const candidate of active) {
				compareL1(collector, interval, candidate);
			}

			active.push(interval);
		}
	}

	return {summary: summaryOf(collector, intervals.length), examples: collector.examples, truncated: collector.truncated};
};

const f1Of = (
	facts: ExtractedFactSetType,
	extractorId: string,
): Readonly<{summary: ViolationSummaryType; examples: PublicationViolationExampleType[]; truncated: boolean}> => {
	const collector = violationCollector();
	const groups = new Map<string, ExtractedOccurrenceType[]>();

	for (const occurrence of facts.occurrences) {
		if (occurrence.role !== 'definition' || occurrence.declarationKind === undefined) {
			continue;
		}

		const relevant = extractorId === 'oracle' ? ROUTINE_KINDS.has(occurrence.declarationKind) : occurrence.declarationKind === 'function';

		if (!relevant) {
			continue;
		}

		const key = `${occurrence.symbolId}\u0000${occurrence.declarationKind}`;
		const group = groups.get(key) ?? [];
		group.push(occurrence);
		groups.set(key, group);
	}

	for (const group of groups.values()) {
		const forward = group.filter((occurrence) => occurrence.forwardDefinition === true).length;
		const full = group.length - forward;
		const [first] = group;

		if (first === undefined) {
			continue;
		}

		const violationClass =
			extractorId === 'oracle' ? (forward > 1 ? 'multiple_forward' : full > 1 ? 'multiple_full' : null) : full > 1 ? 'multiple_implementations' : null;

		if (violationClass !== null) {
			addViolation(collector, {
				invariant: 'F1',
				class: violationClass,
				path: first.path,
				startOffset: first.startOffset,
				symbolId: first.symbolId,
			});
		}
	}

	return {summary: summaryOf(collector, groups.size), examples: collector.examples, truncated: collector.truncated};
};

/**
 * Runs measured invariants S3, O2, L1, and F1.
 *
 * @param facts - Extracted facts.
 * @param finalized - Finalized facts.
 * @param extractorId - Adapter identity.
 * @returns R2 report and bounded examples.
 */
export const measureInvariants = (
	facts: ExtractedFactSetType,
	finalized: FinalizedFactSetType,
	extractorId: string,
): Readonly<{report: R2ReportType; examples: PublicationViolationExampleType[]; truncated: boolean}> => {
	const s3 = s3Of(facts, finalized);
	const o2 = o2Of(facts, finalized);
	const l1 = l1Of(facts, finalized);
	const f1 = f1Of(facts, extractorId);

	return {
		report: {status: 'measured', s3: s3.summary, o2: o2.summary, l1: l1.summary, f1: f1.summary},
		examples: [...s3.examples, ...o2.examples, ...l1.examples, ...f1.examples],
		truncated: s3.truncated || o2.truncated || l1.truncated || f1.truncated,
	};
};
