import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseWithAntlr} from '../src/adapters/oracle/antlrParser.ts';
import {ORACLE_DIAGNOSTIC} from '../src/adapters/oracle/diagnostics.ts';
import {extractOracleSymbols} from '../src/adapters/oracle/extractSymbols.ts';
import {resolveOracleReferences} from '../src/adapters/oracle/resolveReferences.ts';
import {type OracleParseResultType} from '../src/adapters/oracle/syntax.ts';

type FixtureFileType = Readonly<{path: string; parse: OracleParseResultType}>;
type ContextSymbolsType = ReturnType<typeof extractOracleSymbols>;
type ResolvedReferencesType = ReturnType<typeof resolveOracleReferences>;
type OccurrenceType = ResolvedReferencesType['occurrences'][number];
type ContextSymbolType = ContextSymbolsType['symbols'][number];

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'oracle-project', 'database');

const parse = (source: string, file = 'test.sql'): OracleParseResultType => parseWithAntlr({source, path: file, defaultSchema: 'APP'});

const parseFixture = (name: string): FixtureFileType => ({
	path: name,
	parse: parseWithAntlr({source: readFileSync(path.join(fixtureRoot, name), 'utf8'), path: name, defaultSchema: 'APP'}),
});

const resolve = (files: readonly FixtureFileType[]): Readonly<{symbols: ContextSymbolsType; references: ResolvedReferencesType}> => {
	const symbols = extractOracleSymbols({projectId: 'phase4', context: 'APP', files});
	const references = resolveOracleReferences({context: 'APP', defaultSchema: 'APP', files: symbols.analyses, packages: symbols.packages});

	return {symbols, references};
};

const targetIn = (symbols: ContextSymbolsType, occurrence: OccurrenceType | undefined): ContextSymbolType | undefined =>
	symbols.symbols.find((symbol) => symbol.id === occurrence?.symbolId);

const namesOf = (result: OracleParseResultType): readonly string[] => result.references.map((reference) => reference.name.canonical);

describe('Oracle ANTLR procedural references', () => {
	it('collects locals, parameters, calls, named arguments, and nested calls', () => {
		const result = parse(`create procedure run(p_value number) is
	l_value number;
	procedure nested(p_inner number) is
	begin
		l_value := p_value + p_inner;
	end nested;
begin
	l_value := p_value;
	nested(l_value);
	run(p_value => l_value);
end run;
/
`);

		expect(result.references.map((reference) => `${reference.kind}:${reference.name.canonical}:${reference.argumentCount ?? '-'}`)).toStrictEqual([
			'reference:L_VALUE:-',
			'reference:P_VALUE:-',
			'reference:P_INNER:-',
			'reference:L_VALUE:-',
			'reference:P_VALUE:-',
			'call:NESTED:1',
			'reference:L_VALUE:-',
			'call:RUN:1',
			'reference:L_VALUE:-',
		]);
		expect(result.references.find((reference) => reference.name.canonical === 'RUN')?.argumentNames).toStrictEqual(['P_VALUE']);
	});

	it('does not emit declaration names, labels, aliases, package qualifiers, or named-argument labels', () => {
		const result = parse(`create package p as
	type t_rec is record (id number);
	procedure run(p_id number);
end p;
/
create package body p as
	procedure run(p_id number) is
		l_rec t_rec;
	begin
		<<again>>
		l_rec.id := p_id;
		p.run(p_id => l_rec.id);
		goto again;
	end;
end p;
/
`);

		expect(namesOf(result)).not.toContain('AGAIN');
		expect(namesOf(result)).not.toContain('P');
		expect(namesOf(result).filter((name) => name === 'P_ID')).toHaveLength(1);
		expect(result.references.filter((reference) => reference.name.canonical === 'P.RUN')).toHaveLength(1);
		expect(result.references.filter((reference) => reference.name.canonical === 'L_REC.ID')).toHaveLength(2);
	});

	it('keeps static SQL object names and aliases out of reference sites', () => {
		const result = parse(`create procedure sql_refs(p_id number) is
	l_name varchar2(10);
begin
	select e.name into l_name
	from employees e
	where e.id = p_id
	and exists (select 1 from departments d where d.id = e.dept_id);

	insert into audit_log (id, name) values (p_id, l_name);
	update employees e set e.name = l_name where e.id = p_id;
	delete from employees e where e.id = p_id;
	merge into employees e using departments d on (e.dept_id = d.id)
	when matched then update set e.name = l_name;
end;
/
`);

		expect(namesOf(result)).toStrictEqual(expect.arrayContaining(['L_NAME', 'P_ID', 'E.NAME', 'E.ID', 'D.ID', 'E.DEPT_ID']));
		expect(namesOf(result)).not.toContain('EMPLOYEES');
		expect(namesOf(result)).not.toContain('DEPARTMENTS');
		expect(namesOf(result)).not.toContain('AUDIT_LOG');
		expect(namesOf(result)).not.toContain('E');
		expect(namesOf(result)).not.toContain('D');
		expect(namesOf(result)).not.toContain('ID');
		expect(namesOf(result)).not.toContain('NAME');
	});
});

