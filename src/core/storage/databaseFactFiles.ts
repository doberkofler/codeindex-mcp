import {type DatabaseSync} from 'node:sqlite';
import {type SourceFileType} from '../model.ts';
import {type GenerationFactsInputType} from './databaseFactTypes.ts';
import {asString} from './databaseRows.ts';

const FILE_INSERT_SQL = `insert into file (generation_id, path, sha256, content_sha256, line_count)
	 values (?, ?, ?, (select sha256 from content where sha256 = ?), ?)`;

/**
 * Inserts or refreshes every file row of one generation.
 *
 * File identity is version metadata, not a fact group: a revision refreshes it
 * without invalidating the persisted facts of the same path.
 *
 * @param writer - Writer connection inside an open transaction.
 * @param generationId - Generation whose file rows are synchronized.
 * @param files - Current source manifest.
 */
export const syncGenerationFiles = (writer: DatabaseSync, generationId: string, files: readonly SourceFileType[]): void => {
	const existing = new Set(
		writer
			.prepare('select path from file where generation_id = ?')
			.all(generationId)
			.map((row) => asString(row, 'path')),
	);
	const insert = writer.prepare(FILE_INSERT_SQL);
	const update = writer.prepare(
		'update file set sha256 = ?, content_sha256 = (select sha256 from content where sha256 = ?), line_count = ? where generation_id = ? and path = ?',
	);
	const remove = writer.prepare('delete from file where generation_id = ? and path = ?');
	const current = new Set<string>();

	for (const file of files) {
		current.add(file.path);

		try {
			if (existing.has(file.path)) {
				update.run(file.sha256, file.sha256, file.lineCount, generationId, file.path);
			} else {
				insert.run(generationId, file.path, file.sha256, file.sha256, file.lineCount);
			}
		} catch (error) {
			throw new Error(`file row insert failed for ${file.path}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
		}
	}

	for (const path of existing) {
		if (!current.has(path)) {
			remove.run(generationId, path);
		}
	}
};

export const syncProjectContexts = (writer: DatabaseSync, input: GenerationFactsInputType): number => {
	const statement = writer.prepare(
		`insert into project_context (generation_id, name, project_file, config_hash) values (?, ?, ?, ?)
		 on conflict(generation_id, name) do update set project_file = excluded.project_file, config_hash = excluded.config_hash`,
	);
	const remove = writer.prepare('delete from project_context where generation_id = ? and name = ?');
	const existing = new Set(
		writer
			.prepare('select name from project_context where generation_id = ?')
			.all(input.generationId)
			.map((row) => asString(row, 'name')),
	);
	const current = new Set<string>();
	let written = 0;

	for (const project of input.projects) {
		current.add(project.name);
		statement.run(input.generationId, project.name, project.projectFile, project.configHash);
		written += 1;
	}

	for (const name of existing) {
		if (!current.has(name)) {
			remove.run(input.generationId, name);
		}
	}

	return written;
};
