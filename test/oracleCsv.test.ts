import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parseCsv, readCsv} from '../src/core/qualification/oracle/oracleCsv.ts';

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
