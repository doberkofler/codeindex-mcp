import {cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildGeneration} from '../../src/core/generation/buildGeneration.ts';
import {createCodeIndex, type CodeIndex} from '../../src/core/generation/codeIndex.ts';
import {type AdapterConfigType, type ConfigType} from '../../src/core/config/config.ts';
import {IndexDatabase} from '../../src/core/storage/database.ts';
import {testAdaptersFor} from './adapters.ts';
import {silentLogger} from './silentLogger.ts';

const {join} = path;

export type MultiAdapterWorkspaceType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	index: CodeIndex;
	root: string;
	cleanup: () => void;
}>;

const adapterOf = (id: string, projectFile: string, name: string): AdapterConfigType => ({
	id,
	required: true,
	options: {},
	projectFilePath: projectFile,
	projects: [{name, projectFilePath: projectFile}],
});

/**
 * Builds one published TypeScript plus static Oracle generation.
 *
 * The fixtures occupy disjoint paths: TypeScript under `src/` and `shared/`,
 * static Oracle under `database/`, so both adapters share one workspace without
 * claiming the same authored file.
 *
 * @param typescriptFixture - TypeScript fixture directory name.
 * @returns The built index, its database, configuration, and teardown.
 */
export const createMultiAdapterWorkspace = async (typescriptFixture = 'simple-project'): Promise<MultiAdapterWorkspaceType> => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), 'code-index-multi-query-'));
	const root = join(temporaryRoot, 'workspace');

	cpSync(join(import.meta.dirname, '..', 'fixtures', typescriptFixture), root, {recursive: true});
	cpSync(join(import.meta.dirname, '..', 'fixtures', 'oracle-project', 'database'), join(root, 'database'), {recursive: true});
	writeFileSync(join(root, 'oracle-index.json'), readFileSync(join(import.meta.dirname, '..', 'fixtures', 'oracle-project', 'oracle-index.json')));

	const realRoot = realpathSync(root);
	const typescriptProject = join(realRoot, 'tsconfig.json');
	const typescriptServerProject = join(realRoot, 'tsconfig.server.json');

	writeFileSync(typescriptServerProject, readFileSync(typescriptProject));
	const typescript: AdapterConfigType = {
		id: 'typescript',
		required: true,
		options: {},
		projectFilePath: typescriptProject,
		projects: [
			{name: 'app', projectFilePath: typescriptProject},
			{name: 'server', projectFilePath: typescriptServerProject},
		],
	};
	const adapters = [typescript, adapterOf('oracle', join(realRoot, 'oracle-index.json'), 'app')];
	const config: ConfigType = {
		projectName: 'multi-adapter-query',
		rootDir: realRoot,
		adapters,
		extractorId: 'typescript',
		extractorOptions: {},
		projectFilePath: adapters[0]?.projectFilePath ?? '',
		projects: adapters[0]?.projects ?? [],
		storageDirectory: realpathSync(temporaryRoot),
		databasePath: join(realpathSync(temporaryRoot), 'index.sqlite'),
		analyticsEnabled: false,
		analyticsPath: join(realpathSync(temporaryRoot), 'analytics', 'events.jsonl'),
		maxResultBytes: 32_768,
		maxReadLines: 200,
		semanticDiagnostics: false,
		projectId: 'multi-adapter-query',
		logLevel: 'error',
		configPath: null,
	};
	const database = IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectId: config.projectId,
		projects: adapters.map((adapter) => ({adapterId: adapter.id, projectId: config.projectId, projectFilePath: adapter.projectFilePath})),
	});

	const adaptersSet = testAdaptersFor(config);

	try {
		await buildGeneration({config, database, logger: silentLogger, force: true, adapters: adaptersSet});
	} catch (error) {
		database.close();
		rmSync(temporaryRoot, {recursive: true, force: true});
		throw error;
	}

	const index = createCodeIndex(config, database, silentLogger, {watch: false, adapters: adaptersSet.adapters});

	return {
		config,
		database,
		index,
		root: realRoot,
		cleanup: () => {
			database.close();
			rmSync(temporaryRoot, {recursive: true, force: true});
		},
	};
};
