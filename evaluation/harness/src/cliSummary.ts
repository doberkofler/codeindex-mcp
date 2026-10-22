import {type compare} from './report.ts';
import {type RunResultType} from './runTypes.ts';

// Writes the human-readable paired-report summary.
export const printSummary = (runDir: string, results: readonly RunResultType[], comparison: ReturnType<typeof compare>): void => {
	process.stdout.write(`results ${runDir}\n`);
	process.stdout.write(
		`report ${comparison.campaign.campaignId} schema=${comparison.schemaVersion} suite=${comparison.campaign.suite.id}@${comparison.campaign.suite.version} claim=${comparison.campaign.claimClass}\n`,
	);
	process.stdout.write(`runs ${results.length}, valid ${results.filter((run) => run.valid).length}, sources ${comparison.sources.identityDigests.length}\n`);

	for (const [name, summary] of [
		['no-index', comparison.noIndex],
		['accepted', comparison.accepted],
		['candidate', comparison.candidate],
	] as const) {
		const {tokens} = summary.statistics;
		const tokenText = tokens.state === 'exact' ? tokens.median.toFixed(0) : tokens.state;

		process.stdout.write(
			`${name.padEnd(9)} success ${(summary.successRate * 100).toFixed(1)}%  index-use ${(summary.indexUsageRate * 100).toFixed(0)}%  tokens ${tokenText} (n=${tokens.sampleCount})  calls ${summary.medianToolCalls.toFixed(1)}  bytes ${summary.medianOutputBytes.toFixed(0)}  p95 ${(summary.p95WallMs / 1000).toFixed(1)}s (n=${summary.statistics.wallTimeMs.sampleCount})  invalid ${summary.invalidRuns}  retried ${summary.retriedRuns}  execute ${summary.executeRuns}  unknown ${summary.unknownToolRuns}\n`,
		);
	}

	for (const threshold of comparison.thresholds) {
		process.stdout.write(`${threshold.passed ? 'PASS' : 'FAIL'} ${threshold.name} (${threshold.detail})\n`);
	}

	for (const report of comparison.classes) {
		process.stdout.write(
			`class ${report.class.padEnd(14)} cases ${report.caseIds.length}  candidate success ${(report.candidate.successRate * 100).toFixed(1)}%  bytes ${report.candidate.statistics.retrievalBytes.median.toFixed(0)}  calls ${report.candidate.statistics.toolCalls.median.toFixed(1)}  p95 ${(report.candidate.statistics.wallTimeMs.p95 / 1000).toFixed(1)}s (n=${report.candidate.statistics.wallTimeMs.sampleCount})  ${report.passed ? 'PASS' : 'NOT PASSED'}\n`,
		);
	}

	process.stdout.write(`Q2 ${comparison.passed ? 'PASSED' : 'NOT PASSED'}\n`);
};
