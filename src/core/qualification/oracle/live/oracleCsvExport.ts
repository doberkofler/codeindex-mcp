import {writeFileSync} from 'node:fs';
import {stringify} from 'csv-stringify/sync';

const fieldOf = (value: unknown): string => {
	if (value === null || value === undefined) {
		return '';
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (typeof value === 'string') {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}

	return JSON.stringify(value);
};

/**
 * Writes query rows as RFC 4180-style CSV without a header row.
 *
 * Output uses `\n` record separators and quotes only fields that require it.
 * Qualification readers tolerate an optional header, but the historical
 * SQL*Plus exports had none, so omitting it keeps evidence stable.
 *
 * @param filePath - Destination CSV path.
 * @param rows - Row values in query column order.
 */
export const writeCsvRows = (filePath: string, rows: readonly (readonly unknown[])[]): void => {
	const records = rows.map((row) => row.map((value) => fieldOf(value)));
	const text = stringify(records, {
		header: false,
		record_delimiter: '\n',
		quote_record_delimiter: true,
	});

	writeFileSync(filePath, text, {encoding: 'utf8'});
};
