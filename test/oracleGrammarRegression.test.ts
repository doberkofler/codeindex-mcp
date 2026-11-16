import {describe, expect, it} from 'vitest';
import {parseWithAntlr, parseWithAntlrProfiled} from '@codeindex/adapter-oracle/antlrParser';
import {ORACLE_DIAGNOSTIC} from '@codeindex/adapter-oracle/diagnostics';

const parseDiagnostics = (source: string): readonly unknown[] =>
	parseWithAntlr({source, path: 'grammar-regression.sql', defaultSchema: 'APP'}).diagnostics.filter(
		(diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.parse,
	);

describe('Oracle upstream grammar regressions', () => {
	it('predicts a bare JOIN after an unaliased table', () => {
		const profiled = parseWithAntlrProfiled({
			source: 'select * from employees join departments on departments.id = employees.department_id;',
			path: 'bare-join.sql',
			defaultSchema: 'APP',
		});

		expect(profiled.result.diagnostics).toStrictEqual([]);
		expect(profiled.profile.prediction).toBe('sll');
	});

	it('parses simple CASE selector lists and dangling predicates', () => {
		expect(
			parseDiagnostics(`begin
	case grade
		when 'A', 'B' then null;
		when like 'C%' then null;
		when not in ('D', 'F') then null;
		else null;
	end case;
end;
/`),
		).toStrictEqual([]);
	});

	it('accepts COMPRESSION as a PL/SQL identifier', () => {
		expect(parseDiagnostics('create package identifiers as compression boolean; end identifiers;\n/')).toStrictEqual([]);
	});

	it('parses JSON_SERIALIZE expressions and parenthesized IS JSON modes', () => {
		expect(
			parseDiagnostics(`select json_serialize(
	case when use_fallback = 1 then '{}' else json_document end returning clob pretty
) from json_documents
where json_document is json (strict);`),
		).toStrictEqual([]);
	});

	it('keeps extractor facts stable for grammar-only syntax additions', () => {
		const result = parseWithAntlr({
			source: `create package body grammar_facts as
	procedure run is
		grade varchar2(1);
	begin
		case grade when 'A', 'B' then null; else null; end case;
	end run;
end grammar_facts;
/`,
			path: 'grammar-facts.pkb',
			defaultSchema: 'APP',
		});

		expect(result.diagnostics).toStrictEqual([]);
		expect(result.units).toMatchObject([{kind: 'package-body', canonical: 'APP.GRAMMAR_FACTS'}]);
		expect(result.declarations.map((declaration) => `${declaration.kind}:${declaration.name.canonical}`)).toStrictEqual([
			'package:GRAMMAR_FACTS',
			'procedure:RUN',
			'variable:GRADE',
		]);
	});
});
