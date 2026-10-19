import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {type DependencyExtractionResultType} from '../src/core/model.ts';
import {parseWithAntlr} from '../src/adapters/oracle/antlrParser.ts';
import {extractOracleDependencies} from '../src/adapters/oracle/extractDependencies.ts';
import {extractOracleSymbols} from '../src/adapters/oracle/extractSymbols.ts';
import {parseOracleUnits} from '../src/adapters/oracle/parseUnits.ts';
import {type OracleParseResultType} from '../src/adapters/oracle/syntax.ts';
import {tokenizeOracleSource} from '../src/adapters/oracle/tokenize.ts';

type ParsedFileType = Readonly<{path: string; parse: OracleParseResultType}>;
type EdgeType = DependencyExtractionResultType['edges'][number];

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'oracle-project', 'database');

const parse = (source: string, file = 'test.sql'): OracleParseResultType => parseWithAntlr({source, path: file, defaultSchema: 'APP'});

const parseFixture = (name: string): ParsedFileType => ({
	path: name,
	parse: parseWithAntlr({source: readFileSync(path.join(fixtureRoot, name), 'utf8'), path: name, defaultSchema: 'APP'}),
});

const parseStructuralFixture = (name: string): ParsedFileType => {
	const source = readFileSync(path.join(fixtureRoot, name), 'utf8');

	return {
		path: name,
		parse: parseOracleUnits({tokens: tokenizeOracleSource(source, name).tokens, path: name, defaultSchema: 'APP'}),
	};
};

const targetKey = (edge: EdgeType): string => [edge.sourcePath, edge.targetIdentifier ?? '', edge.targetPath ?? '', String(edge.startOffset)].join('\u0000');

const dependenciesOf = (files: readonly ParsedFileType[]): DependencyExtractionResultType => {
	const symbols = extractOracleSymbols({projectId: 'phase5', context: 'APP', files});

	return extractOracleDependencies({
		projectId: 'phase5',
		context: 'APP',
		defaultSchema: 'APP',
		files: symbols.analyses,
		packages: symbols.packages,
	});
};

describe('Oracle ANTLR dependency sites', () => {
	it('emits package calls, package references, and type references', () => {
		const parseResult = parseFixture('sales_api.pkb').parse;
		const dependencies = parseResult.dependencies.map(
			(dependency) => `${dependency.kind}:${dependency.targetName.canonical}:${dependency.memberName?.canonical ?? ''}`,
		);

		expect(dependencies).toStrictEqual(
			expect.arrayContaining([
				'type-reference:HR_API:T_EMPLOYEE',
				'package-call:HR_API:DELETE_EMPLOYEE',
				'package-call:HR_API:EMPLOYEE_LABEL',
				'package-reference:HR_API:C_DEFAULT_SALARY',
				'package-call:EXTERNAL_API:AUDIT',
			]),
		);
		expect(parseResult.dependencies.map((dependency) => dependency.targetName.canonical)).not.toContain('L_EMPLOYEE');
		expect(parseResult.dependencies.map((dependency) => dependency.targetName.canonical)).not.toContain('L_NAME');
	});

	it('excludes local record and collection member chains from dependency sites', () => {
		const parseResult = parse(
			`create package body p as
	procedure run is
		type t_rec is record (field number);
		l_rec t_rec;
		l_value number;
	begin
		l_rec.field := 1;
		l_rec.method(1);
		select e.name into l_value from employees e where e.id = l_value;
	end;
end p;
/
`,
			'local.pkb',
		);

		expect(parseResult.dependencies).toStrictEqual([]);
	});
});

