import {mkdirSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {type SoakReportType} from './soakTypes.ts';

const formatMs = (value: number | null): string => (value === null ? '-' : String(value));

const latencyLine = (report: SoakReportType): string => {
	const {latency} = report;

	return `events ${String(latency.count)}, p50 ${formatMs(latency.p50Ms)} ms, p95 ${formatMs(latency.p95Ms)} ms, max ${formatMs(latency.maxMs)} ms`;
};

const gateLines = (report: SoakReportType): readonly string[] =>
	report.gates.map((gate) => `| \`${gate.id}\` | ${gate.result.toUpperCase()} | ${gate.detail} |`);

const failureLines = (report: SoakReportType): readonly string[] =>
	Object.entries(report.failureCauses).map(([cause, count]) => `| \`${cause}\` | ${String(count)} |`);

/**
 * Renders one operational soak report as sanitized Markdown.
 *
 * The document contains aggregate measurements, closed failure causes, and gate
 * results only. It never contains source text, prompts, absolute paths, or
 * hostnames.
 *
 * @param report - Complete soak report.
 * @returns GitHub-flavoured Markdown.
 */
export const soakMarkdown = (report: SoakReportType): string => {
	const lines = [
		'# Operational soak report',
		'',
		`- Plan hash: \`${report.planHash}\``,
		`- Edit script hash: \`${report.editScriptHash}\``,
		`- Profile: \`${report.workspace.profile}\` (${String(report.workspace.fileCount)} files, ${String(report.workspace.symbolCount)} symbols)`,
		`- Node: ${report.machine.nodeVersion}, platform: ${report.machine.platform}/${report.machine.arch}, CPU: ${report.machine.cpuModel}`,
		`- Builder worker: ${report.runtime.workerEntry ? 'enabled' : 'unavailable'}; watcher: enabled; analytics: ${report.runtime.analytics ? 'enabled' : 'disabled'}`,
		`- Verdict: ${report.passed ? 'pass' : 'fail'}`,
		'',
		'## Freshness',
		'',
		`- ${latencyLine(report)}`,
		`- cold build: ${String(report.coldBuild.durationMs)} ms; final freshness: ${report.freshness?.state ?? 'unknown'}`,
		`- burst overlap observed: ${report.events.some((event) => event.kind === 'burst' && event.overlappedBuild) ? 'yes' : 'no'}`,
		`- restart reuse: ${report.restarts.map((restart) => `${String(restart.reused)}/${String(restart.sameGeneration)}`).join(', ') || 'none'}`,
		'',
		'## Failures and recovery',
		'',
		`- injected failures: ${String(report.recovery.injectedFailures)}; recovered: ${String(report.recovery.recoveredFailures)}; manual interventions: ${String(report.recovery.manualInterventions)}`,
		`- stale-source refusals: ${String(report.staleRefusal?.refused === true ? 1 : 0)}`,
		'',
		'| Cause | Count |',
		'| --- | ---: |',
		...failureLines(report),
		'',
		'## Retention',
		'',
		`- declared policy: ${String(report.retention.policy.publishedGenerations)} published + ${String(report.retention.policy.supersededGenerations)} superseded generation; ${String(report.retention.policy.contentVersionsPerGeneration)} content versions per generation; ${String(report.retention.policy.extractionArtifactsPerContentVersion)} extraction artifacts per content version`,
		`- observed maxima: generations ${String(report.retention.maxima.generations)}/${String(report.retention.bounds.generations)}, content ${String(report.retention.maxima.contentVersions)}/${String(report.retention.bounds.contentVersions)}, artifacts ${String(report.retention.maxima.extractionArtifacts)}/${String(report.retention.bounds.extractionArtifacts)}`,
		`- peak database bytes: ${String(report.retention.maxima.databaseBytes)}; result: ${report.retention.satisfied ? 'bounded' : 'unbounded'}`,
		'',
		'## Gates',
		'',
		'| Gate | Result | Detail |',
		'| --- | --- | --- |',
		...gateLines(report),
		'',
	];

	return lines.join('\n');
};

/**
 * Writes one soak report atomically.
 *
 * @param report - Complete soak report.
 * @param outputPath - Destination JSON path.
 */
export const writeSoakReport = (report: SoakReportType, outputPath: string): void => {
	mkdirSync(path.dirname(outputPath), {recursive: true});
	const temporaryPath = `${outputPath}.tmp`;

	writeFileSync(temporaryPath, `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
	renameSync(temporaryPath, outputPath);
};

/**
 * Writes the sanitized Markdown summary for one report.
 *
 * @param report - Complete soak report.
 * @param markdownPath - Destination Markdown path.
 */
export const writeSoakMarkdown = (report: SoakReportType, markdownPath: string): void => {
	mkdirSync(path.dirname(markdownPath), {recursive: true});
	writeFileSync(markdownPath, soakMarkdown(report), 'utf8');
};
