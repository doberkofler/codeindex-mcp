import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {DEFAULT_ORACLE_SOURCE_EXTENSIONS, type OracleManifestType} from '../../../../adapters/oracle/manifest.ts';
import {indexRootDirectory, type ConfigType} from '../../../config/config.ts';
import {qualifyOracleConfig} from '../runOracleQualification.ts';
import {applyOracleLivePlan, type OracleLiveDependenciesType} from './oracleDatabase.ts';
import {createOracleLivePlan, readOracleLivePlan, type LivePlanType} from './oracleLivePlan.ts';
import {readOracleLiveSettings, type OracleLiveSettingsType} from './oracleLiveSettings.ts';

type LiveIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

export type OracleLiveQualificationOptionsType = Readonly<{
	root: string;
	manifest?: string | undefined;
	output?: string | undefined;
	approval?: string | undefined;
	schema?: string | undefined;
}>;

const projectIdOf = (rootDir: string): string => createHash('sha256').update(`oracle\n${rootDir}`).digest('hex').slice(0, 16);

const resolveRoot = (root: string): string => {
	const resolved = path.resolve(root);

	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new Error(`Oracle source root is not a directory: ${resolved}`);
	}

	return realpathSync(resolved);
};

const writeManifest = (outputDir: string, defaultSchema: string): string => {
	const manifest: OracleManifestType = {
		schemaVersion: 1,
		dialect: '19c',
		defaultSchema,
		extensions: [...DEFAULT_ORACLE_SOURCE_EXTENSIONS],
		include: DEFAULT_ORACLE_SOURCE_EXTENSIONS.map((extension) => `**/*${extension}`),
		exclude: [],
	};
	const manifestPath = path.join(outputDir, 'oracle-index.json');

	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {encoding: 'utf8'});
	return manifestPath;
};

const manifestOf = (environment: NodeJS.ProcessEnv, options: OracleLiveQualificationOptionsType, outputDir: string): string => {
	if (options.manifest !== undefined) {
		const manifestPath = path.resolve(options.manifest);

		if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
			throw new Error(`Oracle manifest is not a file: ${manifestPath}`);
		}

		return realpathSync(manifestPath);
	}

	const defaultSchema = options.schema ?? environment['ORACLE_USER'];

	if (defaultSchema === undefined || defaultSchema.trim() === '') {
		throw new Error('Oracle live qualification requires --schema or ORACLE_USER for the generated manifest');
	}

	return writeManifest(outputDir, defaultSchema);
};

const configOf = (rootDir: string, manifestPath: string, outputDir: string, projectId: string): ConfigType => ({
	projectName: path.basename(rootDir),
	rootDir,
	extractorId: 'oracle',
	extractorOptions: {},
	projectFilePath: manifestPath,
	projects: [{name: 'oracle', projectFilePath: manifestPath}],
	databasePath: path.join(outputDir, 'index.sqlite'),
	analyticsEnabled: false,
	analyticsPath: path.join(outputDir, 'analytics', 'events.jsonl'),
	maxResultBytes: 32_768,
	maxReadLines: 200,
	semanticDiagnostics: false,
	projectId,
	logLevel: 'error',
	configPath: null,
});

const snapshotConfig = (plan: LivePlanType): ConfigType => {
	const rootDir = realpathSync(plan.snapshot.dir);
	const projects = plan.project.projects.map((project) => ({name: project.name, projectFilePath: path.join(rootDir, project.path)}));
	const first = projects.at(0);

	if (first === undefined) {
		throw new Error('Oracle qualification plan has no project context');
	}

	return {
		projectName: plan.project.name,
		rootDir,
		extractorId: 'oracle',
		extractorOptions: {},
		projectFilePath: first.projectFilePath,
		projects,
		databasePath: plan.output.databasePath,
		analyticsEnabled: false,
		analyticsPath: path.join(plan.output.dir, 'analytics', 'events.jsonl'),
		maxResultBytes: 32_768,
		maxReadLines: 200,
		semanticDiagnostics: false,
		projectId: plan.project.id,
		logLevel: 'error',
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

const commandArgument = (value: string): string => (value.includes(' ') ? JSON.stringify(value) : value);

const applyCommand = (options: OracleLiveQualificationOptionsType, rootDir: string, outputDir: string, approval: string): string => {
	const values = [
		'pnpm',
		'qualify:oracle:live',
		'--',
		'--root',
		rootDir,
		...(options.output === undefined ? [] : ['--output', outputDir]),
		'--approval',
		approval,
	];

	return values.map((value) => commandArgument(value)).join(' ');
};

/**
 * Runs the live Oracle qualification workflow.
 *
 * Without an approval hash it creates an external manifest when needed, freezes
 * source, and writes an exact SQL plan. With an approval hash it verifies the
 * frozen plan, compiles and exports truth, rebuilds the snapshot index with the
 * current parser, and compares the facts.
 *
 * @param environment - Environment-only Oracle credentials and SQL*Plus settings.
 * @param options - Source root, optional manifest/output overrides, and approval.
 * @param io - Output sinks.
 * @param dependencies - Injectable compile runner and database factory for tests.
 * @returns Process exit code.
 */
export const runOracleLiveQualification = async (
	environment: NodeJS.ProcessEnv,
	options: OracleLiveQualificationOptionsType,
	io: LiveIoType,
	dependencies: OracleLiveDependenciesType = {},
): Promise<number> => {
	try {
		const rootDir = resolveRoot(options.root);
		const projectId = projectIdOf(rootDir);
		const outputDir = path.resolve(options.output ?? path.join(indexRootDirectory(), 'oracle-live', projectId));

		mkdirSync(outputDir, {recursive: true});

		const settings = readOracleLiveSettings(environment, {rootDir, outputDir, approval: options.approval});

		if (settings.approval === null) {
			const manifestPath = manifestOf(environment, options, outputDir);
			const config = configOf(rootDir, manifestPath, outputDir, projectId);
			const plan = createOracleLivePlan(config, settings);

			io.stdout(`Oracle qualification plan: ${plan.output.planDir}`);
			io.stdout(`Source root: ${rootDir}`);
			io.stdout(`Manifest: ${manifestPath}`);
			io.stdout(`Source snapshot: ${plan.snapshot.dir}`);
			io.stdout(`Files: ${plan.snapshot.files.length}; source hash: ${plan.snapshot.sourceHash}`);
			io.stdout(`Approval: ${plan.approval}`);
			io.stdout(`To apply: ${applyCommand(options, rootDir, outputDir, plan.approval)}`);
			return 0;
		}

		const plan = readOracleLivePlan(settings);

		await applyOracleLivePlan(plan, settings, environment, dependencies);
		const result = await qualifyOracleConfig(snapshotConfig(plan), io, {
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
