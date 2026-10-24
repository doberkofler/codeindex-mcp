import {describe, expect, it} from 'vitest';
import {prepareConditionalSource} from '../src/adapters/oracle/conditionalCompilation.ts';
import {ORACLE_DIAGNOSTIC} from '../src/adapters/oracle/diagnostics.ts';
import {tokenizeOracleSource} from '../src/adapters/oracle/tokenize.ts';

const prepare = (source: string): ReturnType<typeof prepareConditionalSource> => {
	const tokenized = tokenizeOracleSource(source, 'conditional.pks');

	return prepareConditionalSource({source, path: 'conditional.pks', tokens: tokenized.tokens});
};

const messages = (source: string): readonly string[] => prepare(source).diagnostics.map((diagnostic) => diagnostic.message);

describe('Oracle conditional compilation branches', () => {
	it('keeps source without directives unchanged', () => {
		const source = 'create procedure p is begin null; end;\n/\n';
		const result = prepare(source);

		expect(result.source).toBe(source);
		expect(result.diagnostics).toStrictEqual([]);
	});

	it('blanks a literal-false branch and its directives', () => {
		const result = prepare('$IF FALSE $THEN\nhidden_thing;\n$ELSE\nvisible_thing;\n$END\n');

		expect(result.source).toContain('visible_thing');
		expect(result.source).not.toContain('hidden_thing');
		expect(result.source).not.toContain('$IF');
		expect(result.source.split('\n')).toHaveLength(6);
		expect(result.diagnostics).toStrictEqual([]);
	});

	it('blanks an else branch after a literal-true condition', () => {
		const result = prepare('$IF TRUE $THEN\nvisible_thing;\n$ELSE\nhidden_thing;\n$END\n');

		expect(result.source).toContain('visible_thing');
		expect(result.source).not.toContain('hidden_thing');
	});

	it('keeps both branches for a non-literal condition', () => {
		const result = prepare("$IF $$PLSQL_UNIT = 'P' $THEN\nfirst_thing;\n$ELSE\nsecond_thing;\n$END\n");

		expect(result.source).toContain('first_thing');
		expect(result.source).toContain('second_thing');
		expect(result.source).not.toContain('$IF');
	});

	it('selects the first satisfied elsif and blanks later branches', () => {
		const result = prepare('$IF FALSE $THEN\nfirst_thing;\n$ELSIF TRUE $THEN\nsecond_thing;\n$ELSIF TRUE $THEN\nthird_thing;\n$ELSE\nfourth_thing;\n$END\n');

		expect(result.source).not.toContain('first_thing');
		expect(result.source).toContain('second_thing');
		expect(result.source).not.toContain('third_thing');
		expect(result.source).not.toContain('fourth_thing');
	});

	it('keeps a non-literal elsif branch with its following branches', () => {
		const result = prepare('$IF FALSE $THEN\nfirst_thing;\n$ELSIF $$FLAG $THEN\nsecond_thing;\n$ELSE\nthird_thing;\n$END\n');

		expect(result.source).not.toContain('first_thing');
		expect(result.source).toContain('second_thing');
		expect(result.source).toContain('third_thing');
	});

	it('reports every unbalanced directive', () => {
		expect(messages('$ELSIF TRUE $THEN\nthing;\n')).toContain('$ELSIF without a matching $IF');
		expect(messages('$ELSE\nthing;\n')).toContain('$ELSE without a matching $IF');
		expect(messages('$END\n')).toContain('$END without a matching $IF');
		expect(messages('$THEN\nthing;\n')).toContain('$THEN without a matching $IF');
		expect(messages("$ERROR 'unsupported'\n")).toContain('$ERROR directive is not supported by the Oracle extractor');
	});

	it('reports a missing then and resumes at the next directive', () => {
		const result = prepare('$IF TRUE\nfirst_thing;\n$END\n');

		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(ORACLE_DIAGNOSTIC.conditionalCompilation);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain('Unterminated $IF condition: missing $THEN');
	});

	it('stops a condition at a directive that is not then', () => {
		const result = prepare('$IF TRUE $ELSE\nfirst_thing;\n$END\n');

		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain('Unterminated $IF condition: missing $THEN');
	});

	it('blanks an unterminated disabled branch to the end of the file', () => {
		const result = prepare('$IF FALSE $THEN\nhidden_thing;\n');

		expect(result.source).not.toContain('hidden_thing');
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain('Unterminated $IF: 1 conditional block(s) remain open');
	});

	it('keeps nested blocks inside a disabled parent blanked', () => {
		const result = prepare('$IF FALSE $THEN\n$IF TRUE $THEN\nnested_thing;\n$END\n$END\n');

		expect(result.source).not.toContain('nested_thing');
	});

	it('preserves line breaks while blanking disabled content', () => {
		const result = prepare('$IF FALSE $THEN\r\nhidden_a;\r\nhidden_b;\r\n$END\r\n');

		expect(result.source.split('\r\n')).toHaveLength(5);
		expect(result.source).not.toContain('hidden_a');
		expect(result.source).not.toContain('hidden_b');
	});
});
