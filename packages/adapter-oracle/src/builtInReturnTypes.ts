import {type OracleReferenceArgumentType} from './syntax.ts';

const CHARACTER_TYPES = new Set(['VARCHAR2', 'VARCHAR', 'CHAR', 'NCHAR', 'NVARCHAR2', 'CLOB', 'NCLOB', 'LONG']);
const NUMERIC_TYPES = new Set([
	'NUMBER',
	'PLS_INTEGER',
	'SIMPLE_INTEGER',
	'BINARY_INTEGER',
	'INTEGER',
	'INT',
	'SMALLINT',
	'DECIMAL',
	'NUMERIC',
	'FLOAT',
	'REAL',
	'BINARY_FLOAT',
	'BINARY_DOUBLE',
	'NATURAL',
	'NATURALN',
	'POSITIVE',
	'POSITIVEN',
]);
const NUMERIC_PRECEDENCE = ['BINARY_DOUBLE', 'BINARY_FLOAT', 'NUMBER'] as const;

type TypeOfType = (argument: OracleReferenceArgumentType, depth: number) => string | null;

const numericReturnTypeOf = (left: string, right: string): string | null => {
	if (!NUMERIC_TYPES.has(left) || !NUMERIC_TYPES.has(right)) {
		return null;
	}

	return NUMERIC_PRECEDENCE.find((identity) => identity === left || identity === right) ?? 'NUMBER';
};

const roundReturnTypeOf = (invocation: readonly OracleReferenceArgumentType[], depth: number, typeOf: TypeOfType): string | null => {
	if (invocation.length !== 1 && invocation.length !== 2) {
		return null;
	}

	const [firstArgument] = invocation;
	const first = firstArgument === undefined ? null : typeOf(firstArgument, depth + 1);

	if (first === 'DATE') {
		return 'DATE';
	}

	if (first === null || !NUMERIC_TYPES.has(first)) {
		return null;
	}

	return invocation.length === 2 ? 'NUMBER' : first;
};

const nvlReturnTypeOf = (invocation: readonly OracleReferenceArgumentType[], depth: number, typeOf: TypeOfType): string | null => {
	const [firstArgument, secondArgument] = invocation;

	if (invocation.length !== 2 || firstArgument === undefined || secondArgument === undefined) {
		return null;
	}

	const first = typeOf(firstArgument, depth + 1);

	if (first === null) {
		return null;
	}

	if (CHARACTER_TYPES.has(first)) {
		return 'VARCHAR2';
	}

	const second = typeOf(secondArgument, depth + 1);

	return second === null ? null : numericReturnTypeOf(first, second);
};

/**
 * Resolves documented return rules for the retained Oracle built-ins.
 *
 * Unknown, qualified, malformed, and unsupported calls stay unresolved.
 *
 * @param argument - Call-shaped expression.
 * @param depth - Current recursive expression depth.
 * @param typeOf - Recursive argument type resolver.
 * @returns Canonical return identity, or null without conclusive evidence.
 */
export const builtInReturnTypeOf = (argument: OracleReferenceArgumentType, depth: number, typeOf: TypeOfType): string | null => {
	if (depth > 4 || argument.leadName?.parts.length !== 1 || argument.invocation === undefined) {
		return null;
	}

	const [name] = argument.leadName.parts;
	const canonical = name?.canonical ?? '';

	if (canonical === 'TO_CLOB' && argument.invocation.length > 0) {
		return 'CLOB';
	}

	if (canonical === 'ROUND') {
		return roundReturnTypeOf(argument.invocation, depth, typeOf);
	}

	return canonical === 'NVL' ? nvlReturnTypeOf(argument.invocation, depth, typeOf) : null;
};
