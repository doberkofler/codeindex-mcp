import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {scanOracleProject} from '../../../../adapters/oracle/scanProject.ts';
import {readVcsProvenance} from '../../../../adapters/vcs/vcsProvenance.ts';
import {type ConfigType} from '../../../config/config.ts';
import {
	oracleSourceCandidates,
	selectOracleSources,
	selectOracleSourcesWithoutInstalled,
	snapshotManifestOf,
	writeOracleSnapshot,
} from './oracleLiveCandidates.ts';
import {oracleDependentsOf, type OracleDependencyRowType, type OracleDependentType} from './oracleDependencies.ts';
import {recompileStatementOf, type OracleInstalledSourceType, type OracleSourceObjectRefType} from './oracleLiveSource.ts';
import {type OracleLiveSettingsType} from './oracleLiveSettings.ts';
import {BACKUP_SQL, BASELINE_SQL, DEPENDENCIES_SQL, IDENTIFIERS_SQL} from './oracleLiveSql.ts';

const SqlSchema = z.object({
	path: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const OracleObjectTypeSchema = z.enum(['PACKAGE', 'PACKAGE BODY', 'FUNCTION', 'PROCEDURE']);

const SourceUnitSchema = z.object({
	path: z.string().min(1),
	sourcePath: z.string().min(1),
	type: OracleObjectTypeSchema,
	name: z.string().min(1),
	compileClause: z.string(),
	sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
	candidatePaths: z.array(z.string().min(1)).min(1),
});

const OracleDependentSchema = z.object({
	type: z.string().min(1),
	name: z.string().min(1),
	compileClause: z.string(),
	depth: z.number().int().positive(),
});

const LivePlanSchema = z.object({
	version: z.literal(5),
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
		projectFile: z.string().min(1),
		sourceHash: z.string().min(1),
		configHash: z.string().min(1),
		files: z.array(z.object({path: z.string().min(1), sha256: z.string().min(1)})),
		projectFiles: z.array(z.object({path: z.string().min(1), sha256: z.string().min(1)})),
		units: z.array(SourceUnitSchema),
		dependenciesChecked: z.boolean(),
		dependents: z.array(OracleDependentSchema),
		installed: z
			.object({
				objects: z.number().int().nonnegative(),
				selected: z.number().int().nonnegative(),
				missingSource: z.number().int().nonnegative(),
			})
			.nullable(),
	}),
	output: z.object({
		dir: z.string().min(1),
		planDir: z.string().min(1),
		databasePath: z.string().min(1),
		identifiers: z.string().min(1),
		dependencies: z.string().min(1),
		backup: z.string().min(1),
		baselineInvalidObjects: z.string().min(1),
		invalidObjects: z.string().min(1),
		compileLog: z.string().min(1),
		dependentCompileLog: z.string().min(1),
		report: z.string().min(1),
		run: z.string().min(1),
	}),
	sql: z.object({
		backup: SqlSchema,
		baseline: SqlSchema,
		compile: SqlSchema,
		dependents: SqlSchema,
		validate: SqlSchema,
		identifiers: SqlSchema,
		dependencies: SqlSchema,
	}),
});

export type LivePlanType = z.infer<typeof LivePlanSchema>;
type LivePlanSourceUnitType = LivePlanType['snapshot']['units'][number];
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

const typePriority = (type: OracleSourceObjectRefType['type']): number => (type === 'PACKAGE' ? 0 : type === 'PACKAGE BODY' ? 1 : type === 'FUNCTION' ? 2 : 3);

const recompileSql = (units: readonly LivePlanSourceUnitType[]): string => {
	const ordered = units
		.map((unit) => ({type: unit.type, name: unit.name, compileClause: unit.compileClause}))
		.sort((left, right) => typePriority(left.type) - typePriority(right.type) || left.name.localeCompare(right.name));
	const lines = [header('compile.log'), 'WHENEVER SQLERROR EXIT SQL.SQLCODE', "ALTER SESSION SET PLSCOPE_SETTINGS = 'IDENTIFIERS:ALL';"];

	for (const object of ordered) {
		lines.push(`PROMPT RECOMPILE:${object.type}:${object.name}`, `${recompileStatementOf(object)};`);
	}

	lines.push('SPOOL OFF', 'EXIT SQL.SQLCODE', '');
	return lines.join('\n');
};

const dependentSql = (dependents: readonly OracleDependentType[]): string => {
	const lines = [header('dependents.log'), 'WHENEVER SQLERROR CONTINUE'];

	for (const object of dependents) {
		lines.push(`PROMPT RECOMPILE-DEPENDENT:${object.type}:${object.name}`, `${recompileStatementOf(object)};`);
	}

	lines.push('SPOOL OFF', 'EXIT 0', '');
	return lines.join('\n');
};

const sqlFilesOf = (units: readonly LivePlanSourceUnitType[], dependents: readonly OracleDependentType[]): Readonly<Record<LiveSqlNameType, string>> => ({
	backup: BACKUP_SQL,
	baseline: BASELINE_SQL,
	compile: recompileSql(units),
	dependents: dependentSql(dependents),
	validate: BASELINE_SQL,
	identifiers: IDENTIFIERS_SQL,
	dependencies: DEPENDENCIES_SQL,
});

const writePlanSql = (planDir: string, contents: Readonly<Record<LiveSqlNameType, string>>): LivePlanType['sql'] => {
	const writeSql = (name: LiveSqlNameType, content: string): LivePlanType['sql'][LiveSqlNameType] => {
		const sqlPath = path.join(planDir, `${name}.sql`);

		writeFileSync(sqlPath, content, {encoding: 'utf8'});
		return {path: sqlPath, sha256: sha256(content)};
	};

	return {
		backup: writeSql('backup', contents.backup),
		baseline: writeSql('baseline', contents.baseline),
		compile: writeSql('compile', contents.compile),
		dependents: writeSql('dependents', contents.dependents),
		validate: writeSql('validate', contents.validate),
		identifiers: writeSql('identifiers', contents.identifiers),
		dependencies: writeSql('dependencies', contents.dependencies),
	};
};

