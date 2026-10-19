import type OracleDB from 'oracledb';
import {oracleObjectKeyOf} from './oracleLiveSource.ts';
import {type OracleConnectionType} from './oracleLiveSettings.ts';

const SOURCE_TYPES = ['PACKAGE', 'PACKAGE BODY', 'FUNCTION', 'PROCEDURE'] as const;

const loadDriver = async (): Promise<typeof OracleDB> => {
	try {
		const imported = await import('oracledb');
		return imported.default;
	} catch (error) {
		throw new Error('Oracle live qualification requires the optional oracledb package', {cause: error});
	}
};

const isWrapped = (text: string): boolean => {
	const header = text.split(/\r?\n/u, 1).at(0) ?? '';
	return /^\s*(?:PACKAGE(?:\s+BODY)?|FUNCTION|PROCEDURE)\b.+\bwrapped\s*$/iu.test(header);
};

/**
 * Reads the installed PL/SQL objects in one schema without changing anything.
 *
 * Wrapped objects are omitted because their source cannot be compared with the
 * authored snapshot or regenerated into qualified PL/Scope facts.
 *
 * @param connection - Validated Oracle credentials.
 * @returns Canonical keys for unwrapped installed objects.
 * @throws {Error} When the optional Oracle driver is unavailable.
 */
export const readInstalledOracleObjects = async (connection: OracleConnectionType): Promise<ReadonlySet<string>> => {
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
			  WHERE line = 1
			    AND type IN (${SOURCE_TYPES.map((type) => `'${type}'`).join(', ')})`,
			[],
			{outFormat: driver.OUT_FORMAT_ARRAY},
		);
		const installed = new Set<string>();

		for (const row of result.rows ?? []) {
			const [type, name, , text] = row;

			if (typeof type !== 'string' || typeof name !== 'string' || typeof text !== 'string') {
				throw new TypeError('Installed Oracle source inventory contains an unexpected row shape');
			}

			if (!isWrapped(text)) {
				installed.add(oracleObjectKeyOf(type, name));
			}
		}

		return installed;
	} finally {
		await session.close();
	}
};
