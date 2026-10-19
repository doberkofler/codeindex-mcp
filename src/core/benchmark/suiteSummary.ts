import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {type SuiteManifestType, type SuiteStepResultType} from './suiteManifest.ts';

const EvaluationSummarySchema = z.object({
	status: z.enum(['pass', 'warning', 'failure']),
	summary: z.object({
		pass: z.number(),
		warning: z.number(),
		failure: z.number(),
		skipped: z.number(),
	}),
});

const ReportSummarySchema = z.object({
	workspace: z.object({
		kind: z.enum(['generated', 'external']),
		profile: z.string().nullable(),
		fileCount: z.number(),
		symbolCount: z.number(),
		occurrenceCount: z.number(),
	}),
	scenarios: z.array(
		z.object({
			name: z.string(),
			kind: z.string(),
			wallMs: z.number(),
			resources: z.object({rssPeakBytes: z.number()}),
			storage: z.object({totalBytes: z.number()}),
			percentiles: z.object({p95Ms: z.number().nullable()}).optional(),
		}),
	),
	queries: z.record(z.string(), z.object({p95Ms: z.number().nullable()})),
});

const ReferenceSummarySchema = z.object({
	accuracy: z.object({
		expected: z.number(),
		matched: z.number(),
		recall: z.number(),
		precision: z.number(),
	}),
	gate: z.object({
		ok: z.boolean(),
		failures: z.array(z.object({detail: z.string()})),
	}),
});

