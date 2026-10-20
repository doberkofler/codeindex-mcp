import {type ConfigType} from '../../config/config.ts';
import {type ExtractedFactSetType} from '../../facts/index.ts';
import {debugFor} from '../../logging/debug.ts';
import {distributionOf} from './distribution.ts';
import {locationKey, MAX_PROJECTION_DEPTH, type ProjectionBudgetType, type RootResultType} from './projectionModel.ts';
import {projectContext} from './projectionRoots.ts';
import {type P3ReportType} from './types.ts';

const debug = debugFor('publication');

const symbolCountsOf = (roots: readonly RootResultType[], symbolIdByLocation: ReadonlyMap<string, string>): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>();

	for (const root of roots) {
		for (const address of root.addresses) {
			const symbolId = address.terminalKey === null ? undefined : symbolIdByLocation.get(address.terminalKey);

			if (symbolId !== undefined) {
				counts.set(symbolId, (counts.get(symbolId) ?? 0) + 1);
			}
		}
	}

	return counts;
};

/**
 * Runs an independent TypeScript surface-projection and reachability probe.
 *
 * The probe enumerates compiler export-table roots, follows the policy address
 * edges, and records per-root maxima. It never reads production publication
 * facts to construct truth and never persists or publishes anything.
 *
 * @param input - Resolved configuration, extracted files, and probe budget.
 * @returns Per-root projection measurements and aggregate categories.
 */
export const runProjectionPrototype = (
	input: Readonly<{
		readonly config: ConfigType;
		readonly facts: ExtractedFactSetType;
		readonly budget: ProjectionBudgetType;
	}>,
): P3ReportType => {
	const startedAt = performance.now();
	const authoredPaths = new Set(input.facts.files.map((file) => file.absolutePath));
	const pathByAbsolute = new Map(input.facts.files.map((file) => [file.absolutePath, file.path]));
	const symbolIdByLocation = new Map<string, string>();

	for (const symbol of input.facts.symbols) {
		const key = locationKey(symbol.path, symbol.startOffset);

		if (!symbolIdByLocation.has(key)) {
			symbolIdByLocation.set(key, symbol.id);
		}
	}

	const roots: RootResultType[] = [];

	for (const context of input.config.projects) {
		roots.push(...projectContext({config: input.config, context, authoredPaths, pathByAbsolute, budget: input.budget}));
	}

	const completed = roots.filter((root) => !root.exceeded);
	const addresses = completed.flatMap((root) => root.addresses);
	const symbolCounts = [...symbolCountsOf(completed, symbolIdByLocation).values()];
	const depthLimitedRoots = completed.filter((root) => root.depthLimited).length;

	if (depthLimitedRoots > 0) {
		debug('projection depth-limited roots', {roots: depthLimitedRoots, limit: MAX_PROJECTION_DEPTH});
	}

	return {
		status: roots.length === 0 ? 'blocked' : completed.length === roots.length && depthLimitedRoots === 0 ? 'measured' : 'partial',
		roots: roots.length,
		completedRoots: completed.length,
		budgetExceededRoots: roots.length - completed.length,
		depthLimitedRoots,
		surfaceAddresses: roots.reduce((total, root) => total + root.addresses.length, 0),
		reachabilitySteps: roots.reduce((total, root) => total + root.steps, 0),
		surfaceAddressesPerRoot: distributionOf(completed.map((root) => root.addresses.length)),
		reachabilityStepsPerRoot: distributionOf(completed.map((root) => root.steps)),
		maximumSurfaceAddressesPerRoot: completed.reduce((maximum, root) => Math.max(maximum, root.addresses.length), 0),
		maximumReachabilityStepsPerRoot: completed.reduce((maximum, root) => Math.max(maximum, root.steps), 0),
		maximumSurfaceAddressesPerSymbol: symbolCounts.reduce((maximum, value) => Math.max(maximum, value), 0),
		anonymousAddresses: addresses.filter((address) => address.anonymous).length,
		inheritedAddresses: addresses.filter((address) => address.inherited).length,
		depthOneAddresses: addresses.filter((address) => address.depthOne).length,
		runtimeMs: Math.round(performance.now() - startedAt),
		note: `Independent compiler-type projection probe; aggregate counts only. Budget-exceeded roots are excluded from maxima; projection depth is capped at ${String(MAX_PROJECTION_DEPTH)} with path-local cycle detection.`,
	};
};
