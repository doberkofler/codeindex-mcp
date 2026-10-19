import type OracleDB from 'oracledb';
import {oracleObjectKeyOf, type OracleInstalledSourceType} from './oracleLiveSource.ts';
import {type OracleConnectionType} from './oracleLiveSettings.ts';

const SOURCE_TYPES = ['PACKAGE', 'PACKAGE BODY', 'FUNCTION', 'PROCEDURE'] as const;

type SourceLineType = {line: number; text: string};

const loadDriver = async (): Promise<typeof OracleDB> => {
	try {
		const imported = await import('oracledb');
		return imported.default;
	} catch (error) {
		throw new Error('Oracle live qualification requires the optional oracledb package', {cause: error});
	}
};

const isWrapped = (text: string): boolean => /^\s*(?:PACKAGE(?:\s+BODY)?|FUNCTION|PROCEDURE)\b.+\bwrapped\s*$/iu.test(text);

const sourceTextOf = (lines: readonly SourceLineType[]): string => lines.map((line) => line.text.replace(/\r?\n$/u, '')).join('\n');

/**
 * Reads the installed PL/SQL source in one schema without changing anything.
 *
 * Full `USER_SOURCE` text is returned because planning must prove that a
 * candidate file is the source the database holds, not merely that an object
 * name and a filename agree. Wrapped objects are omitted because their source
 * cannot be compared with the authored snapshot.
 *
 * @param connection - Validated Oracle credentials.
 * @returns Installed objects keyed by canonical object key.
 * @throws {Error} When the optional Oracle driver is unavailable or a row is malformed.
 */
export const readInstalledOracleSources = async (connection: OracleConnectionType): Promise<ReadonlyMap<string, OracleInstalledSourceType>> => {
	const driver = await loadDriver();
	const session = await driver.getConnection({
		user: connection.user,
		password: connection.password,
		connectString: connection.server,
	});

	try {
		const result = await session.execute<readonly unknown[]>(
			`SELECT type, name, line, text
			   FROM user_source
			  WHERE type IN (${SOURCE_TYPES.map((type) => `'${type}'`).join(', ')})
			  ORDER BY type, name, line`,
			[],
			{outFormat: driver.OUT_FORMAT_ARRAY},
		);
		const grouped = new Map<string, {type: string; name: string; lines: SourceLineType[]}>();

		for (const row of result.rows ?? []) {
			const [type, name, line, text] = row;

			if (typeof type !== 'string' || typeof name !== 'string' || typeof line !== 'number' || typeof text !== 'string') {
				throw new TypeError('Installed Oracle source inventory contains an unexpected row shape');
			}

			const key = oracleObjectKeyOf(type, name);
			const entry = grouped.get(key) ?? {type, name, lines: []};

			entry.lines.push({line, text});
			grouped.set(key, entry);
		}

		const installed = new Map<string, OracleInstalledSourceType>();

		for (const [key, entry] of grouped) {
			entry.lines.sort((left, right) => left.line - right.line);

			if (!isWrapped(entry.lines[0]?.text ?? '')) {
				installed.set(key, {type: entry.type.toUpperCase(), name: entry.name.toUpperCase(), source: sourceTextOf(entry.lines)});
			}
		}

		return installed;
	} finally {
		await session.close();
	}
};
