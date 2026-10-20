import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {parseOracleManifest} from '../src/adapters/oracle/manifest.ts';
import {parseOracleUnits} from '../src/adapters/oracle/parseUnits.ts';
import {tokenizeOracleSource} from '../src/adapters/oracle/tokenize.ts';
import {loadConfig} from '../src/core/config/config.ts';
import {scanOracleProject} from '../src/adapters/oracle/scanProject.ts';
import {createFixtureConfig, createFixtureIndex} from './helpers/fixture.ts';

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'oracle-project');
const databaseRoot = path.join(fixtureRoot, 'database');

const parseFixture = (name: string): ReturnType<typeof parseOracleUnits> => {
	const source = readFileSync(path.join(databaseRoot, name), 'utf8');
	const tokenized = tokenizeOracleSource(source, name);

	expect(tokenized.diagnostics).toStrictEqual([]);
	return parseOracleUnits({tokens: tokenized.tokens, path: name, defaultSchema: 'APP'});
};

describe('Oracle lexer', () => {
	it('reconstructs source exactly and hides strings and comments from visible tokens', () => {
		const source = `create or replace package "Unicode API" as
	-- package comment
	function json(p_text in varchar2 default q'[a,b]') return varchar2;
	function other(p_text in varchar2 default 'not_a_name') return varchar2;
end "Unicode API";
/`;
		const result = tokenizeOracleSource(source, 'lexer.sql');
		const visible = result.tokens.filter((token) => token.channel === 'visible').map((token) => token.text);

		expect(result.tokens.map((token) => token.text).join('')).toBe(source);
		expect(visible).not.toContain('not_a_name');
		expect(visible).not.toContain('package comment');
		expect(visible).toContain("q'[a,b]'");
	});

	it('advances past malformed input without losing the tail', () => {
		const result = tokenizeOracleSource("create package broken as\nprocedure p;\nend;\n/\nselect 'unterminated", 'broken.sql');

		expect(result.tokens.length).toBeGreaterThan(0);
		expect(result.tokens.map((token) => token.text).join('')).toContain('unterminated');
	});
});

