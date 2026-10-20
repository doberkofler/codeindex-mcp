import {type ConfigType} from '../../config/config.ts';
import {type ExtractedFactSetType} from '../../facts/index.ts';
import {type FinalizedFactSetType} from '../../facts/types.ts';
import {loadTypeScriptProject} from '../../../adapters/typescript/loadProject.ts';
import {addProgramRoots} from './reachabilityTruthModel.ts';
import {keyOf, type TruthStateType} from './reachabilityTruthSupport.ts';

type ReachabilityTruthContextType = Readonly<{
	roots: number;
	addresses: number;
	truthDeclarations: number;
	visibleDeclarations: number;
	missingDeclarations: number;
	extraDeclarations: number;
	ambiguousDeclarations: number;
}>;

export type ReachabilityTruthReportType = Readonly<{
	contexts: number;
	roots: number;
	addresses: number;
	truthDeclarations: number;
	visibleDeclarations: number;
	missingDeclarations: number;
	extraDeclarations: number;
	ambiguousDeclarations: number;
	status: 'partial' | 'passed' | 'failed';
}>;

const visibleDeclarationKeysOf = (context: string, finalized: FinalizedFactSetType): ReadonlySet<string> => {
	const visibleBindings = new Set(
		finalized.bindingContexts.filter((entry) => entry.context === context && entry.exposure !== 'internal').map((entry) => entry.bindingId),
	);
	const keys = new Set<string>();

	for (const site of finalized.bindingSites) {
		if (visibleBindings.has(site.bindingId) && (site.kind === 'declared' || site.kind === 'default')) {
			keys.add(keyOf(site.path, site.range.startOffset));
		}
	}

	return keys;
};

const compareContext = (
	context: ConfigType['projects'][number],
	config: ConfigType,
	facts: ExtractedFactSetType,
	finalized: FinalizedFactSetType,
): ReachabilityTruthContextType => {
	const project = loadTypeScriptProject(config, context.projectFilePath);
	const state: TruthStateType = {
		checker: project.checker,
		authoredPaths: new Set(facts.files.map((file) => file.absolutePath)),
		pathByAbsolute: new Map(facts.files.map((file) => [file.absolutePath, file.path])),
		declarations: new Map(),
		seenSymbols: new Set(),
		seenTypes: new Set(),
		pendingSymbols: [],
		pendingTypes: [],
		roots: 0,
		addresses: 0,
		ambiguous: 0,
	};

	addProgramRoots(state, project.program);

	const truthKeys = new Set(state.declarations.keys());
	const visibleKeys = visibleDeclarationKeysOf(context.name, finalized);
	const missing = [...truthKeys].filter((key) => !visibleKeys.has(key));
	const extra = [...visibleKeys].filter((key) => !truthKeys.has(key));

	return {
		roots: state.roots,
		addresses: state.addresses,
		truthDeclarations: truthKeys.size,
		visibleDeclarations: visibleKeys.size,
		missingDeclarations: missing.length,
		extraDeclarations: extra.length,
		ambiguousDeclarations: state.ambiguous,
	};
};

/**
 * Builds an independent source-associated reachability truth for one
 * TypeScript report run and compares it with visible lexical bindings.
 *
 * Truth roots come from compiler module export tables and script top-level
 * declarations. Reachability follows compiler types and symbols directly.
 * Production bindings are used only for the comparison, never to construct
 * truth.
 *
 * @param input - Resolved configuration, extracted facts, and finalized facts.
 * @returns Aggregate source-association results for G-A2.
 */
export const compareReachabilityTruth = (
	input: Readonly<{config: ConfigType; facts: ExtractedFactSetType; finalized: FinalizedFactSetType}>,
): ReachabilityTruthReportType => {
	const results = input.config.projects.map((context) => compareContext(context, input.config, input.facts, input.finalized));
	const total = (select: (entry: ReachabilityTruthContextType) => number): number => results.reduce((sum, entry) => sum + select(entry), 0);
	const missing = total((entry) => entry.missingDeclarations);
	const extra = total((entry) => entry.extraDeclarations);
	const ambiguous = total((entry) => entry.ambiguousDeclarations);

	return {
		contexts: results.length,
		roots: total((entry) => entry.roots),
		addresses: total((entry) => entry.addresses),
		truthDeclarations: total((entry) => entry.truthDeclarations),
		visibleDeclarations: total((entry) => entry.visibleDeclarations),
		missingDeclarations: missing,
		extraDeclarations: extra,
		ambiguousDeclarations: ambiguous,
		status: results.length === 0 ? 'failed' : missing === 0 && extra === 0 && ambiguous === 0 ? 'passed' : 'failed',
	};
};
