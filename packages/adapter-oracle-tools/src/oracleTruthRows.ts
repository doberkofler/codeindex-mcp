import {objectKey} from './oracleMapping.ts';
import {ORACLE_TRUTH_OBJECT_TYPES} from './oracleTruthPolicy.ts';

/** One PL/Scope truth row reduced to the fields qualification needs. */
export type OracleParsedTruthRowType = Readonly<{
	objectName: string;
	objectType: string;
	name: string;
	signature: string;
	identifierType: string;
	usage: string;
	line: number;
	column: number;
	usageId: number;
	contextId: number;
}>;

/** Parsed-row outcome, including counted malformed and out-of-scope rows. */
export type ParsedRowResultType = Readonly<{kind: 'row'; value: OracleParsedTruthRowType}> | Readonly<{kind: 'malformed'}> | Readonly<{kind: 'out_of_scope'}>;

type UsageNodeType = Readonly<{identifierType: string; contextId: number}>;

/** Enclosing-usage index keyed by object and PL/Scope usage id. */
export type OracleUsageContextIndexType = ReadonlyMap<string, UsageNodeType>;

const usageNodeKeyOf = (objectName: string, objectType: string, usageId: number): string => `${objectKey(objectType, objectName)}\u0000${String(usageId)}`;

const isRoutineType = (identifierType: string): boolean => {
	const type = identifierType.toUpperCase();

	return type === 'FUNCTION' || type === 'PROCEDURE';
};

/**
 * Parses one exported PL/Scope row.
 *
 * The live export column order is object name, object type, name, signature,
 * identifier type, usage, usage id, line, column, and usage context id.
 *
 * @param row - One CSV row.
 * @returns Parsed row, malformed marker, or out-of-scope marker.
 */
export const parsedRowOf = (row: readonly string[]): ParsedRowResultType => {
	if (row.length < 10) {
		return {kind: 'malformed'};
	}

	const [objectName = '', objectType = '', name = '', signature = '', identifierType = '', usage = '', usageId, line, column, contextId] = row;

	if (!ORACLE_TRUTH_OBJECT_TYPES.has(objectType)) {
		return {kind: 'out_of_scope'};
	}

	return {
		kind: 'row',
		value: {
			objectName,
			objectType,
			name,
			signature,
			identifierType,
			usage,
			line: Number(line),
			column: Number(column),
			usageId: Number(usageId),
			contextId: Number(contextId),
		},
	};
};

/**
 * Indexes usage ids so a declaration can be traced to its enclosing scope.
 *
 * @param rows - Every exported PL/Scope row.
 * @returns Enclosing-usage index.
 */
export const usageContextIndex = (rows: readonly (readonly string[])[]): OracleUsageContextIndexType => {
	const index = new Map<string, UsageNodeType>();

	for (const row of rows) {
		if (row.length < 10) {
			continue;
		}

		const objectName = row[0] ?? '';
		const objectType = row[1] ?? '';
		const identifierType = row[4] ?? '';
		const id = Number(row[6]);
		const context = Number(row[9]);

		if (!Number.isInteger(id) || !Number.isInteger(context)) {
			continue;
		}

		index.set(usageNodeKeyOf(objectName, objectType, id), {identifierType, contextId: context});
	}

	return index;
};

/**
 * Reports whether a declaration is intentionally ephemeral.
 *
 * Parameters and declarations inside a routine are never persisted by the
 * publication surface. Nested named routines are persisted as internal symbols,
 * so they are not ephemeral.
 *
 * @param usageById - Enclosing-usage index for the same export.
 * @param declaration - Declaration to classify.
 * @returns Whether the declaration is outside the publication surface.
 */
export const isEphemeralDeclaration = (usageById: OracleUsageContextIndexType, declaration: OracleParsedTruthRowType): boolean => {
	const type = declaration.identifierType.toUpperCase();

	if (type.startsWith('FORMAL ')) {
		return true;
	}

	if (isRoutineType(type)) {
		return false;
	}

	let {contextId} = declaration;

	for (let depth = 0; depth < 64 && contextId !== 0; depth += 1) {
		const parent = usageById.get(usageNodeKeyOf(declaration.objectName, declaration.objectType, contextId));

		if (parent === undefined) {
			return false;
		}

		if (isRoutineType(parent.identifierType)) {
			return true;
		}

		({contextId} = parent);
	}

	return false;
};