describe('Oracle ANTLR recovery and type anchors', () => {
	it('keeps unit and declaration indexes aligned across recovered segments', () => {
		const result = parse(`create package first_api as procedure p; end first_api;
this is not plsql;
/
create procedure good(p_id number) is
begin
	good(p_id);
end good;
/
`);

		const call = result.references.find((reference) => reference.name.canonical === 'GOOD');
		const enclosing = call === undefined ? undefined : result.declarations[call.enclosing];

		expect(result.units.map((unit) => unit.canonical)).toStrictEqual(['APP.FIRST_API', 'APP.GOOD']);
		expect(call?.unit).toBe(1);
		expect(enclosing).toMatchObject({kind: 'procedure', name: {canonical: 'GOOD'}, unit: 1});
	});

	it('emits one type anchor site with the rowType flag', () => {
		const result = parse(`create procedure rowtype_ref is
	l_rec hr_api.t_employee%rowtype;
begin
	l_rec.name := 'x';
end;
/
`);

		const anchor = result.references.find((reference) => reference.kind === 'type-anchor');

		expect(anchor?.name.canonical).toBe('HR_API.T_EMPLOYEE');
		expect(anchor?.rowType).toBe(true);
		expect(
			result.declarations.find((declaration) => declaration.name.canonical === 'L_REC')?.typeReferences.map((reference) => reference.rowType),
		).toStrictEqual([true]);
	});
});

