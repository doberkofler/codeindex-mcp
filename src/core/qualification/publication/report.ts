import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {extractorFor} from '../../../adapters/registry.ts';
import {type ConfigType} from '../../config/config.ts';
import {finalizeFacts} from '../../facts/index.ts';
import {createPublicationDiagnostics} from './diagnostics.ts';
import {measurePublicationFacts} from './measurements.ts';
import {type ProjectionBudgetType} from './projectionModel.ts';
import {runTypeScriptPrototypes} from './typescriptPrototype.ts';
import {type PublicationDiagnosticArtifactType, type PublicationReportType} from './types.ts';

const QUERY_TELEMETRY_COUNTERS: Readonly<Record<string, number>> = {
	exact_name_no_match: 0,
	exact_name_P: 0,
	exact_name_R: 0,
	exact_name_I: 0,
	exact_name_PR: 0,
	exact_name_PI: 0,
	exact_name_RI: 0,
	exact_name_PRI: 0,
};

const peakRssBytes = (): number => process.resourceUsage().maxRSS * 1024;

const issueCountsOf = (issues: readonly Readonly<{code: string}>[]): Readonly<Record<string, number>> => {
	const counts: Record<string, number> = {};

	for (const issue of issues) {
		counts[issue.code] = (counts[issue.code] ?? 0) + 1;
	}

	return counts;
};

const limitationsOf = (extractorId: string, hasPrototypes: boolean): readonly string[] => [
	...(extractorId === 'typescript' && hasPrototypes ? [] : ['Surface projection and reachability closure are not measured for this extractor.']),
	'Occurrence usage bits are not emitted by the current fact seam.',
	'Query telemetry counters remain zero because qualification runs no model-facing queries.',
	...(hasPrototypes ? ['P-1 compares emitted root exports only; G-A2 position association remains blocked.'] : []),
	...(extractorId === 'oracle' ? ['Oracle call-spec and polymorphic-table-function classification is a source probe.'] : []),
];

const writeJson = (filePath: string, value: unknown): void => {
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8'});
};

/**
 * Builds one report-only publication qualification run.
 *
 * The run scans and extracts in memory, finalizes in report mode, runs the
 * adapter prototype pass, and returns aggregate evidence plus bounded local
 * diagnostic examples. It never opens or writes an index database and never
 * publishes a generation.
 *
 * @param input - Resolved configuration, ceilings, probe budget, and whether to run prototypes.
 * @returns Aggregate report and optional local diagnostic artifact.
 */
