import {readFileSync} from 'node:fs';
import {parse} from 'csv-parse/sync';

/**
 * Parses a CSV document without assuming a fixed column count.
 *
 * Handles quoted fields, embedded newlines, escaped quotes, CRLF/LF/CR record
 * separators, and an optional UTF-8 BOM. Blank records and records whose fields
 * are all empty are discarded.
 *
 * @param text - CSV text.
 * @returns Non-empty rows.
 * @throws {Error} When the document contains malformed quoting, such as an
 * unterminated quoted field.
 */
export const parseCsv = (text: string): readonly (readonly string[])[] => {
	const rows = parse(text, {
		bom: true,
		record_delimiter: ['\r\n', '\n', '\r'],
		relax_column_count: true,
		skip_empty_lines: true,
	});

	return rows.filter((entry) => entry.some((value) => value.length > 0));
};

/**
 * Reads a SQL*Plus CSV export, tolerating an optional `OBJECT_NAME` header.
 *
 * @param filePath - CSV path.
 * @returns Data rows.
 * @throws {Error} When the file cannot be read or contains malformed CSV.
 */
export const readCsv = (filePath: string): readonly (readonly string[])[] => {
	const rows = parseCsv(readFileSync(filePath, 'utf8'));
	const first = rows.at(0);

	return first !== undefined && first[0]?.toUpperCase() === 'OBJECT_NAME' ? rows.slice(1) : rows;
};
