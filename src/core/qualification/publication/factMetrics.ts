import {readFileSync} from 'node:fs';
import path from 'node:path';
import {type AdapterStatType, type ExtractedFactSetType} from '../../facts/index.ts';
import {type FinalizedFactSetType} from '../../facts/types.ts';
import {type SourceFileType} from '../../model.ts';
import {PROVISIONAL_HEADROOM_TARGET_FACTOR, PROVISIONAL_REACHABILITY_STEPS_PER_ROOT} from './ceilings.ts';
import {distributionOf, percentileOf} from './distribution.ts';
import {
	type M1ReportType,
	type M2ReportType,
	type M4ReportType,
	type M6ReportType,
	type M7ReportType,
	type M11ReportType,
	type M12ReportType,
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

const surfaceCountsByRoot = (finalized: FinalizedFactSetType): readonly number[] => {
	const counts = new Map<string, number>();

	for (const origin of finalized.surfaceOrigins) {
		counts.set(origin.rootBindingId, (counts.get(origin.rootBindingId) ?? 0) + 1);
	}

	return [...counts.values()];
};

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
 * @param finalized - Finalized facts.
 * @param runtimeMs - Total report runtime.
 * @param peakRssBytes - Process peak RSS.
 * @returns M6 measurements.
 */
export const m6Of = (finalized: FinalizedFactSetType, runtimeMs: number, peakRssBytes: number): M6ReportType => ({
	status: 'partial',
	surfaceAddressesPerRoot: distributionOf(surfaceCountsByRoot(finalized)),
	reachabilityStepsPerRoot: distributionOf([]),
	runtimeMs,
	peakRssBytes,
	note: 'Reachability closure is not implemented before the Phase 4 projection slice; surface origins are preliminary.',
});

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
 * Returns the unavailable reachability ceiling measurement.
 *
 * @returns Blocked M11 record.
 */
export const m11Of = (): M11ReportType => ({
	status: 'blocked',
	maximumReachabilityStepsPerRoot: 0,
	proposedCeiling: PROVISIONAL_REACHABILITY_STEPS_PER_ROOT,
	headroomFactor: null,
	headroomTargetFactor: PROVISIONAL_HEADROOM_TARGET_FACTOR,
	headroomStatus: 'blocked_on_projection',
	note: 'Reachability closure and measured headroom are blocked on the Phase 4 projection slice; the ceiling is provisional only.',
});

/**
 * Measures surface bindings per root and symbol.
 *
 * @param finalized - Finalized facts.
 * @param provisionalCeiling - Provisional external ceiling.
 * @returns M12 measurements.
 */
export const m12Of = (finalized: FinalizedFactSetType, provisionalCeiling: number): M12ReportType => {
	const rootCounts = surfaceCountsByRoot(finalized);
	const symbolIds = new Map(finalized.bindings.map((binding) => [binding.bindingId, binding.symbolId]));
	const countsBySymbol = new Map<string, number>();

	for (const origin of finalized.surfaceOrigins) {
		const symbolId = symbolIds.get(origin.bindingId) ?? origin.bindingId;
		countsBySymbol.set(symbolId, (countsBySymbol.get(symbolId) ?? 0) + 1);
	}

	return {
		status: 'partial',
		maximumSurfaceBindingsPerRoot: maximum(rootCounts),
		maximumSurfaceBindingsPerSymbol: maximum([...countsBySymbol.values()]),
		proposedCeiling: provisionalCeiling,
		headroomFactor: null,
		headroomTargetFactor: PROVISIONAL_HEADROOM_TARGET_FACTOR,
		headroomStatus: 'blocked_on_projection',
		anonymous: 0,
		inherited: 0,
		depth1: 0,
		note: 'Surface-origin classification, measured headroom, and reachability closure are blocked on the Phase 4 projection slice; the ceiling is provisional only.',
	};
};
