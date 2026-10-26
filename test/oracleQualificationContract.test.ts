import {describe, expect, it} from 'vitest';
import {objectKey, type ObjectMappingType} from '../src/core/qualification/oracle/oracleMapping.ts';
import {
	ORACLE_QUALIFICATION_CONTRACT,
	oracleGatesOf,
	oracleQualificationContractIdentityOf,
} from '../src/core/qualification/oracle/oracleQualificationContract.ts';
import {DEPENDENCIES_SQL, IDENTIFIERS_SQL} from '../src/core/qualification/oracle/live/oracleLiveSql.ts';
import {readOracleTruth} from '../src/core/qualification/oracle/oracleTruth.ts';
import {ORACLE_DEPENDENCY_EXCLUSION_REASONS} from '../src/core/qualification/oracle/oracleDependencyExclusions.ts';
import {ORACLE_TRUTH_EXCLUSION_REASONS, positionKeyOf, type OracleTruthExclusionReasonType} from '../src/core/qualification/oracle/oracleTruthExclusions.ts';
import {
	ORACLE_TRUTH_OBJECT_TYPES,
	ORACLE_TRUTH_POLICY_V1,
	ORACLE_TRUTH_POLICY_V2,
	ORACLE_TRUTH_POLICY_V3,
	ORACLE_TRUTH_POLICY_V4,
	ORACLE_TRUTH_POLICY_V5,
	oracleTruthPolicyOf,
} from '../src/core/qualification/oracle/oracleTruthPolicy.ts';

const mappingOf = (lines: readonly string[]): ObjectMappingType => ({path: 'source.pkg', offset: 0, columnShift: 0, lines});

const truthRow = (
	input: Readonly<{
		name: string;
		type: string;
		usage: string;
		line: number;
		column: number;
		signature?: string;
		objectType?: string;
		objectName?: string;
		usageId?: number;
		contextId?: number;
	}>,
): readonly string[] => [
	input.objectName ?? 'demo',
	input.objectType ?? 'PACKAGE',
	input.name,
	input.signature ?? 'demo',
	input.type,
	input.usage,
	String(input.usageId ?? 0),
	String(input.line),
	String(input.column),
	String(input.contextId ?? 0),
];

const mappingsOf = (lines: readonly string[]): ReadonlyMap<string, ObjectMappingType> => new Map([[objectKey('PACKAGE', 'demo'), mappingOf(lines)]]);

const emptyByReason = (): Readonly<Record<OracleTruthExclusionReasonType, number>> =>
	readOracleTruth({rows: [], mappings: new Map(), policy: ORACLE_TRUTH_POLICY_V4}).excludedByReason;

