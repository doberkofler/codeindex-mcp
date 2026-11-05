import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, describe, expect, it} from 'vitest';
import {disposeTypeScriptSessions, typeScriptWarmSessionMetrics} from '@codeindex/adapter-typescript/internals';
import {createTypeScriptInputSnapshot} from '@codeindex/adapter-typescript/inputSnapshot';
import {scanProject} from '@codeindex/adapter-typescript/scanProject';
import {createFixtureConfig} from './helpers/fixture.ts';

const {join} = path;

describe('TypeScript warm compiler session', () => {
	afterEach(() => {
		disposeTypeScriptSessions();
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
});
