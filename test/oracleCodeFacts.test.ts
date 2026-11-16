import {DatabaseSync} from 'node:sqlite';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {loadAmbiguousOverloadSites, loadCodeDependencies, loadCodeFacts} from '@codeindex/adapter-oracle-tools/oracleCodeFacts';

let database: DatabaseSync;

const createCodeFactsDatabase = (): DatabaseSync => {
	const created = new DatabaseSync(':memory:');
	created.exec(`
			create table generation (
				generation_key integer primary key,
				id text not null unique
			);
			create table file (
				file_key integer primary key,
				generation_key integer not null,
				path text not null
			);
			create table symbol (
				symbol_key integer primary key,
				generation_key integer not null,
				id text not null,
				name text not null,
				kind text not null,
				file_key integer not null,
				start_line integer not null,
				start_column integer not null
			);
			create table occurrence (
				generation_key integer not null,
				symbol_key integer not null,
				file_key integer not null,
				start_line integer not null,
				start_column integer not null,
				role text not null
			);
			create table dependency_edge (
				generation_key integer not null,
				source_file_key integer not null,
				target_identifier text,
				kind text not null
			);
			create table diagnostic (
				generation_key integer not null,
				code integer not null,
				file_key integer,
				fallback_path text,
				start_line integer,
				start_column integer
			);
			insert into generation values (1, 'generation');
			insert into generation values (2, 'other');
			insert into file values (1, 1, 'src/demo.pkb');
			insert into file values (2, 1, 'src/self.pkb');
			insert into file values (3, 1, 'src/missing.pkb');
			insert into file values (4, 1, 'src/ignored.pkb');
			insert into file values (5, 2, 'src/other.pkb');
		`);

	return created;
};

describe('Oracle code facts', () => {
	beforeEach(() => {
		database = createCodeFactsDatabase();
	});

	afterEach(() => {
		database.close();
	});

	it('loads definitions and references for one generation', () => {
		database.exec(`
			insert into symbol values (1, 1, 'symbol-1', 'Run', 'procedure', 1, 2, 13);
			insert into symbol values (2, 1, 'symbol-2', 'Value', 'variable', 1, 3, 3);
			insert into symbol values (3, 2, 'symbol-3', 'Ignored', 'variable', 5, 1, 1);
			insert into occurrence values (1, 1, 1, 2, 13, 'definition');
			insert into occurrence values (1, 2, 1, 3, 3, 'reference');
			insert into occurrence values (2, 3, 5, 1, 1, 'definition');
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
			insert into dependency_edge values (1, 1, 'schema.other_pkg', 'package-call');
			insert into dependency_edge values (1, 2, 'schema.self_pkg', 'package-reference');
			insert into dependency_edge values (1, 3, 'schema.absent_pkg', 'type-reference');
			insert into dependency_edge values (1, 4, 'schema.other_pkg', 'type-reference');
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
			insert into diagnostic values (1, 9105, 1, null, 4, 7);
			insert into diagnostic values (1, 9102, 1, null, 5, 1);
			insert into diagnostic values (2, 9105, 5, null, 1, 1);
			insert into diagnostic values (1, 9105, null, 'tsconfig.json', 6, 1);
			insert into diagnostic values (1, 9105, null, null, 7, 1);
		`);

		expect([...loadAmbiguousOverloadSites(database, 'generation')]).toStrictEqual(['src/demo.pkb:4:7', 'tsconfig.json:6:1']);
	});
});
