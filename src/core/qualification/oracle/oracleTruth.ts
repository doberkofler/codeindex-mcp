import {objectKey, positionOf, sourceTokenMatches, type ObjectMappingType} from './oracleMapping.ts';

export type PositionedTruthType = Readonly<{
	path: string;
	line: number;
	column: number;
	name: string;
	type: string;
}>;

export type CodeOccurrenceType = Readonly<{
	path: string;
	line: number;
	column: number;
	name: string;
	kind: string;
}>;

export type ComparisonType = Readonly<{
	truth: number;
	actual: number;
	matched: number;
	missing: number;
	extra: number;
	recall: number;
	precision: number;
	samplesMissing: readonly PositionedTruthType[];
	samplesExtra: readonly CodeOccurrenceType[];
}>;

export type TruthFactsType = Readonly<{
	definitions: ReadonlyMap<string, PositionedTruthType>;
	references: ReadonlyMap<string, PositionedTruthType>;
	identifierRows: number;
	invalidDeclarationRows: number;
	excludedPackageReferences: number;
}>;

const SUPPORTED_TYPES: Readonly<Record<string, string>> = {
	PACKAGE: 'package',
	FUNCTION: 'function',
	PROCEDURE: 'procedure',
	'FORMAL IN': 'parameter',
	'FORMAL OUT': 'parameter',
	'FORMAL IN OUT': 'parameter',
	VARIABLE: 'variable',
	CONSTANT: 'constant',
	CURSOR: 'cursor',
	RECORD: 'record_type',
	'RECORD FIELD': 'field',
	SUBTYPE: 'subtype',
	EXCEPTION: 'exception',
	REFCURSOR: 'cursor',
	'INDEX TABLE': 'collection_type',
	'ASSOCIATIVE ARRAY': 'collection_type',
	'NESTED TABLE': 'collection_type',
	VARRAY: 'collection_type',
};

const DEFINITION_TYPES = new Set(['PACKAGE', 'FUNCTION', 'PROCEDURE']);
const REFERENCE_USAGES = new Set(['REFERENCE', 'ASSIGNMENT', 'CALL']);
const SUPPORTED_KINDS = new Set([...Object.values(SUPPORTED_TYPES), 'package']);

type GroupType = Readonly<{declarations: PositionedTruthType[]; references: PositionedTruthType[]}>;

const keyOf = (position: Readonly<{path: string; line: number; column: number}>, name: string): string =>
	`${position.path}:${String(position.line)}:${String(position.column)}:${name.toLowerCase()}`;

const declarationTypeOf = (status: string, identifierType: string): 'declaration' | 'reference' | null => {
	if (status === 'DECLARATION' || (status === 'DEFINITION' && DEFINITION_TYPES.has(identifierType))) {
		return 'declaration';
	}

	if (REFERENCE_USAGES.has(status) || (status === 'DEFINITION' && !DEFINITION_TYPES.has(identifierType))) {
		return 'reference';
	}

	return null;
};

type TruthStateType = {
	groups: Map<string, GroupType>;
	mappings: ReadonlyMap<string, ObjectMappingType>;
	identifierRows: number;
	invalidDeclarationRows: number;
	excludedPackageReferences: number;
};

type ParsedRowType = Readonly<{
	objectName: string;
	objectType: string;
	name: string;
	signature: string;
	identifierType: string;
	usage: string;
	line: number;
	column: number;
}>;

const parsedRowOf = (row: readonly string[]): ParsedRowType | null => {
	if (row.length < 10) {
		return null;
	}

	const [objectName = '', objectType = '', name = '', signature = '', identifierType = '', usage = '', , line, column] = row;

	if (!['PACKAGE', 'PACKAGE BODY', 'FUNCTION', 'PROCEDURE'].includes(objectType)) {
		return null;
	}

	return {objectName, objectType, name, signature, identifierType, usage, line: Number(line), column: Number(column)};
};

