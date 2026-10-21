import {describe, expect, it} from 'vitest';
import {parseOracleUnits} from '../src/adapters/oracle/parseUnits.ts';
import {extractOracleSymbols} from '../src/adapters/oracle/extractSymbols.ts';
import {resolveOracleReferences} from '../src/adapters/oracle/resolveReferences.ts';
import {tokenizeOracleSource} from '../src/adapters/oracle/tokenize.ts';

type ParsedFileType = Readonly<{path: string; parse: ReturnType<typeof parseOracleUnits>}>;

type ResolvedNameType = Readonly<{name: string; usage: number}>;

const parsedFileOf = (name: string, source: string): ParsedFileType => {
	const tokenized = tokenizeOracleSource(source, name);

	return {path: name, parse: parseOracleUnits({tokens: tokenized.tokens, path: name, defaultSchema: 'APP'})};
};

const resolveFiles = (files: readonly ParsedFileType[]): readonly ResolvedNameType[] => {
	const symbols = extractOracleSymbols({projectId: 'p', context: 'APP', files: files.map((file) => ({path: file.path, parse: file.parse}))});
	const references = resolveOracleReferences({context: 'APP', defaultSchema: 'APP', files: symbols.analyses, packages: symbols.packages});

	return references.occurrences.map((occurrence) => ({
		name: (symbols.symbols.find((symbol) => symbol.id === occurrence.symbolId)?.name ?? '').toUpperCase(),
		usage: occurrence.usage ?? 0,
	}));
};

const usagesOf = (occurrences: readonly ResolvedNameType[], name: string): readonly number[] =>
	occurrences.filter((occurrence) => occurrence.name === name).map((occurrence) => occurrence.usage);

describe('Oracle member resolution', () => {
	it('resolves record fields through a local SUBTYPE alias', () => {
		const files = [
			parsedFileOf('types.pks', ['create package types as', '\ttype item_rec is record (bookid number, headerid number);', 'end types;', '/'].join('\n')),
			parsedFileOf(
				'use.pkb',
				[
					'create package body use as',
					'\tsubtype item_typ is types.item_rec;',
					'\tprocedure run(theRec in item_typ) is',
					'\tbegin',
					'\t\tnull;',
					'\t\tx := theRec.bookid;',
					'\tend run;',
					'end use;',
					'/',
				].join('\n'),
			),
		];
		const occurrences = resolveFiles(files);

		expect(usagesOf(occurrences, 'BOOKID')).toStrictEqual([2]);
	});

	it('reconstructs member chains across consecutive index groups', () => {
		const files = [
			parsedFileOf(
				'chain.pks',
				[
					'create package chain as',
					'\ttype task_rec is record (workdate date);',
					'\ttype task_rows is table of task_rec index by pls_integer;',
					'\ttype task_table is table of task_rows index by pls_integer;',
					'end chain;',
					'/',
				].join('\n'),
			),
			parsedFileOf(
				'chain.pkb',
				[
					'create package body chain as',
					'\tprocedure run(theTable in chain.task_table) is',
					'\t\taDate date;',
					'\tbegin',
					'\t\taDate := theTable(1)(2).workdate;',
					'\tend run;',
					'end chain;',
					'/',
				].join('\n'),
			),
		];
		const occurrences = resolveFiles(files);

		expect(usagesOf(occurrences, 'WORKDATE')).toStrictEqual([2]);
	});

	it('treats a forward declaration and its implementation as one callable', () => {
		const files = [
			parsedFileOf(
				'forward.pkb',
				[
					'create package body forward as',
					'\tfunction compute return number;',
					'\tprocedure run is',
					'\t\ta number;',
					'\tbegin',
					'\t\ta := compute;',
					'\tend run;',
					'\tfunction compute return number is',
					'\tbegin',
					'\t\treturn 1;',
					'\tend compute;',
					'end forward;',
					'/',
				].join('\n'),
			),
		];
		const occurrences = resolveFiles(files);

		expect(usagesOf(occurrences, 'COMPUTE')).toStrictEqual([1]);
	});
});