describe('Oracle O1 qualification contract identity', () => {
	it('freezes exactly one authoritative contract', () => {
		const identity = oracleQualificationContractIdentityOf();

		expect(identity).toStrictEqual({
			id: 'oracle-o1',
			version: '4',
			hash: 'ee83f2ece96074969137447c773c42bfc6400261d1ccefd597bd830ed389e95f',
			truthPolicy: 'v5',
			thresholds: {declarations: 0.995, references: 0.995, dependencies: 0.995, precision: 1},
			emptyTruth: 'fail',
			sampleLimit: 20,
			objectTypes: ['FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'PROCEDURE'],
			exclusionReasons: [...ORACLE_TRUTH_EXCLUSION_REASONS],
			dependencyExclusions: [...ORACLE_DEPENDENCY_EXCLUSION_REASONS],
			ambiguity: {diagnosticCode: 9105, usage: 'CALL', positionMatch: 'exact path/line/column'},
			unmappedObject: 'abort',
		});
		expect(oracleTruthPolicyOf()).toBe(ORACLE_TRUTH_POLICY_V5);
		expect(oracleTruthPolicyOf('v5')).toBe(ORACLE_TRUTH_POLICY_V5);
		expect(oracleTruthPolicyOf('v4')).toBe(ORACLE_TRUTH_POLICY_V4);
		expect(oracleTruthPolicyOf('v3')).toBe(ORACLE_TRUTH_POLICY_V3);
		expect(oracleTruthPolicyOf('v2')).toBe(ORACLE_TRUTH_POLICY_V2);
		expect(oracleTruthPolicyOf('v1')).toBe(ORACLE_TRUTH_POLICY_V1);
		expect(ORACLE_TRUTH_POLICY_V5.omitAmbiguousOverloadInCalls).toBe(true);
		expect(ORACLE_TRUTH_POLICY_V5.excludeEphemeralDeclarations).toBe(true);
		expect(ORACLE_TRUTH_POLICY_V4.omitAmbiguousOverloadInCalls).toBe(true);
		expect(ORACLE_TRUTH_POLICY_V4.excludeEphemeralDeclarations).toBe(true);
		expect(ORACLE_TRUTH_POLICY_V3.excludeEphemeralDeclarations).toBe(false);
		expect(ORACLE_TRUTH_POLICY_V2.omitAmbiguousOverloadInCalls).toBe(false);
	});

	it('exports every contract object type, including procedures', () => {
		for (const sql of [IDENTIFIERS_SQL, DEPENDENCIES_SQL]) {
			for (const type of ORACLE_QUALIFICATION_CONTRACT.objectTypes) {
				expect(sql).toContain(`'${type}'`);
			}
		}
	});

	it('declares every runtime exclusion reason', () => {
		expect(ORACLE_QUALIFICATION_CONTRACT.exclusionReasons).toStrictEqual([...ORACLE_TRUTH_EXCLUSION_REASONS]);
		expect(ORACLE_QUALIFICATION_CONTRACT.dependencyExclusions).toStrictEqual([...ORACLE_DEPENDENCY_EXCLUSION_REASONS]);
		expect(Object.keys(emptyByReason()).sort()).toStrictEqual([...ORACLE_TRUTH_EXCLUSION_REASONS].sort());
		expect([...ORACLE_QUALIFICATION_CONTRACT.objectTypes].sort()).toStrictEqual([...ORACLE_TRUTH_OBJECT_TYPES].sort());
	});
});

describe('Oracle O1 truth population', () => {
	it('includes every supported identifier type as a declaration', () => {
		const entries = Object.entries(ORACLE_TRUTH_POLICY_V3.supportedTypes);
		const names = entries.map((_, index) => `t${String(index)}`);
		const rows = entries.map(([type], index) => truthRow({name: names[index] ?? '', type, usage: 'DECLARATION', line: index + 1, column: 1}));
		const facts = readOracleTruth({rows, mappings: mappingsOf(names), policy: ORACLE_TRUTH_POLICY_V3});

		expect(facts.definitions.size).toBe(entries.length);
		expect(facts.references.size).toBe(0);
		expect(facts.excluded).toStrictEqual([]);
		expect([...facts.definitions.values()].map((fact) => fact.type.toUpperCase()).sort()).toStrictEqual(entries.map(([type]) => type).sort());
	});

	it('excludes unsupported identifier types from both roles and counts them', () => {
		const lines = ['demo', 'run', 'column_name'];
		const facts = readOracleTruth({
			rows: [
				truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 1}),
				truthRow({name: 'run', type: 'PROCEDURE', usage: 'DECLARATION', line: 2, column: 1}),
				truthRow({name: 'column_name', type: 'COLUMN', usage: 'REFERENCE', line: 3, column: 1}),
				truthRow({name: 'column_name', type: 'TABLE', usage: 'DEFINITION', line: 3, column: 1}),
			],
			mappings: mappingsOf(lines),
			policy: ORACLE_TRUTH_POLICY_V3,
		});

		expect(facts.definitions.size).toBe(2);
		expect(facts.references.size).toBe(0);
		expect(facts.excludedByReason.unsupported_identifier_type).toBe(2);
	});

	it('maps usages to declarations, references, and counted omissions', () => {
		const lines = Array.from({length: 8}, (_, index) => `u${String(index)}`);
		const rows = [
			truthRow({name: 'u0', type: 'VARIABLE', usage: 'DECLARATION', line: 1, column: 1}),
			truthRow({name: 'u1', type: 'VARIABLE', usage: 'DEFINITION', line: 2, column: 1}),
			truthRow({name: 'u2', type: 'VARIABLE', usage: 'REFERENCE', line: 3, column: 1}),
			truthRow({name: 'u3', type: 'VARIABLE', usage: 'ASSIGNMENT', line: 4, column: 1}),
			truthRow({name: 'u4', type: 'VARIABLE', usage: 'CALL', line: 5, column: 1}),
			truthRow({name: 'u5', type: 'VARIABLE', usage: 'OTHER', line: 6, column: 1}),
			truthRow({name: 'u6', type: 'COLUMN', usage: 'DEFINITION', line: 7, column: 1}),
			truthRow({name: 'u7', type: 'ROW', usage: 'CALL', line: 8, column: 1}),
		];
		const facts = readOracleTruth({rows, mappings: mappingsOf(lines), policy: ORACLE_TRUTH_POLICY_V3});

		expect(facts.definitions.size).toBe(2);
		expect([...facts.references.values()].map((fact) => fact.name).sort()).toStrictEqual(['u2', 'u3', 'u4']);
		expect(facts.excludedByReason.unmapped_usage).toBe(1);
		expect(facts.excludedByReason.unsupported_identifier_type).toBe(2);
	});
});

