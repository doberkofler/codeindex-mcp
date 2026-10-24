import {describe, expect, it} from 'vitest';
import {createParserState, type OracleParserStateType} from '../src/adapters/oracle/parserState.ts';
import {addBulkCollectSite, argumentShapeOf, assignFollows, forRangeAt, statementStart, typeReferencesOf} from '../src/adapters/oracle/referenceArguments.ts';
import {TokenCursor} from '../src/adapters/oracle/tokenCursor.ts';
import {tokenizeOracleSource} from '../src/adapters/oracle/tokenize.ts';

const stateOf = (source: string): OracleParserStateType => {
	const tokenized = tokenizeOracleSource(source, 'arguments.pkb');

	return createParserState(new TokenCursor(tokenized.tokens), 'APP', 'arguments.pkb');
};

const nthIndex = (state: OracleParserStateType, text: string, occurrence = 0): number => {
	let seen = 0;

	for (let index = 0; index < state.cursor.length; index += 1) {
		if (state.cursor.text(index) === text) {
			if (seen === occurrence) {
				return index;
			}

			seen += 1;
		}
	}

	throw new Error(`Token ${text} occurrence ${String(occurrence)} not found`);
};

const shapeAt = (state: OracleParserStateType, start: number, end: number): ReturnType<typeof argumentShapeOf> =>
	argumentShapeOf(state, {start, end, delimiter: null});

describe('Oracle argument shape classification', () => {
	it('classifies named associations with every literal family', () => {
		const state = stateOf(
			"fn(p_name => l_value, p_text => 'x', p_q => q'[a b]', p_num => .5, p_flag => TRUE, p_unit => $$PLSQL_UNIT, p_line => $$PLSQL_LINE, p_day => DATE '2026-01-01', p_stamp => TIMESTAMP '2026-01-01');",
		);
		const nameIndex = nthIndex(state, 'p_name');
		const valueIndex = nthIndex(state, 'l_value');
		const textIndex = nthIndex(state, "'x'");
		const qIndex = nthIndex(state, "q'[a b]'");
		const numberIndex = nthIndex(state, '.5');
		const flagIndex = nthIndex(state, 'TRUE');
		const unitIndex = nthIndex(state, '$$PLSQL_UNIT');
		const lineIndex = nthIndex(state, '$$PLSQL_LINE');

		expect(shapeAt(state, nameIndex, valueIndex)).toMatchObject({name: 'P_NAME', leadName: {canonical: 'L_VALUE'}, indexed: false});
		expect(shapeAt(state, nthIndex(state, 'p_text'), textIndex)).toMatchObject({name: 'P_TEXT', literalType: 'VARCHAR2'});
		expect(shapeAt(state, nthIndex(state, 'p_q'), qIndex)).toMatchObject({name: 'P_Q', literalType: 'VARCHAR2'});
		expect(shapeAt(state, nthIndex(state, 'p_num'), numberIndex)).toMatchObject({name: 'P_NUM', literalType: 'NUMBER'});
		expect(shapeAt(state, nthIndex(state, 'p_flag'), flagIndex)).toMatchObject({name: 'P_FLAG', literalType: 'BOOLEAN'});
		expect(shapeAt(state, nthIndex(state, 'p_unit'), unitIndex)).toMatchObject({name: 'P_UNIT', literalType: 'VARCHAR2'});
		expect(shapeAt(state, nthIndex(state, 'p_line'), lineIndex)).toMatchObject({name: 'P_LINE', literalType: 'NUMBER'});
		expect(shapeAt(state, nthIndex(state, 'p_day'), nthIndex(state, "'2026-01-01'"))).toMatchObject({name: 'P_DAY', literalType: 'DATE'});
		expect(shapeAt(state, nthIndex(state, 'p_stamp'), nthIndex(state, "'2026-01-01'", 1))).toMatchObject({name: 'P_STAMP', literalType: 'TIMESTAMP'});
	});

	it('recognizes the legacy equals-greater association and plain positional names', () => {
		const state = stateOf('fn(p_name = > rec.field, rec.coll(1).field, arr(2), other);');
		const namedStart = nthIndex(state, 'p_name');
		const indexed = nthIndex(state, 'rec', 1);
		const indexedOnly = nthIndex(state, 'arr');
		const plain = nthIndex(state, 'other');

		expect(shapeAt(state, namedStart, nthIndex(state, 'field'))).toMatchObject({name: 'P_NAME', leadName: {canonical: 'REC.FIELD'}});
		expect(shapeAt(state, indexed, nthIndex(state, 'field', 1))).toMatchObject({leadName: {canonical: 'REC.COLL.FIELD'}, indexed: false});
		expect(shapeAt(state, indexedOnly, nthIndex(state, '2'))).toMatchObject({leadName: {canonical: 'ARR'}, indexed: true});
		expect(shapeAt(state, plain, plain)).toMatchObject({name: null, leadName: {canonical: 'OTHER'}});
	});

	it('returns an unknown shape for malformed or literal-leading arguments', () => {
		const state = stateOf('fn(1, rec.coll(, $x);');

		expect(shapeAt(state, nthIndex(state, '1'), nthIndex(state, '1'))).toStrictEqual({name: null, leadName: undefined, indexed: false, literalType: 'NUMBER'});
		expect(shapeAt(state, nthIndex(state, 'rec'), nthIndex(state, 'rec'))).toMatchObject({leadName: {parts: [{canonical: 'REC'}, {canonical: 'COLL'}]}});
	});
});

