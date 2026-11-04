import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadAdaptersFromDescriptors, loadConfiguredAdapters} from '../src/adapters/loader.ts';
import {type AdapterConfigType, type ConfigType} from '../src/core/config/config.ts';

const {join} = path;

type FixtureType = Readonly<{root: string; config: ConfigType; cleanup: () => void}>;

const adapterModule = (input: Readonly<{id: string; protocolVersion?: number; version?: string}>): string => `
let created = 0;

export const codeIndexAdapter = {
	manifest: {
		protocolVersion: ${String(input.protocolVersion ?? 1)},
		id: '${input.id}',
		implementationVersion: '${input.version ?? '1.0.0'}',
		displayName: 'Fixture ${input.id}',
	},
	create: () => {
		created += 1;
		return {
			id: '${input.id}',
			version: '${input.version ?? '1.0.0'}',
			displayName: 'Fixture ${input.id}',
			discoveryText: 'fixture',
			sourceExtensions: ['.fixture'],
			ignoredSegments: [],
			limitations: [],
			scan: () => ({rootDir: '', projectId: '', extractorId: '${input.id}', extractorVersion: '${input.version ?? '1.0.0'}', compilerVersion: 'none', declaredCompilerVersion: null, compilerDrift: false, files: [], sourceHash: '', configHash: '', projects: [], projectFileCount: 0, excludedFileCount: 0, configDiagnosticCount: 0, scanMs: 0}),
			build: () => ({files: [], symbols: [], bindings: [], bindingContexts: [], bindingSites: [], surfaceOrigins: [], occurrences: [], dependencies: {edges: [], bindings: []}, adapterStats: [], diagnostics: [], compilerMs: 0, extractionMs: 0}),
			configFiles: () => [],
			isSourceFile: () => true,
		};
	},
};

export const createdCount = () => created;
`;

const configuredAdapter = (id: string, module: string): AdapterConfigType => ({
	id,
	required: true,
	module,
	options: {},
	projectFilePath: join('/workspace', 'project.json'),
	projects: [{name: 'root', projectFilePath: join('/workspace', 'project.json')}],
});

const createFixture = (modules: Readonly<Record<string, string>>, specs: readonly (readonly [string, string])[]): FixtureType => {
	const root = mkdtempSync(join(tmpdir(), 'codeindex-loader-'));
	mkdirSync(join(root, 'node_modules'), {recursive: true});

	for (const [fileName, source] of Object.entries(modules)) {
		const filePath = join(root, fileName);
		mkdirSync(path.dirname(filePath), {recursive: true});
		writeFileSync(filePath, source);
	}

	const adapters = specs.map(([id, module]) => configuredAdapter(id, module));
	const config: ConfigType = {
		projectName: 'loader-fixture',
		rootDir: root,
		adapters,
		extractorId: adapters[0]?.id ?? 'fixture',
		extractorOptions: {},
		projectFilePath: '/workspace/project.json',
		projects: [],
		storageDirectory: root,
		databasePath: join(root, 'index.sqlite'),
		analyticsEnabled: false,
		analyticsPath: join(root, 'events.jsonl'),
		maxResultBytes: 32_768,
		maxReadLines: 200,
		semanticDiagnostics: false,
		freshnessDebounceMs: 1000,
		projectId: 'loader-fixture',
		logLevel: 'error',
		configPath: join(root, 'codeindex.config.json'),
	};

	return {
		root,
		config,
		cleanup: () => {
			rmSync(root, {recursive: true, force: true});
		},
	};
};

