import {spawn} from 'node:child_process';
import {type LivePlanType} from './oracleLivePlan.ts';
import {type OracleConnectionType, type OracleLiveSettingsType} from './oracleLiveSettings.ts';
import {phaseProgressLine} from './oracleProgress.ts';

export type SqlplusRequestType = Readonly<{
	executable: string;
	cwd: string;
	input: string;
	timeoutMs: number;
	environment: NodeJS.ProcessEnv;
	onOutput?: ((line: string) => void) | undefined;
}>;

type SqlplusResultType = Readonly<{
	status: number | null;
	stdout: string;
	stderr: string;
}>;

export type SqlplusRunnerType = (request: SqlplusRequestType) => SqlplusResultType | Promise<SqlplusResultType>;

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const childEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(environment).filter(
			([name]) => !name.startsWith('ORACLE_') && !name.startsWith('CODE_INDEX_ORACLE_') && name !== 'CODE_INDEX_QUALIFICATION_OUTPUT_DIR',
		),
	);

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const connectionLine = (connection: OracleConnectionType): string => `connect ${quote(connection.user)}/${quote(connection.password)}@${connection.server}`;

type LineEmitterType = Readonly<{
	push: (chunk: string) => void;
	flush: () => void;
}>;

const lineEmitterOf = (onLine: ((line: string) => void) | undefined): LineEmitterType => {
	let buffer = '';

	return {
		push: (chunk) => {
			buffer += chunk;
			const lines = buffer.split(/\r?\n/u);

			buffer = lines.pop() ?? '';

			for (const line of lines) {
				onLine?.(line);
			}
		},
		flush: () => {
			if (buffer !== '') {
				onLine?.(buffer);
				buffer = '';
			}
		},
	};
};

const appendOutput = (current: string, chunk: string): string =>
	current.length >= MAX_OUTPUT_BYTES ? current : current + chunk.slice(0, MAX_OUTPUT_BYTES - current.length);

const defaultSqlplusRunner: SqlplusRunnerType = async (request) => {
	const deferred = Promise.withResolvers<SqlplusResultType>();
	const child = spawn(request.executable, ['-S', '-L', '/nolog'], {
		cwd: request.cwd,
		env: childEnvironment(request.environment),
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	let stdout = '';
	let stderr = '';
	let failure = '';
	let timedOut = false;
	const stdoutLines = lineEmitterOf(request.onOutput);
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGKILL');
	}, request.timeoutMs);

	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout = appendOutput(stdout, chunk);
		stdoutLines.push(chunk);
	});
	child.stderr.on('data', (chunk: string) => {
		stderr = appendOutput(stderr, chunk);
	});
	child.on('error', (error) => {
		failure = error.message;
	});
	child.stdin.on('error', (_error) => {
		void _error;
	});
	child.on('close', (code) => {
		clearTimeout(timer);
		stdoutLines.flush();
		deferred.resolve({
			status: code,
			stdout,
			stderr: stderr.length > 0 ? stderr : failure || (timedOut ? `SQL*Plus timed out after ${String(request.timeoutMs)} ms` : ''),
		});
	});
	child.stdin.end(request.input);
	const result = await deferred.promise;

	return result;
};

const tail = (value: string): string => value.trim().slice(-2000);

type RecompileOptionsType = Readonly<{
	runner?: SqlplusRunnerType | undefined;
	progress?: ((line: string) => void) | undefined;
}>;

type ScriptRequestType = Readonly<{
	plan: LivePlanType;
	settings: OracleLiveSettingsType;
	environment: NodeJS.ProcessEnv;
	runner: SqlplusRunnerType;
	sqlPath: string;
	label: string;
	progressLabel: string;
	total: number;
	granularity: number;
	progress?: ((line: string) => void) | undefined;
}>;

const progressEveryOf = (total: number): number => Math.max(1, Math.floor(total / 20));

const HEARTBEAT_MS = 10_000;

const runScript = async (request: ScriptRequestType): Promise<void> => {
	const {plan, settings, environment, runner, sqlPath, label, progressLabel, total, granularity, progress} = request;

	if (settings.connection === null) {
		throw new Error('Oracle live qualification apply requires a database connection');
	}

	const startedAt = Date.now();
	let completed = 0;
	let lastLine = '';
	const report = (): void => {
		if (progress === undefined) {
			return;
		}

		const line = phaseProgressLine(progressLabel, completed, total, Date.now() - startedAt);

		if (line !== lastLine) {
			progress(line);
			lastLine = line;
		}
	};
	const heartbeat = setInterval(() => {
		if (completed < total) {
			report();
		}
	}, HEARTBEAT_MS);
	let result: SqlplusResultType;

	heartbeat.unref();

	try {
		result = await runner({
			executable: settings.sqlplus,
			cwd: plan.output.dir,
			input: `${connectionLine(settings.connection)}\n@"${sqlPath}"\n`,
			timeoutMs: settings.timeoutMs,
			environment,
			onOutput: (line) => {
				if (progress === undefined || !line.startsWith('RECOMPILE')) {
					return;
				}

				completed = Math.min(total, completed + 1);

				if (completed % granularity === 0 || completed === total) {
					report();
				}
			},
		});
	} finally {
		clearInterval(heartbeat);
	}

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
 * @param options - Runner override and optional progress sink.
 */
export const recompileOracleObjects = async (
	plan: LivePlanType,
	settings: OracleLiveSettingsType,
	environment: NodeJS.ProcessEnv,
	options: RecompileOptionsType = {},
): Promise<void> => {
	const total = plan.snapshot.units.length;

	options.progress?.(`Recompiling ${String(total)} target objects...`);
	await runScript({
		plan,
		settings,
		environment,
		runner: options.runner ?? defaultSqlplusRunner,
		sqlPath: plan.sql.compile.path,
		label: 'Oracle recompile step',
		progressLabel: 'Targets',
		total,
		granularity: progressEveryOf(total),
		progress: options.progress,
	});
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
 * @param options - Runner override and optional progress sink.
 */
export const recompileOracleDependents = async (
	plan: LivePlanType,
	settings: OracleLiveSettingsType,
	environment: NodeJS.ProcessEnv,
	options: RecompileOptionsType = {},
): Promise<void> => {
	const total = plan.snapshot.dependents.length;

	if (total === 0) {
		return;
	}

	options.progress?.(`Recompiling ${String(total)} dependent objects...`);
	await runScript({
		plan,
		settings,
		environment,
		runner: options.runner ?? defaultSqlplusRunner,
		sqlPath: plan.sql.dependents.path,
		label: 'Oracle dependent recompile step',
		progressLabel: 'Dependents',
		total,
		granularity: progressEveryOf(total),
		progress: options.progress,
	});
};
