import {recompileStatementOf, type OracleCompilableObjectType} from './oracleLiveSource.ts';

/** One ordered recompilation statement and the object it targets. */
export type RecompileStatementType = Readonly<{
	type: string;
	name: string;
	sql: string;
}>;

const typePriority = (type: string): number => (type === 'PACKAGE' ? 0 : type === 'PACKAGE BODY' ? 1 : type === 'FUNCTION' ? 2 : 3);

/**
 * Builds the exact recompilation statements in the order given.
 *
 * Dependent order is dependency depth, so it must not be re-sorted.
 *
 * @param objects - Compilable objects in execution order.
 * @returns Exact `ALTER ... COMPILE` statements.
 */
export const recompileStatementsOf = (objects: readonly OracleCompilableObjectType[]): readonly RecompileStatementType[] =>
	objects.map((object) => ({type: object.type, name: object.name, sql: recompileStatementOf(object)}));

/**
 * Orders qualification targets so package specifications precede their bodies.
 *
 * @param objects - Installed objects selected by the approved plan.
 * @returns Exact `ALTER ... COMPILE` statements in execution order.
 */
export const orderedTargetStatementsOf = (objects: readonly OracleCompilableObjectType[]): readonly RecompileStatementType[] =>
	[...objects]
		.sort((left, right) => typePriority(left.type) - typePriority(right.type) || left.name.localeCompare(right.name))
		.map((object) => ({type: object.type, name: object.name, sql: recompileStatementOf(object)}));
