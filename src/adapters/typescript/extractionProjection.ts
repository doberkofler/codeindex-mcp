import {type FactAddressType} from '../../core/facts/index.ts';
import {PUBLICATION_REACHABILITY_STEPS_PER_ROOT, PUBLICATION_SURFACE_BINDINGS_PER_ROOT} from '../../core/facts/ceilings.ts';
import {debugFor} from '../../core/logging/debug.ts';
import {type ExtractionRuntimeType, symbolForDeclaration, symbolForTsSymbol} from './extractionRuntime.ts';
import {addSite, ensureBinding, type FactSinkType, type RootDraftType} from './extractionRoots.ts';
import {projectPublishedRoot, SurfaceProjectionError, type SurfaceProjectionHostType} from './surfaceProjection.ts';

const debug = debugFor('extract');

/**
 * Projects every published root through compiler types.
 *
 * @param runtime - Extraction state.
 * @param sink - Fact sink whose roots are projected.
 * @throws {TypeError} When a configured projection ceiling is exceeded.
 */
export const projectPublishedRoots = (runtime: ExtractionRuntimeType, sink: FactSinkType): void => {
	let projectingRoot: RootDraftType | null = null;
	const host: SurfaceProjectionHostType = {
		checker: runtime.checker,
		authoredPaths: runtime.authoredPaths,
		maxAddressesPerRoot: PUBLICATION_SURFACE_BINDINGS_PER_ROOT,
		maxReachabilityStepsPerRoot: PUBLICATION_REACHABILITY_STEPS_PER_ROOT,
		symbolForTsSymbol: (symbol) => symbolForTsSymbol(runtime, symbol),
		symbolForDeclaration: (declaration) => symbolForDeclaration(runtime, declaration),
		markReachable: (symbolId) => {
			sink.reachable.add(symbolId);
		},
		addSurface: (address) => {
			const root = projectingRoot;

			if (root === null) {
				return;
			}

			const fullSegments: FactAddressType = [...root.segments, ...address.relativeSegments];
			const draft = ensureBinding(sink, address.symbolId, fullSegments);
			draft.exposure = 'published';
			addSite(sink, {symbolId: address.symbolId, segments: fullSegments, kind: 'surface', pathName: root.site.path, range: root.site.range});

			if (address.anonymous) {
				sink.surfaceFlags.anonymous += 1;
			}

			if (address.inherited) {
				sink.surfaceFlags.inherited += 1;
			}

			if (address.depthOne) {
				sink.surfaceFlags.depthOne += 1;
			}

			sink.origins.push({
				symbolId: address.symbolId,
				segments: fullSegments,
				context: runtime.input.context,
				rootSymbolId: root.symbolId,
				rootSegments: root.segments,
				relativeSegments: address.relativeSegments,
			});
		},
	};

	for (const root of sink.roots) {
		if (root.external) {
			continue;
		}

		projectingRoot = root;

		try {
			const projected = projectPublishedRoot(host, root.tsSymbol, root.segments);
			sink.maxAddresses = Math.max(sink.maxAddresses, projected.addresses + 1);
			sink.maxSteps = Math.max(sink.maxSteps, projected.steps);
		} catch (error) {
			if (error instanceof SurfaceProjectionError) {
				debug('surface projection failed', {root: root.segments, symbol: root.tsSymbol.getName()});
				throw new TypeError(error.message, {cause: error});
			}

			throw error;
		} finally {
			projectingRoot = null;
		}
	}
};
