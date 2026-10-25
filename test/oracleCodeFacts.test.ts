import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {loadAmbiguousOverloadSites, loadCodeDependencies, loadCodeFacts} from '../src/core/qualification/oracle/oracleCodeFacts.ts';

let database: DatabaseSync;

describe('Oracle code facts', () => {
	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		database.exec(`
			create table symbol (
				generation_id text not null,
				id text not null,
				name text not null,
				kind text not null,
				path text not null,
				start_line integer not null,
				start_column integer not null
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
			create table diagnostic (
				generation_id text not null,
				code integer not null,
				path text,
				start_line integer,
				start_column integer
			);
		`);
	});

	afterEach(() => {
		database.close();
	});

	it('loads definitions and references for one generation', () => {
		database.exec(`
			insert into symbol values ('generation', 'symbol-1', 'Run', 'procedure', 'src/demo.pkb', 2, 13);
			insert into symbol values ('generation', 'symbol-2', 'Value', 'variable', 'src/demo.pkb', 3, 3);
			insert into symbol values ('other', 'symbol-3', 'Ignored', 'variable', 'src/other.pkb', 1, 1);
			insert into occurrence values ('generation', 'symbol-1', 'src/demo.pkb', 2, 13, 'definition');
			insert into occurrence values ('generation', 'symbol-2', 'src/demo.pkb', 3, 3, 'reference');
			insert into occurrence values ('other', 'symbol-3', 'src/other.pkb', 1, 1, 'definition');
		`);

		const facts = loadCodeFacts(database, 'generation');

		expect([...facts.definitions.values()]).toStrictEqual([
			{path: 'src/demo.pkb', line: 2, column: 13, name: 'Run', kind: 'procedure', symbolPath: 'src/demo.pkb', symbolLine: 2, symbolColumn: 13},
		]);
		expect([...facts.references.values()]).toStrictEqual([
			{path: 'src/demo.pkb', line: 3, column: 3, name: 'Value', kind: 'variable', symbolPath: 'src/demo.pkb', symbolLine: 3, symbolColumn: 3},
		]);
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

	it('loads ambiguous-overload positions for one generation only', () => {
		database.exec(`
			insert into diagnostic values ('generation', 9105, 'src/demo.pkb', 4, 7);
			insert into diagnostic values ('generation', 9102, 'src/demo.pkb', 5, 1);
			insert into diagnostic values ('other', 9105, 'src/other.pkb', 1, 1);
			insert into diagnostic values ('generation', 9105, null, 6, 1);
		`);

		expect([...loadAmbiguousOverloadSites(database, 'generation')]).toStrictEqual(['src/demo.pkb:4:7']);
	});
});