describe('Oracle ANTLR scope resolution', () => {
	it('resolves locals, parameters, package members, and record fields', () => {
		const files = [parseFixture('hr_api.pks'), parseFixture('hr_api.pkb'), parseFixture('maintenance_run.prc')];
		const {symbols, references} = resolve(files);
		const field = references.occurrences.find((occurrence) => occurrence.path === 'maintenance_run.prc' && occurrence.startLine === 5);
		const local = references.occurrences.find((occurrence) => occurrence.path === 'maintenance_run.prc' && occurrence.startLine === 6);

		expect(field?.symbolId).toBeDefined();
		expect(targetIn(symbols, field)).toMatchObject({kind: 'field', name: 'name'});
		expect(local?.symbolId).toBeDefined();
		expect(targetIn(symbols, local)).toMatchObject({kind: 'variable', name: 'l_name'});
	});

	it('resolves %TYPE anchors and package-qualified record types', () => {
		const files = [parseFixture('hr_api.pks'), parseFixture('hr_api.pkb'), parseFixture('sales_api.pkb')];
		const {symbols, references} = resolve(files);
		const anchor = references.occurrences.find((occurrence) => occurrence.path === 'sales_api.pkb' && occurrence.startLine === 3);

		expect(anchor?.symbolId).toBeDefined();
		expect(targetIn(symbols, anchor)).toMatchObject({kind: 'record_type', name: 't_employee'});
	});

	it('resolves collection indexing and collection element fields', () => {
		const result = parse(
			`create package p as
	type t_rec is record (id number);
	type t_tab is table of t_rec index by pls_integer;
end p;
/
create procedure use_tab is
	l_tab p.t_tab;
begin
	l_tab(1).id := 2;
end;
/
`,
			'collection.pkb',
		);
		const {symbols, references} = resolve([{path: 'collection.pkb', parse: result}]);
		const index = references.occurrences.find((occurrence) => targetIn(symbols, occurrence)?.name === 'l_tab');
		const field = references.occurrences.find((occurrence) => targetIn(symbols, occurrence)?.kind === 'field' && targetIn(symbols, occurrence)?.name === 'id');

		expect(targetIn(symbols, index)).toMatchObject({kind: 'variable', name: 'l_tab'});
		expect(targetIn(symbols, field)).toMatchObject({kind: 'field', name: 'id'});
	});

	it('resolves nested block locals, loop iterators, and shadowing', () => {
		const result = parse(
			`create procedure nested_scope is
	l_value number;
begin
	l_value := 1;
	declare
		l_value number;
	begin
		l_value := 2;
	end;
	for i in 1..3 loop
		l_value := l_value + i;
	end loop;
end;
/
`,
			'nested.pkb',
		);
		const {symbols, references} = resolve([{path: 'nested.pkb', parse: result}]);
		const atLine = (line: number): OccurrenceType | undefined => references.occurrences.find((item) => item.startLine === line);
		const locals = symbols.symbols.filter((symbol) => symbol.kind === 'variable' && symbol.name === 'l_value');

		expect(locals).toHaveLength(2);
		expect(targetIn(symbols, atLine(4))?.id).toBe(locals[0]?.id);
		expect(targetIn(symbols, atLine(8))?.id).toBe(locals[1]?.id);
		expect(symbols.symbols.find((symbol) => symbol.kind === 'variable' && symbol.name === 'i')).toBeDefined();
		expect(references.occurrences.some((occurrence) => occurrence.startLine === 11 && targetIn(symbols, occurrence)?.name === 'i')).toBe(true);
	});
});

describe('Oracle ANTLR cursor and overload scopes', () => {
	it('resolves fields through a cursor loop iterator type', () => {
		const spec = parse(
			`create package p as
	type t_rec is record (id number);
	cursor c_rows return t_rec;
end p;
/
`,
			'cursor.pks',
		);
		const body = parse(
			`create procedure use_cursor is
	l_value number;
begin
	for r in p.c_rows loop
		l_value := r.id;
	end loop;
end;
/
`,
			'cursor.pkb',
		);
		const {symbols, references} = resolve([
			{path: 'cursor.pks', parse: spec},
			{path: 'cursor.pkb', parse: body},
		]);
		const field = references.occurrences.find((occurrence) => targetIn(symbols, occurrence)?.kind === 'field');

		expect(field?.startLine).toBe(5);
		expect(targetIn(symbols, field)).toMatchObject({kind: 'field', name: 'id'});
	});

	it('reports overload ambiguity once and emits no occurrence', () => {
		const result = parse(
			`create package body p as
	procedure over(a number) is begin null; end;
	procedure over(a number, b number default 1) is begin null; end;
	procedure caller is begin over(1); end;
end p;
/
`,
			'overload.pkb',
		);
		const {references} = resolve([{path: 'overload.pkb', parse: result}]);
		const callLine = result.references.find((reference) => reference.kind === 'call' && reference.name.canonical === 'OVER');

		expect(references.diagnostics.filter((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.ambiguousOverload)).toHaveLength(1);
		expect(references.occurrences.filter((occurrence) => occurrence.startLine === callLine?.nameRange.startLine)).toStrictEqual([]);
	});
});
