import {objectKey, positionOf, sourceTokenMatches, type ObjectMappingType} from './oracleMapping.ts';
import {
	emptyTruthExclusionCounts,
	positionKeyOf,
	type ExcludedTruthFactType,
	type OracleTruthExclusionReasonType,
	type TruthExclusionCountsType,
} from './oracleTruthExclusions.ts';
import {
	ORACLE_TRUTH_OBJECT_TYPES,
	ORACLE_TRUTH_POLICY_V3,
	oracleTruthPolicyOf,
	type OracleTruthPolicyType,
	type OracleTruthPolicyVersionType,
} from './oracleTruthPolicy.ts';

/** Upper bound on disagreement samples retained in a qualification report. */
export const ORACLE_COMPARISON_SAMPLE_LIMIT = 20;

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

type OracleTruthExclusionRoleType = 'declaration' | 'reference' | 'none';

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
	malformedRows: number;
	outOfScopeObjectRows: number;
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
	malformedRows: number;
	outOfScopeObjectRows: number;
	ambiguousOverloadPositions: ReadonlySet<string>;
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

type ParsedRowResultType = Readonly<{kind: 'row'; value: ParsedRowType} | {kind: 'malformed'} | {kind: 'out_of_scope'}>;

const parsedRowOf = (row: readonly string[]): ParsedRowResultType => {
	if (row.length < 10) {
		return {kind: 'malformed'};
	}

	const [objectName = '', objectType = '', name = '', signature = '', identifierType = '', usage = '', , line, column] = row;

	if (!ORACLE_TRUTH_OBJECT_TYPES.has(objectType)) {
		return {kind: 'out_of_scope'};
	}

	return {kind: 'row', value: {objectName, objectType, name, signature, identifierType, usage, line: Number(line), column: Number(column)}};
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

	if (input.kind === 'reference' && input.state.policy.filterReferenceTypes && input.supportedKind === undefined) {
		return {role: 'reference', reason: 'unsupported_identifier_type'};
	}

	if (
		input.kind === 'reference' &&
		input.state.policy.omitAmbiguousOverloadInCalls &&
		input.parsed.usage === 'CALL' &&
		input.state.ambiguousOverloadPositions.has(positionKeyOf(input.position))
	) {
		return {role: 'reference', reason: 'omitted_ambiguous_overload'};
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

	return null;
};

const applyTruthRow = (state: TruthStateType, row: readonly string[]): void => {
	const result = parsedRowOf(row);

	if (result.kind === 'malformed') {
		state.malformedRows += 1;
		return;
	}

	if (result.kind === 'out_of_scope') {
		state.outOfScopeObjectRows += 1;
		return;
	}

	const parsed = result.value;
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

		const declarationKeys = new Set<string>();

		for (const declaration of group.declarations) {
			const key = keyOf(declaration, declaration.name);

			declarationKeys.add(key);

			if (definitions.has(key)) {
				exclude(state, declaration, declaration, {role: 'declaration', reason: 'duplicate_fact'});
				continue;
			}

			definitions.set(key, declaration);
		}

		for (const reference of group.references) {
			const key = keyOf(reference, reference.name);

			// PL/Scope reports a constant or field initializer as both a
			// declaration and an assignment at the same location. That assignment is
			// the initializer, not a reference to an existing symbol.
			if (declarationKeys.has(key)) {
				exclude(state, reference, reference, {role: 'reference', reason: 'declaration_initializer'});
				continue;
			}

			if (references.has(key)) {
				exclude(state, reference, reference, {role: 'reference', reason: 'duplicate_fact'});
				continue;
			}

			references.set(key, reference);
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
		malformedRows: state.malformedRows,
		outOfScopeObjectRows: state.outOfScopeObjectRows,
	};
};

/**
 * Reads supported PL/Scope declarations and references from exported rows.
 *
 * `ambiguousOverloadPositions` holds authored positions of emitted
 * `ambiguous-overload` diagnostics. Under the authoritative policy a `CALL`
 * truth row at exactly one of those positions is omitted with a counted
 * reason; no other fact is affected.
 *
 * @param input - CSV rows, indexed object mappings, truth policy, and emitted ambiguity positions.
 * @returns Normalized truth, excluded fact classes, and normalization counters.
 */
export const readOracleTruth = (
	input: Readonly<{
		rows: readonly (readonly string[])[];
		mappings: ReadonlyMap<string, ObjectMappingType>;
		policy?: OracleTruthPolicyType | OracleTruthPolicyVersionType;
		ambiguousOverloadPositions?: ReadonlySet<string> | undefined;
	}>,
): TruthFactsType => {
	const state: TruthStateType = {
		policy: typeof input.policy === 'string' ? oracleTruthPolicyOf(input.policy) : (input.policy ?? ORACLE_TRUTH_POLICY_V3),
		groups: new Map(),
		mappings: input.mappings,
		excluded: [],
		excludedByReason: emptyTruthExclusionCounts(),
		rowsByPath: new Map(),
		identifierRows: 0,
		invalidDeclarationRows: 0,
		excludedPackageReferences: 0,
		malformedRows: 0,
		outOfScopeObjectRows: 0,
		ambiguousOverloadPositions: input.ambiguousOverloadPositions ?? new Set(),
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
	const policy = typeof options.policy === 'string' ? oracleTruthPolicyOf(options.policy) : (options.policy ?? ORACLE_TRUTH_POLICY_V3);
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
			samples: group.samples.length >= ORACLE_COMPARISON_SAMPLE_LIMIT ? group.samples : [...group.samples, fact],
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
			.slice(0, ORACLE_COMPARISON_SAMPLE_LIMIT)
			.map((key) => truth.get(key))
			.filter((value): value is PositionedTruthType => value !== undefined),
		samplesExtra: extraKeys
			.slice(0, ORACLE_COMPARISON_SAMPLE_LIMIT)
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
