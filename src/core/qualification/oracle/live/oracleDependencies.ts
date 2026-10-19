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

type TraversalEntryType = Readonly<{
	object: CompilableType;
	depth: number;
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

/**
 * Computes the transitive compilable dependents of the qualification targets.
 *
 * Targets are recompiled first. Every non-target object that transitively
 * references a target is a candidate for invalidation, so the plan binds an
 * ordered `ALTER ... COMPILE` statement for it. Direct dependents precede their
 * dependents, which restores nested views in dependency order.
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

	const visited = new Set<string>(targetKeys);
	const queue: TraversalEntryType[] = targets.map((target) => ({
		object: {type: target.type.toUpperCase(), name: target.name.toUpperCase(), compileClause: ''},
		depth: 0,
	}));
	const dependents: OracleDependentType[] = [];

	for (const current of queue) {
		const group = edges.get(oracleObjectKeyOf(current.object.type, current.object.name)) ?? [];

		for (const dependent of group) {
			const key = oracleObjectKeyOf(dependent.type, dependent.name);

			if (visited.has(key)) {
				continue;
			}

			visited.add(key);
			const entry = {...dependent, depth: current.depth + 1};

			dependents.push(entry);
			queue.push({object: dependent, depth: entry.depth});
		}
	}

	return dependents.sort(
		(left, right) => left.depth - right.depth || typePriority(left.type) - typePriority(right.type) || left.name.localeCompare(right.name),
	);
};
