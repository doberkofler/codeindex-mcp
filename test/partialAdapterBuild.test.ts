import {cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {oracleExtractor} from '@codeindex/adapter-oracle/index';
import {buildTypeScriptFacts, scanTypeScriptProject, typeScriptExtractor} from '@codeindex/adapter-typescript/index';
import {type ExtractorType} from '../src/adapters/types.ts';
import {adapterConfigFor, type AdapterConfigType, type ConfigType} from '../src/core/config/config.ts';
import {buildGeneration} from '../src/core/generation/buildGeneration.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {adapterSetOf} from './helpers/adapters.ts';
import {silentLogger} from './helpers/fixture.ts';

const {join} = path;

type WorkspaceType = Readonly<{root: string; storage: string; cleanup: () => void}>;

const createWorkspace = (): WorkspaceType => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), 'code-index-partial-'));
	const root = join(temporaryRoot, 'workspace');

	cpSync(join(import.meta.dirname, 'fixtures', 'simple-project'), root, {recursive: true});
	cpSync(join(import.meta.dirname, 'fixtures', 'oracle-project', 'database'), join(root, 'database'), {recursive: true});
	writeFileSync(join(root, 'oracle-index.json'), readFileSync(join(import.meta.dirname, 'fixtures', 'oracle-project', 'oracle-index.json')));

	return {
		root: realpathSync(root),
		storage: realpathSync(temporaryRoot),
		cleanup: () => {
			rmSync(temporaryRoot, {recursive: true, force: true});
		},
	};
};

const adapterOf = (id: string, projectDirectory: string, projectFile: string, name: string): AdapterConfigType => ({
	id,
	required: true,
	options: {},
	projectFilePath: join(projectDirectory, projectFile),
	projects: [{name, projectFilePath: join(projectDirectory, projectFile)}],
});

const configOf = (workspace: WorkspaceType, adapters: readonly [AdapterConfigType, ...AdapterConfigType[]]): ConfigType => {
	const [primary] = adapters;

	return {
		projectName: 'partial-adapter',
		rootDir: workspace.root,
		adapters,
		extractorId: primary.id,
		extractorOptions: primary.options,
		projectFilePath: primary.projectFilePath,
		projects: primary.projects,
		storageDirectory: workspace.storage,
		databasePath: join(workspace.storage, 'index.sqlite'),
		analyticsEnabled: false,
		analyticsPath: join(workspace.storage, 'analytics', 'events.jsonl'),
		maxResultBytes: 32_768,
		maxReadLines: 200,
		semanticDiagnostics: false,
		freshnessDebounceMs: 1000,
		projectId: 'partial-adapter',
		logLevel: 'error',
		configPath: null,
	};
};

const openDatabase = (config: ConfigType): IndexDatabase =>
	IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectId: config.projectId,
		projects: (config.adapters ?? []).map((adapter) => ({
			adapterId: adapter.id,
			projectId: config.projectId,
			projectFilePath: adapter.projectFilePath,
		})),
	});

const wrappedTypeScript = (built: string[]): ExtractorType => ({
	...typeScriptExtractor,
	build: (config, scan, _cache) => {
		built.push('typescript');
		return buildTypeScriptFacts(config, scan);
	},
});

const persistedSymbolIdsOf = (config: ConfigType, generationId: string, adapterId: string): readonly string[] => {
	const reader = new DatabaseSync(config.databasePath, {readOnly: true});

	try {
		return reader
			.prepare('select id from symbol where generation_id = ? and adapter_id = ? order by id')
			.all(generationId, adapterId)
			.map((row) => String(row['id']));
	} finally {
		reader.close();
	}
};

describe('partial adapter build', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('writes only the invalidated adapter and preserves untouched rows', async () => {
		const workspace = createWorkspace();
		({cleanup} = workspace);
		const built: string[] = [];
		const wrappedOracle: ExtractorType = {
			...oracleExtractor,
			build: (config, scan, cache) => {
				built.push('oracle');
				const result = oracleExtractor.build(config, scan, cache);

				if (result instanceof Promise) {
					throw new TypeError('The Oracle fixture build must be synchronous');
				}

				return result;
			},
		};
		const typescript = adapterOf('typescript', workspace.root, 'tsconfig.json', 'app');
		const oracle = adapterOf('oracle', workspace.root, 'oracle-index.json', 'database');
		const config = configOf(workspace, [typescript, oracle]);
		const database = openDatabase(config);
		const adapters = adapterSetOf(wrappedTypeScript(built), wrappedOracle);

		try {
			const first = await buildGeneration({config, database, logger: silentLogger, force: true, adapters});
			const oracleIdsBefore = persistedSymbolIdsOf(config, first.generationId, 'oracle');
			const oracleBefore = database.getGenerationAdapters(first.generationId).find((adapter) => adapter.adapterId === 'oracle');
			expect([...built].sort()).toStrictEqual(['oracle', 'typescript']);

			built.length = 0;
			writeFileSync(
				join(workspace.root, 'src', 'models.ts'),
				`${readFileSync(join(workspace.root, 'src', 'models.ts'), 'utf8')}\nexport type TargetedEdit = string;\n`,
			);
			const scan = scanTypeScriptProject(adapterConfigFor(config, typescript), []);
			const second = await buildGeneration({
				config,
				database,
				logger: silentLogger,
				adapters,
				scans: [{adapterId: 'typescript', coverage: 'present', absenceReason: null, scan}],
			});

			expect(second.outcome).toBe('published');
			expect(built).toStrictEqual(['typescript']);
			expect(persistedSymbolIdsOf(config, second.generationId, 'oracle')).toStrictEqual(oracleIdsBefore);
			expect(database.getGenerationAdapters(second.generationId).find((adapter) => adapter.adapterId === 'oracle')).toMatchObject({
				fileCount: oracleBefore?.fileCount,
				symbolCount: oracleBefore?.symbolCount,
			});
			expect(database.getGenerationAdapters(second.generationId).map((adapter) => adapter.adapterId)).toStrictEqual(['oracle', 'typescript']);
			expect(second.symbolCount).toBe(database.getGenerationAdapters(second.generationId).reduce((total, adapter) => total + adapter.symbolCount, 0));
		} finally {
			database.close();
		}
	});
});
