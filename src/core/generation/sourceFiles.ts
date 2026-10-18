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
