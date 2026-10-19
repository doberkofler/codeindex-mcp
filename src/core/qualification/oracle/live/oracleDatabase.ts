import {readFileSync} from 'node:fs';
import type OracleDB from 'oracledb';
import {compileOracleSources, type SqlplusRunnerType} from './oracleCompile.ts';
import {writeCsvRows} from './oracleCsvExport.ts';
import {type LivePlanType} from './oracleLivePlan.ts';
import {type OracleConnectionType, type OracleLiveSettingsType} from './oracleLiveSettings.ts';

type OracleDatabaseType = Readonly<{
	query: (sql: string) => Promise<readonly (readonly unknown[])[]>;
	close: () => Promise<void>;
}>;

type OracleDatabaseFactoryType = (connection: OracleConnectionType) => Promise<OracleDatabaseType>;

export type OracleLiveDependenciesType = Readonly<{
	sqlplusRunner?: SqlplusRunnerType;
	databaseFactory?: OracleDatabaseFactoryType;
}>;

const loadDriver = async (): Promise<typeof OracleDB> => {
	try {
		const imported = await import('oracledb');
		return imported.default;
	} catch (error) {
		throw new Error('Oracle live qualification requires the optional oracledb package', {cause: error});
	}
};

const databaseOf = (connection: OracleDB.Connection): OracleDatabaseType => ({
	query: async (sql) => {
		const result = await connection.execute<readonly unknown[]>(sql);
		return result.rows ?? [];
	},
	close: async () => {
		await connection.close();
	},
});

/**
 * Opens one Oracle driver session for qualification evidence queries.
 *
 * The optional dependency is loaded dynamically so normal indexing never
 * requires the driver or its native bindings.
 *
 * @param connection - Validated Oracle credentials.
 * @returns A query-only database session.
 */
const openOracleDatabase: OracleDatabaseFactoryType = async (connection) => {
	const driver = await loadDriver();
	const session = await driver.getConnection({
		user: connection.user,
		password: connection.password,
		connectString: connection.server,
	});

	return databaseOf(session);
};

const queryFile = async (database: OracleDatabaseType, filePath: string): Promise<readonly (readonly unknown[])[]> => {
	const rows = await database.query(readFileSync(filePath, 'utf8'));
	return rows;
};

const display = (value: unknown): string => {
	if (value === null || value === undefined) {
		return '';
	}

	if (typeof value === 'string') {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}

	return JSON.stringify(value);
};

const invalidSummary = (rows: readonly (readonly unknown[])[]): string =>
	rows
		.slice(0, 20)
		.map((row) => row.map((value) => display(value)).join(' '))
		.join('; ');

/**
 * Executes one approved live qualification plan.
 *
 * Order is deliberate: back up source first, compile the frozen snapshot
 * through SQL*Plus, then validate and export truth through the persistent
 * Oracle driver session. The plan is checked before this function is called.
 *
 * @param plan - Approved and hash-verified plan.
 * @param settings - Oracle connection and SQL*Plus settings.
 * @param environment - Parent environment forwarded without Oracle credentials.
 * @param dependencies - Injectable compile runner and database factory for tests.
 * @throws {Error} When compilation fails or any object remains invalid.
 */
export const applyOracleLivePlan = async (
	plan: LivePlanType,
	settings: OracleLiveSettingsType,
	environment: NodeJS.ProcessEnv,
	dependencies: OracleLiveDependenciesType = {},
): Promise<void> => {
	const {connection} = settings;

	if (connection === null) {
		throw new Error('Oracle live qualification apply requires a database connection');
	}

	const database = await (dependencies.databaseFactory ?? openOracleDatabase)(connection);

	try {
		writeCsvRows(plan.output.backup, await queryFile(database, plan.sql.backup.path));
		compileOracleSources(plan, settings, environment, dependencies.sqlplusRunner);
		const invalid = await queryFile(database, plan.sql.validate.path);

		writeCsvRows(plan.output.invalidObjects, invalid);

		if (invalid.length > 0) {
			throw new Error(`Oracle qualification left invalid objects: ${invalidSummary(invalid)}`);
		}

		writeCsvRows(plan.output.identifiers, await queryFile(database, plan.sql.identifiers.path));
		writeCsvRows(plan.output.dependencies, await queryFile(database, plan.sql.dependencies.path));
	} finally {
		await database.close();
	}
};