describe('Oracle statement and assignment predicates', () => {
	it('detects statement positions from the previous token', () => {
		const state = stateOf('BEGIN run; x := 1; THEN other;');

		expect(statementStart(state, nthIndex(state, 'run'))).toBe(true);
		expect(statementStart(state, nthIndex(state, 'x'))).toBe(true);
		expect(statementStart(state, nthIndex(state, 'other'))).toBe(true);
		expect(statementStart(state, nthIndex(state, 'BEGIN'))).toBe(true);
		expect(statementStart(state, nthIndex(state, '1'))).toBe(false);
	});

	it('detects assignments after one or more balanced index groups', () => {
		const state = stateOf('arr(1) := 2; arr(1)(2) := 3; arr(1) other; arr ;');

		expect(assignFollows(state, nthIndex(state, '('))).toBe(true);
		expect(assignFollows(state, nthIndex(state, '(', 1))).toBe(true);
		expect(assignFollows(state, nthIndex(state, '(', 2))).toBe(true);
		expect(assignFollows(state, nthIndex(state, '(', 3))).toBe(false);
		expect(assignFollows(state, nthIndex(state, 'arr', 2))).toBe(false);
	});

	it('detects a numeric FOR range and rejects cursor and unterminated headers', () => {
		const state = stateOf('for i in 1..3 loop null; end loop; for r in c_rows loop null; end loop; for j in fn(x) loop null; end loop;');

		expect(forRangeAt(state, nthIndex(state, 'for'))).toBe(true);
		expect(forRangeAt(state, nthIndex(state, 'for', 1))).toBe(false);
		expect(forRangeAt(state, nthIndex(state, 'for', 2))).toBe(false);
	});
});

describe('Oracle type reference extraction', () => {
	it('reads %TYPE and %ROWTYPE anchors and plain symbolic types', () => {
		const typeState = stateOf('l_a employees.id%type; l_b hr.rec%rowtype; l_c app.custom_type;');

		expect(typeReferencesOf(typeState, nthIndex(typeState, 'employees'), nthIndex(typeState, '%type'))).toStrictEqual([
			expect.objectContaining({name: expect.objectContaining({canonical: 'EMPLOYEES.ID'}), anchored: true, rowType: false}),
		]);
		expect(typeReferencesOf(typeState, nthIndex(typeState, 'hr'), nthIndex(typeState, '%rowtype'))).toStrictEqual([
			expect.objectContaining({name: expect.objectContaining({canonical: 'HR.REC'}), anchored: false, rowType: true}),
		]);
		expect(typeReferencesOf(typeState, nthIndex(typeState, 'app'), nthIndex(typeState, 'custom_type'))).toStrictEqual([
			expect.objectContaining({name: expect.objectContaining({canonical: 'APP.CUSTOM_TYPE'}), anchored: false, rowType: false}),
		]);
	});

	it('skips shape keywords and returns no reference for an empty type', () => {
		const state = stateOf('l_a constant number; l_b table of varchar2(10);');

		expect(typeReferencesOf(state, nthIndex(state, 'constant'), nthIndex(state, 'number'))).toStrictEqual([
			expect.objectContaining({name: expect.objectContaining({canonical: 'NUMBER'})}),
		]);
		expect(typeReferencesOf(state, nthIndex(state, 'table'), nthIndex(state, 'varchar2'))).toStrictEqual([
			expect.objectContaining({name: expect.objectContaining({canonical: 'VARCHAR2'})}),
		]);
		expect(typeReferencesOf(state, 0, -1)).toStrictEqual([]);
	});
});

describe('Oracle BULK COLLECT markers', () => {
	it('adds one marker with the selected-item count and target position', () => {
		const state = stateOf('select a, b bulk collect into rec(1).field from t;');
		const bulk = nthIndex(state, 'bulk');

		addBulkCollectSite(state, bulk, 0, 0);

		expect(state.references).toStrictEqual([
			expect.objectContaining({kind: 'reference', bulkFields: 2, name: expect.objectContaining({canonical: 'REC.FIELD'})}),
		]);
	});

	it('does not add a marker without INTO, a target, or an authored select list', () => {
		const withoutInto = stateOf('select a bulk collect from t;');
		const withoutTarget = stateOf('select a bulk collect into 1 from t;');
		const fetch = stateOf('fetch c bulk collect into arr;');
		const starred = stateOf('select * bulk collect into arr from t;');

		for (const state of [withoutInto, withoutTarget, fetch]) {
			addBulkCollectSite(state, nthIndex(state, 'bulk'), 0, 0);
			expect(state.references).toStrictEqual([]);
		}

		addBulkCollectSite(starred, nthIndex(starred, 'bulk'), 0, 0);
		expect(starred.references).toStrictEqual([expect.objectContaining({bulkFields: null, name: expect.objectContaining({canonical: 'ARR'})})]);
	});
});
