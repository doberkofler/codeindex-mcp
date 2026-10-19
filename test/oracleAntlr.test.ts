import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {antlrOracleParser, parseWithAntlr, parseWithAntlrProfiled, type OracleAntlrProfileType} from '../src/adapters/oracle/antlrParser.ts';
import {ORACLE_DIAGNOSTIC} from '../src/adapters/oracle/diagnostics.ts';
import {type OracleParseResultType} from '../src/adapters/oracle/syntax.ts';

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'oracle-project', 'database');
const parse = (source: string, file = 'test.sql'): OracleParseResultType => parseWithAntlr({source, path: file, defaultSchema: 'APP'});

describe('Oracle ANTLR unit facts', () => {
	it('emits top-level package units and preserves one-based ranges', () => {
		const result = parse('\ncreate or replace package hr_api as\n\tprocedure p;\nend hr_api;\n/\n');

		expect(result.diagnostics).toStrictEqual([]);
		expect(result.units).toMatchObject([
			{
				kind: 'package-spec',
				canonical: 'APP.HR_API',
				range: {startLine: 2, startColumn: 1, startOffset: 1},
				nameRange: {startLine: 2},
			},
		]);
		expect(result.declarations[0]).toMatchObject({kind: 'package', exported: true, unit: 0});
		expect(result.declarations[1]).toMatchObject({kind: 'procedure', parent: 0, exported: true});
	});

	it('distinguishes package bodies from specifications', () => {
		const result = parse('create package body hr_api as procedure p is begin null; end; end hr_api;\n/\n');

		expect(result.units).toMatchObject([{kind: 'package-body', canonical: 'APP.HR_API'}]);
		expect(result.declarations[0]).toMatchObject({kind: 'package', exported: false});
		expect(result.declarations[1]).toMatchObject({kind: 'procedure', parent: 0, exported: false});
	});

	it('emits standalone procedures and functions', () => {
		const result = parse('create procedure p(x in number) is begin null; end;\n/\ncreate function f return number is begin return 1; end;\n/\n');

		expect(result.diagnostics).toStrictEqual([]);
		expect(result.units.map((unit) => `${unit.kind}:${unit.canonical}`)).toStrictEqual(['procedure:APP.P', 'function:APP.F']);
		expect(result.declarations.map((declaration) => declaration.kind)).toStrictEqual(['procedure', 'parameter', 'function']);
	});

	it('parses the committed Oracle fixture package specification', () => {
		const source = readFileSync(path.join(fixtureRoot, 'hr_api.pks'), 'utf8');
		const result = parseWithAntlr({source, path: 'hr_api.pks', defaultSchema: 'APP'});

		expect(result.units.map((unit) => unit.canonical)).toContain('APP.HR_API');
		expect(result.diagnostics.filter((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.parse)).toStrictEqual([]);
	});

	it('keeps the parser adapter free of lexer failures on the package body fixture', () => {
		const source = readFileSync(path.join(fixtureRoot, 'hr_api.pkb'), 'utf8');
		const result = parseWithAntlr({source, path: 'hr_api.pkb', defaultSchema: 'APP'});

		expect(result.diagnostics.filter((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.lexer)).toStrictEqual([]);
	});
});

describe('Oracle ANTLR conditional compilation', () => {
	it('blanks a literal-disabled branch before parsing', () => {
		const result = parse(`create package ok as
$IF FALSE $THEN
procedure broken(;
$ELSE
procedure good;
$END
end ok;
/
`);

		expect(result.diagnostics).toStrictEqual([]);
		expect(result.units.map((unit) => unit.canonical)).toStrictEqual(['APP.OK']);
	});

	it('blanks a literal-enabled else branch before parsing', () => {
		const result = parse(`create package ok as
$IF TRUE $THEN
procedure good;
$ELSE
procedure broken(;
$END
end ok;
/
`);

		expect(result.diagnostics).toStrictEqual([]);
		expect(result.units.map((unit) => unit.canonical)).toStrictEqual(['APP.OK']);
	});

	it('keeps both branches for non-literal conditions', () => {
		const result = parse(`create package ok as
$IF $$flag $THEN
procedure first_p;
$ELSE
procedure second_p;
$END
end ok;
/
`);

		expect(result.diagnostics).toStrictEqual([]);
		expect(result.units.map((unit) => unit.canonical)).toStrictEqual(['APP.OK']);
	});

	it('suppresses lexer diagnostics from a literal-disabled branch', () => {
		const result = parse(`create package ok as
$IF FALSE $THEN
procedure broken(;
\\
$ELSE
procedure good;
$END
end ok;
/
`);

		expect(result.diagnostics).toStrictEqual([]);
		expect(result.units.map((unit) => unit.canonical)).toStrictEqual(['APP.OK']);
	});

	it('follows literal $ELSIF chains', () => {
		const result = parse(`create package ok as
$IF FALSE $THEN
procedure broken(;
$ELSIF TRUE $THEN
procedure good;
$ELSE
procedure also_broken(;
$END
end ok;
/
`);

		expect(result.diagnostics).toStrictEqual([]);
		expect(result.units.map((unit) => unit.canonical)).toStrictEqual(['APP.OK']);
	});

	it('reports an unterminated $IF block', () => {
		const result = parse('create package ok as\n$IF FALSE $THEN\nprocedure broken(;\n');
		const conditional = result.diagnostics.filter((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.conditionalCompilation);

		expect(conditional.map((diagnostic) => diagnostic.message)).toStrictEqual([expect.stringContaining('Unterminated $IF')]);
	});

	it('reports unbalanced conditional directives instead of truncating', () => {
		const result = parse('create package ok as procedure p; $END end ok;\n/\n');
		const conditional = result.diagnostics.filter((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.conditionalCompilation);

		expect(conditional).toHaveLength(1);
		expect(conditional.map((diagnostic) => diagnostic.message)).toStrictEqual([expect.stringContaining('$END')]);
		expect(conditional.map((diagnostic) => diagnostic.path)).toStrictEqual(['test.sql']);
	});
});

describe('Oracle ANTLR recovery and diagnostics', () => {
	it('recovers a later unit after a malformed prefix', () => {
		const result = parse(`create package broken as
procedure p(;
/
create package good as
procedure q;
end good;
/
`);

		expect(result.units.map((unit) => unit.canonical)).toContain('APP.GOOD');
	});

	it('bounds parser diagnostics and emits one overflow marker', () => {
		const body = Array.from({length: 40}, () => 'create procedure ;\n/\n').join('');
		const result = parse(body);
		const parserDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code !== ORACLE_DIAGNOSTIC.lexer);

		expect(parserDiagnostics.length).toBeLessThanOrEqual(21);
		expect(parserDiagnostics.some((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.diagnosticOverflow)).toBe(true);
	});

	it('does not expose absolute source paths in diagnostics', () => {
		const result = parse('create package broken as procedure p(; end broken;\n/\n');
		const serialized = JSON.stringify(result.diagnostics);

		expect(serialized).not.toContain(process.cwd());
		expect(result.diagnostics.every((diagnostic) => diagnostic.path === 'test.sql')).toBe(true);
	});

	it('exposes the parser seam with identical behavior', () => {
		const input = {source: 'create package p as end p;\n/\n', path: 'seam.sql', defaultSchema: 'APP'};

		expect(antlrOracleParser(input)).toStrictEqual(parseWithAntlr(input));
	});

	it('uses the parse diagnostic category for malformed declarations', () => {
		const result = parse('create package broken as procedure p(; end broken;\n/\n');
		const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

		expect(codes).toContain(ORACLE_DIAGNOSTIC.parse);
	});

	it('returns identical facts with opt-in phase profiling', () => {
		const input = {source: 'create package p as procedure q; end p;\n/\n', path: 'profile.sql', defaultSchema: 'APP'};
		const profiled = parseWithAntlrProfiled(input);
		const profile: OracleAntlrProfileType = profiled.profile;

		expect(profiled.result).toStrictEqual(parseWithAntlr(input));
		expect(profile).toMatchObject({prediction: 'sll', recovered: false, sllAttempts: 1, llAttempts: 0});
		expect(profile.totalMs).toBeGreaterThanOrEqual(0);
	});

	it('reports an LL fallback without leaking SLL diagnostics', () => {
		const source = readFileSync(path.join(import.meta.dirname, 'fixtures', 'oracle-grammar-gaps', 'constant-size-type.pks'), 'utf8');
		const profiled = parseWithAntlrProfiled({source, path: 'constant-size-type.pks', defaultSchema: 'APP'});
		const plain = parseWithAntlr({source, path: 'constant-size-type.pks', defaultSchema: 'APP'});

		expect(profiled.profile.prediction).toBe('sll-fallback-ll');
		expect(profiled.profile.sllAttempts).toBeGreaterThanOrEqual(1);
		expect(profiled.profile.llAttempts).toBeGreaterThanOrEqual(1);
		expect(profiled.profile.sllParseMs).toBeGreaterThan(0);
		expect(profiled.result).toStrictEqual(plain);
	});
});