describe('Oracle declaration parser', () => {
	it('extracts package specification declarations, parameters, types, and fields', () => {
		const parsed = parseFixture('hr_api.pks');
		const names = parsed.declarations.map((declaration) => `${declaration.kind}:${declaration.name.canonical}`);

		expect(parsed.units).toHaveLength(1);
		expect(parsed.units[0]?.canonical).toBe('APP.HR_API');
		expect(names).toContain('record_type:T_EMPLOYEE');
		expect(names).toContain('field:ID');
		expect(names).toContain('field:NAME');
		expect(names).toContain('collection_type:T_EMPLOYEE_TT');
		expect(names).toContain('subtype:T_NAME');
		expect(names).toContain('constant:C_DEFAULT_SALARY');
		expect(names).toContain('variable:G_LAST_ID');
		expect(names).toContain('exception:E_INVALID');
		expect(names).toContain('function:EMPLOYEE_LABEL');
		expect(names.filter((name) => name === 'procedure:FIND_EMPLOYEE')).toHaveLength(2);
		expect(names).toContain('parameter:P_EMPLOYEE_ID');
		expect(names).toContain('parameter:P_SALARY');

		const save = parsed.declarations.find((declaration) => declaration.kind === 'procedure' && declaration.name.canonical === 'SAVE_EMPLOYEE');

		expect(save?.parameters.map((parameter) => `${parameter.name.canonical}:${parameter.mode}:${parameter.typeText}`)).toStrictEqual([
			'P_EMPLOYEE_ID:IN OUT:EMPLOYEES.EMPLOYEE_ID%TYPE',
			'P_NAME:IN:VARCHAR2',
			'P_SALARY:IN:NUMBER',
		]);
		expect(save?.parameters[2]?.hasDefault).toBe(true);
	});

	it('extracts package body implementations, private members, and nested routines', () => {
		const parsed = parseFixture('hr_api.pkb');
		const names = parsed.declarations.map((declaration) => `${declaration.kind}:${declaration.name.canonical}`);

		expect(parsed.units[0]?.kind).toBe('package-body');
		expect(names.filter((name) => name === 'procedure:FORWARD_HELPER')).toHaveLength(2);
		expect(names).toContain('constant:G_PRIVATE');
		expect(names).toContain('procedure:PRIVATE_HELPER');
		expect(names).toContain('procedure:LOG_LOOKUP');
		expect(parsed.references.some((reference) => reference.name.canonical === 'HR_API.DELETE_EMPLOYEE')).toBe(true);
		expect(parsed.dependencies.some((dependency) => dependency.targetName.canonical === 'HR_API')).toBe(true);
	});

	it('recovers routine declarations after nested CASE expressions', () => {
		const parsed = parseFixture('qualification.pkb');
		const names = parsed.declarations.map((declaration) => declaration.name.canonical);

		expect(names).toContain('CASE_THEN_ROUTINE');
		expect(names).toContain('AFTER_CASE');
		expect(names).toContain('DISABLED_BRANCH');
		expect(names).toContain('LITERAL_TRUE_BRANCH');
		expect(names).toContain('UNKNOWN_BRANCH');
	});

	it('does not emit references at declaration positions', () => {
		const parsed = parseFixture('qualification.pkb');
		const offsets = new Set(parsed.declarations.map((declaration) => declaration.nameRange.startOffset));

		expect(parsed.references.filter((reference) => offsets.has(reference.nameRange.startOffset))).toStrictEqual([]);
	});

	it('skips disabled conditional compilation branches and keeps enabled branches', () => {
		const parsed = parseFixture('qualification.pkb');
		const names = parsed.references.map((reference) => reference.name.canonical);

		const dependencies = parsed.dependencies.map((dependency) => dependency.targetName.canonical);

		expect(names).not.toContain('MISSING_PACKAGE.MISSING_FUNCTION');
		expect(names).not.toContain('HIDDEN_HELPER');
		expect(names).toContain('ENABLED_PACKAGE.ENABLED_CALL');
		expect(names).not.toContain('DISABLED_PACKAGE.DISABLED_CALL');
		expect(names).toContain('FIRST_PACKAGE.FIRST_BRANCH');
		expect(names).toContain('SECOND_PACKAGE.SECOND_BRANCH');
		expect(dependencies).not.toContain('MISSING_PACKAGE');
		expect(dependencies).toContain('ENABLED_PACKAGE');
		expect(dependencies).not.toContain('DISABLED_PACKAGE');
	});

	it('parses multiple units in a script and reports wrapped source', () => {
		const source = `create or replace package first_api as procedure run; end first_api;
/
create or replace procedure second_run is begin null; end second_run;
/
create or replace package wrapped_api wrapped
`;
		const tokenized = tokenizeOracleSource(source, 'multi.sql');
		const parsed = parseOracleUnits({tokens: tokenized.tokens, path: 'multi.sql', defaultSchema: 'APP'});

		expect(parsed.units.map((unit) => `${unit.kind}:${unit.name.canonical}`)).toStrictEqual(['package-spec:FIRST_API', 'procedure:SECOND_RUN']);
		expect(parsed.diagnostics.some((diagnostic) => diagnostic.code === 9103)).toBe(true);
	});
});

describe('Oracle manifest', () => {
	it('rejects invalid manifests and unsafe patterns', () => {
		expect(() => parseOracleManifest({schemaVersion: 1, dialect: '19c', defaultSchema: 'APP', include: ['../*.pks']})).toThrow(/pattern/u);
		expect(() => parseOracleManifest({schemaVersion: 2, dialect: '19c', defaultSchema: 'APP', include: ['*.pks']})).toThrow(/Invalid Oracle manifest/u);
	});

	it('supports manifest-defined extensions', () => {
		const manifest = parseOracleManifest({
			schemaVersion: 1,
			dialect: '19c',
			defaultSchema: 'APP',
			extensions: ['.ora'],
			include: ['database/**/*.ora'],
		});

		expect(manifest.extensions).toStrictEqual(['.ora']);
	});
});

