import {readFileSync} from 'node:fs';
import type OracleDB from 'oracledb';
import {writeCsvRows} from './oracleCsvExport.ts';
import {type LivePlanType} from './oracleLivePlan.ts';
import {recompileOracleDependents, recompileOracleObjects, type SqlplusRunnerType} from './oracleRecompile.ts';
import {type OracleConnectionType, type OracleLiveSettingsType} from './oracleLiveSettings.ts';
import {assertOracleSourceMatchesSnapshot, oracleObjectKeyOf} from './oracleLiveSource.ts';
import {formatDuration} from './oracleProgress.ts';

type OracleDatabaseType = Readonly<{
	query: (sql: string) => Promise<readonly (readonly unknown[])[]>;
	close: () => Promise<void>;
}>;

type OracleDatabaseFactoryType = (connection: OracleConnectionType) => Promise<OracleDatabaseType>;

export type OracleLiveDependenciesType = Readonly<{
	sqlplusRunner?: SqlplusRunnerType;
	databaseFactory?: OracleDatabaseFactoryType;
	progress?: (line: string) => void;
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

/** One `USER_OBJECTS` row captured by the invalid-object inventory. */
type OracleInvalidObjectType = Readonly<{
	objectType: string;
	objectName: string;
	status: string;
}>;

/** Outcome of one applied plan, after comparing the final state with the baseline. */
export type OracleLiveApplyResultType = Readonly<{
	baselineInvalid: readonly OracleInvalidObjectType[];
	remainingBaselineInvalid: readonly OracleInvalidObjectType[];
	restoredBaselineInvalid: readonly OracleInvalidObjectType[];
}>;

const invalidObjectOf = (row: readonly unknown[]): OracleInvalidObjectType => {
	const [objectType, objectName, status] = row;

	if (typeof objectType !== 'string' || typeof objectName !== 'string' || typeof status !== 'string') {
		throw new TypeError('Oracle invalid-object inventory contains an unexpected row shape');
	}

	return {objectType, objectName, status};
};

const invalidObjectKeyOf = (object: Readonly<{objectType: string; objectName: string}>): string => oracleObjectKeyOf(object.objectType, object.objectName);

const ignoreProgress = (_line: string): void => {
	void _line;
};

const assertInvalidObjectsAllowed = (plan: LivePlanType, baselineKeys: ReadonlySet<string>, invalid: readonly (readonly unknown[])[]): void => {
	const targetKeys = new Set(plan.snapshot.units.map((unit) => oracleObjectKeyOf(unit.type, unit.name)));
	const invalidTargets = invalid.filter((row) => targetKeys.has(invalidObjectKeyOf(invalidObjectOf(row))));

	if (invalidTargets.length > 0) {
		throw new Error(`Oracle qualification left invalid target PL/SQL: ${invalidSummary(invalidTargets)}`);
	}

	const dependentKeys = new Set(plan.snapshot.dependents.map((dependent) => oracleObjectKeyOf(dependent.type, dependent.name)));
	const invalidDependents = invalid.filter((row) => dependentKeys.has(invalidObjectKeyOf(invalidObjectOf(row))));

	if (invalidDependents.length > 0) {
		throw new Error(`Oracle qualification failed to restore dependent objects: ${invalidSummary(invalidDependents)}`);
	}

	const newInvalid = invalid.filter((row) => !baselineKeys.has(invalidObjectKeyOf(invalidObjectOf(row))));

	if (newInvalid.length > 0) {
		throw new Error(`Oracle qualification left new invalid objects: ${invalidSummary(newInvalid)}`);
	}
};

/**
 * Executes one approved live qualification plan.
 *
 * Order is deliberate: capture the complete pre-DDL invalid-object baseline,
 * back up installed source, verify it matches the frozen snapshot, recompile
 * the installed objects with PL/Scope enabled, restore approved dependents,
 * then validate and export truth through the persistent Oracle driver session.
 * The plan is checked before this function is called.
 *
 * Pre-existing invalid objects are reported but never attributed to this run.
 * The run fails only for invalid qualification targets or objects that became
 * invalid compared with the baseline.
 *
 * @param plan - Approved and hash-verified plan.
 * @param settings - Oracle connection and SQL*Plus settings.
 * @param environment - Parent environment forwarded without Oracle credentials.
 * @param dependencies - Injectable recompile runner and database factory for tests.
 * @returns Baseline-invalid and restored counts for reporting.
 * @throws {Error} When source drift, recompilation failure, an invalid target, or new invalid objects remain.
 */
export const applyOracleLivePlan = async (
	plan: LivePlanType,
	settings: OracleLiveSettingsType,
	environment: NodeJS.ProcessEnv,
	dependencies: OracleLiveDependenciesType = {},
): Promise<OracleLiveApplyResultType> => {
	const {connection} = settings;

	if (connection === null) {
		throw new Error('Oracle live qualification apply requires a database connection');
	}

	const progress: (line: string) => void = dependencies.progress ?? ignoreProgress;
	const startedAt = Date.now();
	const database = await (dependencies.databaseFactory ?? openOracleDatabase)(connection);

	try {
		const baselineStart = Date.now();

		progress('Capturing pre-DDL invalid-object baseline...');
		const baseline = await queryFile(database, plan.sql.baseline.path);
		const baselineInvalid = baseline.map((row) => invalidObjectOf(row));
		const baselineKeys = new Set(baselineInvalid.map((object) => invalidObjectKeyOf(object)));

		writeCsvRows(plan.output.baselineInvalidObjects, baseline);
		progress(`Baseline: ${String(baselineInvalid.length)} invalid object(s) (${formatDuration(Date.now() - baselineStart)})`);

		const sourceStart = Date.now();

		progress('Backing up and verifying installed source...');
		const backup = await queryFile(database, plan.sql.backup.path);

		writeCsvRows(plan.output.backup, backup);
		assertOracleSourceMatchesSnapshot(plan, backup);
		progress(`Source verified (${formatDuration(Date.now() - sourceStart)})`);

		await recompileOracleObjects(plan, settings, environment, {runner: dependencies.sqlplusRunner, progress});

		if (plan.snapshot.dependents.length > 0) {
			await recompileOracleDependents(plan, settings, environment, {runner: dependencies.sqlplusRunner, progress});
		}

		const validationStart = Date.now();

		progress('Validating target PL/SQL and dependent restoration...');
		const invalid = await queryFile(database, plan.sql.validate.path);
		const invalidObjects = invalid.map((row) => invalidObjectOf(row));

		writeCsvRows(plan.output.invalidObjects, invalid);
		assertInvalidObjectsAllowed(plan, baselineKeys, invalid);
		progress(`Validation passed (${formatDuration(Date.now() - validationStart)})`);

		const exportStart = Date.now();

		progress('Exporting identifiers and dependencies...');
		writeCsvRows(plan.output.identifiers, await queryFile(database, plan.sql.identifiers.path));
		writeCsvRows(plan.output.dependencies, await queryFile(database, plan.sql.dependencies.path));
		progress(`Exports written (${formatDuration(Date.now() - exportStart)})`);

		const remainingBaselineInvalid = invalidObjects.filter((object) => baselineKeys.has(invalidObjectKeyOf(object)));
		const remainingKeys = new Set(remainingBaselineInvalid.map((object) => invalidObjectKeyOf(object)));

		progress(`Database work completed in ${formatDuration(Date.now() - startedAt)}`);

		return {
			baselineInvalid,
			remainingBaselineInvalid,
			restoredBaselineInvalid: baselineInvalid.filter((object) => !remainingKeys.has(invalidObjectKeyOf(object))),
		};
	} finally {
		await database.close();
	}
};
