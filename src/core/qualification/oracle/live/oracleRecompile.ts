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
	if (settings.connection === null) {
		throw new Error('Oracle live qualification apply requires a database connection');
	}

	const result = runner({
		executable: settings.sqlplus,
		cwd: plan.output.dir,
		input: `${connectionLine(settings.connection)}\n@"${plan.sql.compile.path}"\n`,
		timeoutMs: settings.timeoutMs,
		environment,
	});

	if (result.status !== 0) {
		const detail = tail(result.stderr) || tail(result.stdout);
		throw new Error(`Oracle recompile step failed${detail === '' ? '' : `\n${detail}`}`);
	}
};
