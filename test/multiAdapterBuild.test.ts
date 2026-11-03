import {cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {buildTypeScriptFacts, scanTypeScriptProject, typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {type ExtractorType} from '../src/adapters/types.ts';
import {type AdapterConfigType, type ConfigType} from '../src/core/config/config.ts';
import {assertAdapterIdentity, assertSharedExtractedFiles} from '../src/core/generation/adapterBuild.ts';
import {buildFailureOf, runAdapterStage} from '../src/core/generation/buildFailure.ts';
import {buildGeneration} from '../src/core/generation/buildGeneration.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {adapterSetOf, testAdaptersFor} from './helpers/adapters.ts';
import {silentLogger} from './helpers/fixture.ts';

const {join} = path;

type WorkspaceType = Readonly<{root: string; storage: string; cleanup: () => void}>;

const createWorkspace = (): WorkspaceType => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), 'code-index-multi-'));
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
		projectName: 'multi-adapter',
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
		projectId: 'multi-adapter',
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

const wrappedTypeScript = (id: string, built: string[]): ExtractorType => ({
	...typeScriptExtractor,
	id,
	version: `${id}-1`,
	scan: (config, knownPaths) => ({...scanTypeScriptProject(config, knownPaths), extractorId: id}),
	build: (config, scan, _cache) => {
		built.push(id);
		return buildTypeScriptFacts(config, scan);
	},
});

describe('multi-adapter build', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('publishes TypeScript and static Oracle facts in one candidate with per-adapter provenance', async () => {
		const workspace = createWorkspace();
		({cleanup} = workspace);
		const config = configOf(workspace, [
			adapterOf('typescript', workspace.root, 'tsconfig.json', 'app'),
			adapterOf('oracle', workspace.root, 'oracle-index.json', 'database'),
		]);
		const database = openDatabase(config);

		try {
			const report = await buildGeneration({config, database, logger: silentLogger, force: true, adapters: testAdaptersFor(config)});
			const published = database.getPublishedGeneration();

			expect(report.outcome).toBe('published');
			expect(published).not.toBeNull();
			// The singular columns project the first present adapter in configuration
			// order, not the alphabetically first adapter.
			expect(published?.extractorId).toBe('typescript');

			const adapters = database.getGenerationAdapters(report.generationId);
			expect(adapters.map((adapter) => `${adapter.adapterId}:${adapter.coverage}`)).toStrictEqual(['oracle:present', 'typescript:present']);
			expect(report.symbolCount).toBe(adapters.reduce((total, adapter) => total + adapter.symbolCount, 0));
			expect(report.fileCount).toBe(adapters.reduce((total, adapter) => total + adapter.fileCount, 0));

			const files = database.listFiles(report.generationId);
			expect(files.some((file) => file.path.endsWith('.ts'))).toBe(true);
			expect(files.some((file) => file.path.endsWith('.sql'))).toBe(true);

			expect(database.listProjectContextNames(report.generationId)).toStrictEqual(['app', 'database']);
		} finally {
			database.close();
		}
	});

	it('reuses one unchanged adapter while re-extracting the edited adapter', async () => {
		const workspace = createWorkspace();
		({cleanup} = workspace);
		cpSync(join(import.meta.dirname, 'fixtures', 'simple-project'), join(workspace.root, 'second'), {recursive: true});
		const built: string[] = [];
		const extractors = [wrappedTypeScript('typescript', built), wrappedTypeScript('alt', built)];
		const config = configOf(workspace, [
			adapterOf('typescript', workspace.root, 'tsconfig.json', 'app'),
			adapterOf('alt', join(workspace.root, 'second'), 'tsconfig.json', 'second'),
		]);
		const database = openDatabase(config);

		try {
			await buildGeneration({config, database, logger: silentLogger, force: true, adapters: adapterSetOf(...extractors)});
			expect([...built].sort()).toStrictEqual(['alt', 'typescript']);

			built.length = 0;
			writeFileSync(
				join(workspace.root, 'src', 'models.ts'),
				`${readFileSync(join(workspace.root, 'src', 'models.ts'), 'utf8')}\nexport type MultiAdapterEdit = string;\n`,
			);
			const second = await buildGeneration({config, database, logger: silentLogger, adapters: adapterSetOf(...extractors)});

			expect(second.outcome).toBe('published');
			expect(built).toStrictEqual(['typescript']);

			const adapters = new Map(database.getGenerationAdapters(second.generationId).map((adapter) => [adapter.adapterId, adapter]));
			expect(adapters.get('alt')?.symbolCount).toBeGreaterThan(0);
			expect(adapters.get('typescript')?.symbolCount).toBeGreaterThan(0);
		} finally {
			database.close();
		}
	});
});