describe('Oracle ANTLR dependency resolution', () => {
	it('resolves workspace packages to the specification path and keeps external calls unresolved', () => {
		const files = [parseFixture('hr_api.pks'), parseFixture('hr_api.pkb'), parseFixture('sales_api.pkb')];
		const {edges} = dependenciesOf(files);
		const edgeAt = (sourcePath: string, targetIdentifier: string, kind: string): EdgeType | undefined =>
			edges.find((edge) => edge.sourcePath === sourcePath && edge.targetIdentifier === targetIdentifier && edge.kind === kind);

		expect(edgeAt('sales_api.pkb', 'APP.HR_API', 'package-call')).toMatchObject({
			sourcePath: 'sales_api.pkb',
			targetPath: 'hr_api.pks',
			rawTarget: 'hr_api',
			kind: 'package-call',
		});
		expect(edgeAt('sales_api.pkb', 'APP.EXTERNAL_API', 'package-call')).toMatchObject({
			sourcePath: 'sales_api.pkb',
			targetPath: null,
			rawTarget: 'external_api',
			kind: 'package-call',
		});
	});

	it('resolves a body-only package target to its body path', () => {
		const body = parse(
			`create package body lone_api as
	procedure run is begin null; end;
end lone_api;
/
`,
			'lone_api.pkb',
		);
		const caller = parse(
			`create procedure caller is
begin
	lone_api.run;
end caller;
/
`,
			'caller.prc',
		);
		const {edges} = dependenciesOf([
			{path: 'lone_api.pkb', parse: body},
			{path: 'caller.prc', parse: caller},
		]);

		expect(edges).toStrictEqual([
			expect.objectContaining({
				sourcePath: 'caller.prc',
				targetIdentifier: 'APP.LONE_API',
				targetPath: 'lone_api.pkb',
				kind: 'package-call',
			}),
		]);
	});

	it('preserves schema-qualified external package targets', () => {
		const parseResult = parse(
			`create procedure caller is
begin
	schema_api.package_api.run(1);
end caller;
/
`,
			'schema_call.prc',
		);
		const {edges} = dependenciesOf([{path: 'schema_call.prc', parse: parseResult}]);

		expect(edges).toStrictEqual([
			expect.objectContaining({
				rawTarget: 'schema_api.package_api',
				targetIdentifier: 'SCHEMA_API.PACKAGE_API',
				targetPath: null,
				kind: 'package-call',
			}),
		]);
	});

	it('does not treat SQL aliases or table columns as package edges', () => {
		const parseResult = parse(
			`create procedure sql_edges is
	l_value number;
begin
	select e.name into l_value
	from employees e
	where e.id = l_value;
end;
/
`,
			'sql_edges.prc',
		);
		const {edges} = dependenciesOf([{path: 'sql_edges.prc', parse: parseResult}]);

		expect(edges).toStrictEqual([]);
	});
});

describe('Oracle ANTLR dependency recovery', () => {
	it('offsets dependency indexes across recovered segments', () => {
		const parseResult = parse(
			`create package first_api as procedure p; end first_api;
this is not plsql;
/
create procedure caller is
begin
	hr_api.run;
end caller;
/
`,
			'recovered.pkb',
		);
		const dependency = parseResult.dependencies.find((item) => item.targetName.canonical === 'HR_API');
		const enclosing = dependency === undefined ? undefined : parseResult.declarations[dependency.enclosing];

		expect(parseResult.units.map((unit) => unit.canonical)).toStrictEqual(['APP.FIRST_API', 'APP.CALLER']);
		expect(dependency?.unit).toBe(1);
		expect(enclosing).toMatchObject({kind: 'procedure', name: {canonical: 'CALLER'}, unit: 1});
	});
});

describe('Oracle ANTLR dependency differential', () => {
	it('matches structural dependency targets on the committed fixtures', () => {
		const names = ['hr_api.pks', 'hr_api.pkb', 'sales_api.pks', 'sales_api.pkb', 'maintenance_run.prc', 'qualification.pkb'];
		const structural = dependenciesOf(names.map((name) => parseStructuralFixture(name)))
			.edges.map((edge) => targetKey(edge))
			.sort();
		const antlr = dependenciesOf(names.map((name) => parseFixture(name)))
			.edges.map((edge) => targetKey(edge))
			.sort();

		expect(antlr).toStrictEqual(structural);
	});
});
