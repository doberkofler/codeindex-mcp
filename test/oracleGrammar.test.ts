import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterAll, describe, expect, it} from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const checkedInDirectory = path.join(repositoryRoot, 'src', 'adapters', 'oracle', 'generated');
const artifacts = ['PlSqlLexer.ts', 'PlSqlParser.ts', 'PlSqlParserVisitor.ts', 'PlSqlLexerBase.ts', 'PlSqlParserBase.ts'] as const;
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'oracle-grammar-'));

describe('Oracle grammar generation', () => {
	afterAll(() => {
		rmSync(temporaryRoot, {recursive: true, force: true});
	});

	it('reproduces the checked-in parser artifacts byte for byte', () => {
		const result = spawnSync(
			process.execPath,
			['--experimental-strip-types', path.join(repositoryRoot, 'scripts', 'generateOracleGrammar.ts'), temporaryRoot],
			{
				cwd: repositoryRoot,
				encoding: 'utf8',
			},
		);

		expect(result.status).toBe(0);

		for (const artifact of artifacts) {
			const generated = readFileSync(path.join(temporaryRoot, artifact), 'utf8');
			const checkedIn = readFileSync(path.join(checkedInDirectory, artifact), 'utf8');

			expect(generated).toBe(checkedIn);
		}
	}, 60_000);

	it('contains no machine-specific paths or generation timestamps', () => {
		for (const artifact of artifacts) {
			const source = readFileSync(path.join(checkedInDirectory, artifact), 'utf8');

			expect(source).not.toContain(repositoryRoot);
			expect(source).not.toMatch(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
		}
	});
});
