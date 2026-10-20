import {readFileSync} from 'node:fs';
import path from 'node:path';
import {type AdapterStatType, type ExtractedFactSetType} from '../../facts/index.ts';
import {type FinalizedFactSetType} from '../../facts/types.ts';
import {type SourceFileType} from '../../model.ts';
import {headroomCeilingOf, HEADROOM_TARGET_FACTOR, FALLBACK_REACHABILITY_STEPS_PER_ROOT} from './ceilings.ts';
import {distributionOf, percentileOf} from './distribution.ts';
import {
	type M1ReportType,
	type M2ReportType,
	type M4ReportType,
	type M6ReportType,
	type M7ReportType,
	type M11ReportType,
	type M12ReportType,
	type P3ReportType,
} from './types.ts';

const maximum = (values: readonly number[]): number => values.reduce((current, value) => Math.max(current, value), 0);

const javascriptKind = (file: SourceFileType): 'javascript' | 'typescript' => {
	const extension = path.extname(file.path).toLowerCase();

	return extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs' ? 'javascript' : 'typescript';
};

const readSource = (file: SourceFileType): string => {
	try {
		return readFileSync(file.absolutePath, 'utf8');
	} catch {
		return '';
	}
};

const statValue = (stats: readonly AdapterStatType[], metric: string, dimension?: string): number =>
	stats
		.filter((stat) => stat.metric === metric && (dimension === undefined || (stat.dimensions ?? []).includes(dimension)))
		.reduce((total, stat) => total + stat.value, 0);

/**
 * Measures named nested TypeScript functions.
 *
 * @param facts - Extracted facts.
 * @returns Nested-function count and extent distribution.
 */
export const m1Of = (facts: ExtractedFactSetType): M1ReportType => {
	const nested = facts.symbols.filter((symbol) => symbol.kind === 'function' && symbol.enclosingId !== null);
	const lines = nested.map((symbol) => Math.max(0, symbol.endLine - symbol.startLine + 1));

	return {
		status: 'measured',
		nestedFunctions: nested.length,
		totalLines: lines.reduce((total, value) => total + value, 0),
		p95ExtentLines: percentileOf(lines, 95),
		maxExtentLines: maximum(lines),
	};
};

/**
 * Measures JavaScript and CommonJS files in the indexed roots.
 *
 * @param files - Scanned authored files.
 * @returns JavaScript form counts.
 */
