import {type DependencyExtractionResultType, type IndexedDependencyEdgeType} from '../../core/model.ts';
import {type OracleFileAnalysisType} from './extractSymbols.ts';
import {type OraclePackageLookupMapType} from './scopeGraph.ts';
import {createOracleId} from './symbolIdentity.ts';

type InputType = Readonly<{
	projectId: string;
	context: string;
	defaultSchema: string;
	files: readonly OracleFileAnalysisType[];
	packages: OraclePackageLookupMapType;
}>;

const targetCanonicalOf = (parts: readonly string[], defaultSchema: string): string =>
	parts.length === 1 ? `${defaultSchema}.${parts[0] ?? ''}` : parts.slice(0, 2).join('.');

/**
 * Extracts direct Oracle package dependencies from qualified name sites.
 *
 * Only calls, indexed package references, and indexed type anchors become
 * edges. This keeps SQL table and column chains out of package dependency facts.
 *
 * @param input - Project identity, schema, parsed analyses, and package lookup tables.
 * @returns Dependency edges with empty binding rows.
 */
export const extractOracleDependencies = (input: InputType): DependencyExtractionResultType => {
	const edges: IndexedDependencyEdgeType[] = [];
	const seen = new Set<string>();

	for (const file of input.files) {
		for (const site of file.parse.dependencies) {
			const targetParts = site.targetName.parts.map((part) => part.canonical);
			const targetIdentifier = targetCanonicalOf(targetParts, input.defaultSchema);
			const packageRecord = input.packages.get(targetIdentifier);

			if (packageRecord === undefined && site.kind !== 'package-call') {
				continue;
			}

			const targetPath = packageRecord?.specPath ?? packageRecord?.bodyPath ?? null;
			const rawTarget = site.targetName.text;
			const id = createOracleId({
				projectId: input.projectId,
				path: file.path,
				startOffset: site.range.startOffset,
				kind: site.kind,
				name: rawTarget,
				discriminator: input.context,
			});
			const key = [id, targetIdentifier, site.kind, file.path, String(site.range.startOffset)].join('\u0000');

			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			edges.push({
				id,
				context: input.context,
				sourcePath: file.path,
				targetPath,
				rawTarget,
				targetIdentifier,
				kind: site.kind,
				compileTimeOnly: false,
				startLine: site.range.startLine,
				startColumn: site.range.startColumn,
				endLine: site.range.endLine,
				endColumn: site.range.endColumn,
				startOffset: site.range.startOffset,
				endOffset: site.range.endOffset,
			});
		}
	}

	edges.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.startOffset - right.startOffset || left.id.localeCompare(right.id));

	return {edges, bindings: []};
};
