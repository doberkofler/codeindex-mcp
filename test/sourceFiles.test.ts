import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createVerifiedSourceFileRecord, hashContent} from '../src/core/generation/sourceFiles.ts';

describe('verified source records', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
			directory = undefined;
		}
	});

	it('pairs compiler text with the exact bytes that were read', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-source-'));
		const rootDir = path.join(directory, 'workspace');
		const absolutePath = path.join(rootDir, 'src', 'example.ts');
		const source = 'export const example = 1;\n';
		mkdirSync(path.dirname(absolutePath), {recursive: true});
		writeFileSync(absolutePath, source);

		const record = createVerifiedSourceFileRecord(absolutePath, rootDir, source);

		expect(record).toMatchObject({path: 'src/example.ts', sha256: hashContent(source), lineCount: 2});
	});

	it('accepts a byte-order mark that the compiler strips', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-source-'));
		const rootDir = path.join(directory, 'workspace');
		const absolutePath = path.join(rootDir, 'src', 'example.ts');
		const source = 'export const example = 1;\n';
		mkdirSync(path.dirname(absolutePath), {recursive: true});
		writeFileSync(absolutePath, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(source)]));

		const record = createVerifiedSourceFileRecord(absolutePath, rootDir, source);

		expect(record).toMatchObject({path: 'src/example.ts', lineCount: 2});
	});

	it('rejects content that changed after the compiler read it', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-source-'));
		const rootDir = path.join(directory, 'workspace');
		const absolutePath = path.join(rootDir, 'src', 'example.ts');
		mkdirSync(path.dirname(absolutePath), {recursive: true});
		writeFileSync(absolutePath, 'export const current = 1;\n');

		expect(() => createVerifiedSourceFileRecord(absolutePath, rootDir, 'export const compiler = 1;\n')).toThrow(/Source changed/u);
	});
});
