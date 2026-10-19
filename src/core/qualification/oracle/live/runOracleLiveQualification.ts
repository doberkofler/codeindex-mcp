import {realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {loadConfig} from '../../../config/config.ts';
import {qualifyOracleConfig} from '../runOracleQualification.ts';
import {applyOracleLivePlan, type OracleLiveDependenciesType} from './oracleDatabase.ts';
import {createOracleLivePlan, readOracleLivePlan, type LivePlanType} from './oracleLivePlan.ts';
import {readOracleLiveSettings, type OracleLiveSettingsType} from './oracleLiveSettings.ts';

type LiveIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

const snapshotConfig = (config: ReturnType<typeof loadConfig>, plan: LivePlanType): ReturnType<typeof loadConfig> => {
	const rootDir = realpathSync(plan.snapshot.dir);
	const projects = plan.project.projects.map((project) => ({name: project.name, projectFilePath: path.join(rootDir, project.path)}));
	const first = projects.at(0);

	if (first === undefined) {
		throw new Error('Oracle qualification plan has no project context');
	}

	return {
		...config,
		rootDir,
		projectFilePath: first.projectFilePath,
		projects,
		databasePath: plan.output.databasePath,
		analyticsEnabled: false,
		analyticsPath: path.join(plan.output.dir, 'analytics', 'events.jsonl'),
		configPath: null,
	};
};

const writeRunMetadata = (plan: LivePlanType, settings: OracleLiveSettingsType, result: Awaited<ReturnType<typeof qualifyOracleConfig>>): void => {
	writeFileSync(
		plan.output.run,
		`${JSON.stringify(
			{
				version: 1,
				approval: plan.approval,
				outputDir: plan.output.dir,
				source: {
					project: plan.project,
					sourceHash: plan.snapshot.sourceHash,
					configHash: plan.snapshot.configHash,
					files: plan.snapshot.files.length,
				},
				driver: 'oracledb',
				sqlplus: settings.sqlplus,
				completedAt: new Date().toISOString(),
				generationId: result.report.generationId,
				gates: result.report.gates,
				artifacts: {
					backup: plan.output.backup,
					invalidObjects: plan.output.invalidObjects,
					compileLog: plan.output.compileLog,
					identifiers: plan.output.identifiers,
					dependencies: plan.output.dependencies,
					report: plan.output.report,
				},
			},
			null,
			2,
		)}\n`,
		{encoding: 'utf8'},
	);
};

/**
 * Runs the environment-only live Oracle qualification workflow.
 *
 * Without an approval hash it freezes source and writes an exact SQL plan. With
 * an approval hash it verifies the plan, compiles and exports truth, rebuilds
 * the snapshot index with the current parser, and compares the facts.
 *
 * @param environment - Environment-only configuration and Oracle credentials.
 * @param io - Output sinks.
 * @param dependencies - Injectable compile runner and database factory for tests.
 * @returns Process exit code.
 */
export const runOracleLiveQualification = async (
	environment: NodeJS.ProcessEnv,
	io: LiveIoType,
	dependencies: OracleLiveDependenciesType = {},
): Promise<number> => {
	try {
		const config = loadConfig(environment);

		if (config.extractorId !== 'oracle') {
			throw new Error(`Oracle live qualification requires the oracle extractor, received ${config.extractorId}`);
		}

		const settings = readOracleLiveSettings(environment, config);

		if (settings.approval === null) {
			const plan = createOracleLivePlan(config, settings);

			io.stdout(`Oracle qualification plan: ${plan.output.planDir}`);
			io.stdout(`Source snapshot: ${plan.snapshot.dir}`);
			io.stdout(`Files: ${plan.snapshot.files.length}; source hash: ${plan.snapshot.sourceHash}`);
			io.stdout(`Approval: ${plan.approval}`);
			io.stdout(`To apply: CODE_INDEX_ORACLE_APPROVAL=${plan.approval} pnpm qualify:oracle:live`);
			return 0;
		}

		const plan = readOracleLivePlan(settings);

		await applyOracleLivePlan(plan, settings, environment, dependencies);
		const result = await qualifyOracleConfig(snapshotConfig(config, plan), io, {
			identifiers: plan.output.identifiers,
			dependencies: plan.output.dependencies,
			output: plan.output.report,
		});

		writeRunMetadata(plan, settings, result);
		return result.code;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};
