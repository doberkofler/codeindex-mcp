import {debugFor} from '../logging/debug.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {CodeIndexError} from '../errors/errors.ts';
import {
	type DependencyConsumerType,
	type DependencyEvidenceBindingType,
	type DependencyEvidenceConsumerType,
	type IndexedDependencyBindingType,
	type StoredDependencyEdgeType,
} from '../model.ts';

const debug = debugFor('dependencies');

export type DependencyConsumerMatchType = Readonly<{
	readonly path: string;
	readonly depth: number;
	readonly directRoot: string;
	readonly edge: StoredDependencyEdgeType;
	readonly evidenceCount: number;
}>;

type MutableMatchType = {
	depth: number;
	edge: StoredDependencyEdgeType;
	evidenceCount: number;
};

type RootGroupType = Map<string, MutableMatchType>;

type RootGroupsType = Map<string, RootGroupType>;

const compareEdges = (left: StoredDependencyEdgeType, right: StoredDependencyEdgeType): number =>
	left.startOffset - right.startOffset || left.id.localeCompare(right.id);

const compareMatches = (left: DependencyConsumerMatchType, right: DependencyConsumerMatchType): number =>
	left.directRoot.localeCompare(right.directRoot) || left.depth - right.depth || left.path.localeCompare(right.path);

const addFrontierRoot = (frontier: Map<string, Set<string>>, path: string, root: string): void => {
	const roots = frontier.get(path) ?? new Set<string>();

	roots.add(root);
	frontier.set(path, roots);
};

const directEdgesByRoot = (edges: readonly StoredDependencyEdgeType[]): ReadonlyMap<string, readonly StoredDependencyEdgeType[]> => {
	const grouped = new Map<string, StoredDependencyEdgeType[]>();

	for (const edge of edges) {
		const group = grouped.get(edge.sourcePath) ?? [];

		group.push(edge);
		grouped.set(edge.sourcePath, group);
	}

	return grouped;
};

const createRootGroups = (directByRoot: ReadonlyMap<string, readonly StoredDependencyEdgeType[]>, selectedRoots: readonly string[]): RootGroupsType => {
	const rootGroups = new Map<string, RootGroupType>();

	for (const root of selectedRoots) {
		const edges = directByRoot.get(root) ?? [];
		const [primary] = edges;
		const group = new Map<string, MutableMatchType>();

		if (primary !== undefined) {
			group.set(root, {depth: 1, edge: primary, evidenceCount: edges.length});
		}

		rootGroups.set(root, group);
	}

	return rootGroups;
};

const extendReachedGroup = (
	input: Readonly<{
		rootGroups: RootGroupsType;
		next: Map<string, Set<string>>;
		root: string;
		edge: StoredDependencyEdgeType;
		depth: number;
	}>,
): void => {
	const group = input.rootGroups.get(input.root);

	if (group === undefined) {
		return;
	}

	const existing = group.get(input.edge.sourcePath);

	if (existing === undefined) {
		group.set(input.edge.sourcePath, {depth: input.depth + 1, edge: input.edge, evidenceCount: 1});
		addFrontierRoot(input.next, input.edge.sourcePath, input.root);
		return;
	}

	if (existing.depth === input.depth + 1) {
		existing.evidenceCount += 1;

		if (compareEdges(input.edge, existing.edge) < 0) {
			existing.edge = input.edge;
		}
	}
};

const propagateImpact = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		rootGroups: RootGroupsType;
		selectedRoots: readonly string[];
		context?: string | undefined;
	}>,
): void => {
	let frontier = new Map<string, Set<string>>();

	for (const root of input.selectedRoots) {
		frontier.set(root, new Set([root]));
	}

	let depth = 1;

	while (frontier.size > 0) {
		const targets = [...frontier.keys()].sort();
		const next = new Map<string, Set<string>>();

		for (const edge of input.database.findDependencyEdgesByTargets(input.generationId, targets, input.context)) {
			const reachedRoots = frontier.get(edge.targetPath ?? '');

			if (reachedRoots === undefined || edge.sourcePath === edge.targetPath) {
				continue;
			}

			for (const root of [...reachedRoots].sort()) {
				extendReachedGroup({rootGroups: input.rootGroups, next, root, edge, depth});
			}
		}

		frontier = next;
		depth += 1;
	}
};

