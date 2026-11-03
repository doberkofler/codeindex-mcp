import {oracleObjectKeyOf} from './oracleLiveSource.ts';

/**
 * One `USER_DEPENDENCIES` edge where the referenced object belongs to the
 * connected schema.
 */
export type OracleDependencyRowType = Readonly<{
	name: string;
	type: string;
	referencedName: string;
	referencedType: string;
}>;

export type OracleDependentType = Readonly<{
	type: string;
	name: string;
	compileClause: string;
	depth: number;
}>;

type CompilableType = Readonly<{
	type: string;
	name: string;
	compileClause: string;
}>;

type AdjacencyType = ReadonlyMap<string, readonly string[]>;

type ComponentGraphType = Readonly<{
	componentOf: ReadonlyMap<string, number>;
	count: number;
}>;

const COMPILABLE_TYPES: ReadonlyMap<string, string> = new Map([
	['PACKAGE', 'SPECIFICATION'],
	['PACKAGE BODY', 'BODY'],
	['FUNCTION', ''],
	['PROCEDURE', ''],
	['TYPE', 'SPECIFICATION'],
	['TYPE BODY', 'BODY'],
	['TRIGGER', ''],
	['VIEW', ''],
	['MATERIALIZED VIEW', ''],
	['SYNONYM', ''],
]);

const typePriority = (type: string): number => {
	switch (type) {
		case 'PACKAGE': {
			return 0;
		}
		case 'PACKAGE BODY': {
			return 1;
		}
		case 'FUNCTION': {
			return 2;
		}
		case 'PROCEDURE': {
			return 3;
		}
		case 'TYPE': {
			return 4;
		}
		case 'TYPE BODY': {
			return 5;
		}
		case 'TRIGGER': {
			return 6;
		}
		case 'VIEW': {
			return 7;
		}
		case 'MATERIALIZED VIEW': {
			return 8;
		}
		case 'SYNONYM': {
			return 9;
		}
		default: {
			return 10;
		}
	}
};

const compilableOf = (type: string, name: string): CompilableType | null => {
	const normalizedType = type.toUpperCase();
	const compileClause = COMPILABLE_TYPES.get(normalizedType);

	if (compileClause === undefined) {
		return null;
	}

	return {type: normalizedType, name: name.toUpperCase(), compileClause};
};

const reverseAdjacencyOf = (nodes: readonly string[], adjacency: AdjacencyType): ReadonlyMap<string, readonly string[]> => {
	const reversed = new Map<string, string[]>(nodes.map((node) => [node, []]));

	for (const node of nodes) {
		for (const dependent of adjacency.get(node) ?? []) {
			reversed.get(dependent)?.push(node);
		}
	}

	return reversed;
};

/**
 * Produces a deterministic depth-first finish order without recursion.
 *
 * @param nodes - Graph nodes in stable input order.
 * @param adjacency - Prerequisite-to-dependent edges.
 * @returns Nodes ordered by ascending finish time.
 */
const finishOrderOf = (nodes: readonly string[], adjacency: AdjacencyType): readonly string[] => {
	const visited = new Set<string>();
	const order: string[] = [];

	for (const start of nodes) {
		if (visited.has(start)) {
			continue;
		}

		visited.add(start);
		const stack: {key: string; next: number}[] = [{key: start, next: 0}];

		while (stack.length > 0) {
			const top = stack.at(-1);

			if (top === undefined) {
				break;
			}

			const dependents = adjacency.get(top.key) ?? [];
			const dependent = dependents[top.next];

			if (dependent !== undefined) {
				top.next += 1;

				if (!visited.has(dependent)) {
					visited.add(dependent);
					stack.push({key: dependent, next: 0});
				}

				continue;
			}

			order.push(top.key);
			stack.pop();
		}
	}

	return order;
};

/**
 * Collapses dependency cycles into strongly connected components (Kosaraju).
 *
 * A cycle cannot be ordered by recompilation, so every member of a component
 * receives the same depth and deterministic tie-breaking inside the component.
 *
 * @param order - Depth-first finish order.
 * @param reversed - Dependent-to-prerequisite edges.
 * @returns Component assignment and component count.
 */
