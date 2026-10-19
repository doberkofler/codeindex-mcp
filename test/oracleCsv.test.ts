import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseCsv, readCsv} from '../src/core/qualification/oracle/oracleCsv.ts';
import {writeCsvRows} from '../src/core/qualification/oracle/live/oracleCsvExport.ts';

let directory: string | undefined;

describe('Oracle CSV', () => {
	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('parses quoted commas, escaped quotes, and CRLF rows', () => {
		expect(parseCsv('"name, with comma","quoted ""value"""\r\nplain,row\n\n')).toStrictEqual([
			['name, with comma', 'quoted "value"'],
			['plain', 'row'],
		]);
	});

	it('retains a final field without a trailing newline', () => {
		expect(parseCsv('first,second')).toStrictEqual([['first', 'second']]);
		expect(parseCsv('first,')).toStrictEqual([['first', '']]);
	});

	it('parses mixed record separators and strips a BOM', () => {
		expect(parseCsv('\uFEFFa,b\r\nc,d\ne,f\rg,h\n')).toStrictEqual([
			['a', 'b'],
			['c', 'd'],
			['e', 'f'],
			['g', 'h'],
		]);
	});

	it('rejects malformed quoting instead of guessing', () => {
		expect(() => parseCsv('a,"unterminated\n')).toThrow(/Quote Not Closed/u);
	});

	it('removes an optional OBJECT_NAME header after a BOM', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-oracle-csv-'));
		const file = path.join(directory, 'bom-header.csv');
		writeFileSync(file, '\uFEFFobject_name,line\nDEMO,1\n');

		expect(readCsv(file)).toStrictEqual([['DEMO', '1']]);
	});

	it('writes LF-delimited rows without a header', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-oracle-csv-'));
		const file = path.join(directory, 'rows.csv');

		writeCsvRows(file, [
			['a', 'b,c', 'd"e', 'line\nbreak', 'x\ry', ''],
			[new Date('2020-01-01T00:00:00.000Z'), 42n, {value: 1}, null],
		]);

		expect(readFileSync(file, 'utf8')).toBe('a,"b,c","d""e","line\nbreak","x\ry",\n2020-01-01T00:00:00.000Z,42,"{""value"":1}",\n');
	});

	it('writes an empty file when there are no rows', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-oracle-csv-'));
		const file = path.join(directory, 'empty.csv');

		writeCsvRows(file, []);

		expect(readFileSync(file, 'utf8')).toBe('');
	});

	it('removes an optional OBJECT_NAME header', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-oracle-csv-'));
		const withHeader = path.join(directory, 'with-header.csv');
		const withoutHeader = path.join(directory, 'without-header.csv');
		writeFileSync(withHeader, 'object_name,line\nDEMO,1\n');
		writeFileSync(withoutHeader, 'DEMO,1\n');

		expect(readCsv(withHeader)).toStrictEqual([['DEMO', '1']]);
		expect(readCsv(withoutHeader)).toStrictEqual([['DEMO', '1']]);
	});
});