describe('multi-adapter coverage and ownership', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('records declared optional absence and re-extracts once the adapter recovers', async () => {
		const workspace = createWorkspace();
		({cleanup} = workspace);
		let available = false;
		const built: string[] = [];
		const optional: ExtractorType = {
			...typeScriptExtractor,
			id: 'optional',
			version: 'optional-1',
			absenceReasons: ['tool-missing'],
			probe: () => (available ? {available: true} : {available: false, reason: 'tool-missing'}),
			scan: (config, knownPaths) => ({...scanTypeScriptProject(config, knownPaths), extractorId: 'optional'}),
			build: (config, scan, _cache) => {
				built.push('optional');
				return buildTypeScriptFacts(config, scan);
			},
		};
		cpSync(join(import.meta.dirname, 'fixtures', 'simple-project'), join(workspace.root, 'optional'), {recursive: true});
		const config = configOf(workspace, [
			adapterOf('typescript', workspace.root, 'tsconfig.json', 'app'),
			{...adapterOf('optional', join(workspace.root, 'optional'), 'tsconfig.json', 'optional'), required: false},
		]);
		const database = openDatabase(config);

		try {
			const first = await buildGeneration({config, database, logger: silentLogger, force: true, adapters: adapterSetOf(typeScriptExtractor, optional)});
			const absent = database.getGenerationAdapters(first.generationId).find((adapter) => adapter.adapterId === 'optional');

			expect(absent).toMatchObject({coverage: 'absent', absenceReason: 'tool-missing', symbolCount: 0});
			expect(built).toStrictEqual([]);

			available = true;
			const second = await buildGeneration({config, database, logger: silentLogger, adapters: adapterSetOf(typeScriptExtractor, optional)});
			const present = database.getGenerationAdapters(second.generationId).find((adapter) => adapter.adapterId === 'optional');

			expect(second.outcome).toBe('published');
			expect(present).toMatchObject({coverage: 'present', absenceReason: null});
			expect(built).toStrictEqual(['optional']);
		} finally {
			database.close();
		}
	});

	it('fails a required adapter that reports declared unavailability', async () => {
		const workspace = createWorkspace();
		({cleanup} = workspace);
		const unavailable: ExtractorType = {
			...typeScriptExtractor,
			id: 'unavailable',
			version: 'unavailable-1',
			absenceReasons: ['tool-missing'],
			probe: () => ({available: false, reason: 'tool-missing'}),
		};
		const config = configOf(workspace, [
			adapterOf('typescript', workspace.root, 'tsconfig.json', 'app'),
			adapterOf('unavailable', workspace.root, 'tsconfig.json', 'unavailable'),
		]);
		const database = openDatabase(config);

		try {
			await expect(
				buildGeneration({config, database, logger: silentLogger, force: true, adapters: adapterSetOf(typeScriptExtractor, unavailable)}),
			).rejects.toThrow(/is unavailable/iu);
			expect(database.getPublishedGeneration()).toBeNull();
		} finally {
			database.close();
		}
	});
});

describe('required adapter availability and ownership', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('preserves the published generation when a required adapter fails', async () => {
		const workspace = createWorkspace();
		({cleanup} = workspace);
		const config = configOf(workspace, [
			adapterOf('typescript', workspace.root, 'tsconfig.json', 'app'),
			adapterOf('oracle', workspace.root, 'oracle-index.json', 'database'),
		]);
		const database = openDatabase(config);

		try {
			const first = await buildGeneration({config, database, logger: silentLogger, force: true, adapters: testAdaptersFor(config)});
			writeFileSync(join(workspace.root, 'oracle-index.json'), '{not valid json');

			await expect(buildGeneration({config, database, logger: silentLogger, force: true, adapters: testAdaptersFor(config)})).rejects.toThrow(
				/not valid JSON/iu,
			);

			const published = database.getPublishedGeneration();
			expect(published?.id).toBe(first.generationId);
			expect(published?.revision).toBe(1);
			expect(database.getGenerationAdapters(first.generationId)).toHaveLength(2);
		} finally {
			database.close();
		}
	});

	it('rejects two adapters that claim the same authored path', async () => {
		const workspace = createWorkspace();
		({cleanup} = workspace);
		const built: string[] = [];
		const config = configOf(workspace, [
			adapterOf('typescript', workspace.root, 'tsconfig.json', 'app'),
			adapterOf('copy', workspace.root, 'tsconfig.json', 'copy'),
		]);
		const database = openDatabase(config);

		try {
			await expect(
				buildGeneration({
					config,
					database,
					logger: silentLogger,
					force: true,
					adapters: adapterSetOf(wrappedTypeScript('typescript', built), wrappedTypeScript('copy', built)),
				}),
			).rejects.toThrow(/ownership conflict/iu);
			expect(database.getPublishedGeneration()).toBeNull();
		} finally {
			database.close();
		}
	});
});

describe('multi-adapter contract assertions', () => {
	it('rejects identity reused by two adapters with a named collision', () => {
		const first = {adapterId: 'alpha', coverage: 'present' as const, facts: {symbols: [{id: 'symbol-1'}], bindings: []}, dependencies: {edges: []}};
		const second = {adapterId: 'beta', coverage: 'present' as const, facts: {symbols: [{id: 'symbol-1'}], bindings: []}, dependencies: {edges: []}};

		expect(() => {
			assertAdapterIdentity([first, second]);
		}).toThrow(/adapter identity collision: symbol symbol-1 is claimed by alpha and beta/iu);
		expect(() => {
			assertAdapterIdentity([first, {...second, facts: {symbols: [{id: 'symbol-2'}], bindings: []}}]);
		}).not.toThrow();
	});

	it('rejects a path claimed by two extracted file sets', () => {
		const first = {adapterId: 'alpha', files: [{path: 'src/shared.ts'}]};
		const second = {adapterId: 'beta', files: [{path: 'src/shared.ts'}]};

		expect(() => {
			assertSharedExtractedFiles([first, second]);
		}).toThrow(/ownership conflict: src\/shared\.ts is claimed by alpha and beta/iu);
		expect(() => {
			assertSharedExtractedFiles([first, {adapterId: 'beta', files: [{path: 'src/other.ts'}]}]);
		}).not.toThrow();
	});

	it('names the failing adapter in a multi-adapter failure envelope', () => {
		const error = new Error('adapter exploded');

		const failInAdapter = (): void => {
			runAdapterStage('oracle', () => {
				throw error;
			});
		};

		expect(failInAdapter).toThrow('adapter exploded');

		// A multi-adapter build cannot infer the adapter from the plan list, so the
		// annotation is the only source of the failing adapter.
		expect(buildFailureOf(error, 'extraction', null, null)).toMatchObject({adapter: 'oracle', stage: 'extraction'});
	});
});