const componentGraphOf = (order: readonly string[], reversed: AdjacencyType): ComponentGraphType => {
	const componentOf = new Map<string, number>();
	let count = 0;

	for (let index = order.length - 1; index >= 0; index -= 1) {
		const start = order[index];

		if (start === undefined || componentOf.has(start)) {
			continue;
		}

		componentOf.set(start, count);
		const stack: string[] = [start];

		while (stack.length > 0) {
			const key = stack.pop();

			if (key === undefined) {
				break;
			}

			for (const predecessor of reversed.get(key) ?? []) {
				if (!componentOf.has(predecessor)) {
					componentOf.set(predecessor, count);
					stack.push(predecessor);
				}
			}
		}

		count += 1;
	}

	return {componentOf, count};
};

/**
 * Collects every non-target object reachable from the targets.
 *
 * @param targetKeys - Object keys compiled by the qualification plan.
 * @param edges - Complete dependency edges keyed by referenced object.
 * @returns Reachable compilable dependents keyed by object key.
 */
const reachableObjectsOf = (targetKeys: ReadonlySet<string>, edges: ReadonlyMap<string, readonly CompilableType[]>): ReadonlyMap<string, CompilableType> => {
	const reachable = new Map<string, CompilableType>();
	const expanded = new Set<string>();
	const queue: string[] = [...targetKeys];

	while (queue.length > 0) {
		const key = queue.pop();

		if (key === undefined || expanded.has(key)) {
			continue;
		}

		expanded.add(key);

		for (const dependent of edges.get(key) ?? []) {
			const dependentKey = oracleObjectKeyOf(dependent.type, dependent.name);

			if (targetKeys.has(dependentKey) || reachable.has(dependentKey)) {
				continue;
			}

			reachable.set(dependentKey, dependent);
			queue.push(dependentKey);
		}
	}

	return reachable;
};

/**
 * Builds the dependency edges between reachable objects.
 *
 * @param edges - Complete dependency edges keyed by referenced object.
 * @param reachable - Reachable compilable dependents keyed by object key.
 * @returns Reachable object adjacency keyed by referenced object.
 */
const reachableAdjacencyOf = (
	edges: ReadonlyMap<string, readonly CompilableType[]>,
	reachable: ReadonlyMap<string, CompilableType>,
): ReadonlyMap<string, readonly string[]> => {
	const adjacency = new Map<string, readonly string[]>();

	for (const key of reachable.keys()) {
		const dependents = new Set<string>();

		for (const dependent of edges.get(key) ?? []) {
			const dependentKey = oracleObjectKeyOf(dependent.type, dependent.name);

			if (reachable.has(dependentKey)) {
				dependents.add(dependentKey);
			}
		}

		adjacency.set(key, [...dependents]);
	}

	return adjacency;
};

/**
 * Builds the component graph in prerequisite-to-dependent direction.
 *
 * @param edges - Complete dependency edges keyed by referenced object.
 * @param componentOf - Component assignment for reachable objects.
 * @returns Component adjacency.
 */
const componentEdgesOf = (
	edges: ReadonlyMap<string, readonly CompilableType[]>,
	componentOf: ReadonlyMap<string, number>,
): ReadonlyMap<number, ReadonlySet<number>> => {
	const componentEdges = new Map<number, Set<number>>();

	for (const [key, dependents] of edges) {
		const component = componentOf.get(key);

		if (component === undefined) {
			continue;
		}

		for (const dependent of dependents) {
			const dependentComponent = componentOf.get(oracleObjectKeyOf(dependent.type, dependent.name));

			if (dependentComponent === undefined || dependentComponent === component) {
				continue;
			}

			const group = componentEdges.get(component) ?? new Set<number>();

			group.add(dependentComponent);
			componentEdges.set(component, group);
		}
	}

	return componentEdges;
};

/**
 * Finds the components that directly reference a qualification target.
 *
 * @param targetKeys - Object keys compiled by the qualification plan.
 * @param edges - Complete dependency edges keyed by referenced object.
 * @param componentOf - Component assignment for reachable objects.
 * @returns Components with a target prerequisite.
 */
const targetPrerequisiteComponentsOf = (
	targetKeys: ReadonlySet<string>,
	edges: ReadonlyMap<string, readonly CompilableType[]>,
	componentOf: ReadonlyMap<string, number>,
): ReadonlySet<number> => {
	const components = new Set<number>();

	for (const targetKey of targetKeys) {
		for (const dependent of edges.get(targetKey) ?? []) {
			const component = componentOf.get(oracleObjectKeyOf(dependent.type, dependent.name));

			if (component !== undefined) {
				components.add(component);
			}
		}
	}

	return components;
};

