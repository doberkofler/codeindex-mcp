import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {loadCodeDependencies, loadCodeFacts} from '../src/core/qualification/oracle/oracleCodeFacts.ts';

let database: DatabaseSync;

describe('Oracle code facts', () => {
	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		database.exec(`
			create table symbol (
				generation_id text not null,
				id text not null,
				name text not null,
				kind text not null
			);
			create table occurrence (
				generation_id text not null,
				symbol_id text not null,
				path text not null,
				start_line integer not null,
				start_column integer not null,
				role text not null
			);
			create table dependency_edge (
				generation_id text not null,
				source_path text not null,
				target_identifier text,
				kind text not null
			);
		`);
	});

	afterEach(() => {
		database.close();
	});

	it('loads definitions and references for one generation', () => {
		database.exec(`
			insert into symbol values ('generation', 'symbol-1', 'Run', 'procedure');
			insert into symbol values ('generation', 'symbol-2', 'Value', 'variable');
			insert into symbol values ('other', 'symbol-3', 'Ignored', 'variable');
			insert into occurrence values ('generation', 'symbol-1', 'src/demo.pkb', 2, 13, 'definition');
			insert into occurrence values ('generation', 'symbol-2', 'src/demo.pkb', 3, 3, 'reference');
			insert into occurrence values ('other', 'symbol-3', 'src/other.pkb', 1, 1, 'definition');
		`);

		const facts = loadCodeFacts(database, 'generation');

		expect([...facts.definitions.values()]).toStrictEqual([{path: 'src/demo.pkb', line: 2, column: 13, name: 'Run', kind: 'procedure'}]);
		expect([...facts.references.values()]).toStrictEqual([{path: 'src/demo.pkb', line: 3, column: 3, name: 'Value', kind: 'variable'}]);
		expect(facts.definitions.has('src/demo.pkb:2:13:run')).toBe(true);
	});

	it('keeps dependency edges that target another corpus package', () => {
		database.exec(`
			insert into dependency_edge values ('generation', 'src/demo.pkb', 'schema.other_pkg', 'package-call');
			insert into dependency_edge values ('generation', 'src/self.pkb', 'schema.self_pkg', 'package-reference');
			insert into dependency_edge values ('generation', 'src/missing.pkb', 'schema.absent_pkg', 'type-reference');
			insert into dependency_edge values ('generation', 'src/ignored.pkb', 'schema.other_pkg', 'type-reference');
		`);

		const dependencies = loadCodeDependencies(
			database,
			'generation',
			new Set(['other_pkg', 'self_pkg', 'absent_pkg']),
			new Map([
				['src/demo.pkb', 'demo_pkg'],
				['src/self.pkb', 'self_pkg'],
				['src/ignored.pkb', 'ignored_pkg'],
			]),
		);

		expect([...dependencies]).toStrictEqual(['src/demo.pkb\u0000other_pkg', 'src/missing.pkb\u0000absent_pkg', 'src/ignored.pkb\u0000other_pkg']);
	});
});
