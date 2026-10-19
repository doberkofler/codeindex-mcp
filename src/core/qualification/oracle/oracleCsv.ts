import {readFileSync} from 'node:fs';

/**
 * Parses a CSV document without assuming a fixed column count.
 *
 * @param text - CSV text.
 * @returns Non-empty rows.
 */
export const parseCsv = (text: string): readonly (readonly string[])[] => {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;

	for (let index = 0; index < text.length; index += 1) {
		const character = text[index] ?? '';

		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (character === '"') {
				quoted = false;
			} else {
				field += character;
			}
			continue;
		}

		if (character === '"') {
			quoted = true;
		} else if (character === ',') {
			row.push(field);
			field = '';
		} else if (character === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else if (character !== '\r') {
			field += character;
		}
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows.filter((entry) => entry.some((value) => value.length > 0));
};

/**
 * Reads a SQL*Plus CSV export, tolerating an optional `OBJECT_NAME` header.
 *
 * @param filePath - CSV path.
 * @returns Data rows.
 */
export const readCsv = (filePath: string): readonly (readonly string[])[] => {
	const rows = parseCsv(readFileSync(filePath, 'utf8'));
	const first = rows.at(0);

	return first !== undefined && first[0]?.toUpperCase() === 'OBJECT_NAME' ? rows.slice(1) : rows;
};
