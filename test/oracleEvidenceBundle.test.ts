import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {preflightOracleEvidenceBundle, type OracleEvidencePreflightReportType} from '../src/core/qualification/oracle/live/oracleEvidenceBundle.ts';
import {oracleQualificationContractIdentityOf} from '../src/core/qualification/oracle/oracleQualificationContract.ts';
import {runOraclePreflight} from '../src/transports/cli/oraclePreflightCommand.ts';
import {runOracleReplay} from '../src/transports/cli/oracleReplayCommand.ts';

const APPROVAL = '4c82485ae33d80a0c950f0b89a889461ab72092653ee817609eab2cc467b3173';
const SOURCE_HASH = 'dfae2b41a2595d3e83065b9c5807b596f1b43e7cf8fd634958e89e86cfebf2d7';
const CONFIG_HASH = '0f790f4865d3929fdb651968b2558d9309ad49d552bd0f93f10119c7ab74f933';
const PROJECT_FILE = 'manifests/qualification-index.json';

type PlanFixtureType = Readonly<{
	version: number;
	approval: string;
	snapshot: Readonly<{
		sourceHash: string;
		configHash: string;
		files: readonly {path: string; sha256: string}[];
		projectFiles: readonly {path: string; sha256: string}[];
	}>;
}>;

type RunFixtureType = Readonly<{
	version: number;
	approval: string;
	source: Readonly<{sourceHash: string; configHash: string; files: number}>;
	contract?: Readonly<{id: string; version: string; hash: string; truthPolicy: string}> | undefined;
	truth?: Readonly<{identifiersSha256: string; dependenciesSha256: string}> | undefined;
}>;

type BundleType = Readonly<{
	directory: string;
	descriptor: string;
	root: string;
	refresh: () => void;
	writePlan: (plan: PlanFixtureType) => void;
	writeRun: (run: RunFixtureType) => void;
}>;

const TRUTH_EXPORTS = ['user-identifiers.csv', 'user-dependencies.csv', 'user-source-backup.csv', 'compile.log', 'dependents.log'] as const;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const writeText = (filePath: string, content: string): void => {
	mkdirSync(path.dirname(filePath), {recursive: true});
	writeFileSync(filePath, content, {encoding: 'utf8'});
};