/**
 * Counts incoming component edges, including components without any.
 *
 * @param componentEdges - Component adjacency in prerequisite-to-dependent direction.
 * @param count - Number of components.
 * @returns Component indegree.
 */
const componentIndegreeOf = (componentEdges: ReadonlyMap<number, ReadonlySet<number>>, count: number): ReadonlyMap<number, number> => {
	const indegree = new Map<number, number>();

	for (let component = 0; component < count; component += 1) {
		indegree.set(component, 0);
	}

	for (const dependents of componentEdges.values()) {
		for (const dependent of dependents) {
			indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1);
		}
	}

	return indegree;
};

/**
 * Assigns each component its longest prerequisite depth using topological order.
 *
 * @param componentEdges - Component adjacency in prerequisite-to-dependent direction.
 * @param targetPrerequisites - Components that directly reference a target.
 * @param count - Number of components.
 * @returns Component depth, where direct dependents have depth one.
 */
const componentDepthsOf = (
	componentEdges: ReadonlyMap<number, ReadonlySet<number>>,
	targetPrerequisites: ReadonlySet<number>,
	count: number,
): ReadonlyMap<number, number> => {
	const indegree = new Map(componentIndegreeOf(componentEdges, count));
	const depth = new Map<number, number>();
	const ready: number[] = [];

	for (let component = 0; component < count; component += 1) {
		depth.set(component, 0);
	}

	for (let component = 0; component < count; component += 1) {
		if (indegree.get(component) === 0) {
			ready.push(component);
		}
	}

	while (ready.length > 0) {
		const component = ready.pop();

		if (component === undefined) {
			break;
		}

		const componentDepth = Math.max(depth.get(component) ?? 0, targetPrerequisites.has(component) ? 1 : 0);

		depth.set(component, componentDepth);

		for (const dependent of componentEdges.get(component) ?? []) {
			depth.set(dependent, Math.max(depth.get(dependent) ?? 0, componentDepth + 1));

			const remaining = (indegree.get(dependent) ?? 1) - 1;

			indegree.set(dependent, remaining);

			if (remaining === 0) {
				ready.push(dependent);
			}
		}
	}

	return depth;
};

/**
 * Computes the transitive compilable dependents of the qualification targets.
 *
 * Targets are recompiled first. Every non-target object that transitively
 * references a target is a candidate for invalidation, so the plan binds an
 * ordered `ALTER ... COMPILE` statement for it. Dependents are ordered
 * topologically: an object that invalidates another object compiles first.
 * Dependency cycles are collapsed because no recompilation order can satisfy
 * them, and depth is the longest prerequisite path rather than the shortest
 * discovery path, so a shared dependent never precedes one of its invalidators.
 *
 * @param targets - Installed objects compiled by the qualification plan.
 * @param dependencies - `USER_DEPENDENCIES` edges in the connected schema.
 * @returns Compilable dependents ordered by depth, type, and name.
 */
export const oracleDependentsOf = (
	targets: readonly Readonly<{type: string; name: string}>[],
	dependencies: readonly OracleDependencyRowType[],
): readonly OracleDependentType[] => {
	const targetKeys = new Set(targets.map((target) => oracleObjectKeyOf(target.type, target.name)));
	const edges = new Map<string, CompilableType[]>();

	for (const row of dependencies) {
		const dependent = compilableOf(row.type, row.name);

		if (dependent === null) {
			continue;
		}

		const key = oracleObjectKeyOf(row.referencedType, row.referencedName);
		const group = edges.get(key) ?? [];

		group.push(dependent);
		edges.set(key, group);
	}

	const reachable = reachableObjectsOf(targetKeys, edges);
	const adjacency = reachableAdjacencyOf(edges, reachable);
	const nodes = [...reachable.keys()];
	const order = finishOrderOf(nodes, adjacency);
	const reversed = reverseAdjacencyOf(nodes, adjacency);
	const {componentOf, count} = componentGraphOf(order, reversed);
	const componentEdges = componentEdgesOf(edges, componentOf);
	const targetPrerequisites = targetPrerequisiteComponentsOf(targetKeys, edges, componentOf);
	const depth = componentDepthsOf(componentEdges, targetPrerequisites, count);

	return [...reachable.entries()]
		.map(([key, object]) => {
			const component = componentOf.get(key);

			return {...object, depth: component === undefined ? 1 : Math.max(1, depth.get(component) ?? 0)};
		})
		.sort((left, right) => left.depth - right.depth || typePriority(left.type) - typePriority(right.type) || left.name.localeCompare(right.name));
};
