import {writeFileSync} from 'node:fs';
import {type LivePlanType} from './oracleLivePlan.ts';
import {orderedTargetStatementsOf, recompileStatementsOf, type RecompileStatementType} from './oracleRecompileStatements.ts';
import {phaseProgressLine} from './oracleProgress.ts';

/** Minimal execution surface required to recompile installed PL/SQL objects. */
export type OracleStatementExecutorType = Readonly<{
	execute: (sql: string) => Promise<void>;
}>;

const PLSCOPE_SQL = "ALTER SESSION SET PLSCOPE_SETTINGS = 'IDENTIFIERS:ALL'";
const MAX_ERROR_CHARS = 2000;
const HEARTBEAT_MS = 10_000;

type RecompileOptionsType = Readonly<{
	progress?: ((line: string) => void) | undefined;
}>;

type RecompilePhaseType = Readonly<{
	label: string;
	progressLabel: string;
	logPath: string;
	approval: string;
	statements: readonly RecompileStatementType[];
	continueOnError: boolean;
}>;

const progressEveryOf = (total: number): number => Math.max(1, Math.floor(total / 20));

const errorTextOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).trim().slice(0, MAX_ERROR_CHARS);

const runPhase = async (database: OracleStatementExecutorType, phase: RecompilePhaseType, options: RecompileOptionsType): Promise<void> => {
	const total = phase.statements.length;
	const granularity = progressEveryOf(total);
	const startedAt = Date.now();
	const log = [`-- Oracle live qualification ${phase.progressLabel.toLowerCase()} log`, `-- Plan approval: ${phase.approval}`, ''];
	let completed = 0;
	let lastLine = '';
	const report = (): void => {
		if (options.progress === undefined) {
			return;
		}

		const line = phaseProgressLine(phase.progressLabel, completed, total, Date.now() - startedAt);

		if (line !== lastLine) {
			options.progress(line);
			lastLine = line;
		}
	};
	const heartbeat = setInterval(() => {
		if (completed < total) {
			report();
		}
	}, HEARTBEAT_MS);

	heartbeat.unref();

	try {
		if (!phase.continueOnError) {
			try {
				await database.execute(PLSCOPE_SQL);
			} catch (error) {
				log.push(`${PLSCOPE_SQL};`, `-- ERROR: ${errorTextOf(error)}`, '');
				throw new Error(`${phase.label} failed\n${errorTextOf(error)}`, {cause: error});
			}

			log.push(`${PLSCOPE_SQL};`, '-- OK', '');
		}

		for (const statement of phase.statements) {
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- Recompilation must follow approved order and each statement is logged before the next starts.
				await database.execute(statement.sql);
				log.push(`${statement.sql};`, '-- OK', '');
			} catch (error) {
				log.push(`${statement.sql};`, `-- ERROR: ${errorTextOf(error)}`, '');

				if (!phase.continueOnError) {
					throw new Error(`${phase.label} failed\n${errorTextOf(error)}`, {cause: error});
				}
			}

			completed += 1;

			if (completed % granularity === 0 || completed === total) {
				report();
			}
		}
	} finally {
		clearInterval(heartbeat);
		writeFileSync(phase.logPath, log.join('\n'), {encoding: 'utf8'});
	}
};

/**
 * Recompiles the installed qualification objects with PL/Scope enabled.
 *
 * Only `ALTER ... COMPILE` statements for objects named by the frozen source
 * snapshot are executed. Authored `CREATE OR REPLACE` scripts never run, so the
 * installed source remains the qualification source of truth.
 *
 * @param plan - Approved and hash-verified plan.
 * @param database - Session shared with the qualification evidence queries.
 * @param options - Optional progress sink.
 */
export const recompileOracleObjects = async (plan: LivePlanType, database: OracleStatementExecutorType, options: RecompileOptionsType = {}): Promise<void> => {
	const total = plan.snapshot.units.length;

	options.progress?.(`Recompiling ${String(total)} target objects...`);
	await runPhase(
		database,
		{
			label: 'Oracle recompile step',
			progressLabel: 'Targets',
			logPath: plan.output.compileLog,
			approval: plan.approval,
			statements: orderedTargetStatementsOf(plan.snapshot.units),
			continueOnError: false,
		},
		options,
	);
};

/**
 * Recompiles the approved dependent objects after the qualification targets.
 *
 * Execution deliberately continues after an `ALTER ... COMPILE` error so a
 * pre-existing invalid dependent cannot hide the target validation that follows.
 * The independent invalid-object comparison decides whether the run failed.
 *
 * @param plan - Approved and hash-verified plan.
 * @param database - Session shared with the qualification evidence queries.
 * @param options - Optional progress sink.
 */
export const recompileOracleDependents = async (
	plan: LivePlanType,
	database: OracleStatementExecutorType,
	options: RecompileOptionsType = {},
): Promise<void> => {
	const total = plan.snapshot.dependents.length;

	if (total === 0) {
		return;
	}

	options.progress?.(`Recompiling ${String(total)} dependent objects...`);
	await runPhase(
		database,
		{
			label: 'Oracle dependent recompile step',
			progressLabel: 'Dependents',
			logPath: plan.output.dependentCompileLog,
			approval: plan.approval,
			statements: recompileStatementsOf(plan.snapshot.dependents),
			continueOnError: true,
		},
		options,
	);
};