describe('Oracle O1 definition mapping', () => {
	const lines = ['demo', 'flag', 'run', 'if flag then', 'body'];

	const rows = [
		truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 1, signature: 's1', usageId: 1, contextId: 0}),
		truthRow({name: 'flag', type: 'VARIABLE', usage: 'DECLARATION', line: 2, column: 1, signature: 's2', usageId: 2, contextId: 1}),
		truthRow({name: 'run', type: 'PROCEDURE', usage: 'DECLARATION', line: 3, column: 1, signature: 's3', usageId: 3, contextId: 1}),
		truthRow({name: 'run', type: 'PROCEDURE', usage: 'DEFINITION', line: 3, column: 1, signature: 's3', usageId: 4, contextId: 1}),
		truthRow({name: 'flag', type: 'VARIABLE', usage: 'DEFINITION', line: 4, column: 4, signature: 's2', usageId: 5, contextId: 3}),
	];

	it('treats a program-unit DEFINITION as the declaration point', () => {
		const facts = readOracleTruth({rows, mappings: mappingsOf(lines), policy: ORACLE_TRUTH_POLICY_V5});

		expect([...facts.definitions.values()].map((fact) => fact.name).sort()).toStrictEqual(['demo', 'flag', 'run']);
		expect(facts.excludedByReason.duplicate_fact).toBe(1);
	});

	it('treats a scalar predicate DEFINITION as a reference use under the authoritative policy', () => {
		const facts = readOracleTruth({rows, mappings: mappingsOf(lines), policy: ORACLE_TRUTH_POLICY_V5});

		expect([...facts.references.values()].map((fact) => `${fact.name}:${String(fact.line)}:${String(fact.column)}`)).toStrictEqual(['flag:4:4']);
		expect(facts.excludedByReason.ephemeral_declaration).toBe(0);
		expect(facts.excludedByReason.declaration_initializer).toBe(0);
	});

	it('kept the widened declaration mapping under the replayed policy', () => {
		const facts = readOracleTruth({rows, mappings: mappingsOf(lines), policy: ORACLE_TRUTH_POLICY_V4});

		expect(facts.definitions.size).toBe(3);
		expect(facts.references.size).toBe(0);
		expect(facts.excludedByReason.ephemeral_declaration).toBe(1);
	});
});

