import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {scanOracleProject} from '../../../../adapters/oracle/scanProject.ts';
import {readVcsProvenance} from '../../../../adapters/vcs/vcsProvenance.ts';
import {type ConfigType} from '../../../config/config.ts';
import {createSourceFileRecord} from '../../../generation/sourceFiles.ts';
import {type OracleLiveSettingsType} from './oracleLiveSettings.ts';
import {BACKUP_SQL, DEPENDENCIES_SQL, IDENTIFIERS_SQL, VALIDATE_SQL} from './oracleLiveSql.ts';

const SqlSchema = z.object({
	path: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const LivePlanSchema = z.object({
	version: z.literal(2),
	approval: z.string().regex(/^[a-f0-9]{64}$/u),
	createdAt: z.string().min(1),
	project: z.object({
		name: z.string().min(1),
		id: z.string().min(1),
		rootDir: z.string().min(1),
		projectFile: z.string().min(1),
		projects: z.array(z.object({name: z.string().min(1), path: z.string().min(1)})),
		vcs: z.object({
			kind: z.string().min(1),
			repository: z.string().nullable(),
			revision: z.string().nullable(),
			relativeRoot: z.string().nullable(),
		}),
	}),
	snapshot: z.object({
		dir: z.string().min(1),
		sourceHash: z.string().min(1),
		configHash: z.string().min(1),
		files: z.array(z.object({path: z.string().min(1), sha256: z.string().min(1)})),
		projectFiles: z.array(z.object({path: z.string().min(1), sha256: z.string().min(1)})),
	}),
	output: z.object({
		dir: z.string().min(1),
		planDir: z.string().min(1),
		databasePath: z.string().min(1),
		identifiers: z.string().min(1),
		dependencies: z.string().min(1),
		backup: z.string().min(1),
		invalidObjects: z.string().min(1),
		compileLog: z.string().min(1),
		report: z.string().min(1),
		run: z.string().min(1),
	}),
	sql: z.object({
		backup: SqlSchema,
		compile: SqlSchema,
		validate: SqlSchema,
		identifiers: SqlSchema,
		dependencies: SqlSchema,
	}),
});

export type LivePlanType = z.infer<typeof LivePlanSchema>;
type LiveSqlNameType = keyof LivePlanType['sql'];

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const approvalOf = (plan: Omit<LivePlanType, 'approval' | 'createdAt'>): string =>
	sha256(
		JSON.stringify({
			version: plan.version,
			project: plan.project,
			snapshot: plan.snapshot,
			output: plan.output,
			sql: plan.sql,
		}),
	);

const header = (spool: string | null): string =>
	[
		'SET DEFINE OFF',
		'SET ECHO OFF',
		'SET FEEDBACK OFF',
		'SET PAGESIZE 0',
		'SET LINESIZE 32767',
		'SET TRIMSPOOL ON',
		'SET SERVEROUTPUT ON SIZE UNLIMITED',
		...(spool === null ? [] : [`SPOOL ${spool}`]),
	].join('\n');

const compileSql = (files: readonly Readonly<{path: string; absolutePath: string}>[], snapshotDir: string): string => {
	const specs = files.filter((file) => ['.pks', '.pkg'].includes(path.extname(file.path).toLowerCase()));
	const bodies = files.filter((file) => !specs.includes(file));
	const passes = [specs, specs, bodies, bodies];
	const lines = [
		header('compile.log'),
		'WHENEVER SQLERROR EXIT SQL.SQLCODE',
		"ALTER SESSION SET PLSCOPE_SETTINGS = 'IDENTIFIERS:ALL';",
		'WHENEVER SQLERROR CONTINUE',
	];

	for (const pass of passes) {
		for (const file of pass) {
			lines.push(`PROMPT FILE:${file.path}`, `@"${path.join(snapshotDir, file.path)}"`);
		}
	}

	lines.push('SPOOL OFF', 'EXIT SQL.SQLCODE', '');
	return lines.join('\n');
};

const sqlFilesOf = (
	input: Readonly<{snapshotDir: string; files: readonly Readonly<{path: string; absolutePath: string}>[]}>,
): Readonly<Record<LiveSqlNameType, string>> => ({
	backup: BACKUP_SQL,
	compile: compileSql(input.files, input.snapshotDir),
	validate: VALIDATE_SQL,
	identifiers: IDENTIFIERS_SQL,
	dependencies: DEPENDENCIES_SQL,
});

const snapshotProjectPath = (rootDir: string, projectFilePath: string, index: number): string => {
	const relativePath = path.relative(rootDir, projectFilePath);
	const inside = relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);

	if (inside) {
		return relativePath.split(path.sep).join('/');
	}

	return ['manifests', `${index}-${path.basename(projectFilePath)}`].join('/');
};

const copySnapshot = (snapshotDir: string, files: ReturnType<typeof scanOracleProject>['files']): {path: string; sha256: string}[] => {
	for (const file of files) {
		const destination = path.join(snapshotDir, file.path);

		mkdirSync(path.dirname(destination), {recursive: true});
		copyFileSync(file.absolutePath, destination);

		const copied = createSourceFileRecord(destination, snapshotDir);

		if (copied.sha256 !== file.sha256) {
			throw new Error(`Oracle source changed while creating the qualification snapshot: ${file.path}`);
		}
	}

	return files.map((file) => ({path: file.path, sha256: file.sha256}));
};

/**
 * Freezes source, writes approved SQL, and returns an approval-gated plan.
 *
 * @param config - Resolved Oracle workspace configuration.
 * @param settings - Environment-only live qualification settings.
 * @returns The written plan, including its approval hash.
 */
export const createOracleLivePlan = (config: ConfigType, settings: OracleLiveSettingsType): LivePlanType => {
	const {outputDir} = settings;
	const planDir = path.join(outputDir, 'plan');
	const snapshotDir = path.join(outputDir, 'workspace');
	const databasePath = path.join(outputDir, 'index.sqlite');
	const created = scanOracleProject(config);

	rmSync(planDir, {recursive: true, force: true});
	rmSync(snapshotDir, {recursive: true, force: true});
	mkdirSync(planDir, {recursive: true});
	mkdirSync(snapshotDir, {recursive: true});

	const snapshotFiles = copySnapshot(snapshotDir, created.files);
	const projectFiles: {path: string; sha256: string}[] = [];
	const projects: {name: string; path: string}[] = [];

	for (const [index, project] of config.projects.entries()) {
		const relative = snapshotProjectPath(config.rootDir, project.projectFilePath, index);
		const destination = path.join(snapshotDir, relative);

		mkdirSync(path.dirname(destination), {recursive: true});
		copyFileSync(project.projectFilePath, destination);
		projectFiles.push({path: relative, sha256: sha256(readFileSync(destination))});
		projects.push({name: project.name, path: relative});
	}

	const firstProject = projects.at(0);

	if (firstProject === undefined) {
		throw new Error('Oracle qualification requires at least one project manifest');
	}

	const files = created.files.map((file) => ({path: file.path, absolutePath: path.join(snapshotDir, file.path)}));
	const contents = sqlFilesOf({snapshotDir, files});
	const writeSql = (name: LiveSqlNameType, content: string): LivePlanType['sql'][LiveSqlNameType] => {
		const sqlPath = path.join(planDir, `${name}.sql`);

		writeFileSync(sqlPath, content, {encoding: 'utf8'});
		return {path: sqlPath, sha256: sha256(content)};
	};
	const sql = {
		backup: writeSql('backup', contents.backup),
		compile: writeSql('compile', contents.compile),
		validate: writeSql('validate', contents.validate),
		identifiers: writeSql('identifiers', contents.identifiers),
		dependencies: writeSql('dependencies', contents.dependencies),
	};
	const planWithoutApproval = {
		version: 2 as const,
		project: {
			name: config.projectName,
			id: config.projectId,
			rootDir: config.rootDir,
			projectFile: firstProject.path,
			projects,
			vcs: readVcsProvenance(config.rootDir),
		},
		snapshot: {dir: snapshotDir, sourceHash: created.sourceHash, configHash: created.configHash, files: snapshotFiles, projectFiles},
		output: {
			dir: outputDir,
			planDir,
			databasePath,
			identifiers: path.join(outputDir, 'user-identifiers.csv'),
			dependencies: path.join(outputDir, 'user-dependencies.csv'),
			backup: path.join(outputDir, 'user-source-backup.csv'),
			invalidObjects: path.join(outputDir, 'invalid-objects.csv'),
			compileLog: path.join(outputDir, 'compile.log'),
			report: path.join(outputDir, 'oracle-qualification.json'),
			run: path.join(outputDir, 'run.json'),
		},
		sql,
	};
	const plan: LivePlanType = {
		...planWithoutApproval,
		approval: approvalOf(planWithoutApproval),
		createdAt: new Date().toISOString(),
	};

	writeFileSync(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, {encoding: 'utf8'});
	return plan;
};

/**
 * Reads and verifies a previously approved plan and its SQL files.
 *
 * @param settings - Settings containing the approval hash and output directory.
 * @returns The verified plan.
 * @throws {Error} When the plan is missing, approval does not match, or SQL was modified.
 */
export const readOracleLivePlan = (settings: OracleLiveSettingsType): LivePlanType => {
	if (settings.approval === null) {
		throw new Error('Oracle live qualification apply requires CODE_INDEX_ORACLE_APPROVAL');
	}

	const raw: unknown = JSON.parse(readFileSync(path.join(settings.outputDir, 'plan.json'), 'utf8'));
	const parsed = LivePlanSchema.safeParse(raw);

	if (!parsed.success) {
		throw new Error(`Invalid Oracle qualification plan:\n${z.prettifyError(parsed.error)}`);
	}

	const plan = parsed.data;

	if (plan.output.dir !== settings.outputDir) {
		throw new Error(`Oracle qualification plan output does not match ${settings.outputDir}`);
	}

	if (plan.approval !== settings.approval || approvalOf(plan) !== plan.approval) {
		throw new Error('Oracle qualification approval hash does not match the current plan');
	}

	for (const sql of Object.values(plan.sql)) {
		if (sha256(readFileSync(sql.path)) !== sql.sha256) {
			throw new Error(`Oracle qualification SQL changed after approval: ${sql.path}`);
		}
	}

	for (const file of [...plan.snapshot.files, ...plan.snapshot.projectFiles]) {
		if (sha256(readFileSync(path.join(plan.snapshot.dir, file.path))) !== file.sha256) {
			throw new Error(`Oracle qualification snapshot changed after approval: ${file.path}`);
		}
	}

	return plan;
};
