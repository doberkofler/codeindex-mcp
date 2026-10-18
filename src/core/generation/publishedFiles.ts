import path from 'node:path';
import {type IndexDatabase} from '../storage/database.ts';

/**
 * Resolves the files in the published generation to absolute paths.
 *
 * @param database - Open index database.
 * @param rootDir - Absolute workspace root.
 * @returns Published files, or an empty list when nothing is published.
 */
export const publishedFiles = (database: IndexDatabase, rootDir: string): readonly Readonly<{absolutePath: string}>[] => {
	const published = database.getPublishedGeneration();

	if (published === null) {
		return [];
	}

	return database.listFiles(published.id).map((file) => ({absolutePath: path.resolve(rootDir, file.path)}));
};