export const m2Of = (files: readonly SourceFileType[]): M2ReportType => {
	let javascriptFiles = 0;
	let commonJsFiles = 0;
	let esmJavaScriptFiles = 0;

	for (const file of files) {
		if (javascriptKind(file) !== 'javascript') {
			continue;
		}

		javascriptFiles += 1;
		const source = readSource(file);
		const commonJs = path.extname(file.path).toLowerCase() === '.cjs' || /\bmodule\.exports\b|exports\s*(?:\.|\[)/u.test(source);
		const esm =
			/\bexport\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|interface\b|type\b|enum\b|\{|\*)/u.test(source) ||
			/\bimport\s+(?:type\s+)?[\w*{]/u.test(source);

		if (commonJs) {
			commonJsFiles += 1;
		}

		if (esm && !commonJs) {
			esmJavaScriptFiles += 1;
		}
	}

	return {
		status: 'measured',
		javascriptFiles,
		commonJsFiles,
		esmJavaScriptFiles,
		unclassifiedJavaScriptFiles: javascriptFiles - commonJsFiles - esmJavaScriptFiles,
	};
};

/**
 * Measures definition sites and bindings per symbol.
 *
 * @param facts - Extracted facts.
 * @param finalized - Finalized facts.
 * @returns Definition and binding distributions.
 */
export const m4Of = (facts: ExtractedFactSetType, finalized: FinalizedFactSetType): M4ReportType => {
	const bindingsBySymbol = new Map<string, number>();
	const sitesByBinding = new Map<string, number>();

	for (const binding of finalized.bindings) {
		bindingsBySymbol.set(binding.symbolId, (bindingsBySymbol.get(binding.symbolId) ?? 0) + 1);
	}

	for (const site of finalized.bindingSites) {
		sitesByBinding.set(site.bindingId, (sitesByBinding.get(site.bindingId) ?? 0) + 1);
	}

	const bindingCounts = [...bindingsBySymbol.values()];
	const siteCounts = [...sitesByBinding.values()];

	return {
		status: 'measured',
		definitionOccurrences: facts.occurrences.filter((occurrence) => occurrence.role === 'definition').length,
		definitionSites: finalized.bindingSites.length,
		symbolsWithMultipleBindings: bindingCounts.filter((count) => count > 1).length,
		bindingsPerSymbol: distributionOf(bindingCounts),
		sitesPerBinding: distributionOf(siteCounts),
	};
};

/**
 * Measures surface addresses, runtime, and peak memory.
 *
 * @param projection - Independent projection probe, or null when it did not run.
 * @param runtimeMs - Total report runtime.
 * @param peakRssBytes - Process peak RSS.
 * @returns M6 measurements.
 */
export const m6Of = (projection: P3ReportType | null, runtimeMs: number, peakRssBytes: number): M6ReportType =>
	projection === null
		? {
				status: 'partial',
				surfaceAddressesPerRoot: distributionOf([]),
				reachabilityStepsPerRoot: distributionOf([]),
				runtimeMs,
				peakRssBytes,
				note: 'The independent projection probe did not run for this extractor.',
			}
		: {
				status: projection.status === 'measured' ? 'measured' : 'partial',
				surfaceAddressesPerRoot: projection.surfaceAddressesPerRoot,
				reachabilityStepsPerRoot: projection.reachabilityStepsPerRoot,
				runtimeMs,
				peakRssBytes,
				note: projection.note,
			};

/**
 * Projects Oracle adapter statistics into M7.
 *
 * @param stats - Adapter aggregate statistics.
 * @returns M7 measurements or a blocked record.
 */
export const m7Of = (stats: readonly AdapterStatType[]): M7ReportType => {
	if (!stats.some((stat) => stat.metric.startsWith('oracle_'))) {
		return {
			status: 'blocked',
			routinePairs: null,
			cursorPairs: null,
			specDefinedCursors: null,
			callSpecs: null,
			polymorphicTableFunctions: null,
			ambiguityRatePpm: null,
			overloadGroups: null,
			bodyForwards: null,
			bodyLessSpec: null,
			unclassifiedBodyLessSpec: null,
			note: 'Oracle adapter statistics were not emitted for this extractor.',
		};
	}

	return {
		status: 'measured',
		routinePairs: statValue(stats, 'oracle_routine_pairs'),
		cursorPairs: statValue(stats, 'oracle_cursor_pairs'),
		specDefinedCursors: statValue(stats, 'oracle_spec_defined_cursors'),
		callSpecs: statValue(stats, 'oracle_call_specs'),
		polymorphicTableFunctions: statValue(stats, 'oracle_polymorphic_table_functions'),
		ambiguityRatePpm: statValue(stats, 'oracle_ambiguity_rate_ppm'),
		overloadGroups: statValue(stats, 'oracle_overload_groups'),
		bodyForwards: statValue(stats, 'oracle_body_forwards'),
		bodyLessSpec: statValue(stats, 'oracle_body_less_spec'),
		unclassifiedBodyLessSpec: statValue(stats, 'oracle_body_less_spec', 'unclassified'),
	};
};

/**
 * Derives the reachability-step ceiling from the projection probe.
 *
 * @param projection - Independent projection probe, or null when it did not run.
 * @returns M11 measurement.
 */
export const m11Of = (projection: P3ReportType | null): M11ReportType => {
	if (projection === null) {
		return {
			status: 'blocked',
			maximumReachabilityStepsPerRoot: 0,
			proposedCeiling: FALLBACK_REACHABILITY_STEPS_PER_ROOT,
			headroomFactor: null,
			headroomTargetFactor: HEADROOM_TARGET_FACTOR,
			headroomStatus: 'blocked_on_projection',
			note: 'The independent projection probe did not run; the ceiling is provisional only.',
		};
	}

	const observedMaximum = projection.maximumReachabilityStepsPerRoot;
	const ceiling = headroomCeilingOf(observedMaximum, HEADROOM_TARGET_FACTOR);

	return {
		status: projection.status === 'measured' ? 'measured' : 'partial',
		maximumReachabilityStepsPerRoot: observedMaximum,
		proposedCeiling: ceiling,
		headroomFactor: ceiling === null ? null : ceiling / observedMaximum,
		headroomTargetFactor: HEADROOM_TARGET_FACTOR,
		headroomStatus: 'computed',
		note: `Derived from observed maximum plus ${String(HEADROOM_TARGET_FACTOR)}x headroom, rounded up to the next 1/2/5 x 10^n value.`,
	};
};

/**
 * Measures surface bindings per root and symbol.
 *
 * @param projection - Independent projection probe, or null when it did not run.
 * @param provisionalCeiling - Report-mode ceiling used when the probe is absent.
 * @returns M12 measurements.
 */
export const m12Of = (projection: P3ReportType | null, provisionalCeiling: number): M12ReportType => {
	if (projection === null) {
		return {
			status: 'partial',
			maximumSurfaceBindingsPerRoot: 0,
			maximumSurfaceBindingsPerSymbol: 0,
			proposedCeiling: provisionalCeiling,
			headroomFactor: null,
			headroomTargetFactor: HEADROOM_TARGET_FACTOR,
			headroomStatus: 'blocked_on_projection',
			anonymous: 0,
			inherited: 0,
			depth1: 0,
			note: 'The independent projection probe did not run; the ceiling is provisional only.',
		};
	}

	const observedMaximum = projection.maximumSurfaceAddressesPerRoot;
	const ceiling = headroomCeilingOf(observedMaximum, HEADROOM_TARGET_FACTOR);

	return {
		status: projection.status === 'measured' ? 'measured' : 'partial',
		maximumSurfaceBindingsPerRoot: observedMaximum,
		maximumSurfaceBindingsPerSymbol: projection.maximumSurfaceAddressesPerSymbol,
		proposedCeiling: ceiling,
		headroomFactor: ceiling === null ? null : ceiling / observedMaximum,
		headroomTargetFactor: HEADROOM_TARGET_FACTOR,
		headroomStatus: 'computed',
		anonymous: projection.anonymousAddresses,
		inherited: projection.inheritedAddresses,
		depth1: projection.depthOneAddresses,
		note: `Derived from observed maximum plus ${String(HEADROOM_TARGET_FACTOR)}x headroom, rounded up to the next 1/2/5 x 10^n value.`,
	};
};
