import {objectKey, positionOf, sourceTokenMatches, type ObjectMappingType} from './oracleMapping.ts';
import {ORACLE_TRUTH_POLICY_V2, oracleTruthPolicyOf, type OracleTruthPolicyType, type OracleTruthPolicyVersionType} from './oracleTruthPolicy.ts';

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
	symbolPath?: string | undefined;
	symbolLine?: number | undefined;
	symbolColumn?: number | undefined;
}>;

type OracleTruthExclusionReasonType =
	| 'unsupported_identifier_type'
	| 'unmapped_usage'
	| 'invalid_declaration'
	| 'package_reference'
	| 'missing_group_declaration';

type OracleTruthExclusionRoleType = 'declaration' | 'reference' | 'none';

export type ExcludedTruthFactType = Readonly<{
	path: string;
	line: number;
	column: number;
	name: string;
	type: string;
	role: OracleTruthExclusionRoleType;
	reason: OracleTruthExclusionReasonType;
}>;

type OracleExtraClassType = 'omitted_by_policy' | 'location_mismatch' | 'outside_plscope' | 'false_positive';

type ExtraClassType = Readonly<{
	count: number;
	samples: readonly CodeOccurrenceType[];
}>;

export type ExtraClassifierType = (fact: CodeOccurrenceType) => OracleExtraClassType;

export type ComparisonType = Readonly<{
	truth: number;
	actual: number;
	matched: number;
	missing: number;
	extra: number;
	ignoredExtra: number;
	recall: number;
	precision: number;
	samplesMissing: readonly PositionedTruthType[];
	samplesExtra: readonly CodeOccurrenceType[];
	extraClasses: Readonly<Record<OracleExtraClassType, ExtraClassType>>;
}>;

export type TruthExclusionCountsType = Readonly<Record<OracleTruthExclusionReasonType, number>>;

export type TruthFactsType = Readonly<{
	policy: OracleTruthPolicyType;
	definitions: ReadonlyMap<string, PositionedTruthType>;
	references: ReadonlyMap<string, PositionedTruthType>;
	excluded: readonly ExcludedTruthFactType[];
	excludedByReason: TruthExclusionCountsType;
	rowsByPath: ReadonlyMap<string, number>;
	identifierRows: number;
	invalidDeclarationRows: number;
	excludedPackageReferences: number;
}>;

export type CompareOptionsType = Readonly<{
	policy?: OracleTruthPolicyType | OracleTruthPolicyVersionType;
	role?: 'declaration' | 'reference' | undefined;
	excluded?: readonly ExcludedTruthFactType[];
	classifyExtra?: ExtraClassifierType | undefined;
}>;

type GroupType = Readonly<{declarations: PositionedTruthType[]; references: PositionedTruthType[]}>;

const keyOf = (position: Readonly<{path: string; line: number; column: number}>, name: string): string =>
	`${position.path}:${String(position.line)}:${String(position.column)}:${name.toLowerCase()}`;

const typeKeyOf = (identifierType: string): string => identifierType.toUpperCase();

const declarationTypeOf = (policy: OracleTruthPolicyType, status: string, identifierType: string): 'declaration' | 'reference' | null => {
	if (status === 'DECLARATION') {
		return 'declaration';
	}

	if (status === 'DEFINITION') {
		return policy.definitionTypes.has(typeKeyOf(identifierType)) ? 'declaration' : 'reference';
	}

	if (policy.referenceUsages.has(status)) {
		return 'reference';
	}

	return null;
};

const emptyExclusionCounts = (): Record<OracleTruthExclusionReasonType, number> => ({
	unsupported_identifier_type: 0,
	unmapped_usage: 0,
	invalid_declaration: 0,
	package_reference: 0,
	missing_group_declaration: 0,
});

