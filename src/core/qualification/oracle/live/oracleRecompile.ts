import {spawnSync} from 'node:child_process';
import {type LivePlanType} from './oracleLivePlan.ts';
import {type OracleConnectionType, type OracleLiveSettingsType} from './oracleLiveSettings.ts';

export type SqlplusRequestType = Readonly<{
	executable: string;
	cwd: string;
	input: string;
	timeoutMs: number;
	environment: NodeJS.ProcessEnv;
}>;

type SqlplusResultType = Readonly<{
	status: number | null;
	stdout: string;
	stderr: string;
}>;

export type SqlplusRunnerType = (request: SqlplusRequestType) => SqlplusResultType;

const childEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(environment).filter(
			([name]) => !name.startsWith('ORACLE_') && !name.startsWith('CODE_INDEX_ORACLE_') && name !== 'CODE_INDEX_QUALIFICATION_OUTPUT_DIR',
		),
	);

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const connectionLine = (connection: OracleConnectionType): string => `connect ${quote(connection.user)}/${quote(connection.password)}@${connection.server}`;

const defaultSqlplusRunner: SqlplusRunnerType = (request) => {
	const result = spawnSync(request.executable, ['-S', '-L', '/nolog'], {
		cwd: request.cwd,
		env: childEnvironment(request.environment),
		input: request.input,
		encoding: 'utf8',
		timeout: request.timeoutMs,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});

	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr.length > 0 ? result.stderr : (result.error?.message ?? ''),
	};
};

const tail = (value: string): string => value.trim().slice(-2000);

type ScriptRequestType = Readonly<{
	plan: LivePlanType;
	settings: OracleLiveSettingsType;
	environment: NodeJS.ProcessEnv;
	runner: SqlplusRunnerType;
	sqlPath: string;
	label: string;
}>;

const runScript = (request: ScriptRequestType): void => {
	const {plan, settings, environment, runner, sqlPath, label} = request;

	if (settings.connection === null) {
		throw new Error('Oracle live qualification apply requires a database connection');
	}

	const result = runner({
		executable: settings.sqlplus,
		cwd: plan.output.dir,
		input: `${connectionLine(settings.connection)}\n@"${sqlPath}"\n`,
		timeoutMs: settings.timeoutMs,
		environment,
	});

	if (result.status !== 0) {
		const detail = tail(result.stderr) || tail(result.stdout);
		throw new Error(`${label} failed${detail === '' ? '' : `\n${detail}`}`);
	}
};

/**
 * Recompiles the installed qualification objects with PL/Scope enabled.
 *
 * The script contains only `ALTER ... COMPILE` statements for objects named by
 * the frozen source snapshot. It never runs authored `CREATE OR REPLACE`
 * scripts, so the installed source remains the qualification source of truth.
 *
 * @param plan - Approved and hash-verified plan.
 * @param settings - Settings containing the Oracle connection and SQL*Plus executable.
 * @param environment - Parent environment forwarded without Oracle credentials.
 * @param runner - SQL*Plus runner, injectable for tests.
 */
export const recompileOracleObjects = (
	plan: LivePlanType,
	settings: OracleLiveSettingsType,
	environment: NodeJS.ProcessEnv,
	runner: SqlplusRunnerType = defaultSqlplusRunner,
): void => {
	runScript({plan, settings, environment, runner, sqlPath: plan.sql.compile.path, label: 'Oracle recompile step'});
};

/**
 * Recompiles the approved dependent objects after the qualification targets.
 *
 * The script deliberately continues after an `ALTER ... COMPILE` error so a
 * pre-existing invalid dependent cannot hide the target validation that follows.
 * The independent invalid-object comparison decides whether the run failed.
 *
 * @param plan - Approved and hash-verified plan.
 * @param settings - Settings containing the Oracle connection and SQL*Plus executable.
 * @param environment - Parent environment forwarded without Oracle credentials.
 * @param runner - SQL*Plus runner, injectable for tests.
 */
export const recompileOracleDependents = (
	plan: LivePlanType,
	settings: OracleLiveSettingsType,
	environment: NodeJS.ProcessEnv,
	runner: SqlplusRunnerType = defaultSqlplusRunner,
): void => {
	runScript({plan, settings, environment, runner, sqlPath: plan.sql.dependents.path, label: 'Oracle dependent recompile step'});
};
