import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {build} from 'vite';

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '../../..');
const outDir = path.join(here, '../.work/typescript-bundle');

mkdirSync(outDir, {recursive: true});

await build({
	configFile: false,
	root: repoRoot,
	logLevel: 'error',
	build: {
		emptyOutDir: true,
		target: 'node26',
		minify: false,
		outDir,
		lib: {
			entry: path.join(here, 'harness.mjs'),
			fileName: () => 'harness.mjs',
			formats: ['es'],
		},
		rollupOptions: {external: ['antlr4ng', 'node:fs', 'node:path']},
	},
});
