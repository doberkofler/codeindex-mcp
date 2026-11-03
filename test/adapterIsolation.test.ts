import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const FORBIDDEN_IMPORTS = ['core/storage', 'core/query', 'core/generation', 'core/facts', 'core/config', 'core/model'];

const sourceFilesOf = (root: string): readonly string[] =>
	readdirSync(root, {withFileTypes: true}).flatMap((entry) => {
		const full = path.join(root, entry.name);

		return entry.isDirectory() ? sourceFilesOf(full) : entry.name.endsWith('.ts') ? [full] : [];
	});

describe('adapter package isolation', () => {
	it('keeps the host runtime graph free of language dependencies', () => {
		const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {dependencies: Readonly<Record<string, string>>};

		for (const name of ['typescript', 'antlr4ng', 'oracledb', '@codeindex/adapter-typescript', '@codeindex/adapter-oracle']) {
			expect(manifest.dependencies).not.toHaveProperty(name);
		}
	});

	it('keeps official adapters free of host storage and query imports', () => {
		for (const packageName of ['adapter-typescript', 'adapter-oracle']) {
			for (const file of sourceFilesOf(path.join(repositoryRoot, 'packages', packageName, 'src'))) {
				const source = readFileSync(file, 'utf8');

				for (const forbidden of FORBIDDEN_IMPORTS) {
					expect(source).not.toContain(forbidden);
				}
			}
		}
	});
});