const snapshotProjectPath = (rootDir: string, projectFilePath: string, index: number): string => {
	const relativePath = path.relative(rootDir, projectFilePath);
	const inside = relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);

	if (inside) {
		return relativePath.split(path.sep).join('/');
	}

	return ['manifests', `${index}-${path.basename(projectFilePath)}`].join('/');
};

const copySnapshotManifests = (
	config: ConfigType,
	snapshotDir: string,
	generatedManifestPath: string,
): Readonly<{
	projectFiles: {path: string; sha256: string}[];
	projects: {name: string; path: string}[];
}> => {
	const projectFiles: {path: string; sha256: string}[] = [];
	const projects: {name: string; path: string}[] = [];
	const generated = path.resolve(path.join(snapshotDir, generatedManifestPath));

	for (const [index, project] of config.projects.entries()) {
		const relative = snapshotProjectPath(config.rootDir, project.projectFilePath, index);
		const destination = path.join(snapshotDir, relative);

		if (path.resolve(destination) === generated) {
			throw new Error(`Oracle qualification manifest path collides with the generated snapshot manifest: ${relative}`);
		}

		mkdirSync(path.dirname(destination), {recursive: true});
		copyFileSync(project.projectFilePath, destination);
		projectFiles.push({path: relative, sha256: sha256(readFileSync(destination))});
		projects.push({name: project.name, path: relative});
	}

	return {projectFiles, projects};
};

/**
 * Freezes source, writes approved SQL, and returns an approval-gated plan.
 *
 * @param config - Resolved Oracle workspace configuration.
 * @param settings - Environment-only live qualification settings.
 * @param installedSources - Installed source keyed by object, or null when planning offline.
 * @param installedDependencies - Installed dependency edges, or null when planning offline.
 * @returns The written plan, including its approval hash.
 * @throws {Error} When a candidate file cannot be proven to match installed source.
 */
export const createOracleLivePlan = (
	config: ConfigType,
	settings: OracleLiveSettingsType,
	installedSources: ReadonlyMap<string, OracleInstalledSourceType> | null = null,
	installedDependencies: readonly OracleDependencyRowType[] | null = null,
): LivePlanType => {
	const {outputDir} = settings;
	const planDir = path.join(outputDir, 'plan');
	const snapshotDir = path.join(outputDir, 'workspace');
	const databasePath = path.join(outputDir, 'index.sqlite');
	const created = scanOracleProject(config);
	const candidates = oracleSourceCandidates(created.files);
	const selection =
		installedSources === null
			? {selected: selectOracleSourcesWithoutInstalled(candidates), missingSource: 0}
			: selectOracleSources(installedSources, candidates);

	if (selection.selected.length === 0) {
		throw new Error('No installed Oracle object matches the qualification source snapshot');
	}

	const dependents =
		installedDependencies === null
			? []
			: oracleDependentsOf(
					selection.selected.map((entry) => entry.unit.object),
					installedDependencies,
				);

	rmSync(planDir, {recursive: true, force: true});
	rmSync(snapshotDir, {recursive: true, force: true});
	mkdirSync(planDir, {recursive: true});
	mkdirSync(snapshotDir, {recursive: true});

	const snapshot = writeOracleSnapshot(snapshotDir, selection.selected);
	const manifest = snapshotManifestOf(config);
	const manifestDestination = path.join(snapshotDir, manifest.path);

	mkdirSync(path.dirname(manifestDestination), {recursive: true});
	writeFileSync(manifestDestination, manifest.content, {encoding: 'utf8'});

	const {projectFiles, projects} = copySnapshotManifests(config, snapshotDir, manifest.path);

	projectFiles.push({path: manifest.path, sha256: sha256(manifest.content)});

	const firstProject = projects.at(0);

	if (firstProject === undefined) {
		throw new Error('Oracle qualification requires at least one project manifest');
	}

	const sql = writePlanSql(planDir, sqlFilesOf(snapshot.units, dependents));
	const planWithoutApproval = {
		version: 5 as const,
		project: {
			name: config.projectName,
			id: config.projectId,
			rootDir: config.rootDir,
			projectFile: firstProject.path,
			projects,
			vcs: readVcsProvenance(config.rootDir),
		},
		snapshot: {
			dir: snapshotDir,
			projectFile: manifest.path,
			sourceHash: snapshot.sourceHash,
			configHash: created.configHash,
			files: snapshot.files,
			projectFiles,
			units: snapshot.units,
			dependenciesChecked: installedDependencies !== null,
			dependents: [...dependents],
			installed:
				installedSources === null
					? null
					: {
							objects: installedSources.size,
							selected: selection.selected.length,
							missingSource: selection.missingSource,
						},
		},
		output: {
			dir: outputDir,
			planDir,
			databasePath,
			identifiers: path.join(outputDir, 'user-identifiers.csv'),
			dependencies: path.join(outputDir, 'user-dependencies.csv'),
			backup: path.join(outputDir, 'user-source-backup.csv'),
			baselineInvalidObjects: path.join(outputDir, 'baseline-invalid-objects.csv'),
			invalidObjects: path.join(outputDir, 'invalid-objects.csv'),
			compileLog: path.join(outputDir, 'compile.log'),
			dependentCompileLog: path.join(outputDir, 'dependents.log'),
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