describe('Oracle overload resolution', () => {
	it('discriminates overloads by arity, named arguments, and static argument types', () => {
		const files = [
			parsedFileOf(
				'overloads.pks',
				[
					'create package overloads as',
					'\tprocedure put(theValue in number);',
					'\tprocedure put(theValue in varchar2);',
					'\tprocedure put(theName in varchar2, theValue in number);',
					'\tprocedure put(theName in varchar2, theExtra in varchar2);',
					'end overloads;',
					'/',
				].join('\n'),
			),
			parsedFileOf(
				'overloads.pkb',
				[
					'create package body overloads as',
					'\tprocedure put(theValue in number) is begin null; end put;',
					'\tprocedure put(theValue in varchar2) is begin null; end put;',
					'\tprocedure put(theName in varchar2, theValue in number) is begin null; end put;',
					'\tprocedure put(theName in varchar2, theExtra in varchar2) is begin null; end put;',
					'\tprocedure caller is',
					'\t\taNumber number;',
					'\t\taText varchar2(10);',
					'\tbegin',
					'\t\tput(aNumber);',
					'\t\tput(aText);',
					'\t\tput(theName => aText, theValue => aNumber);',
					'\t\tput(theValue => aText);',
					'\tend caller;',
					'end overloads;',
					'/',
				].join('\n'),
			),
		];
		const occurrences = resolveFiles(files);

		expect(usagesOf(occurrences, 'PUT')).toStrictEqual([1, 1, 1, 1]);
	});

	it('keeps a call ambiguous when no argument disambiguates the overloads', () => {
		const files = [
			parsedFileOf(
				'ambiguous.pks',
				['create package ambiguous as', '\tprocedure put(theValue in number);', '\tprocedure put(theValue in pls_integer);', 'end ambiguous;', '/'].join('\n'),
			),
			parsedFileOf(
				'ambiguous.pkb',
				[
					'create package body ambiguous as',
					'\tprocedure put(theValue in number) is begin null; end put;',
					'\tprocedure put(theValue in pls_integer) is begin null; end put;',
					'\tprocedure caller is',
					'\t\taUnknown unknown_source.value%type;',
					'\tbegin',
					'\t\tput(aUnknown);',
					'\tend caller;',
					'end ambiguous;',
					'/',
				].join('\n'),
			),
		];
		const occurrences = resolveFiles(files);

		expect(usagesOf(occurrences, 'PUT')).toStrictEqual([]);
	});
});

describe('Oracle write and call contexts', () => {
	it('treats indexed assignment targets as writes rather than calls', () => {
		const files = [
			parsedFileOf(
				'indexed.pkb',
				[
					'create package body indexed as',
					'\ttype row_list is table of number index by pls_integer;',
					'\tprocedure run is',
					'\t\taRows row_list;',
					'\tbegin',
					'\t\taRows(1) := 1;',
					'\tend run;',
					'end indexed;',
					'/',
				].join('\n'),
			),
		];
		const occurrences = resolveFiles(files);

		expect(usagesOf(occurrences, 'AROWS')).toStrictEqual([4]);
	});

	it('marks a cursor in a FOR header as a call and keeps SQL constants in a cursor query', () => {
		const files = [
			parsedFileOf('cursor_for.pks', ['create package cursor_for as', '\tk_limit constant number := 10;', 'end cursor_for;', '/'].join('\n')),
			parsedFileOf(
				'cursor_for.pkb',
				[
					'create package body cursor_for as',
					'\tcursor cRows is select jobid from jobs where status = cursor_for.k_limit;',
					'\tprocedure run is',
					'\tbegin',
					'\t\tfor r in cRows loop null; end loop;',
					'\t\tfor i in 1..cursor_for.k_limit loop null; end loop;',
					'\tend run;',
					'end cursor_for;',
					'/',
				].join('\n'),
			),
		];
		const occurrences = resolveFiles(files);

		expect(usagesOf(occurrences, 'CROWS')).toStrictEqual([1]);
		expect(usagesOf(occurrences, 'K_LIMIT')).toStrictEqual([2]);
	});
});