export const createPublicationReport = (
	input: Readonly<{
		readonly config: ConfigType;
		readonly provisionalCeiling: number;
		readonly projectionBudget: ProjectionBudgetType;
		readonly includePrototypes: boolean;
	}>,
): Readonly<{report: PublicationReportType; diagnostics: PublicationDiagnosticArtifactType}> => {
	const startedAt = performance.now();
	const extractor = extractorFor(input.config.extractorId);
	const scan = extractor.scan(input.config, []);
	const extracted = extractor.build(input.config, scan);
	const finalizationStartedAt = performance.now();
	const finalized = finalizeFacts(extracted, {mode: 'report', maxBindingsPerRoot: input.provisionalCeiling});
	const finalizationMs = Math.round(performance.now() - finalizationStartedAt);
	const prototypes =
		input.includePrototypes && input.config.extractorId === 'typescript'
			? runTypeScriptPrototypes({config: input.config, facts: extracted, finalized, budget: input.projectionBudget})
			: null;
	const totalAtMeasurement = Math.round(performance.now() - startedAt);
	const measured = measurePublicationFacts({
		extractorId: input.config.extractorId,
		facts: extracted,
		finalized,
		runtimeMs: totalAtMeasurement,
		peakRssBytes: peakRssBytes(),
		provisionalCeiling: input.provisionalCeiling,
		prototypeUnions: prototypes === null ? null : {unionCases: prototypes.unionCases, intersectionCases: prototypes.intersectionCases},
		projection: prototypes?.p3 ?? null,
	});
	const report: PublicationReportType = {
		schemaVersion: 1,
		tool: 'publication-report',
		runtime: {
			scanMs: scan.scanMs,
			compilerMs: extracted.compilerMs,
			extractionMs: extracted.extractionMs,
			finalizationMs,
			totalMs: Math.round(performance.now() - startedAt),
			peakRssBytes: peakRssBytes(),
		},
		workspace: {
			projectId: input.config.projectId,
			contexts: input.config.projects.map((context) => context.name),
			fileCount: scan.files.length,
			sourceLineCount: scan.files.reduce((total, file) => total + file.lineCount, 0),
			sourceHash: scan.sourceHash,
			configHash: scan.configHash,
			excludedFileCount: scan.excludedFileCount,
		},
		extractor: {
			id: scan.extractorId,
			version: scan.extractorVersion,
			compilerVersion: scan.compilerVersion,
			declaredCompilerVersion: scan.declaredCompilerVersion,
			compilerDrift: scan.compilerDrift,
		},
		facts: {
			files: extracted.files.length,
			symbols: extracted.symbols.length,
			occurrences: extracted.occurrences.length,
			definitions: extracted.occurrences.filter((occurrence) => occurrence.role === 'definition').length,
			references: extracted.occurrences.filter((occurrence) => occurrence.role === 'reference').length,
			bindings: extracted.bindings.length,
			bindingContexts: extracted.bindingContexts.length,
			bindingSites: extracted.bindingSites.length,
			surfaceOrigins: extracted.surfaceOrigins.length,
			dependencyEdges: extracted.dependencies.edges.length,
			dependencyBindings: extracted.dependencies.bindings.length,
		},
		exposure: {
			publishedSymbols: finalized.stats.publishedSymbols,
			reachableSymbols: finalized.stats.reachableSymbols,
			internalOnlySymbols: finalized.stats.internalOnlySymbols,
			publishedBindings: finalized.stats.publishedBindings,
			reachableBindings: finalized.stats.reachableBindings,
			internalBindings: finalized.stats.internalBindings,
		},
		measurements: measured.measurements,
		prototypes: {p1: prototypes?.p1 ?? null, p2: prototypes?.p2 ?? null, p3: prototypes?.p3 ?? null},
		issues: {total: finalized.issues.length, byCode: issueCountsOf(finalized.issues)},
		telemetry: {status: 'not_collected', counters: QUERY_TELEMETRY_COUNTERS},
		limitations: limitationsOf(input.config.extractorId, prototypes !== null),
	};
	const diagnostics = createPublicationDiagnostics({
		projectId: input.config.projectId,
		contexts: input.config.projects.map((context) => context.name),
		r2: measured.measurements.r2,
		examples: measured.violationExamples,
		truncated: measured.truncatedViolations,
	});

	return {report, diagnostics};
};

/**
 * Writes one aggregate report to a JSON path.
 *
 * @param filePath - Destination path outside the index persistence boundary.
 * @param report - Aggregate report.
 */
export const writePublicationReport = (filePath: string, report: PublicationReportType): void => {
	writeJson(filePath, report);
};

/**
 * Writes the bounded local diagnostic artifact.
 *
 * @param filePath - Destination path.
 * @param diagnostics - Diagnostic artifact containing relative paths and opaque IDs only.
 */
export const writePublicationDiagnostics = (filePath: string, diagnostics: PublicationDiagnosticArtifactType): void => {
	writeJson(filePath, diagnostics);
};

/**
 * Formats a concise human-readable summary of one report.
 *
 * @param report - Aggregate report.
 * @returns Summary lines with no names, paths, or source text.
 */
export const formatPublicationReport = (report: PublicationReportType): readonly string[] => [
	`publication report: ${report.extractor.id} (${report.workspace.projectId})`,
	`  files: ${String(report.facts.files)}; symbols: ${String(report.facts.symbols)}; occurrences: ${String(report.facts.occurrences)}`,
	`  bindings: ${String(report.facts.bindings)}; sites: ${String(report.facts.bindingSites)}; origins: ${String(report.facts.surfaceOrigins)}`,
	`  exposure: published ${String(report.exposure.publishedSymbols)}; reachable ${String(report.exposure.reachableSymbols)}; internal ${String(report.exposure.internalOnlySymbols)}`,
	`  R2 violations: S3 ${String(report.measurements.r2.s3.violations)}; O2 ${String(report.measurements.r2.o2.violations)}; L1 ${String(report.measurements.r2.l1.violations)}; F1 ${String(report.measurements.r2.f1.violations)}`,
	`  report issues: ${String(report.issues.total)}`,
	`  runtime: ${String(report.runtime.totalMs)} ms; peak RSS: ${String(report.runtime.peakRssBytes)} bytes`,
];
