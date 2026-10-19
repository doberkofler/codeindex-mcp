import {writeFileSync} from 'node:fs';

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

const escaped = (value: unknown): string => {
	const text = fieldOf(value);
	return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/**
 * Writes query rows as RFC 4180-style CSV without a header row.
 *
 * Qualification readers tolerate an optional header, but the historical
 * SQL*Plus exports had none, so omitting it keeps evidence stable.
 *
 * @param filePath - Destination CSV path.
 * @param rows - Row values in query column order.
 */
export const writeCsvRows = (filePath: string, rows: readonly (readonly unknown[])[]): void => {
	const text = rows.map((row) => row.map((value) => escaped(value)).join(',')).join('\n');

	writeFileSync(filePath, rows.length === 0 ? '' : `${text}\n`, {encoding: 'utf8'});
};
