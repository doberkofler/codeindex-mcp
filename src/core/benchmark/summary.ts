import {type BenchmarkReportType, type BenchmarkScenarioResultType} from './benchTypes.ts';
import {type BenchmarkEvaluationType, type BenchmarkGateType} from './evaluationTypes.ts';

type CellValueType = number | string | boolean | null;

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const cell = (value: CellValueType): string => {
	if (value === null) {
		return '-';
	}

	return String(value)
		.replaceAll('|', String.raw`\|`)
		.replaceAll('\n', ' ');
};

const formatMs = (value: number | null): string => (value === null ? '-' : `${value.toFixed(1)} ms`);

const formatBytes = (value: number): string => {
	if (value >= GIB) {
		return `${(value / GIB).toFixed(2)} GiB`;
	}

	if (value >= MIB) {
		return `${(value / MIB).toFixed(2)} MiB`;
	}

	if (value >= KIB) {
		return `${(value / KIB).toFixed(1)} KiB`;
	}

	return `${String(value)} B`;
};

const formatPercent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const gateValue = (entry: BenchmarkGateType, value: CellValueType): string => {
	const rendered = cell(value);

	if (entry.unit === null || value === null) {
		return rendered;
	}

	if (entry.unit === 'bytes') {
		return typeof value === 'number' ? formatBytes(value) : rendered;
	}

	if (entry.unit === 'ratio') {
		return typeof value === 'number' ? formatPercent(value) : rendered;
	}

	if (entry.unit === 'count') {
		return rendered;
	}

	return `${rendered} ${entry.unit}`;
};

const evaluationSection = (evaluation: BenchmarkEvaluationType | null): string => {
	if (evaluation === null) {
		return ['## Gates', '', 'No baseline supplied; no gates were evaluated.'].join('\n');
	}

	const header = `**${evaluation.status.toUpperCase()}** — ${String(evaluation.summary.pass)} pass, ${String(evaluation.summary.warning)} warning, ${String(evaluation.summary.failure)} failure, ${String(evaluation.summary.skipped)} skipped`;
	const rows = evaluation.gates.map(
		(entry) => `| ${entry.status} | ${cell(entry.code)} | ${gateValue(entry, entry.actual)} | ${gateValue(entry, entry.expected)} | ${cell(entry.message)} |`,
	);

	return ['## Gates', '', header, '', '| Status | Gate | Actual | Expected | Detail |', '| --- | --- | ---: | ---: | --- |', ...rows].join('\n');
};

const scenarioLatency = (scenario: BenchmarkScenarioResultType): string => {
	if (scenario.kind === 'edit') {
		return formatMs(scenario.percentiles.p95Ms);
	}

	if (scenario.kind === 'cursor') {
		return formatMs(scenario.samples.length === 0 ? null : Math.max(...scenario.samples.map((sample) => sample.elapsedMs)));
	}

	return '-';
};

const scenarioReuse = (scenario: BenchmarkScenarioResultType): string => (scenario.kind === 'cursor' ? '-' : formatPercent(scenario.reuse.contentReuseRatio));

const scenarioSection = (report: BenchmarkReportType): string => {
	const rows = report.scenarios.map(
		(scenario) =>
			`| ${scenario.name} | ${scenario.kind} | ${String(scenario.wallMs)} ms | ${scenarioLatency(scenario)} | ${formatBytes(scenario.resources.rssPeakBytes)} | ${formatBytes(scenario.storage.totalBytes)} | ${scenarioReuse(scenario)} |`,
	);

	return [
		'## Scenarios',
		'',
		'| Scenario | Kind | Wall | P95 / max | RSS peak | Database | Content reuse |',
		'| --- | --- | ---: | ---: | ---: | ---: | ---: |',
		...rows,
	].join('\n');
};

const querySection = (report: BenchmarkReportType): string => {
	const rows = Object.entries(report.queries).map(
		([name, percentile]) =>
			`| ${name} | ${String(percentile.count)} | ${formatMs(percentile.p50Ms)} | ${formatMs(percentile.p95Ms)} | ${formatMs(percentile.p99Ms)} | ${formatMs(percentile.maxMs)} |`,
	);

	return [
		'## Queries',
		'',
		rows.length === 0 ? 'No query samples were recorded.' : '| Query | Count | p50 | p95 | p99 | max |',
		...(rows.length === 0 ? [] : ['| --- | ---: | ---: | ---: | ---: | ---: |', ...rows]),
	].join('\n');
};

/**
 * Builds a GitHub-flavoured Markdown summary.
 *
 * The JSON report remains authoritative; this summary is derived from it and
 * from the optional evaluation sidecar.
 *
 * @param report - Completed benchmark report.
 * @param evaluation - Gate evaluation, or null when no baseline was supplied.
 * @returns Markdown document ending with a newline.
 */
export const buildBenchmarkSummary = (report: BenchmarkReportType, evaluation: BenchmarkEvaluationType | null): string => {
	const workspace = report.workspace.profile === null ? report.workspace.kind : `${report.workspace.kind}/${report.workspace.profile}`;
	const sections = [
		'# Code index benchmark',
		'',
		`- Generated: ${report.generatedAt}`,
		`- Workspace: ${workspace}, ${String(report.workspace.fileCount)} files, ${String(report.workspace.symbolCount)} symbols, ${String(report.workspace.occurrenceCount)} occurrences`,
		`- Machine: ${report.machine.platform}/${report.machine.arch}`,
		`- Runtime: worker entry ${report.runtime.workerEntry ? 'enabled' : 'disabled'}; scenarios in one process`,
		'',
		evaluationSection(evaluation),
		'',
		scenarioSection(report),
		'',
		querySection(report),
		'',
		'## Notes',
		'',
		'Extraction artifacts are measured but not consumed; a zero artifact-reuse ratio is expected until artifact consumption is implemented.',
		'',
	];

	return sections.join('\n');
};
