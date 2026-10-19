import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {computeSourceHash, createSourceFileRecord, createVerifiedSourceFileRecord, hashContent} from '../src/core/generation/sourceFiles.ts';

describe('verified source records', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
			directory = undefined;
		}
	});

	const sourceFile = (bytes: Buffer | string): Readonly<{rootDir: string; absolutePath: string}> => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-source-'));
		const rootDir = path.join(directory, 'workspace');
		const absolutePath = path.join(rootDir, 'src', 'example.ts');
		mkdirSync(path.dirname(absolutePath), {recursive: true});
		writeFileSync(absolutePath, bytes);

		return {rootDir, absolutePath};
	};

	it('pairs compiler text with the exact bytes that were read', () => {
		const source = 'export const example = 1;\n';
		const {rootDir, absolutePath} = sourceFile(source);

		const record = createVerifiedSourceFileRecord(absolutePath, rootDir, source);

		expect(record).toMatchObject({path: 'src/example.ts', sha256: hashContent(source), lineCount: 2});
	});

	it('accepts a byte-order mark that the compiler strips', () => {
		const source = 'export const example = 1;\n';
		const {rootDir, absolutePath} = sourceFile(Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(source)]));

		const record = createVerifiedSourceFileRecord(absolutePath, rootDir, source);

		expect(record).toMatchObject({path: 'src/example.ts', lineCount: 2});
	});

	it.each([
		['UTF-16LE', 255, 254],
		['UTF-16BE', 254, 255],
	])('decodes %s byte-order marks to the compiler text', (_name, first, second) => {
		const source = 'export const example = 1;\n';
		const encoded = Buffer.from(source, 'utf16le');
		const bytes = first === 254 ? Buffer.concat([Buffer.from([first, second]), encoded.swap16()]) : Buffer.concat([Buffer.from([first, second]), encoded]);
		const {rootDir, absolutePath} = sourceFile(bytes);

		const record = createVerifiedSourceFileRecord(absolutePath, rootDir, source);

		expect(record).toMatchObject({path: 'src/example.ts', lineCount: 2});
	});

	it('counts an empty file as zero lines', () => {
		const {rootDir, absolutePath} = sourceFile(Buffer.alloc(0));

		expect(createSourceFileRecord(absolutePath, rootDir)).toMatchObject({path: 'src/example.ts', byteCount: 0, lineCount: 0});
	});

	it('rejects content that changed after the compiler read it', () => {
		const {rootDir, absolutePath} = sourceFile('export const current = 1;\n');

		expect(() => createVerifiedSourceFileRecord(absolutePath, rootDir, 'export const compiler = 1;\n')).toThrow(/Source changed/u);
	});

	it('hashes stable source sets', () => {
		const {rootDir, absolutePath} = sourceFile('export const current = 1;\n');
		const record = createSourceFileRecord(absolutePath, rootDir);

		expect(computeSourceHash([record])).toBe(computeSourceHash([record]));
	});
});
