import {measurePublicationInvariants, type PublicationInvariantReportType, type PublicationInvariantViolationType} from '../../facts/measuredInvariants.ts';
import {type ExtractedFactSetType} from '../../facts/index.ts';
import {type FinalizedFactSetType} from '../../facts/types.ts';
import {type R2ReportType, type ViolationSummaryType} from './types.ts';

const MAX_VIOLATION_EXAMPLES = 200;

export type PublicationViolationExampleType = Readonly<{
	readonly invariant: 'S3' | 'O2' | 'L1' | 'F1';
	readonly class: string;
	readonly path: string;
	readonly startOffset: number;
	readonly symbolId: string;
	readonly bindingId: string | null;
}>;

const classesOf = (violations: readonly PublicationInvariantViolationType[]): Readonly<Record<string, number>> => {
	const classes: Record<string, number> = {};

	for (const violation of violations) {
		classes[violation.class] = (classes[violation.class] ?? 0) + 1;
	}

	return classes;
};

const summaryOf = (report: PublicationInvariantReportType[keyof PublicationInvariantReportType]): ViolationSummaryType => ({
	status: 'measured',
	checked: report.checked,
	violations: report.violations.length,
	classes: classesOf(report.violations),
	...(report.note === undefined ? {} : {note: report.note}),
});

const examplesOf = (report: PublicationInvariantReportType): PublicationViolationExampleType[] =>
	[report.s3, report.o2, report.l1, report.f1].flatMap((summary) => summary.violations).slice(0, MAX_VIOLATION_EXAMPLES);

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
	const measured = measurePublicationInvariants(facts, finalized, extractorId);
	const total = measured.s3.violations.length + measured.o2.violations.length + measured.l1.violations.length + measured.f1.violations.length;

	return {
		report: {status: 'measured', s3: summaryOf(measured.s3), o2: summaryOf(measured.o2), l1: summaryOf(measured.l1), f1: summaryOf(measured.f1)},
		examples: examplesOf(measured),
		truncated: total > MAX_VIOLATION_EXAMPLES,
	};
};
