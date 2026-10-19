import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseWithAntlr} from '../src/adapters/oracle/antlrParser.ts';
import {parseOracleUnits} from '../src/adapters/oracle/parseUnits.ts';
import {type OracleParseResultType} from '../src/adapters/oracle/syntax.ts';
import {tokenizeOracleSource} from '../src/adapters/oracle/tokenize.ts';

const databaseRoot = path.join(import.meta.dirname, 'fixtures', 'oracle-project', 'database');
const fixtures = ['hr_api.pks', 'hr_api.pkb', 'qualification.pkb', 'sales_api.pks', 'sales_api.pkb', 'maintenance_run.prc'];
const mixedSource = `create package mixed_api as
	type t_rec is record (a number, b varchar2(10));
	type t_tab is table of t_rec index by pls_integer;
	type t_ref is ref cursor return t_rec;
	subtype t_small is number(3);
	c_limit constant number := 10;
	v_row t_rec;
	e_bad exception;
	cursor c_rows(p_id number, p_name varchar2 default 'x') return t_rec;
	procedure over(p_a number);
	procedure over(p_a varchar2, p_b number default 1);
	function f(p_x t_rec) return number;
end mixed_api;
/
create procedure standalone(p_a in out number) is
	procedure nested(p_n number) is
	begin
		null;
	end nested;
begin
	null;
end standalone;
/
`;
const overloadSource = 'create package p as procedure over(p_a number); procedure over(p_a varchar2, p_b number default 1); end p;\n/\n';
const conditionalSource = `create package p as
$IF FALSE $THEN
	procedure hidden_branch;
$END
	procedure visible_branch;
end p;
/
`;

const parseFixture = (name: string): Readonly<{structural: OracleParseResultType; antlr: OracleParseResultType}> => {
	const source = readFileSync(path.join(databaseRoot, name), 'utf8');
	const tokenized = tokenizeOracleSource(source, name);

	return {
		structural: parseOracleUnits({tokens: tokenized.tokens, path: name, defaultSchema: 'APP'}),
		antlr: parseWithAntlr({source, path: name, defaultSchema: 'APP'}),
	};
};

const declarationKey = (declaration: OracleParseResultType['declarations'][number]): string => `${declaration.kind}:${declaration.name.canonical}`;

const declarationIndexOf = (declarations: OracleParseResultType['declarations'], kind: string, name: string): number =>
	declarations.findIndex((declaration) => declaration.kind === kind && declaration.name.canonical === name);

const parameterSignatureOf = (declaration: OracleParseResultType['declarations'][number]): readonly string[] =>
	declaration.parameters.map((parameter) => `${parameter.mode}:${parameter.typeText}:${parameter.hasDefault}`);

describe('Oracle ANTLR declaration parity', () => {
	it.each(fixtures)('matches the structural parser on %s', (name) => {
		const {structural, antlr} = parseFixture(name);

		expect({units: antlr.units, declarations: antlr.declarations}).toStrictEqual({
			units: structural.units,
			declarations: structural.declarations,
		});
	});

	it('emits parameters, variables, constants, cursors, exceptions, subtypes, types, and fields', () => {
		const result = parseWithAntlr({source: mixedSource, path: 'mixed.pks', defaultSchema: 'APP'});

		expect(result.declarations.map(declarationKey)).toStrictEqual([
			'package:MIXED_API',
			'record_type:T_REC',
			'field:A',
			'field:B',
			'collection_type:T_TAB',
			'cursor:T_REF',
			'subtype:T_SMALL',
			'constant:C_LIMIT',
			'variable:V_ROW',
			'exception:E_BAD',
			'cursor:C_ROWS',
			'parameter:P_ID',
			'parameter:P_NAME',
			'procedure:OVER',
			'parameter:P_A',
			'procedure:OVER',
			'parameter:P_A',
			'parameter:P_B',
			'function:F',
			'parameter:P_X',
			'procedure:STANDALONE',
			'parameter:P_A',
			'procedure:NESTED',
			'parameter:P_N',
		]);

		const record = declarationIndexOf(result.declarations, 'record_type', 'T_REC');
		const cursor = declarationIndexOf(result.declarations, 'cursor', 'C_ROWS');
		const standalone = declarationIndexOf(result.declarations, 'procedure', 'STANDALONE');
		const nested = declarationIndexOf(result.declarations, 'procedure', 'NESTED');

		expect(result.declarations[declarationIndexOf(result.declarations, 'field', 'A')]?.parent).toBe(record);
		expect(result.declarations[declarationIndexOf(result.declarations, 'parameter', 'P_ID')]?.parent).toBe(cursor);
		expect(result.declarations[nested]?.parent).toBe(standalone);
		expect(result.declarations[nested]?.exported).toBe(false);
		expect(result.declarations[standalone]?.exported).toBe(true);
		expect(result.declarations[declarationIndexOf(result.declarations, 'parameter', 'P_N')]?.exported).toBe(false);
	});

	it('preserves overload identity and parameter signatures', () => {
		const result = parseWithAntlr({source: overloadSource, path: 'overloads.pks', defaultSchema: 'APP'});
		const overloads = result.declarations.filter((declaration) => declaration.kind === 'procedure' && declaration.name.canonical === 'OVER');

		expect(overloads).toHaveLength(2);
		expect(overloads.map((declaration) => parameterSignatureOf(declaration))).toStrictEqual([['IN:NUMBER:false'], ['IN:VARCHAR2:false', 'IN:NUMBER:true']]);
	});

	it('links package specifications and bodies by canonical unit identity', () => {
		const spec = parseFixture('sales_api.pks').antlr;
		const body = parseFixture('sales_api.pkb').antlr;

		expect(spec.units.map((unit) => `${unit.kind}:${unit.canonical}`)).toStrictEqual(['package-spec:APP.SALES_API']);
		expect(body.units.map((unit) => `${unit.kind}:${unit.canonical}`)).toStrictEqual(['package-body:APP.SALES_API']);
		expect(spec.declarations[0]?.exported).toBe(true);
		expect(body.declarations[0]?.exported).toBe(false);
		expect(body.declarations.filter((declaration) => declaration.parent === 0).map((declaration) => declaration.exported)).toStrictEqual([false]);
	});

	it('omits declarations from literal-disabled conditional branches', () => {
		const result = parseWithAntlr({source: conditionalSource, path: 'conditional.pks', defaultSchema: 'APP'});

		expect(result.declarations.map(declarationKey)).toStrictEqual(['package:P', 'procedure:VISIBLE_BRANCH']);
	});

	it('does not emit routine tail clauses as local declarations', () => {
		const result = parseWithAntlr({
			source: `create procedure external_proc(p number) is external;
/
create procedure call_spec_proc(p number) as language java name 'X';
/
`,
			path: 'external.prc',
			defaultSchema: 'APP',
		});

		expect(result.units.map((unit) => unit.canonical)).toStrictEqual(['APP.EXTERNAL_PROC', 'APP.CALL_SPEC_PROC']);
		expect(result.declarations.map(declarationKey)).toStrictEqual(['procedure:EXTERNAL_PROC', 'parameter:P', 'procedure:CALL_SPEC_PROC', 'parameter:P']);
	});

	it('emits no reference or dependency sites during Phase 3', () => {
		const result = parseFixture('hr_api.pkb').antlr;

		expect(result.references).toStrictEqual([]);
		expect(result.dependencies).toStrictEqual([]);
	});
});
