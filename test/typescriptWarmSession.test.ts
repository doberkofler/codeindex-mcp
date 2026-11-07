import {appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {disposeTypeScriptSessions, typeScriptWarmSessionMetrics} from '@codeindex/adapter-typescript/internals';
import {createTypeScriptInputSnapshot} from '@codeindex/adapter-typescript/inputSnapshot';
import {buildTypeScriptFacts} from '@codeindex/adapter-typescript/index';
import {scanProject} from '@codeindex/adapter-typescript/scanProject';
import {z} from 'zod';
import {createFixtureConfig} from './helpers/fixture.ts';

const {join} = path;
const DECLARATION_HEAVY_DECLARATIONS = 1000;
const DECLARATION_HEAVY_REFERENCES = 249_001;
const MAX_DECLARATION_HEAVY_REQUESTS = 500;
const TimingDumpSchema = z.object({timing: z.object({totals: z.object({requestCount: z.number().int().nonnegative()})})});

const assertDeclarationHeavyRequestBound = (): void => {
	const {config, cleanup} = createFixtureConfig('simple-project');
	const timingDirectory = join(config.storageDirectory, 'typescript-timing');

	try {
		mkdirSync(timingDirectory, {recursive: true});
		vi.stubEnv('TS_API_TIMING_DIR', timingDirectory);
		const declarations = Array.from({length: DECLARATION_HEAVY_DECLARATIONS}, (_, index) => `export const value${String(index)} = ${String(index)};`).join(
			'\n',
		);
		const references = Array.from({length: DECLARATION_HEAVY_REFERENCES}, (_, index) => `value${String(index % DECLARATION_HEAVY_DECLARATIONS)};`).join('\n');
		writeFileSync(join(config.rootDir, 'src', 'large.ts'), `${declarations}\n${references}\n`, 'utf8');

		const scan = scanProject(config);
		const build = buildTypeScriptFacts(config, scan);
		const timingFile = readdirSync(timingDirectory).at(0);

		expect(build.symbols.filter((symbol) => symbol.path === 'src/large.ts')).toHaveLength(DECLARATION_HEAVY_DECLARATIONS);

		if (timingFile === undefined) {
			throw new Error('TypeScript timing dump was not written');
		}

		const timing = TimingDumpSchema.parse(JSON.parse(readFileSync(join(timingDirectory, timingFile), 'utf8')));
		expect(timing.timing.totals.requestCount).toBeLessThanOrEqual(MAX_DECLARATION_HEAVY_REQUESTS);
	} finally {
		cleanup();
	}
};

describe('TypeScript warm compiler session', () => {
	afterEach(() => {
		disposeTypeScriptSessions();
		vi.unstubAllEnvs();
	});

	it('reuses one session for unchanged and authored-only scans', () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			const before = typeScriptWarmSessionMetrics();
			const first = scanProject(config);
			const afterCreate = typeScriptWarmSessionMetrics();
			const second = scanProject(config);
			const afterReuse = typeScriptWarmSessionMetrics();

			expect(afterCreate.created - before.created).toBe(1);
			expect(afterReuse.reused - afterCreate.reused).toBe(1);
			expect(afterReuse.created - afterCreate.created).toBe(0);
			expect(second.inputHash).toBe(first.inputHash);

			appendFileSync(join(config.rootDir, 'src', 'index.ts'), '\n// warm edit\n', 'utf8');
			const edited = scanProject(config);
			const afterEdit = typeScriptWarmSessionMetrics();

			expect(afterEdit.created - afterReuse.created).toBe(0);
			expect(afterEdit.reused - afterReuse.reused).toBe(1);
			expect(edited.sourceHash).not.toBe(first.sourceHash);

			const {snapshot} = createTypeScriptInputSnapshot(config);
			const sourceText = snapshot.programOf(config.projectFilePath)?.getSourceFile(join(config.rootDir, 'src', 'index.ts'))?.text;

			expect(sourceText).toContain('warm edit');
			snapshot.dispose();
		} finally {
			cleanup();
		}
	});

	it('rebuilds the snapshot when a project file or lockfile changes', () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			scanProject(config);
			const baseline = typeScriptWarmSessionMetrics();

			appendFileSync(join(config.rootDir, 'tsconfig.json'), '\n', 'utf8');
			scanProject(config);
			const afterProjectFile = typeScriptWarmSessionMetrics();

			expect(afterProjectFile.created - baseline.created).toBe(1);
			expect(afterProjectFile.reused - baseline.reused).toBe(0);

			appendFileSync(join(config.rootDir, 'pnpm-lock.yaml'), '\n# lockfile edit\n', 'utf8');
			scanProject(config);
			const afterLockfile = typeScriptWarmSessionMetrics();

			expect(afterLockfile.created - afterProjectFile.created).toBe(1);
			expect(afterLockfile.reused - afterProjectFile.reused).toBe(0);
		} finally {
			cleanup();
		}
	});

	it('evicts an idle session after the configured timeout', async () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			const before = typeScriptWarmSessionMetrics();
			const configured = {...config, extractorOptions: {warmIdleMs: 25}};
			const {snapshot} = createTypeScriptInputSnapshot(configured);

			snapshot.dispose();
			await delay(100);
			const after = typeScriptWarmSessionMetrics();

			expect(after.evicted - before.evicted).toBe(1);
			expect(after.sessions).toBe(0);
		} finally {
			cleanup();
		}
	});

	it('evicts a compiler session when bounded identifier resolution is required', () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			writeFileSync(join(config.rootDir, 'src', 'large.ts'), `const retained = 1;\n${'retained;\n'.repeat(250_000)}`, 'utf8');
			const scan = scanProject(config);
			const before = typeScriptWarmSessionMetrics();

			buildTypeScriptFacts(config, scan);
			const after = typeScriptWarmSessionMetrics();

			expect(after.evicted - before.evicted).toBe(1);
			expect(after.sessions).toBe(0);
		} finally {
			cleanup();
		}
	}, 60_000);

	it('bounds compiler requests for declaration-heavy oversized projects', () => {
		expect.hasAssertions();
		assertDeclarationHeavyRequestBound();
	}, 60_000);
});
