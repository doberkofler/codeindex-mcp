import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {referenceCoverageQuery} from '../src/core/storage/databasePublicationQueries.ts';
import {explainQueryPlan} from '../src/core/storage/databaseOpen.ts';
import {scopedFactIdOf} from '../src/core/storage/factIdentity.ts';
import {publishNewGeneration} from './helpers/statistics.ts';

describe('reference coverage query plan', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	it('looks up occurrences by symbol key instead of scanning generation indexes', () => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-reference-plan-'));
		const databasePath = path.join(directory, 'index.sqlite');
		const generationId = 'generation-1';
		const symbolId = scopedFactIdOf('typescript', 'symbol-0');

		publishNewGeneration(databasePath, generationId, 1200);
		const reader = new DatabaseSync(databasePath, {readOnly: true});

		try {
			const coverage = referenceCoverageQuery({
				generationId,
				symbolId,
				filters: {generationId, symbolId},
			});
			const plan = explainQueryPlan(reader, coverage.sql, coverage.parameters);
			const planText = plan.join('\n');

			expect(plan.filter((line) => line.includes('SEARCH o USING INDEX sqlite_autoindex_occurrence_1 (symbol_key=?)'))).toHaveLength(2);
			expect(planText).not.toContain('occurrence_by_path');
			expect(planText).not.toContain('occurrence_by_enclosing');
		} finally {
			reader.close();
		}
	});
});
