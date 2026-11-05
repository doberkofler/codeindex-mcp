import {mkdirSync, symlinkSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {buildTypeScriptFacts} from '@codeindex/adapter-typescript/index';
import {createTypeScriptInputSnapshot} from '@codeindex/adapter-typescript/inputSnapshot';
import {loadTypeScriptProject} from '@codeindex/adapter-typescript/loadProject';
import {scanProject} from '@codeindex/adapter-typescript/scanProject';
import {createFixtureConfig} from './helpers/fixture.ts';

const {join} = path;

const prepare = (): Readonly<{config: ReturnType<typeof createFixtureConfig>['config']; cleanup: () => void}> => {
	const fixture = createFixtureConfig('typescript-types', [{name: 'periscope', project: 'periscope/tsconfig.json'}]);
	const projectDirectory = join(fixture.config.rootDir, 'periscope');

	mkdirSync(join(projectDirectory, 'node_modules'));
	// pnpm stores the package once and links it into the importing project.
	symlinkSync(join('..', 'store', 'vite'), join(projectDirectory, 'node_modules', 'vite'), 'dir');

	return fixture;
};

describe('TypeScript project type resolution', () => {
	it('resolves a symlinked types entry from the project directory and reports only the missing type', () => {
		const {config, cleanup} = prepare();

		try {
			const scan = scanProject(config);
			const built = buildTypeScriptFacts(config, scan);

			expect(built.diagnostics).toHaveLength(1);
			expect(built.diagnostics[0]).toMatchObject({
				category: 'error',
				code: 2688,
				path: 'periscope/tsconfig.json',
			});
			expect(built.diagnostics[0]?.message).toContain('missing-types');
			expect(built.diagnostics[0]?.message).not.toContain('vite/client');
		} finally {
			cleanup();
		}
	});

	it('resolves the same project with and without a captured input snapshot', () => {
		const {config, cleanup} = prepare();

		try {
			const direct = loadTypeScriptProject(config);

			try {
				const {snapshot} = createTypeScriptInputSnapshot(config);

				try {
					const captured = loadTypeScriptProject(config, config.projectFilePath, snapshot);

					try {
						expect(direct.diagnostics).toHaveLength(1);
						expect(captured.diagnostics).toStrictEqual(direct.diagnostics);
						expect(captured.diagnostics[0]).toMatchObject({code: 2688, path: 'periscope/tsconfig.json'});
					} finally {
						captured.dispose();
					}
				} finally {
					snapshot.dispose();
				}
			} finally {
				direct.dispose();
			}
		} finally {
			cleanup();
		}
	});
});
