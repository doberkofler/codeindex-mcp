import {type FindSymbolResultType, type OutlineResultType} from '../../core/modelPublication.ts';

/**
 * One outline entry reduced to navigation essentials.
 *
 * The full outline entry repeats binding identity, sites, and context metadata
 * for every declaration, which multiplies payload size by roughly ten for a
 * file of a few hundred lines.
 */
type CompactOutlineItemType = Readonly<{
	symbolId: string;
	name: string;
	kind: string;
	path: string;
	startLine: number;
	endLine: number;
}>;

/** Outline result with compact items and unchanged paging fields. */
export type CompactOutlineResultType = Omit<OutlineResultType, 'items'> & Readonly<{items: readonly CompactOutlineItemType[]}>;

/** One symbol match reduced to navigation essentials. */
type CompactSymbolItemType = Readonly<{
	symbolId: string;
	name: string;
	qualifiedName: string;
	kind: string;
	path: string;
	startLine: number;
	endLine: number;
}>;

/** Symbol result with compact items and unchanged paging fields. */
export type CompactSymbolResultType = Omit<FindSymbolResultType, 'items'> & Readonly<{items: readonly CompactSymbolItemType[]}>;

/**
 * Projects an outline result onto compact items.
 *
 * Paging, freshness, truncation, and re-export fields are preserved verbatim;
 * only per-declaration detail is dropped.
 *
 * @param result - Complete outline result.
 * @returns The same page with compact items.
 */
export const compactOutlineOf = (result: OutlineResultType): CompactOutlineResultType => ({
	...result,
	items: result.items.map((item) => ({
		symbolId: item.id,
		name: item.name,
		kind: item.kind,
		path: item.site.path,
		startLine: item.site.startLine,
		endLine: item.site.endLine,
	})),
});

/**
 * Projects a symbol-search result onto compact items.
 *
 * @param result - Complete symbol-search result.
 * @returns The same page with compact items.
 */
export const compactSymbolsOf = (result: FindSymbolResultType): CompactSymbolResultType => ({
	...result,
	items: result.items.map((item) => ({
		symbolId: item.symbolId,
		name: item.name,
		qualifiedName: item.qualifiedName,
		kind: item.kind,
		path: item.path,
		startLine: item.startLine,
		endLine: item.endLine,
	})),
});