type TruthStateType = {
	policy: OracleTruthPolicyType;
	groups: Map<string, GroupType>;
	mappings: ReadonlyMap<string, ObjectMappingType>;
	excluded: ExcludedTruthFactType[];
	excludedByReason: Record<OracleTruthExclusionReasonType, number>;
	rowsByPath: Map<string, number>;
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

const identityOf = (parsed: ParsedRowType): Readonly<{name: string; type: string}> => ({name: parsed.name, type: parsed.identifierType});

type ExclusionDecisionType = Readonly<{role: OracleTruthExclusionRoleType; reason: OracleTruthExclusionReasonType}>;

const exclude = (
	state: TruthStateType,
	position: Readonly<{path: string; line: number; column: number}>,
	fact: Readonly<{name: string; type: string}>,
	decision: ExclusionDecisionType,
): void => {
	state.excluded.push({...position, name: fact.name, type: fact.type, role: decision.role, reason: decision.reason});
	state.excludedByReason[decision.reason] += 1;
};

const exclusionFor = (
	input: Readonly<{
		state: TruthStateType;
		parsed: ParsedRowType;
		mapping: ObjectMappingType;
		position: Readonly<{path: string; line: number; column: number}>;
		kind: 'declaration' | 'reference' | null;
		supportedKind: string | undefined;
	}>,
): ExclusionDecisionType | null => {
	if (input.kind === null) {
		return {role: 'none', reason: 'unmapped_usage'};
	}

	if (input.kind === 'reference' && typeKeyOf(input.parsed.identifierType) === 'PACKAGE') {
		input.state.excludedPackageReferences += 1;
		return {role: 'reference', reason: 'package_reference'};
	}

	if (input.kind === 'declaration' && (input.supportedKind === undefined || !sourceTokenMatches(input.mapping, input.position, input.parsed.name))) {
		input.state.invalidDeclarationRows += 1;
		return {
			role: 'declaration',
			reason: input.supportedKind === undefined ? 'unsupported_identifier_type' : 'invalid_declaration',
		};
	}

	if (input.kind === 'reference' && input.state.policy.filterReferenceTypes && input.supportedKind === undefined) {
		return {role: 'reference', reason: 'unsupported_identifier_type'};
	}

	return null;
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
	state.rowsByPath.set(mapping.path, (state.rowsByPath.get(mapping.path) ?? 0) + 1);

	const position = positionOf(mapping, parsed.line, parsed.column);
	const kind = declarationTypeOf(state.policy, parsed.usage, parsed.identifierType);
	const supportedKind = state.policy.supportedTypes[typeKeyOf(parsed.identifierType)];
	const decision = exclusionFor({state, parsed, mapping, position, kind, supportedKind});

	if (decision !== null) {
		exclude(state, position, identityOf(parsed), decision);
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
			for (const reference of group.references) {
				exclude(state, reference, reference, {role: 'reference', reason: 'missing_group_declaration'});
			}

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
		policy: state.policy,
		definitions,
		references,
		excluded: state.excluded,
		excludedByReason: state.excludedByReason,
		rowsByPath: state.rowsByPath,
		identifierRows: state.identifierRows,
		invalidDeclarationRows: state.invalidDeclarationRows,
		excludedPackageReferences: state.excludedPackageReferences,
	};
};

/**
 * Reads supported PL/Scope declarations and references from exported rows.
 *
 * @param input - CSV rows, indexed object mappings, and the truth policy.
 * @returns Normalized truth, excluded fact classes, and normalization counters.
 */
export const readOracleTruth = (
	input: Readonly<{
		rows: readonly (readonly string[])[];
		mappings: ReadonlyMap<string, ObjectMappingType>;
		policy?: OracleTruthPolicyType | OracleTruthPolicyVersionType;
	}>,
): TruthFactsType => {
	const state: TruthStateType = {
		policy: typeof input.policy === 'string' ? oracleTruthPolicyOf(input.policy) : (input.policy ?? ORACLE_TRUTH_POLICY_V2),
		groups: new Map(),
		mappings: input.mappings,
		excluded: [],
		excludedByReason: emptyExclusionCounts(),
		rowsByPath: new Map(),
		identifierRows: 0,
		invalidDeclarationRows: 0,
		excludedPackageReferences: 0,
	};

	for (const row of input.rows) {
		applyTruthRow(state, row);
	}

	return factsOf(state);
};

const extraClassesOf = (): Record<OracleExtraClassType, ExtraClassType> => ({
	omitted_by_policy: {count: 0, samples: []},
	location_mismatch: {count: 0, samples: []},
	outside_plscope: {count: 0, samples: []},
	false_positive: {count: 0, samples: []},
});

const kindMatchesTruth = (policy: OracleTruthPolicyType, truth: PositionedTruthType, fact: CodeOccurrenceType): boolean => {
	const mapped = policy.supportedTypes[typeKeyOf(truth.type)];

	return mapped !== undefined && mapped === fact.kind;
};

type TruthNameIndexType = ReadonlyMap<string, ReadonlyMap<string, readonly PositionedTruthType[]>>;

const truthNameIndex = (truth: ReadonlyMap<string, PositionedTruthType>): TruthNameIndexType => {
	const paths = new Map<string, Map<string, PositionedTruthType[]>>();

	for (const candidate of truth.values()) {
		const names = paths.get(candidate.path) ?? new Map<string, PositionedTruthType[]>();
		const key = candidate.name.toLowerCase();
		const group = names.get(key) ?? [];

		group.push(candidate);
		names.set(key, group);
		paths.set(candidate.path, names);
	}

	return paths;
};

const nearbyTruth = (index: TruthNameIndexType, fact: CodeOccurrenceType, policy: OracleTruthPolicyType): boolean =>
	(index.get(fact.path)?.get(fact.name.toLowerCase()) ?? []).some(
		(candidate) =>
			kindMatchesTruth(policy, candidate, fact) &&
			(candidate.line === fact.line || (Math.abs(candidate.line - fact.line) <= 1 && Math.abs(candidate.column - fact.column) <= 2)),
	);

const classifyExtra = (
	input: Readonly<{
		fact: CodeOccurrenceType;
		nearbyIndex: TruthNameIndexType;
		excludedKeys: ReadonlySet<string>;
		policy: OracleTruthPolicyType;
		classifier: ExtraClassifierType | undefined;
	}>,
): OracleExtraClassType => {
	if (input.excludedKeys.has(keyOf(input.fact, input.fact.name))) {
		return 'omitted_by_policy';
	}

	if (nearbyTruth(input.nearbyIndex, input.fact, input.policy)) {
		return 'location_mismatch';
	}

	if (input.classifier !== undefined) {
		return input.classifier(input.fact);
	}

	return 'false_positive';
};

/**
 * Compares normalized truth with indexed occurrences.
 *
 * @param truth - Truth keyed by path, line, column, and name.
 * @param actual - Indexed facts keyed the same way.
 * @param options - Policy, fact role, excluded truth rows, and an optional source-aware classifier.
 * @returns Accuracy, bounded disagreement samples, and extra-fact classes.
 */
export const compareFacts = (
	truth: ReadonlyMap<string, PositionedTruthType>,
	actual: ReadonlyMap<string, CodeOccurrenceType>,
	options: CompareOptionsType = {},
): ComparisonType => {
	const policy = typeof options.policy === 'string' ? oracleTruthPolicyOf(options.policy) : (options.policy ?? ORACLE_TRUTH_POLICY_V2);
	const truthKeys = new Set(truth.keys());
	const actualKeys = new Set([...actual.entries()].filter(([, value]) => policy.supportedKinds.has(value.kind)).map(([key]) => key));
	const matched = [...truthKeys].filter((key) => actualKeys.has(key)).length;
	const missingKeys = [...truthKeys].filter((key) => !actualKeys.has(key));
	const extraKeys = [...actualKeys].filter((key) => !truthKeys.has(key));
	const extraClasses = extraClassesOf();
	const excludedKeys = new Set(
		(options.excluded ?? [])
			.filter((candidate) => options.role === undefined || candidate.role === options.role || candidate.role === 'none')
			.map((candidate) => keyOf(candidate, candidate.name)),
	);
	const nearbyIndex = truthNameIndex(truth);

	for (const key of extraKeys) {
		const fact = actual.get(key);

		if (fact === undefined) {
			continue;
		}

		const extraClass = classifyExtra({fact, nearbyIndex, excludedKeys, policy, classifier: options.classifyExtra});
		const group = extraClasses[extraClass];

		extraClasses[extraClass] = {
			count: group.count + 1,
			samples: group.samples.length >= 20 ? group.samples : [...group.samples, fact],
		};
	}

	const ignoredExtra = extraClasses.omitted_by_policy.count + extraClasses.location_mismatch.count + extraClasses.outside_plscope.count;
	const scoredActual = actualKeys.size - ignoredExtra;

	return {
		truth: truthKeys.size,
		actual: actualKeys.size,
		matched,
		missing: missingKeys.length,
		extra: extraKeys.length,
		ignoredExtra,
		recall: truthKeys.size === 0 ? 1 : matched / truthKeys.size,
		precision: scoredActual === 0 ? 1 : matched / scoredActual,
		samplesMissing: missingKeys
			.slice(0, 20)
			.map((key) => truth.get(key))
			.filter((value): value is PositionedTruthType => value !== undefined),
		samplesExtra: extraKeys
			.slice(0, 20)
			.map((key) => actual.get(key))
			.filter((value): value is CodeOccurrenceType => value !== undefined),
		extraClasses,
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
