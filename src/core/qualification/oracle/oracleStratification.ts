import {type CodeFactsType} from './oracleCodeFacts.ts';
import {type ObjectMappingType} from './oracleMapping.ts';
import {
	compareFacts,
	type CodeOccurrenceType,
	type ComparisonType,
	type ExcludedTruthFactType,
	type ExtraClassifierType,
	type PositionedTruthType,
} from './oracleTruth.ts';
import {type OracleTruthPolicyType} from './oracleTruthPolicy.ts';

type OracleReferenceStratumType = 'procedural' | 'static_sql' | 'member_chain' | 'iterator' | 'pragma' | 'type_anchor';

export type OracleStratifiedComparisonType = Readonly<{
	declarations: Readonly<Record<string, ComparisonType>>;
	references: Readonly<Record<OracleReferenceStratumType, ComparisonType>>;
}>;

export type OracleStratifyInputType = Readonly<{
	truth: Readonly<{
		definitions: ReadonlyMap<string, PositionedTruthType>;
		references: ReadonlyMap<string, PositionedTruthType>;
		excluded: readonly ExcludedTruthFactType[];
	}>;
	actual: Pick<CodeFactsType, 'definitions' | 'references'>;
	mappings: ReadonlyMap<string, ObjectMappingType>;
	policy: OracleTruthPolicyType;
	classifyExtra?: ExtraClassifierType | undefined;
}>;

const lineOf = (mappings: ReadonlyMap<string, ObjectMappingType>, path: string, line: number): string => mappings.get(path)?.lines[line - 1] ?? '';

const isTypeAnchor = (line: string, column: number, name: string): boolean => /^%\s*(?:type|rowtype)\b/iu.test(line.slice(column - 1 + name.length));

const isPragma = (line: string, column: number): boolean => /\bpragma\b/iu.test(line.slice(0, Math.max(0, column - 1)));

const isMemberChain = (line: string, column: number): boolean =>
	line
		.slice(0, Math.max(0, column - 1))
		.trimEnd()
		.endsWith('.');

const isIteratorType = (type: string): boolean => type.toUpperCase() === 'ITERATOR' || type.toUpperCase() === 'RECORD ITERATOR';

const isStaticSql = (lines: readonly string[], line: number, column: number): boolean => {
	let chunk = '';
	let index = line - 1;

	while (index >= 0 && line - index <= 100) {
		const text = lines[index] ?? '';
		const segment = text.slice(0, index === line - 1 ? Math.max(0, column - 1) : text.length);
		const semicolon = segment.lastIndexOf(';');

		if (semicolon !== -1) {
			chunk = `${segment.slice(semicolon + 1)}${chunk}`;
			break;
		}

		chunk = `${segment}\n${chunk}`;
		index -= 1;
	}

	return /\b(?:select|insert|update|delete|merge)\b/iu.test(chunk);
};

const escapePattern = (value: string): string => value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

const isIteratorDeclaration = (line: string | undefined, name: string): boolean =>
	line !== undefined && new RegExp(`\\bfor\\s+${escapePattern(name)}\\s+in\\b`, 'iu').test(line);

const referenceStratumOf = (
	fact: Readonly<{
		path: string;
		line: number;
		column: number;
		name: string;
		type?: string | undefined;
		kind?: string | undefined;
		symbolPath?: string | undefined;
		symbolLine?: number | undefined;
	}>,
	mappings: ReadonlyMap<string, ObjectMappingType>,
): OracleReferenceStratumType => {
	const line = lineOf(mappings, fact.path, fact.line);
	const declarationLine = fact.symbolLine === undefined ? undefined : lineOf(mappings, fact.symbolPath ?? fact.path, fact.symbolLine);

	if ((fact.type !== undefined && isIteratorType(fact.type)) || (fact.kind === 'variable' && isIteratorDeclaration(declarationLine, fact.name))) {
		return 'iterator';
	}

	if (isTypeAnchor(line, fact.column, fact.name)) {
		return 'type_anchor';
	}

	if (isPragma(line, fact.column)) {
		return 'pragma';
	}

	if (isMemberChain(line, fact.column)) {
		return 'member_chain';
	}

	return isStaticSql(mappings.get(fact.path)?.lines ?? [], fact.line, fact.column) ? 'static_sql' : 'procedural';
};