const writeJson = (filePath: string, value: unknown): void => {
	writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const truthHashesOf = (root: string): ReadonlyMap<string, string> => {
	for (const name of TRUTH_EXPORTS) {
		writeText(path.join(root, name), `${name}\n`);
	}

	return new Map(TRUTH_EXPORTS.map((name) => [name, sha256(readFileSync(path.join(root, name), 'utf8'))]));
};

const planFixtureOf = (snapshotDir: string, projectPath: string): PlanFixtureType => ({
	version: 6,
	approval: APPROVAL,
	snapshot: {
		sourceHash: SOURCE_HASH,
		configHash: CONFIG_HASH,
		files: [{path: 'a.sql', sha256: sha256(readFileSync(path.join(snapshotDir, 'a.sql'), 'utf8'))}],
		projectFiles: [{path: PROJECT_FILE, sha256: sha256(readFileSync(projectPath, 'utf8'))}],
	},
});

const runFixtureOf = (truthHashes: ReadonlyMap<string, string>): RunFixtureType => {
	const contract = oracleQualificationContractIdentityOf();

	return {
		version: 1,
		approval: APPROVAL,
		source: {sourceHash: SOURCE_HASH, configHash: CONFIG_HASH, files: 1},
		contract: {id: contract.id, version: contract.version, hash: contract.hash, truthPolicy: contract.truthPolicy},
		truth: {
			identifiersSha256: truthHashes.get('user-identifiers.csv') ?? '',
			dependenciesSha256: truthHashes.get('user-dependencies.csv') ?? '',
		},
	};
};

const writeDescriptor = (descriptorPath: string): void => {
	writeJson(descriptorPath, {
		schemaVersion: 1,
		evidence: {externalRoot: 'oracle-live/replacement', snapshotDir: 'workspace', plan: 'plan.json', run: 'run.json', approval: APPROVAL},
		source: {kind: 'svn', revision: '78950', relativeRoot: '^/ljs_app/trunk/ljs_db/LJS_DB', defaultSchema: 'LJ_UNITTEST'},
		snapshot: {projectFile: PROJECT_FILE, sourceHash: SOURCE_HASH, configHash: CONFIG_HASH, fileCount: 1, unitCount: 1},
		files: {checksums: 'corpus.sha256', units: 'units.json'},
	});
};

const createBundle = (): BundleType => {
	const directory = mkdtempSync(path.join(tmpdir(), 'oracle-evidence-bundle-'));
	const descriptorDir = path.join(directory, 'descriptor');
	const root = path.join(directory, 'evidence');
	const descriptorPath = path.join(descriptorDir, 'corpus.json');
	const snapshotDir = path.join(root, 'workspace');
	const projectPath = path.join(snapshotDir, PROJECT_FILE);

	writeText(path.join(snapshotDir, 'a.sql'), 'create or replace procedure p is begin null; end;\n');
	writeJson(projectPath, {schemaVersion: 1, extensions: ['.sql']});

	const truthHashes = truthHashesOf(root);
	const writePlan = (plan: PlanFixtureType): void => {
		writeJson(path.join(root, 'plan.json'), plan);
	};
	const writeRun = (run: RunFixtureType): void => {
		writeJson(path.join(root, 'run.json'), run);
	};

	writePlan(planFixtureOf(snapshotDir, projectPath));
	writeRun(runFixtureOf(truthHashes));
	writeDescriptor(descriptorPath);
	writeJson(path.join(descriptorDir, 'units.json'), [
		{path: 'a.sql', type: 'PROCEDURE', name: 'P', sourceSha256: sha256(readFileSync(path.join(snapshotDir, 'a.sql'), 'utf8'))},
	]);

	const refresh = (): void => {
		writeText(path.join(descriptorDir, 'corpus.sha256'), `${sha256(readFileSync(path.join(snapshotDir, 'a.sql'), 'utf8'))}  a.sql\n`);
		const evidenceFiles = ['plan.json', 'run.json', ...TRUTH_EXPORTS]
			.filter((name) => existsSync(path.join(root, name)))
			.map((name) => `${sha256(readFileSync(path.join(root, name), 'utf8'))}  ${name}`);

		writeText(path.join(descriptorDir, 'plscope.sha256'), `${evidenceFiles.join('\n')}\n`);
	};

	refresh();

	return {directory, descriptor: descriptorPath, root, refresh, writePlan, writeRun};
};

const preflight = async (bundle: BundleType): Promise<OracleEvidencePreflightReportType> => {
	const report = await preflightOracleEvidenceBundle({}, {descriptorPath: bundle.descriptor, evidenceRoot: bundle.root});

	return report;
};

const statusOf = (report: OracleEvidencePreflightReportType, name: string): string | undefined =>
	report.identities.find((identity) => identity.name === name)?.status;

const temporaryDirectories: string[] = [];

const bundle = (): BundleType => {
	const created = createBundle();
	temporaryDirectories.push(created.directory);
	return created;
};

describe('Oracle evidence bundle preflight', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('passes a complete bundle and keeps artifact paths bundle-relative', async () => {
		const context = bundle();
		const report = await preflight(context);

		expect(report.ok).toBe(true);
		expect(report.summary).toStrictEqual({ok: report.artifacts.length + report.identities.length, missing: 0, mismatch: 0, unverified: 0});
		expect(report.artifacts.map((artifact) => artifact.path)).toContain('workspace/a.sql');
		expect(report.artifacts.map((artifact) => artifact.path)).toContain('user-identifiers.csv');
		expect(report.artifacts.every((artifact) => !path.isAbsolute(artifact.path))).toBe(true);
		expect(statusOf(report, 'run.contract')).toBe('ok');
		expect(statusOf(report, 'run.truthIdentifiers')).toBe('ok');
	});

	it('fails before any database work when an external artifact is absent', async () => {
		const context = bundle();

		rmSync(path.join(context.root, 'user-identifiers.csv'));
		context.refresh();

		const report = await preflight(context);

		expect(report.ok).toBe(false);
		expect(report.artifacts.find((artifact) => artifact.path === 'user-identifiers.csv')?.status).toBe('missing');
		expect(statusOf(report, 'run.truthIdentifiers')).toBe('missing');
	});

	it('rejects a snapshot file whose checksum no longer matches', async () => {
		const context = bundle();

		writeText(path.join(context.root, 'workspace', 'a.sql'), 'create or replace procedure p is begin commit; end;\n');

		const report = await preflight(context);

		expect(report.artifacts.find((artifact) => artifact.path === 'workspace/a.sql')?.status).toBe('mismatch');
		expect(report.ok).toBe(false);
	});

	it('rejects an approval hash that disagrees with the retained plan', async () => {
		const context = bundle();

		context.writePlan({
			version: 6,
			approval: 'a'.repeat(64),
			snapshot: {
				sourceHash: SOURCE_HASH,
				configHash: CONFIG_HASH,
				files: [{path: 'a.sql', sha256: sha256(readFileSync(path.join(context.root, 'workspace', 'a.sql'), 'utf8'))}],
				projectFiles: [],
			},
		});
		context.refresh();

		const report = await preflight(context);

		expect(statusOf(report, 'plan.approval')).toBe('mismatch');
		expect(statusOf(report, 'plan.projectFile')).toBe('mismatch');
		expect(report.ok).toBe(false);
	});

	it('rejects a contract identity that differs from the authoritative contract', async () => {
		const context = bundle();

		context.writeRun({
			version: 1,
			approval: APPROVAL,
			source: {sourceHash: SOURCE_HASH, configHash: CONFIG_HASH, files: 1},
			contract: {id: 'oracle-o1', version: '0', hash: 'b'.repeat(64), truthPolicy: 'v2'},
		});
		context.refresh();

		const report = await preflight(context);

		expect(statusOf(report, 'run.contract')).toBe('mismatch');
		expect(report.identities.find((identity) => identity.name === 'run.contract')?.expected).toContain('oracle-o1@3');
		expect(report.ok).toBe(false);
	});

	it('rejects truth hashes that differ from the retained exports', async () => {
		const context = bundle();

		context.writeRun({
			version: 1,
			approval: APPROVAL,
			source: {sourceHash: SOURCE_HASH, configHash: CONFIG_HASH, files: 1},
			truth: {identifiersSha256: 'c'.repeat(64), dependenciesSha256: 'd'.repeat(64)},
		});
		context.refresh();

		const report = await preflight(context);

		expect(statusOf(report, 'run.truthIdentifiers')).toBe('mismatch');
		expect(statusOf(report, 'run.truthDependencies')).toBe('mismatch');
		expect(report.ok).toBe(false);
	});

	it('rejects a unit map that disagrees with the frozen corpus', async () => {
		const context = bundle();

		writeJson(path.join(path.dirname(context.descriptor), 'units.json'), [{path: 'b.sql', type: 'PROCEDURE', name: 'P', sourceSha256: 'e'.repeat(64)}]);

		const report = await preflight(context);

		expect(statusOf(report, 'corpus.unitPaths')).toBe('mismatch');
		expect(report.ok).toBe(false);
	});

	it('reports every missing artifact when the evidence root does not exist', async () => {
		const context = bundle();
		const report = await preflightOracleEvidenceBundle({}, {descriptorPath: context.descriptor, evidenceRoot: path.join(context.directory, 'absent')});

		expect(report.ok).toBe(false);
		expect(report.summary.missing).toBeGreaterThan(0);
		expect(report.artifacts.some((artifact) => artifact.path === 'plan.json' && artifact.status === 'missing')).toBe(true);
	});
});

