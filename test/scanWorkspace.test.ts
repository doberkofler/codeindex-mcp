import {appendFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {scanProject} from '../src/adapters/typescript/scanProject.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

describe('scanWorkspace', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('discovers authored files and excludes generated and declaration files', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);

		const scan = scanProject(fixture.config);

		expect(scan.files.map((file) => file.path)).toStrictEqual(['src/index.ts', 'src/models.ts', 'src/summary.ts']);
		expect(scan.excludedFileCount).toBe(2);
		expect(scan.configDiagnosticCount).toBe(0);
	});

	it('produces identical hashes for unchanged source', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);

		const first = scanProject(fixture.config);
		const second = scanProject(fixture.config);

		expect(second.sourceHash).toBe(first.sourceHash);
		expect(second.configHash).toBe(first.configHash);
	});

	it('changes the source hash when file content changes', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);

		const first = scanProject(fixture.config);
		appendFileSync(path.join(fixture.config.rootDir, 'src', 'models.ts'), '\nexport const extra = 1;\n');
		const second = scanProject(fixture.config);

		expect(second.sourceHash).not.toBe(first.sourceHash);
		expect(second.configHash).toBe(first.configHash);
	});

	it('ignores previously indexed paths that no longer exist', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const first = scanProject(fixture.config);
		const deletedPath = 'src/models.ts';
		rmSync(path.join(fixture.config.rootDir, deletedPath));
		const second = scanProject(
			fixture.config,
			first.files.map((file) => file.path),
		);

		expect(first.files.map((file) => file.path)).toContain(deletedPath);
		expect(second.files.map((file) => file.path)).not.toContain(deletedPath);
	});

	it('changes the source hash when an authored file is added', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);

		const first = scanProject(fixture.config);
		appendFileSync(path.join(fixture.config.rootDir, 'src', 'added.ts'), 'export const added = true;\n');
		const second = scanProject(fixture.config);

		expect(second.sourceHash).not.toBe(first.sourceHash);
		expect(second.files).toHaveLength(first.files.length + 1);
	});

	it('detects declared compiler drift and hashes it', () => {
		const fixture = createFixtureConfig('simple-project');
		({cleanup} = fixture);
		const baseline = scanProject(fixture.config);
		writeFileSync(path.join(fixture.config.rootDir, 'package.json'), JSON.stringify({devDependencies: {typescript7: 'npm:typescript@7.0.2'}}));
		const drifted = scanProject(fixture.config);

		expect(drifted.declaredCompilerVersion).toBe('7.0.2');
		expect(drifted.compilerDrift).toBe(true);
		expect(drifted.configHash).not.toBe(baseline.configHash);
	});
});
