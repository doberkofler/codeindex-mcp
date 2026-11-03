import {DatabaseSync} from 'node:sqlite';
import {afterAll, describe, expect, it} from 'vitest';
import {createFixtureIndex} from './helpers/fixture.ts';

const partitionFixture = await createFixtureIndex('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

describe('reference partition completeness', () => {
	const fixture = partitionFixture;

	afterAll(() => {
		fixture.cleanup();
	});

	it('reports bounded when a capped file left a symbol without a stored definition', () => {
		const symbol = fixture.index.findSymbols({query: 'HR_API.SAVE_EMPLOYEE', match: 'qualified', exposure: 'visible', limit: 1}).items.at(0);

		if (symbol === undefined) {
			throw new Error('Expected HR_API.SAVE_EMPLOYEE');
		}

		const before = fixture.index.findReferences({symbolId: symbol.symbolId, limit: 100});
		const {generationId} = fixture.index.getStatus();

		expect(before.partition?.completeness).toBe('complete');
		expect(before.definitionsTotal).toBeGreaterThan(0);

		if (generationId === null) {
			throw new Error('Expected a published generation');
		}

		const writer = new DatabaseSync(fixture.config.databasePath);

		try {
			writer.prepare("delete from occurrence where generation_id = ? and symbol_id = ? and role = 'definition'").run(generationId, symbol.symbolId);
		} finally {
			writer.close();
		}

		const after = fixture.index.findReferences({symbolId: symbol.symbolId, limit: 100});

		expect(after.partition).toMatchObject({scope: 'partition', completeness: 'bounded'});
		expect(after.definitionsTotal).toBe(0);
		expect(after.occurrencesTotal).toBe(before.occurrencesTotal - before.definitionsTotal);
	});
});
