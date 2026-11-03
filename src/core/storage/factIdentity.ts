import {createHash} from 'node:crypto';
import {type FinalizedFactSetType} from '../facts/types.ts';
import {type GenerationFactsInputType} from './databaseFactTypes.ts';

/**
 * Derives the opaque persisted identity for one adapter-local identifier.
 *
 * Adapter authors choose their own symbol, binding, site, and dependency
 * identifiers. Hashing the owning adapter together with the local identifier
 * keeps two adapters from colliding in one generation, and keeps a local
 * identifier from being interpreted as a core-wide identity.
 *
 * @param adapterId - Adapter that owns the identifier.
 * @param localId - Adapter-emitted identifier.
 * @returns Stable opaque persisted identifier.
 */
export const scopedFactIdOf = (adapterId: string, localId: string): string =>
	`a_${createHash('sha256').update(adapterId).update('\u0000').update(localId).digest('hex')}`;

const scopedOptionalId = (adapterId: string, localId: string | null): string | null => (localId === null ? null : scopedFactIdOf(adapterId, localId));

/**
 * Rewrites every adapter-local identifier to its core-owned persisted identity.
 *
 * The rewrite is purely structural: every relationship that referenced a local
 * identifier references the corresponding persisted identifier afterwards.
 *
 * @param adapterId - Adapter that emitted the facts.
 * @param facts - Finalized adapter facts.
 * @returns Facts whose identifiers are safe to persist for this adapter.
 */
const scopedFactsOf = (adapterId: string, facts: FinalizedFactSetType): FinalizedFactSetType => ({
	...facts,
	symbols: facts.symbols.map((symbol) => ({
		...symbol,
		id: scopedFactIdOf(adapterId, symbol.id),
		enclosingId: scopedOptionalId(adapterId, symbol.enclosingId),
	})),
	bindings: facts.bindings.map((binding) => ({
		...binding,
		bindingId: scopedFactIdOf(adapterId, binding.bindingId),
		symbolId: scopedFactIdOf(adapterId, binding.symbolId),
	})),
	bindingContexts: facts.bindingContexts.map((context) => ({
		...context,
		bindingId: scopedFactIdOf(adapterId, context.bindingId),
	})),
	bindingSites: facts.bindingSites.map((site) => ({
		...site,
		bindingId: scopedFactIdOf(adapterId, site.bindingId),
	})),
	surfaceOrigins: facts.surfaceOrigins.map((origin) => ({
		...origin,
		bindingId: scopedFactIdOf(adapterId, origin.bindingId),
		rootBindingId: scopedFactIdOf(adapterId, origin.rootBindingId),
	})),
	occurrences: facts.occurrences.map((occurrence) => ({
		...occurrence,
		symbolId: scopedFactIdOf(adapterId, occurrence.symbolId),
		enclosingId: scopedOptionalId(adapterId, occurrence.enclosingId),
	})),
});

/**
 * Namespaces adapter-local identities before persistence.
 *
 * @param input - Fact write input.
 * @returns The same write with core-owned identifiers.
 */
export const scopeAdapterFacts = (input: GenerationFactsInputType): GenerationFactsInputType => ({
	...input,
	facts: scopedFactsOf(input.adapterId, input.facts),
	dependencies: {
		edges: input.dependencies.edges.map((edge) => ({...edge, id: scopedFactIdOf(input.adapterId, edge.id)})),
		bindings: input.dependencies.bindings.map((binding) => ({...binding, edgeId: scopedFactIdOf(input.adapterId, binding.edgeId)})),
	},
});