describe('Oracle evidence preflight command', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('returns a failing exit code without a database session', async () => {
		const context = bundle();
		const lines: string[] = [];
		const errors: string[] = [];
		const code = await runOraclePreflight(
			{},
			{
				stdout: (line) => {
					lines.push(line);
				},
				stderr: (line) => {
					errors.push(line);
				},
			},
			{bundle: context.descriptor, evidenceRoot: path.join(context.directory, 'absent'), json: false},
		);

		expect(code).toBe(1);
		expect(errors).toStrictEqual([]);
		expect(lines[0]).toBe('Oracle evidence preflight: FAIL');
		expect(lines.join('\n')).toContain('MISSING plan.json');
	});
});

describe('Oracle evidence replay command', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('refuses to replay when the retained bundle does not preflight', async () => {
		const context = bundle();
		const lines: string[] = [];
		const errors: string[] = [];
		const code = await runOracleReplay(
			{},
			{
				stdout: (line) => {
					lines.push(line);
				},
				stderr: (line) => {
					errors.push(line);
				},
			},
			{bundle: context.descriptor, evidenceRoot: path.join(context.directory, 'absent')},
		);

		expect(code).toBe(1);
		expect(lines).toStrictEqual([]);
		expect(errors.join('\n')).toContain('preflight failed');
	});
});