const applyTruthRow = (state: TruthStateType, row: readonly string[]): void => {
	const parsed = parsedRowOf(row);

	if (parsed === null) {
		return;
	}

	const mapping = state.mappings.get(objectKey(parsed.objectType, parsed.objectName));

	if (mapping === undefined) {
		throw new Error(`Cannot map PL/Scope object ${parsed.objectType} ${parsed.objectName} to an indexed file`);
	}

	state.identifierRows += 1;
	const position = positionOf(mapping, parsed.line, parsed.column);
	const kind = declarationTypeOf(parsed.usage, parsed.identifierType);

	if (kind === null) {
		return;
	}

	if (kind === 'reference' && parsed.identifierType === 'PACKAGE') {
		state.excludedPackageReferences += 1;
		return;
	}

	if (kind === 'declaration' && (SUPPORTED_TYPES[parsed.identifierType] === undefined || !sourceTokenMatches(mapping, position, parsed.name))) {
		state.invalidDeclarationRows += 1;
		return;
	}

	const group = state.groups.get(parsed.signature) ?? {declarations: [], references: []};
	const item = {...position, name: parsed.name, type: parsed.identifierType};

	if (kind === 'declaration') {
		group.declarations.push(item);
	} else {
		group.references.push(item);
	}

	state.groups.set(parsed.signature, group);
};

const factsOf = (state: TruthStateType): TruthFactsType => {
	const definitions = new Map<string, PositionedTruthType>();
	const references = new Map<string, PositionedTruthType>();

	for (const group of state.groups.values()) {
		if (group.declarations.length === 0) {
			continue;
		}

		for (const declaration of group.declarations) {
			definitions.set(keyOf(declaration, declaration.name), declaration);
		}

		for (const reference of group.references) {
			references.set(keyOf(reference, reference.name), reference);
		}
	}

	return {
		definitions,
		references,
		identifierRows: state.identifierRows,
		invalidDeclarationRows: state.invalidDeclarationRows,
		excludedPackageReferences: state.excludedPackageReferences,
	};
};

/**
 * Reads supported PL/Scope declarations and references from exported rows.
 *
 * @param input - CSV rows and indexed object mappings.
 * @returns Normalized truth and normalization counters.
 */
export const readOracleTruth = (input: Readonly<{rows: readonly (readonly string[])[]; mappings: ReadonlyMap<string, ObjectMappingType>}>): TruthFactsType => {
	const state: TruthStateType = {
		groups: new Map(),
		mappings: input.mappings,
		identifierRows: 0,
		invalidDeclarationRows: 0,
		excludedPackageReferences: 0,
	};

	for (const row of input.rows) {
		applyTruthRow(state, row);
	}

	return factsOf(state);
};

/**
 * Compares normalized truth with indexed occurrences.
 *
 * @param truth - Truth keyed by path, line, column, and name.
 * @param actual - Indexed facts keyed the same way.
 * @returns Accuracy and bounded disagreement samples.
 */
export const compareFacts = (truth: ReadonlyMap<string, PositionedTruthType>, actual: ReadonlyMap<string, CodeOccurrenceType>): ComparisonType => {
	const truthKeys = new Set(truth.keys());
	const actualKeys = new Set([...actual.entries()].filter(([, value]) => SUPPORTED_KINDS.has(value.kind)).map(([key]) => key));
	const matched = [...truthKeys].filter((key) => actualKeys.has(key)).length;
	const missingKeys = [...truthKeys].filter((key) => !actualKeys.has(key));
	const extraKeys = [...actualKeys].filter((key) => !truthKeys.has(key));

	return {
		truth: truthKeys.size,
		actual: actualKeys.size,
		matched,
		missing: missingKeys.length,
		extra: extraKeys.length,
		recall: truthKeys.size === 0 ? 1 : matched / truthKeys.size,
		precision: actualKeys.size === 0 ? 1 : matched / actualKeys.size,
		samplesMissing: missingKeys
			.slice(0, 20)
			.map((key) => truth.get(key))
			.filter((value): value is PositionedTruthType => value !== undefined),
		samplesExtra: extraKeys
			.slice(0, 20)
			.map((key) => actual.get(key))
			.filter((value): value is CodeOccurrenceType => value !== undefined),
	};
};

/**
 * Evaluates one accuracy section.
 *
 * @param comparison - Accuracy values.
 * @param recallGate - Required recall.
 * @returns Gate result.
 */
export const gateOf = (
	comparison: Readonly<{recall: number; precision: number}>,
	recallGate: number,
): Readonly<{ok: boolean; recall: boolean; precision: boolean}> => ({
	recall: comparison.recall >= recallGate,
	precision: comparison.precision >= 1,
	ok: comparison.recall >= recallGate && comparison.precision >= 1,
});
