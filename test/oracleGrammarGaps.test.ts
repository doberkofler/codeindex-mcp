import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseWithAntlr} from '../src/adapters/oracle/antlrParser.ts';
import {ORACLE_DIAGNOSTIC} from '../src/adapters/oracle/diagnostics.ts';
import {type OracleParseResultType} from '../src/adapters/oracle/syntax.ts';

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'oracle-grammar-gaps');
const openGaps = [
	'constant-size-type.pks',
	'xmltable-returning-sequence.sql',
	'json-strict.pkb',
	'nullable-field.pks',
	'record-insert.sql',
	'wrapped.pkb',
] as const;
const fixedGaps = ['rem-comment.sql', 'keyword-identifier.pks', 'sqlplus-exec.sql'] as const;

const parseFixture = (name: string): OracleParseResultType => {
	const source = readFileSync(path.join(fixtureRoot, name), 'utf8');

	return parseWithAntlr({source, path: name, defaultSchema: 'APP'});
};

describe('Oracle grammar gap fixtures', () => {
	it.each(openGaps)('records the known parse gap in %s', (name) => {
		const result = parseFixture(name);

		expect(result.diagnostics.some((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.parse)).toBe(true);
	});

	it.each(fixedGaps)('parses the upstream-fixed fixture %s without a parse diagnostic', (name) => {
		const result = parseFixture(name);

		expect(result.diagnostics.some((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.parse)).toBe(false);
	});
});
