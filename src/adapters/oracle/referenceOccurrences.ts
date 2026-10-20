import {type IndexedOccurrenceType} from '../../core/model.ts';
import {type OracleReferenceSiteType} from './syntax.ts';

const usageOfSite = (site: OracleReferenceSiteType): number => site.usage ?? (site.kind === 'call' ? 1 : site.kind === 'type-anchor' ? 8 : 2);

/**
 * Projects one resolved authored site into an indexed occurrence.
 *
 * @param input - Context, file path, site, target, and enclosing symbol.
 * @returns Indexed reference occurrence.
 */
export const occurrenceOf = (
	input: Readonly<{context: string; path: string; site: OracleReferenceSiteType; symbolId: string; enclosingId: string | null}>,
): IndexedOccurrenceType => ({
	symbolId: input.symbolId,
	path: input.path,
	startLine: input.site.nameRange.startLine,
	startColumn: input.site.nameRange.startColumn,
	endLine: input.site.nameRange.endLine,
	endColumn: input.site.nameRange.endColumn,
	startOffset: input.site.nameRange.startOffset,
	endOffset: input.site.nameRange.endOffset,
	role: 'reference',
	usage: usageOfSite(input.site),
	enclosingId: input.enclosingId,
	contexts: [input.context],
});
