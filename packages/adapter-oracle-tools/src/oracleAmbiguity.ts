import {createHash} from 'node:crypto';
import {ORACLE_QUALIFICATION_CONTRACT} from './oracleQualificationContract.ts';
import {type OracleCallTruthType} from './oracleTruth.ts';
import {positionKeyOf} from './oracleTruthExclusions.ts';

export type OracleAmbiguityReportType = Readonly<{
	diagnostics: number;
	ambiguousCalls: number;
	rawCalls: number;
	excludedCalls: number;
	rate: number;
	unmatchedDiagnostics: number;
	rawPopulationSha256: string;
	excludedPopulationSha256: string;
	byCallee: readonly Readonly<{callee: string; count: number}>[];
	budget: Readonly<{maximumCount: number; maximumRate: number}>;
}>;

const callKeyOf = (call: OracleCallTruthType): string => JSON.stringify([call.path, call.line, call.column, call.name.toLowerCase(), call.signature]);

const populationHashOf = (calls: readonly OracleCallTruthType[]): string =>
	createHash('sha256')
		.update(
			[...calls]
				.map((call) => callKeyOf(call))
				.sort((left, right) => left.localeCompare(right))
				.join('\n'),
		)
		.digest('hex');

/**
 * Builds the ambiguity gate evidence from raw PL/Scope CALL rows.
 *
 * The raw hash excludes policy decisions, so adding exclusions cannot reduce or
 * otherwise rewrite the pinned population.
 *
 * @param calls - Raw mapped CALL rows with exact signatures.
 * @param diagnosticPositions - Exact positions of emitted ambiguity diagnostics.
 * @returns Aggregate evidence and the frozen contract budget.
 */
export const oracleAmbiguityReportOf = (calls: readonly OracleCallTruthType[], diagnosticPositions: ReadonlySet<string>): OracleAmbiguityReportType => {
	const excluded = calls.filter((call) => call.excluded);
	const rawPositions = new Set(calls.map((call) => positionKeyOf(call)));
	const byCallee = new Map<string, number>();

	for (const call of excluded) {
		const callee = call.name.toLowerCase();
		byCallee.set(callee, (byCallee.get(callee) ?? 0) + 1);
	}

	const diagnostics = diagnosticPositions.size;
	const rawCalls = calls.length;
	const {maximumCount, maximumRate} = ORACLE_QUALIFICATION_CONTRACT.ambiguity.budget;

	return {
		diagnostics,
		ambiguousCalls: excluded.length,
		rawCalls,
		excludedCalls: excluded.length,
		rate: rawCalls === 0 ? (diagnostics === 0 ? 0 : 1) : diagnostics / rawCalls,
		unmatchedDiagnostics: [...diagnosticPositions].filter((position) => !rawPositions.has(position)).length,
		rawPopulationSha256: populationHashOf(calls),
		excludedPopulationSha256: populationHashOf(excluded),
		byCallee: [...byCallee].map(([callee, count]) => ({callee, count})).sort((left, right) => left.callee.localeCompare(right.callee)),
		budget: {
			maximumCount,
			maximumRate: rawCalls === 0 ? 0 : maximumRate.numerator / rawCalls,
		},
	};
};