const declarationKindOf = (policy: OracleTruthPolicyType, type: string): string => policy.supportedTypes[type.toUpperCase()] ?? type.toLowerCase();

const addGrouped = <T>(groups: Map<string, Map<string, T>>, group: string, key: string, value: T): void => {
	const values = groups.get(group) ?? new Map<string, T>();

	values.set(key, value);
	groups.set(group, values);
};

type CompareGroupedInputType<T extends PositionedTruthType, U extends CodeOccurrenceType> = Readonly<{
	truth: ReadonlyMap<string, T>;
	actual: ReadonlyMap<string, U>;
	truthKeyOf: (value: T) => string;
	actualKeyOf: (value: U) => string;
	role: 'declaration' | 'reference';
	policy: OracleTruthPolicyType;
	excluded: readonly ExcludedTruthFactType[];
	classifyExtra?: ExtraClassifierType | undefined;
}>;

const compareGrouped = <T extends PositionedTruthType, U extends CodeOccurrenceType>(
	input: CompareGroupedInputType<T, U>,
): Readonly<Record<string, ComparisonType>> => {
	const truthGroups = new Map<string, Map<string, T>>();
	const actualGroups = new Map<string, Map<string, U>>();

	for (const [key, value] of input.truth) {
		addGrouped(truthGroups, input.truthKeyOf(value), key, value);
	}

	for (const [key, value] of input.actual) {
		addGrouped(actualGroups, input.actualKeyOf(value), key, value);
	}

	const groups = [...new Set([...truthGroups.keys(), ...actualGroups.keys()])].sort();
	const result: Record<string, ComparisonType> = {};

	for (const group of groups) {
		result[group] = compareFacts(truthGroups.get(group) ?? new Map(), actualGroups.get(group) ?? new Map(), {
			policy: input.policy,
			role: input.role,
			excluded: input.excluded,
			classifyExtra: input.classifyExtra,
		});
	}

	return result;
};

/**
 * Computes declaration-kind and reference-construct strata under one truth policy.
 *
 * @param input - Truth maps, indexed facts, source mappings, policy, and extra classifier.
 * @returns Comparison metrics for every observed declaration kind and each reference construct.
 */
export const compareOracleStrata = (input: OracleStratifyInputType): OracleStratifiedComparisonType => {
	const declarations = compareGrouped({
		truth: input.truth.definitions,
		actual: input.actual.definitions,
		truthKeyOf: (value) => declarationKindOf(input.policy, value.type),
		actualKeyOf: (value) => value.kind,
		role: 'declaration',
		policy: input.policy,
		excluded: input.truth.excluded,
		classifyExtra: input.classifyExtra,
	});
	const references = compareGrouped({
		truth: input.truth.references,
		actual: input.actual.references,
		truthKeyOf: (value) => referenceStratumOf(value, input.mappings),
		actualKeyOf: (value) => referenceStratumOf(value, input.mappings),
		role: 'reference',
		policy: input.policy,
		excluded: input.truth.excluded,
		classifyExtra: input.classifyExtra,
	});
	const empty = compareFacts(new Map(), new Map(), {policy: input.policy});
	const completeReferences: Record<OracleReferenceStratumType, ComparisonType> = {
		procedural: references['procedural'] ?? empty,
		static_sql: references['static_sql'] ?? empty,
		member_chain: references['member_chain'] ?? empty,
		iterator: references['iterator'] ?? empty,
		pragma: references['pragma'] ?? empty,
		type_anchor: references['type_anchor'] ?? empty,
	};

	return {declarations, references: completeReferences};
};
