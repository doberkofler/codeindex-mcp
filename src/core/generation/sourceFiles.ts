import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {toRepositoryPath} from '../config/config.ts';
import {type SourceFileType} from '../model.ts';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const countLines = (content: string): number => {
	if (content.length === 0) {
		return 0;
	}

	return content.split('\n').length;
};

const decodeSourceBytes = (bytes: Buffer): string => {
	if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
		return bytes.toString('utf8', 3);
	}

	if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) {
		return bytes.toString('utf16le', 2);
	}

	if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) {
		const content = Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)));
		content.swap16();
		return content.toString('utf16le');
	}

	return bytes.toString('utf8');
};

/**
 * Creates one hashed source record for an authored file.
 *
 * @param absolutePath - Absolute authored source path.
 * @param rootDir - Absolute indexed workspace root.
 * @returns The hashed source record.
 */
export const createSourceFileRecord = (absolutePath: string, rootDir: string): SourceFileType => {
	const bytes = readFileSync(absolutePath);
	const content = bytes.toString('utf8');

	return {
		path: toRepositoryPath(rootDir, absolutePath),
		absolutePath,
		sha256: hash(bytes),
		byteCount: bytes.byteLength,
		lineCount: countLines(content),
	};
};

/**
 * Creates a source record whose bytes decode to the exact compiler text.
 *
 * The digest describes the same content the compiler parsed, so AST offsets
 * cannot be paired with a later version of the file.
 *
 * @param absolutePath - Absolute authored source path.
 * @param rootDir - Absolute indexed workspace root.
 * @param compilerText - Source text held by the loaded compiler program.
 * @returns The verified source record.
 * @throws {Error} When the file changed after the compiler read it.
 */
export const createVerifiedSourceFileRecord = (absolutePath: string, rootDir: string, compilerText: string): SourceFileType => {
	const bytes = readFileSync(absolutePath);
	const content = decodeSourceBytes(bytes);
	const path = toRepositoryPath(rootDir, absolutePath);

	if (content !== compilerText) {
		throw new Error(`Source changed during index build: ${path}`);
	}

	return {
		path,
		absolutePath,
		sha256: hash(bytes),
		byteCount: bytes.byteLength,
		lineCount: countLines(content),
	};
};

/**
 * Computes the deterministic source-set hash for a manifest.
 *
 * @param files - Published source records.
 * @returns The hexadecimal source-set hash.
 */
export const computeSourceHash = (files: readonly SourceFileType[]): string =>
	hash(files.map((file) => `${file.path}\u0000${file.sha256}\u0000${file.lineCount}`).join('\n'));

/**
 * Returns the hexadecimal SHA-256 digest of one source string.
 *
 * @param content - Source text read from disk.
 * @returns The content digest.
 */
export const hashContent = (content: string): string => hash(content);
