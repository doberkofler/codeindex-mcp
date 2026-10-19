import {afterEach, describe, expect, it} from 'vitest';
import {publishedFiles} from '../src/core/generation/publishedFiles.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {createFixtureIndex, type FixtureContextType} from './helpers/fixture.ts';

let fixture: FixtureContextType | undefined;

describe('published files', () => {
	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('returns no files before a generation is published', () => {
		const database = IndexDatabase.open(':memory:');

		try {
			expect(publishedFiles(database, '/workspace')).toStrictEqual([]);
		} finally {
			database.close();
		}
	});

	it('resolves published paths against the workspace root', () => {
		fixture = createFixtureIndex('simple-project');
		const files = publishedFiles(fixture.database, fixture.config.rootDir);

		expect(files.length).toBeGreaterThan(0);
		expect(files.every((file) => file.absolutePath.startsWith(`${fixture?.config.rootDir}/`))).toBe(true);
	});
});
