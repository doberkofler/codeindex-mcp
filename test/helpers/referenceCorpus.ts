import {REFERENCE_CONSTRUCT_TAGS, type ReferenceConstructTagType} from '../../src/adapters/typescript/referenceConstructs.ts';

type ReferenceCorpusSelectorType = Readonly<{
	readonly path: string;
	readonly name: string;
	readonly kind: string;
}>;

export type ReferenceCorpusRepresentativeType = Readonly<{
	readonly tag: ReferenceConstructTagType;
	readonly selector: ReferenceCorpusSelectorType;
	readonly mustSample: boolean;
}>;

/**
 * Explicit expectations for the checked-in reference corpus.
 *
 * Selectors use path, declaration name, and kind instead of byte offsets so the
 * corpus can be reformatted without rewriting the manifest. A `mustSample`
 * selector pins the deterministic sampler: if it stops being selected, the
 * corpus changed and the sampling decision must be reviewed.
 *
 * `knownLimitations` is intentionally empty. The production gate accepts no
 * mismatches until a limitation is classified and justified here.
 */
export const REFERENCE_CORPUS_MANIFEST: Readonly<{
	requiredTags: readonly ReferenceConstructTagType[];
	representatives: readonly ReferenceCorpusRepresentativeType[];
	knownLimitations: readonly string[];
}> = {
	requiredTags: REFERENCE_CONSTRUCT_TAGS,
	representatives: [
		{
			tag: 'direct-reference',
			selector: {path: 'direct/declarations.ts', name: 'DirectClass01', kind: 'class'},
			mustSample: true,
		},
		{
			tag: 'named-import',
			selector: {path: 'direct/declarations.ts', name: 'DirectClass01', kind: 'class'},
			mustSample: true,
		},
		{
			tag: 'inheritance',
			selector: {path: 'inheritance/base.ts', name: 'BaseRecord', kind: 'class'},
			mustSample: true,
		},
		{
			tag: 'mixed-type-value',
			selector: {path: 'inheritance/base.ts', name: 'BaseRecord', kind: 'class'},
			mustSample: true,
		},
		{
			tag: 'default-import',
			selector: {path: 'aliases/default.ts', name: 'default', kind: 'function'},
			mustSample: true,
		},
		{
			tag: 'declaration-merging',
			selector: {path: 'merging/module.ts', name: 'mergedWorker', kind: 'function'},
			mustSample: true,
		},
		{
			tag: 'type-only-reference',
			selector: {path: 'direct/declarations.ts', name: 'DirectShape01', kind: 'interface'},
			mustSample: true,
		},
		{
			tag: 'override',
			selector: {path: 'inheritance/derived.ts', name: 'describe', kind: 'method'},
			mustSample: true,
		},
		{
			tag: 'namespace-import',
			selector: {path: 'aliases/namespace.ts', name: 'namespaceFn03', kind: 'variable'},
			mustSample: true,
		},
		{
			tag: 'barrel-reexport',
			selector: {path: 'barrels/parts.ts', name: 'barrelFn01', kind: 'variable'},
			mustSample: true,
		},
		{
			tag: 'destructuring',
			selector: {path: 'destructuring/usage.ts', name: 'inner', kind: 'variable'},
			mustSample: true,
		},
		{
			tag: 'javascript',
			selector: {path: 'javascript/library.js', name: 'jsFn04', kind: 'variable'},
			mustSample: true,
		},
		{
			tag: 'jsx-component',
			selector: {path: 'jsx/Panel.tsx', name: 'Badge', kind: 'variable'},
			mustSample: true,
		},
		{
			tag: 'path-alias',
			selector: {path: 'pathAliases/target.ts', name: 'aliasFn04', kind: 'variable'},
			mustSample: true,
		},
		{
			tag: 'named-reexport',
			selector: {path: 'reexports/source.ts', name: 'sourceFn01', kind: 'variable'},
			mustSample: true,
		},
		{
			tag: 'shorthand-property',
			selector: {path: 'shorthand/declarations.ts', name: 'shorthandValue', kind: 'variable'},
			mustSample: true,
		},
	],
	knownLimitations: [],
};