const readArtifact = <SchemaType extends z.ZodType>(filePath: string, schema: SchemaType): z.infer<SchemaType> | null => {
	try {
		const parsed = schema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

const cell = (value: string): string => value.replaceAll('|', String.raw`\|`).replaceAll('\n', ' ');
const formatMs = (value: number | null): string => (value === null ? '-' : `${value.toFixed(1)} ms`);
const formatBytes = (value: number): string =>
	value >= 1024 * 1024 * 1024 ? `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB` : `${(value / (1024 * 1024)).toFixed(1)} MiB`;

const stepSection = (steps: readonly SuiteStepResultType[]): string => {
	const rows = steps.map(
		(step) =>
			`| ${step.id} | ${step.kind} | ${step.status} | ${String(step.exitCode)} | ${(step.durationMs / 1000).toFixed(1)} s | ${step.detail === null ? '-' : cell(step.detail)} |`,
	);

	return ['## Steps', '', '| Step | Kind | Status | Exit | Duration | Detail |', '| --- | --- | --- | ---: | ---: | --- |', ...rows].join('\n');
};

const evaluationRow = (input: Readonly<{stepId: string; outputDir: string; artifact: string}>): string | null => {
	const filePath = path.resolve(input.outputDir, input.artifact);

	if (!existsSync(filePath)) {
		return null;
	}

	const evaluation = readArtifact(filePath, EvaluationSummarySchema);

	if (evaluation === null) {
		return null;
	}

	return `| ${input.stepId} | ${evaluation.status} | ${String(evaluation.summary.pass)} | ${String(evaluation.summary.warning)} | ${String(evaluation.summary.failure)} | ${String(evaluation.summary.skipped)} |`;
};

const gateSection = (input: Readonly<{outputDir: string; steps: readonly SuiteStepResultType[]}>): string => {
	const rows = input.steps.flatMap((step) =>
		step.artifacts.flatMap((artifact) => {
			if (!artifact.endsWith('.evaluation.json')) {
				return [];
			}

			const row = evaluationRow({stepId: step.id, outputDir: input.outputDir, artifact});
			return row === null ? [] : [row];
		}),
	);

	if (rows.length === 0) {
		return ['## Gates', '', 'No evaluation sidecars were produced.'].join('\n');
	}

	return ['## Gates', '', '| Step | Status | Pass | Warning | Failure | Skipped |', '| --- | --- | ---: | ---: | ---: | ---: |', ...rows].join('\n');
};

const metricBlock = (input: Readonly<{stepId: string; report: z.infer<typeof ReportSummarySchema>}>): string => {
	const scenarioRows = input.report.scenarios.map(
		(scenario) =>
			`| ${scenario.name} | ${scenario.kind} | ${String(scenario.wallMs)} ms | ${formatMs(scenario.percentiles?.p95Ms ?? null)} | ${formatBytes(scenario.resources.rssPeakBytes)} | ${formatBytes(scenario.storage.totalBytes)} |`,
	);
	const queryRows = Object.entries(input.report.queries).map(([name, percentile]) => `| ${name} | ${formatMs(percentile.p95Ms)} |`);

	return [
		`### ${input.stepId}`,
		'',
		`- Workspace: ${input.report.workspace.kind}/${input.report.workspace.profile ?? 'external'}, ${String(input.report.workspace.fileCount)} files, ${String(input.report.workspace.symbolCount)} symbols, ${String(input.report.workspace.occurrenceCount)} occurrences`,
		'',
		'| Scenario | Kind | Wall | P95 | RSS peak | Database |',
		'| --- | --- | ---: | ---: | ---: | ---: |',
		...scenarioRows,
		'',
		...(queryRows.length === 0 ? [] : ['| Query | p95 |', '| --- | ---: |', ...queryRows, '']),
	].join('\n');
};

const metricsSection = (input: Readonly<{outputDir: string; steps: readonly SuiteStepResultType[]}>): string => {
	const blocks = input.steps.flatMap((step) =>
		step.artifacts.flatMap((artifact) => {
			if (!artifact.endsWith('.json') || artifact.endsWith('.evaluation.json') || step.kind === 'reference') {
				return [];
			}

			const filePath = path.resolve(input.outputDir, artifact);

			if (!existsSync(filePath)) {
				return [];
			}

			const parsed = ReportSummarySchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);

			return parsed.success ? [metricBlock({stepId: step.id, report: parsed.data})] : [];
		}),
	);

	return blocks.length === 0 ? ['## Measurements', '', 'No reports were produced.'].join('\n') : ['## Measurements', '', ...blocks].join('\n');
};

const referenceSection = (input: Readonly<{outputDir: string; steps: readonly SuiteStepResultType[]}>): string => {
	const step = input.steps.find((candidate) => candidate.kind === 'reference');
	const artifact = step?.artifacts.at(0);

	if (step === undefined || artifact === undefined || !existsSync(path.resolve(input.outputDir, artifact))) {
		return ['## Reference verification', '', 'Not run.'].join('\n');
	}

	const reference = readArtifact(path.resolve(input.outputDir, artifact), ReferenceSummarySchema);

	if (reference === null) {
		return ['## Reference verification', '', 'The report could not be parsed.'].join('\n');
	}

	const failures = reference.gate.failures.map((failure) => `- ${failure.detail}`);

	return [
		'## Reference verification',
		'',
		`- Gate: **${reference.gate.ok ? 'PASS' : 'FAIL'}**`,
		`- Recall: ${(reference.accuracy.recall * 100).toFixed(2)}% (${String(reference.accuracy.matched)}/${String(reference.accuracy.expected)})`,
		`- Precision: ${(reference.accuracy.precision * 100).toFixed(2)}%`,
		'',
		...(failures.length === 0 ? [] : ['Failures:', '', ...failures, '']),
	].join('\n');
};

const projectSection = (manifest: SuiteManifestType): readonly string[] =>
	manifest.projects.length === 0
		? []
		: [
				'## Public projects',
				'',
				'| Project | Revision | Lockfile |',
				'| --- | --- | --- |',
				...manifest.projects.map((project) => `| ${project.name} | ${project.revision} | ${project.lockfileSha256 ?? '-'} |`),
				'',
			];

/**
 * Builds the aggregate Markdown summary.
 *
 * @param input - Completed manifest and evidence directory.
 * @returns GitHub-flavoured Markdown.
 */
export const buildSuiteSummary = (input: Readonly<{manifest: SuiteManifestType; outputDir: string}>): string => {
	const {identity} = input.manifest;

	return [
		`# Benchmark suite: ${input.manifest.suite.id}`,
		'',
		`- Status: **${input.manifest.status.toUpperCase()}**`,
		`- Suite: ${input.manifest.suite.path} (${input.manifest.suite.sha256})`,
		`- Started: ${input.manifest.startedAt}`,
		`- Completed: ${input.manifest.completedAt ?? '-'}`,
		`- CodeIndex: ${identity.commit}${identity.dirty ? ' (dirty)' : ''}, CLI ${identity.cliSha256}`,
		`- Version: ${identity.version}`,
		`- Machine: ${identity.platform}/${identity.arch}, ${identity.cpuModel}, ${(identity.totalMemoryBytes / (1024 * 1024 * 1024)).toFixed(0)} GiB`,
		`- Runtime: Node ${identity.nodeVersion}, SQLite ${identity.sqliteVersion}`,
		'',
		...projectSection(input.manifest),
		stepSection(input.manifest.steps),
		'',
		gateSection({outputDir: input.outputDir, steps: input.manifest.steps}),
		'',
		referenceSection({outputDir: input.outputDir, steps: input.manifest.steps}),
		'',
		metricsSection({outputDir: input.outputDir, steps: input.manifest.steps}),
		'',
		'## Notes',
		'',
		'- Reports and evaluation sidecars are authoritative; this summary is derived.',
		'- Generated corpora and databases are removed after a successful run unless `--keep-workspace` is set.',
		'- Public projects are pinned checkouts prepared outside the measured interval; they are never mutated.',
		'',
	].join('\n');
};