describe('Oracle O1 exclusion audit', () => {
	it('records every reason with a stable code and reconstructible denominators', () => {
		const conflicting: ObjectMappingType = {
			path: 'source.pkg',
			offset: 0,
			columnShift: 0,
			lines: ['demo', 'kept', 'wrong_token', 'same', 'same', 'run', 'orphan', 'dup_ref', 'anchor_decl'],
		};
		const ambiguous = positionKeyOf({path: 'source.pkg', line: 6, column: 1});
		const facts = readOracleTruth({
			rows: [
				truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 1, signature: 's1'}),
				truthRow({name: 'kept', type: 'VARIABLE', usage: 'DECLARATION', line: 2, column: 1, signature: 's1'}),
				truthRow({name: 'kept', type: 'VARIABLE', usage: 'ASSIGNMENT', line: 2, column: 1, signature: 's1'}),
				truthRow({name: 'missing', type: 'VARIABLE', usage: 'DECLARATION', line: 3, column: 1, signature: 's2'}),
				truthRow({name: 'same', type: 'VARIABLE', usage: 'DECLARATION', line: 4, column: 1, signature: 's3'}),
				truthRow({name: 'same', type: 'VARIABLE', usage: 'DECLARATION', line: 4, column: 1, signature: 's3'}),
				truthRow({name: 'same', type: 'VARIABLE', usage: 'REFERENCE', line: 5, column: 1, signature: 's3'}),
				truthRow({name: 'same', type: 'VARIABLE', usage: 'REFERENCE', line: 5, column: 1, signature: 's3'}),
				truthRow({name: 'demo', type: 'PACKAGE', usage: 'REFERENCE', line: 1, column: 1, signature: 's1'}),
				truthRow({name: 'run', type: 'VARIABLE', usage: 'CALL', line: 6, column: 1, signature: 's4'}),
				truthRow({name: 'run', type: 'VARIABLE', usage: 'DECLARATION', line: 6, column: 1, signature: 's4'}),
				truthRow({name: 'orphan', type: 'VARIABLE', usage: 'REFERENCE', line: 7, column: 1, signature: 's5'}),
				truthRow({name: 'other', type: 'VARIABLE', usage: 'OTHER', line: 7, column: 1, signature: 's5'}),
				truthRow({name: 'dup_ref', type: 'VARIABLE', usage: 'REFERENCE', line: 8, column: 1, signature: 's6'}),
				truthRow({name: 'dup_ref', type: 'VARIABLE', usage: 'REFERENCE', line: 8, column: 1, signature: 's6'}),
				truthRow({name: 'anchor_decl', type: 'VARIABLE', usage: 'DECLARATION', line: 9, column: 1, signature: 's6'}),
				[],
				truthRow({name: 'ignored', type: 'VARIABLE', usage: 'DECLARATION', line: 7, column: 1, objectType: 'TABLE'}),
			],
			mappings: new Map([[objectKey('PACKAGE', 'demo'), conflicting]]),
			policy: ORACLE_TRUTH_POLICY_V3,
			ambiguousOverloadPositions: new Set([ambiguous]),
		});

		expect(facts.excludedByReason).toStrictEqual({
			unsupported_identifier_type: 0,
			unmapped_usage: 1,
			invalid_declaration: 1,
			package_reference: 1,
			missing_group_declaration: 1,
			declaration_initializer: 1,
			duplicate_fact: 3,
			omitted_ambiguous_overload: 1,
			ephemeral_declaration: 0,
		});
		expect(facts.malformedRows).toBe(1);
		expect(facts.outOfScopeObjectRows).toBe(1);
		expect(facts.definitions.size).toBe(5);
		expect(facts.references.size).toBe(2);
		expect(facts.identifierRows).toBe(16);
		expect(facts.definitions.size + facts.references.size + Object.values(facts.excludedByReason).reduce((total, count) => total + count, 0)).toBe(
			facts.identifierRows,
		);
	});
});

describe('Oracle O1 ephemeral declarations', () => {
	it('omits parameters and routine-local declarations under the publication policy', () => {
		const lines = ['demo', 'run', 'p_value', 'l_value', 'g_value', 'inner'];
		const facts = readOracleTruth({
			rows: [
				truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 1, signature: 's1', usageId: 1, contextId: 0}),
				truthRow({name: 'run', type: 'PROCEDURE', usage: 'DECLARATION', line: 2, column: 1, signature: 's2', usageId: 2, contextId: 1}),
				truthRow({name: 'p_value', type: 'FORMAL IN', usage: 'DECLARATION', line: 3, column: 1, signature: 's3', usageId: 3, contextId: 2}),
				truthRow({name: 'l_value', type: 'VARIABLE', usage: 'DECLARATION', line: 4, column: 1, signature: 's4', usageId: 4, contextId: 2}),
				truthRow({name: 'g_value', type: 'VARIABLE', usage: 'DECLARATION', line: 5, column: 1, signature: 's5', usageId: 5, contextId: 1}),
				truthRow({name: 'inner', type: 'PROCEDURE', usage: 'DECLARATION', line: 6, column: 1, signature: 's6', usageId: 6, contextId: 2}),
			],
			mappings: mappingsOf(lines),
			policy: ORACLE_TRUTH_POLICY_V4,
		});

		expect([...facts.definitions.values()].map((fact) => fact.name).sort()).toStrictEqual(['demo', 'g_value', 'inner', 'run']);
		expect(facts.excludedByReason.ephemeral_declaration).toBe(2);
	});

	it('keeps ephemeral rows under the historical policy', () => {
		const facts = readOracleTruth({
			rows: [truthRow({name: 'p_value', type: 'FORMAL IN', usage: 'DECLARATION', line: 1, column: 1, usageId: 1, contextId: 0})],
			mappings: mappingsOf(['p_value']),
			policy: ORACLE_TRUTH_POLICY_V3,
		});

		expect(facts.definitions.size).toBe(1);
		expect(facts.excludedByReason.ephemeral_declaration).toBe(0);
	});
});

