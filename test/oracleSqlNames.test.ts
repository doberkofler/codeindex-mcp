import {CharStream, CommonTokenStream} from 'antlr4ng';
import {describe, expect, it} from 'vitest';
import {collectAntlrSqlNames} from '../src/adapters/oracle/antlrSqlNames.ts';
import {PlSqlLexer} from '../src/adapters/oracle/generated/PlSqlLexer.ts';
import {PlSqlParser, type Sql_scriptContext} from '../src/adapters/oracle/generated/PlSqlParser.ts';

const namesOf = (source: string): readonly string[] => {
	const lexer = new PlSqlLexer(CharStream.fromString(source));
	const stream = new CommonTokenStream(lexer);
	stream.fill();
	const parser = new PlSqlParser(stream);
	parser.removeErrorListeners();
	const script = parser.sql_script();

	return [...collectAntlrSqlNames(script)].sort();
};

describe('Oracle SQL name collection', () => {
	it('collects tables, table aliases, column aliases, and query names', () => {
		expect(
			namesOf(`WITH recent_jobs (id) AS (
	SELECT j.id AS job_alias FROM employees e JOIN departments d ON d.id = e.dept_id
)
SELECT r.id AS final_alias
FROM recent_jobs r;
`),
		).toStrictEqual(expect.arrayContaining(['RECENT_JOBS', 'EMPLOYEES', 'E', 'DEPARTMENTS', 'D', 'JOB_ALIAS', 'FINAL_ALIAS', 'R']));
	});

	it('reads a qualified tableview name and ignores aliases without identifiers', () => {
		expect(namesOf('SELECT x "Column Alias" FROM hr.employees "Table Alias";\n')).toStrictEqual(
			expect.arrayContaining(['EMPLOYEES', '"Table Alias"', '"Column Alias"']),
		);
	});

	it('tolerates an alias without an identifier and reads an id-expression table', () => {
		const script = {
			accept: (visitor: {
				visitTable_alias: (context: unknown) => void;
				visitColumn_alias: (context: unknown) => void;
				visitQuery_name: (context: unknown) => void;
				visitTableview_name: (context: unknown) => void;
			}): void => {
				const alias = {identifier: (): null => null};
				visitor.visitTable_alias(alias);
				visitor.visitColumn_alias(alias);
				visitor.visitQuery_name({identifier: () => ({id_expression: (): {getText: () => string} => ({getText: (): string => 'QUERY_NAME'})})});
				visitor.visitTableview_name({
					id_expression: (): {getText: () => string} => ({getText: (): string => 'SCHEMA.TABLE_NAME'}),
					identifier: (): null => null,
					getChildCount: (): number => 0,
				});
			},
		} as unknown as Sql_scriptContext;

		expect([...collectAntlrSqlNames(script)]).toStrictEqual(expect.arrayContaining(['QUERY_NAME', 'SCHEMA.TABLE_NAME']));
	});
});