/**
 * Finds authored modules that consume one normalized package.
 *
 * Direct usage contains modules with a package edge. Module impact keeps the
 * direct consumer that starts every shortest authored path, so a module
 * reachable through several roots appears once per root. Traversal is
 * cycle-safe and deterministic.
 *
 * @param input - Database, generation, package, traversal mode, and optional direct root.
 * @returns Consumers ordered by direct root, depth, and path.
 * @throws {@link CodeIndexError} When the selected root is not a direct package consumer.
 */
export const findDependencyConsumers = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		packageName: string;
		context?: string | undefined;
		transitive: boolean;
		root?: string | undefined;
	}>,
): readonly DependencyConsumerMatchType[] => {
	const direct = input.database.findDependencyEdgesByPackage(input.generationId, input.packageName, input.context);
	const directByRoot = directEdgesByRoot(direct);
	const allRoots = [...directByRoot.keys()].sort();

	if (input.root !== undefined && !directByRoot.has(input.root)) {
		throw new CodeIndexError('invalid_argument', `Root is not a direct consumer of ${input.packageName}: ${input.root}`);
	}

	const selectedRoots = input.root === undefined ? allRoots : [input.root];
	const rootGroups = createRootGroups(directByRoot, selectedRoots);

	if (input.transitive) {
		propagateImpact({database: input.database, generationId: input.generationId, rootGroups, selectedRoots, context: input.context});
	}

	const consumers: DependencyConsumerMatchType[] = [];

	for (const [directRoot, group] of rootGroups) {
		for (const [path, match] of group) {
			consumers.push({path, depth: match.depth, directRoot, edge: match.edge, evidenceCount: match.evidenceCount});
		}
	}

	consumers.sort(compareMatches);
	debug('dependency consumers resolved', {
		generationId: input.generationId,
		package: input.packageName,
		transitive: input.transitive,
		root: input.root ?? null,
		direct: direct.length,
		roots: selectedRoots.length,
		consumers: consumers.length,
	});

	return consumers;
};

const evidenceBindings = (bindings: readonly IndexedDependencyBindingType[]): readonly DependencyEvidenceBindingType[] =>
	bindings.map(({kind, importedName, exportedName, localName, typeOnly}) => ({kind, importedName, exportedName, localName, typeOnly}));

/**
 * Projects traversal matches into compact response items.
 *
 * @param matches - Consumers for the requested page.
 * @returns Items containing only path, depth, and the direct root.
 */
export const toDependencyConsumers = (matches: readonly DependencyConsumerMatchType[]): readonly DependencyConsumerType[] =>
	matches.map(({path, depth, directRoot}) => ({path, depth, directRoot}));

/**
 * Converts traversal matches and their bindings into evidence response items.
 *
 * @param matches - Consumers for the requested page.
 * @param bindings - Persisted bindings for the page's evidence edges.
 * @returns Dependency consumer items with locations and bindings.
 */
export const toDependencyEvidenceConsumers = (
	matches: readonly DependencyConsumerMatchType[],
	bindings: readonly IndexedDependencyBindingType[],
): readonly DependencyEvidenceConsumerType[] => {
	const byEdge = new Map<string, IndexedDependencyBindingType[]>();

	for (const entry of bindings) {
		const group = byEdge.get(entry.edgeId) ?? [];

		group.push(entry);
		byEdge.set(entry.edgeId, group);
	}

	return matches.map((match) => ({
		path: match.path,
		depth: match.depth,
		directRoot: match.directRoot,
		relationship: match.depth === 1 ? 'direct' : 'transitive',
		evidenceCount: match.evidenceCount,
		evidence: {
			targetPath: match.edge.targetPath,
			rawSpecifier: match.edge.rawSpecifier,
			normalizedPackage: match.edge.normalizedPackage,
			kind: match.edge.kind,
			startLine: match.edge.startLine,
			startColumn: match.edge.startColumn,
			endLine: match.edge.endLine,
			endColumn: match.edge.endColumn,
			context: match.edge.context ?? null,
			bindings: evidenceBindings(byEdge.get(match.edge.id) ?? []),
		},
	}));
};