describe('Oracle O1 ambiguity policy', () => {
	const lines = ['demo', 'call_site', 'reference_site', 'retained_call'];

	it('omits only a CALL row at an emitted ambiguity position', () => {
		const facts = readOracleTruth({
			rows: [
				truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 1}),
				truthRow({name: 'call_site', type: 'PROCEDURE', usage: 'CALL', line: 2, column: 1}),
				truthRow({name: 'reference_site', type: 'VARIABLE', usage: 'REFERENCE', line: 3, column: 1}),
				truthRow({name: 'retained_call', type: 'PROCEDURE', usage: 'CALL', line: 4, column: 1}),
			],
			mappings: mappingsOf(lines),
			policy: ORACLE_TRUTH_POLICY_V3,
			ambiguousOverloadPositions: new Set([positionKeyOf({path: 'source.pkg', line: 2, column: 1}), positionKeyOf({path: 'source.pkg', line: 3, column: 1})]),
		});

		expect([...facts.references.values()].map((fact) => fact.name).sort()).toStrictEqual(['reference_site', 'retained_call']);
		expect(facts.excludedByReason.omitted_ambiguous_overload).toBe(1);
		expect(facts.excluded).toStrictEqual([
			{path: 'source.pkg', line: 2, column: 1, name: 'call_site', type: 'PROCEDURE', role: 'reference', reason: 'omitted_ambiguous_overload'},
		]);
	});

	it('keeps the row under a historical policy', () => {
		const facts = readOracleTruth({
			rows: [
				truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 1}),
				truthRow({name: 'call_site', type: 'PROCEDURE', usage: 'CALL', line: 2, column: 1}),
			],
			mappings: mappingsOf(lines),
			policy: ORACLE_TRUTH_POLICY_V2,
			ambiguousOverloadPositions: new Set([positionKeyOf({path: 'source.pkg', line: 2, column: 1})]),
		});

		expect(facts.references.size).toBe(1);
		expect(facts.excludedByReason.omitted_ambiguous_overload).toBe(0);
	});
});

describe('Oracle O1 gate results', () => {
	it('passes every contract threshold exactly at the boundary', () => {
		const gates = oracleGatesOf({
			declarations: {recall: 0.995, precision: 1},
			references: {recall: 0.995, precision: 1},
			dependencies: {recall: 0.995, precision: 1},
			identifierRows: 1,
		});

		expect(gates).toStrictEqual({
			declarations: {ok: true, recall: true, precision: true},
			references: {ok: true, recall: true, precision: true},
			dependencies: {ok: true, recall: true, precision: true},
			ok: true,
		});
	});

	it('fails each gate independently', () => {
		const passing = {recall: 1, precision: 1};
		const failingRecall = {recall: 0.9949, precision: 1};
		const failingPrecision = {recall: 1, precision: 0.9999};
		const gatesOf = (overrides: Partial<Parameters<typeof oracleGatesOf>[0]>): ReturnType<typeof oracleGatesOf> =>
			oracleGatesOf({declarations: passing, references: passing, dependencies: passing, identifierRows: 1, ...overrides});

		expect(gatesOf({declarations: failingRecall}).declarations).toStrictEqual({ok: false, recall: false, precision: true});
		expect(gatesOf({references: failingRecall}).references).toStrictEqual({ok: false, recall: false, precision: true});
		expect(gatesOf({dependencies: failingRecall}).dependencies).toStrictEqual({ok: false, recall: false, precision: true});
		expect(gatesOf({declarations: failingPrecision}).declarations).toStrictEqual({ok: false, recall: true, precision: false});
		expect(gatesOf({references: failingPrecision}).references).toStrictEqual({ok: false, recall: true, precision: false});
		expect(gatesOf({dependencies: failingPrecision}).dependencies).toStrictEqual({ok: false, recall: true, precision: false});
		expect(gatesOf({declarations: failingRecall}).ok).toBe(false);
	});

	it('fails every gate for empty truth', () => {
		const gates = oracleGatesOf({
			declarations: {recall: 1, precision: 1},
			references: {recall: 1, precision: 1},
			dependencies: {recall: 1, precision: 1},
			identifierRows: 0,
		});

		expect(gates.ok).toBe(false);
		expect(gates.declarations.ok).toBe(false);
		expect(gates.references.ok).toBe(false);
		expect(gates.dependencies.ok).toBe(false);
	});
});