describe('adapter loader', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	const fixture = (...args: Parameters<typeof createFixture>): FixtureType => {
		const created = createFixture(...args);
		const {cleanup: remove} = created;
		cleanup = remove;
		return created;
	};

	it('resolves a relative module from the configuration directory', async () => {
		const {config} = fixture({'adapter.mjs': adapterModule({id: 'fixture'})}, [['fixture', './adapter.mjs']]);

		const loaded = await loadConfiguredAdapters(config);

		expect(loaded.adapters.map((adapter) => adapter.id)).toStrictEqual(['fixture']);
		expect(loaded.descriptors[0]).toMatchObject({id: 'fixture', protocolVersion: 1, implementationVersion: '1.0.0'});
	});

	it('resolves a bare package from the configuration location', async () => {
		const {config} = fixture(
			{
				'node_modules/fixture-adapter/package.json': JSON.stringify({name: 'fixture-adapter', version: '2.0.0', type: 'module', main: './index.mjs'}),
				'node_modules/fixture-adapter/index.mjs': adapterModule({id: 'fixture'}),
			},
			[['fixture', 'fixture-adapter']],
		);

		const loaded = await loadConfiguredAdapters(config);

		expect(loaded.descriptors[0]).toMatchObject({id: 'fixture', packageVersion: '2.0.0'});
	});

	it('fails before scanning when a module is missing', async () => {
		const {config} = fixture({}, [['fixture', 'missing-adapter']]);

		await expect(loadConfiguredAdapters(config)).rejects.toMatchObject({code: 'adapter_module_not_found'});
	});

	it('rejects an invalid module export without leaking an absolute path', async () => {
		const {config, root} = fixture({'adapter.mjs': 'export const other = 1;\n'}, [['fixture', './adapter.mjs']]);

		const error: unknown = await loadConfiguredAdapters(config).then(
			() => null,
			(error_: unknown) => error_,
		);

		expect(error).toMatchObject({code: 'adapter_module_invalid'});
		expect(error instanceof Error ? error.message : '').not.toContain(root);
	});

	it('rejects an unsupported protocol and an id mismatch', async () => {
		const unsupported = fixture({'adapter.mjs': adapterModule({id: 'fixture', protocolVersion: 9})}, [['fixture', './adapter.mjs']]);
		await expect(loadConfiguredAdapters(unsupported.config)).rejects.toMatchObject({code: 'adapter_protocol_unsupported'});
		cleanup?.();
		cleanup = undefined;

		const mismatch = fixture({'adapter.mjs': adapterModule({id: 'other'})}, [['fixture', './adapter.mjs']]);
		await expect(loadConfiguredAdapters(mismatch.config)).rejects.toMatchObject({code: 'adapter_id_mismatch'});
	});

	it('rejects one module configured for two adapter ids', async () => {
		const {config} = fixture({'adapter.mjs': adapterModule({id: 'first'})}, [
			['first', './adapter.mjs'],
			['second', './adapter.mjs'],
		]);

		await expect(loadConfiguredAdapters(config)).rejects.toMatchObject({code: 'adapter_module_duplicate'});
	});

	it('caches the import but creates a fresh adapter per load', async () => {
		const {config} = fixture({'adapter.mjs': adapterModule({id: 'fixture'})}, [['fixture', './adapter.mjs']]);

		const first = await loadConfiguredAdapters(config);
		const second = await loadConfiguredAdapters(config);

		expect(first.adapters[0]).not.toBe(second.adapters[0]);

		const reloaded = await loadAdaptersFromDescriptors(first.descriptors);
		expect(reloaded.adapters[0]?.id).toBe('fixture');
	});

	it('rejects worker descriptors whose identity drifted', async () => {
		const {config} = fixture({'adapter.mjs': adapterModule({id: 'fixture'})}, [['fixture', './adapter.mjs']]);
		const loaded = await loadConfiguredAdapters(config);
		const descriptor = loaded.descriptors.at(0);

		if (descriptor === undefined) {
			throw new Error('Expected a descriptor');
		}

		await expect(loadAdaptersFromDescriptors([{...descriptor, implementationVersion: '9.9.9'}])).rejects.toMatchObject({
			code: 'adapter_version_mismatch',
		});
	});
});