describe('Oracle index integration', () => {
	const fixture = createFixtureIndex('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

	afterAll(() => {
		fixture.cleanup();
	});
	const firstSymbol = (query: string): ReturnType<typeof fixture.index.findSymbols>['items'][number] => {
		const symbol = fixture.index.findSymbols({query, match: 'qualified', limit: 1}).items.at(0);

		if (symbol === undefined) {
			throw new Error(`Expected symbol ${query}`);
		}

		return symbol;
	};

	it('indexes package specs and bodies and serves outlines', () => {
		const status = fixture.index.getStatus();
		const outline = fixture.index.getOutline({path: 'database/hr_api.pks', limit: 100});

		expect(status.scope.extractor.id).toBe('oracle');
		expect(status.counts.files).toBeGreaterThan(4);
		expect(status.counts.diagnostics).toBe(0);
		expect(outline.items.some((symbol) => symbol.kind === 'package' && symbol.qualifiedName === 'owner["APP"]::HR_API')).toBe(true);
		expect(outline.items.some((symbol) => symbol.kind === 'procedure' && symbol.name === 'SAVE_EMPLOYEE')).toBe(true);
	});

	it('links body definitions to canonical specification symbols', () => {
		const matches = fixture.index.findSymbols({query: 'owner["APP"]::HR_API.SAVE_EMPLOYEE', match: 'qualified', limit: 10});
		const exact = matches.items.filter((item) => item.match === 'exact_qualified');
		const references = fixture.index.findReferences({symbolId: exact[0]?.id ?? '', limit: 100});

		expect(exact).toHaveLength(1);
		expect(references.items.filter((reference) => reference.role === 'definition').map((reference) => reference.path)).toStrictEqual([
			'database/hr_api.pkb',
			'database/hr_api.pks',
		]);
	});

	it('resolves package calls and record fields while keeping ephemeral declarations out of the index', () => {
		const sync = firstSymbol('owner["APP"]::SALES_API.SYNC_EMPLOYEE');
		const label = firstSymbol('owner["APP"]::HR_API.EMPLOYEE_LABEL');
		const deleteEmployee = firstSymbol('owner["APP"]::HR_API.DELETE_EMPLOYEE');

		expect(fixture.index.findReferences({symbolId: sync.id, limit: 100}).items.length).toBeGreaterThan(0);
		expect(fixture.index.findReferences({symbolId: label.id, limit: 100}).items.length).toBeGreaterThan(1);
		expect(fixture.index.findSymbols({query: 'owner["APP"]::SALES_API.SYNC_EMPLOYEE.L_NAME', match: 'qualified', limit: 10}).items).toHaveLength(0);
		expect(fixture.index.findSymbols({query: 'owner["APP"]::HR_API.FIND_EMPLOYEE.P_NAME', match: 'qualified', limit: 10}).items).toHaveLength(0);

		const qualifiedCall = fixture.index
			.findReferences({symbolId: deleteEmployee.id, limit: 100})
			.items.find((item) => item.path === 'database/sales_api.pkb' && item.startLine === 6);

		expect(qualifiedCall?.startColumn).toBe(10);

		const packageSymbol = firstSymbol('owner["APP"]::HR_API');
		const packageReferences = fixture.index.findReferences({symbolId: packageSymbol.id, limit: 100}).items;

		expect(packageReferences.some((item) => item.path === 'database/hr_api.pkb' && item.startLine === 57)).toBe(false);

		const record = firstSymbol('owner["APP"]::HR_API.T_EMPLOYEE');
		expect(fixture.index.findReferences({symbolId: record.id, limit: 100}).items.map((item) => item.path)).toContain('database/sales_api.pkb');

		const field = firstSymbol('owner["APP"]::HR_API.T_EMPLOYEE.ID');
		expect(fixture.index.findReferences({symbolId: field.id, limit: 10}).items.map((item) => item.role)).toStrictEqual(['definition']);

		const forward = firstSymbol('owner["APP"]::HR_API.FORWARD_HELPER');
		const forwardDefinitions = fixture.index.findReferences({symbolId: forward.id, role: 'definition', limit: 10});

		expect(forwardDefinitions.items).toHaveLength(2);
	});

	it('reports direct package dependencies and transitive authored impact', () => {
		const direct = fixture.index.findDependencies({target: 'APP.HR_API', limit: 100});
		const impact = fixture.index.findDependencies({target: 'APP.HR_API', transitive: true, limit: 100});

		expect(direct.items.map((item) => item.path)).toContain('database/sales_api.pkb');
		expect(direct.items.map((item) => item.path)).toContain('database/maintenance_run.prc');
		expect(direct.queryMeaning).toBe('direct_usage');
		expect(impact.queryMeaning).toBe('dependency_impact');
		expect(impact.summary.roots.length).toBeGreaterThan(0);

		const external = fixture.index.findDependencies({target: 'APP.EXTERNAL_API', limit: 10});

		expect(external.items.map((item) => item.path)).toContain('database/sales_api.pkb');
	});

	it('reads bounded source for an Oracle symbol', () => {
		const symbol = firstSymbol('owner["APP"]::SALES_API.SYNC_EMPLOYEE');
		const result = fixture.index.readSymbol({symbolId: symbol.id, contextLines: 1});

		if (result.kind !== 'text') {
			throw new Error('Expected text read result');
		}

		expect(result.source).toContain('procedure sync_employee');
		expect(result.path).toBe('database/sales_api.pkb');
	});
});

describe('Oracle manifest scanning and freshness', () => {
	const projects = [{name: 'app', project: 'oracle-index.json'}];

	it('requires an explicit manifest when the Oracle extractor is selected', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'oracle-config-'));

		try {
			expect(() => loadConfig({CODE_INDEX_ROOT: directory, CODE_INDEX_EXTRACTOR: 'oracle'}, directory)).toThrow(/oracle extractor requires/u);
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('changes the source hash for edits, adds, deletes, and manifest changes', () => {
		const {config, cleanup} = createFixtureConfig('oracle-project', projects, 'oracle');

		try {
			const initial = scanOracleProject(config);
			const added = path.join(config.rootDir, 'database', 'added.pks');
			const sourceFile = path.join(config.rootDir, 'database', 'hr_api.pks');
			const originalSource = readFileSync(sourceFile);

			writeFileSync(added, 'create or replace package added_api as procedure run; end added_api;\n/\n');
			const afterAdd = scanOracleProject(config);

			expect(afterAdd.files).toHaveLength(initial.files.length + 1);
			expect(afterAdd.sourceHash).not.toBe(initial.sourceHash);

			writeFileSync(sourceFile, `${readFileSync(sourceFile, 'utf8')}\n`);
			const afterEdit = scanOracleProject(config);

			expect(afterEdit.sourceHash).not.toBe(afterAdd.sourceHash);

			rmSync(added);
			writeFileSync(sourceFile, originalSource);
			const afterDelete = scanOracleProject(config);

			expect(afterDelete.files).toHaveLength(initial.files.length);
			expect(afterDelete.sourceHash).toBe(initial.sourceHash);

			const manifestPath = config.projects[0]?.projectFilePath ?? '';
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
			writeFileSync(manifestPath, JSON.stringify({...manifest, exclude: ['**/generated/**', 'database/sales_api.pkb']}));
			const afterManifest = scanOracleProject(config);

			expect(afterManifest.files.map((file) => file.path)).not.toContain('database/sales_api.pkb');
			expect(afterManifest.configHash).not.toBe(initial.configHash);
		} finally {
			cleanup();
		}
	});

	it('honours manifest-defined extensions', () => {
		const {config, cleanup} = createFixtureConfig('oracle-project', projects, 'oracle');

		try {
			const manifestPath = config.projects[0]?.projectFilePath ?? '';
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {include?: string[]} & Record<string, unknown>;
			const include = [...(manifest.include ?? []), 'database/**/*.sql'];

			writeFileSync(manifestPath, JSON.stringify({...manifest, extensions: ['.pks', '.pkb', '.sql'], include}));
			writeFileSync(path.join(config.rootDir, 'database', 'script.sql'), 'create or replace procedure script_run is begin null; end;\n/\n');
			const scanned = scanOracleProject(config);

			expect(scanned.files.map((file) => file.path)).toContain('database/script.sql');
		} finally {
			cleanup();
		}
	});
});
