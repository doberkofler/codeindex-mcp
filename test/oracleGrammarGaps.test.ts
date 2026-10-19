import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseWithAntlr} from '../src/adapters/oracle/antlrParser.ts';
import {ORACLE_DIAGNOSTIC} from '../src/adapters/oracle/diagnostics.ts';

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'oracle-grammar-gaps');
const fixtures = [
	'rem-comment.sql',
	'keyword-identifier.pks',
	'constant-size-type.pks',
	'xmltable-returning-sequence.sql',
	'json-strict.pkb',
	'sqlplus-exec.sql',
	'nullable-field.pks',
	'record-insert.sql',
	'wrapped.pkb',
];

describe('Oracle grammar gap fixtures', () => {
	it.each(fixtures)('records the known parse gap in %s', (name) => {
		const source = readFileSync(path.join(fixtureRoot, name), 'utf8');
		const result = parseWithAntlr({source, path: name, defaultSchema: 'APP'});

		expect(result.diagnostics.some((diagnostic) => diagnostic.code === ORACLE_DIAGNOSTIC.parse)).toBe(true);
	});
});
