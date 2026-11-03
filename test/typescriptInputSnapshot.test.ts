import {appendFileSync, cpSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createTypeScriptInputSnapshot} from '@codeindex/adapter-typescript/inputSnapshot';
import {loadTypeScriptProject} from '@codeindex/adapter-typescript/loadProject';
import {scanProject} from '@codeindex/adapter-typescript/scanProject';
import {verifyTypeScriptReferences} from '../src/core/qualification/typescript/verifyReferences.ts';
import {buildGeneration} from '../src/core/generation/buildGeneration.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {testAdaptersFor} from './helpers/adapters.ts';
import {createFixtureConfig, silentLogger} from './helpers/fixture.ts';

const {join} = path;

const prepare = (): Readonly<{config: ReturnType<typeof createFixtureConfig>['config']; cleanup: () => void}> => {
	const fixture = createFixtureConfig('input-manifest');
	cpSync(join(fixture.config.rootDir, 'vendor'), join(fixture.config.rootDir, 'node_modules'), {recursive: true});
	return fixture;
};

const inputMutations = (): readonly (readonly [string, (rootDir: string) => void])[] => [
	[
		'lockfile',
		(rootDir) => {
			appendFileSync(join(rootDir, 'pnpm-lock.yaml'), '\n# edited\n');
		},
	],
	[
		'authored declaration',
		(rootDir) => {
			writeFileSync(join(rootDir, 'src', 'ambient.d.ts'), 'declare const BUILD_ID: number;\n');
		},
	],
	[
		'package exports',
		(rootDir) => {
			writeFileSync(
				join(rootDir, 'node_modules', 'external-package', 'package.json'),
				JSON.stringify({
					name: 'external-package',
					version: '1.0.0',
					types: './lib/index.d.ts',
					exports: {'.': {types: './lib/other.d.ts', default: './lib/index.js'}},
				}),
			);
		},
	],
	[
		'external declaration',
		(rootDir) => {
			writeFileSync(join(rootDir, 'node_modules', 'external-package', 'lib', 'helper.d.ts'), 'export declare const externalValue: number;\n');
		},
	],
	[
		'new declaration target',
		(rootDir) => {
			writeFileSync(join(rootDir, 'src', 'created.d.ts'), 'declare const CREATED: string;\n');
		},
	],
];

describe('TypeScript input manifest', () => {
	it('produces a stable input hash for unchanged inputs', () => {
		const {config, cleanup} = prepare();

		try {
			const first = scanProject(config);
			const second = scanProject(config);

			expect(second.inputHash).toBe(first.inputHash);
			expect(second.inputHash).toMatch(/^[a-f0-9]{64}$/u);
			expect(first.watchInputs?.every((watched) => watched.startsWith(config.rootDir))).toBe(true);
			expect(first.watchInputs?.some((watched) => watched.includes('node_modules'))).toBe(false);
			expect(first.watchInputs).toContain(join(config.rootDir, 'pnpm-lock.yaml'));
			expect(first.watchInputs).not.toContain(join(config.rootDir, 'src', 'main.ts'));
		} finally {
			cleanup();
		}
	});

	it('changes the input hash for lockfile-only, declaration-only, package-exports, and external-declaration edits', () => {
		for (const [label, mutate] of inputMutations()) {
			const {config, cleanup} = prepare();

			try {
				const baseline = scanProject(config).inputHash;

				mutate(config.rootDir);
				expect({label, hash: scanProject(config).inputHash}).not.toStrictEqual({label, hash: baseline});
			} finally {
				cleanup();
			}
		}
	});

	it('invalidates reuse when only a non-authored input changes', async () => {
		const {config, cleanup} = prepare();

		try {
			const database = IndexDatabase.open(config.databasePath, {
				rootDir: config.rootDir,
				projectFilePath: config.projectFilePath,
				projectId: config.projectId,
				extractorId: config.extractorId,
			});

			try {
				const first = await buildGeneration({config, database, logger: silentLogger, adapters: testAdaptersFor(config)});
				const unchanged = await buildGeneration({config, database, logger: silentLogger, adapters: testAdaptersFor(config)});

				expect(first.reused).toBe(false);
				expect(unchanged.reused).toBe(true);

				appendFileSync(join(config.rootDir, 'pnpm-lock.yaml'), '\n# edited\n');
				const lockfileChanged = await buildGeneration({config, database, logger: silentLogger, adapters: testAdaptersFor(config)});

				expect(lockfileChanged.reused).toBe(false);
				expect(lockfileChanged.generationId).toBe(first.generationId);
				expect(lockfileChanged.revision).toBe(first.revision + 1);

				writeFileSync(join(config.rootDir, 'src', 'ambient.d.ts'), 'declare const BUILD_ID: number;\n');
				const declarationChanged = await buildGeneration({config, database, logger: silentLogger, adapters: testAdaptersFor(config)});

				expect(declarationChanged.reused).toBe(false);
				expect(declarationChanged.revision).toBe(lockfileChanged.revision + 1);
			} finally {
				database.close();
			}
		} finally {
			cleanup();
		}
	});

	it('resolves a symlinked package to the same canonical path in extraction and verification', () => {
		const {config, cleanup} = createFixtureConfig('input-manifest');

		try {
			const store = join(config.rootDir, 'store', 'external-package');
			mkdirSync(join(config.rootDir, 'store'), {recursive: true});
			mkdirSync(join(config.rootDir, 'node_modules'), {recursive: true});
			renameSync(join(config.rootDir, 'vendor', 'external-package'), store);
			symlinkSync(store, join(config.rootDir, 'node_modules', 'external-package'), 'dir');

			const {snapshot} = createTypeScriptInputSnapshot(config);
			const loaded = loadTypeScriptProject(config, config.projectFilePath, snapshot);
			const canonicalHelper = realpathSync(join(store, 'lib', 'helper.d.ts'));
			const helper = loaded.program.getSourceFiles().find((sourceFile) => sourceFile.fileName.endsWith('helper.d.ts'));

			expect(helper?.fileName).toBe(canonicalHelper);
			expect(scanProject(config).inputHash).toBe(snapshot.manifest.inputHash);
			expect(() => verifyTypeScriptReferences(config)).not.toThrow();
		} finally {
			cleanup();
		}
	});
});
