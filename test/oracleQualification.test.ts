import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {readTruthDependencies} from '../src/core/qualification/oracle/oracleDependencies.ts';
import {
	objectKey,
	objectMapping,
	objectTypeOfPath,
	positionOf,
	sourceTokenMatches,
	type ObjectMappingType,
} from '../src/core/qualification/oracle/oracleMapping.ts';
import {compareFacts, gateOf, readOracleTruth, type CodeOccurrenceType, type PositionedTruthType} from '../src/core/qualification/oracle/oracleTruth.ts';

const {join} = path;
const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(join(tmpdir(), 'code-index-oracle-qualification-'));
	temporaryDirectories.push(directory);
	return directory;
};

const mapping = (overrides: Partial<ObjectMappingType> = {}): ObjectMappingType => ({
	path: 'source.pkg',
	offset: 0,
	columnShift: 0,
	lines: ['package demo is', '  procedure run;', '  value number;'],
	...overrides,
});

const truthRow = (input: Readonly<{name: string; type: string; usage: string; line: number; column: number; signature?: string}>): readonly string[] => [
	'demo',
	'PACKAGE',
	input.name,
	input.signature ?? 'demo',
	input.type,
	input.usage,
	'',
	String(input.line),
	String(input.column),
	'',
];

const removeTemporaryDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

describe('Oracle object mapping', () => {
	afterEach(removeTemporaryDirectories);

	it('maps supported object types and locations', () => {
		const root = temporaryDirectory();
		const sources: Readonly<Record<string, string>> = {
			'package.pkg': 'create or replace editionable package demo is\nend;\n',
			'body.pkb': 'create or replace package body demo is\nend;\n',
			'function.fnc': 'create or replace function demo return number is\nbegin\n\treturn 1;\nend;\n',
			'procedure.prc': 'create or replace procedure demo is\nbegin\n\tnull;\nend;\n',
		};

		for (const [file, source] of Object.entries(sources)) {
			writeFileSync(join(root, file), source);
		}

		expect(objectMapping(root, 'package.pkg', 'PACKAGE', 'demo')).toMatchObject({path: 'package.pkg', offset: 0});
		expect(objectMapping(root, 'body.pkb', 'PACKAGE BODY', 'demo')).toMatchObject({offset: 0});
		expect(objectMapping(root, 'function.fnc', 'FUNCTION', 'DEMO')).toMatchObject({offset: 0});
		expect(objectMapping(root, 'procedure.prc', 'PROCEDURE', 'demo')).toMatchObject({offset: 0});
		expect(objectMapping(root, 'package.pkg', 'PACKAGE', 'demo')).toMatchObject({columnShift: expect.any(Number)});
	});

	it('rejects unsupported or missing objects', () => {
		const root = temporaryDirectory();
		writeFileSync(join(root, 'source.pkg'), 'package other is\nend;\n');

		expect(() => objectMapping(root, 'source.pkg', 'TABLE', 'demo')).toThrow(/Unsupported Oracle object type/u);
		expect(() => objectMapping(root, 'source.pkg', 'PACKAGE', 'demo')).toThrow(/Cannot locate PACKAGE demo/u);
	});

	it('maps positions and compares source tokens', () => {
		const source = mapping();

		expect(objectTypeOfPath('a.PKG')).toBe('PACKAGE');
		expect(objectTypeOfPath('a.pks')).toBe('PACKAGE');
		expect(objectTypeOfPath('a.pkb')).toBe('PACKAGE BODY');
		expect(objectTypeOfPath('a.fnc')).toBe('FUNCTION');
		expect(objectTypeOfPath('a.prc')).toBe('PROCEDURE');
		expect(objectTypeOfPath('a.sql')).toBeNull();
		expect(objectKey('PACKAGE', 'DEMO')).toBe('PACKAGE:demo');
		expect(positionOf(source, 2, 3)).toStrictEqual({path: 'source.pkg', line: 2, column: 3});
		expect(positionOf({...source, offset: 4, columnShift: 2}, 1, 3)).toStrictEqual({path: 'source.pkg', line: 5, column: 5});
		expect(sourceTokenMatches(source, {path: 'source.pkg', line: 1, column: 9}, 'DEMO')).toBe(true);
		expect(sourceTokenMatches(source, {path: 'other.pkg', line: 1, column: 9}, 'demo')).toBe(false);
		expect(sourceTokenMatches(source, {path: 'source.pkg', line: 9, column: 1}, 'demo')).toBe(false);
	});
});

describe('Oracle truth extraction', () => {
	afterEach(removeTemporaryDirectories);

	it('keeps supported declarations and references and counts exclusions', () => {
		const mappings = new Map([[objectKey('PACKAGE', 'demo'), mapping()]]);
		const facts = readOracleTruth({
			rows: [
				truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 9}),
				truthRow({name: 'value', type: 'VARIABLE', usage: 'DECLARATION', line: 3, column: 3}),
				truthRow({name: 'run', type: 'PROCEDURE', usage: 'CALL', line: 2, column: 13}),
				[],
				truthRow({name: 'demo', type: 'PACKAGE', usage: 'REFERENCE', line: 1, column: 9}),
				truthRow({name: 'broken', type: 'UNKNOWN', usage: 'DECLARATION', line: 3, column: 3}),
				truthRow({name: 'ignored', type: 'VARIABLE', usage: 'OTHER', line: 3, column: 3}),
			],
			mappings,
		});

		expect(facts.identifierRows).toBe(6);
		expect(facts.excludedPackageReferences).toBe(1);
		expect(facts.invalidDeclarationRows).toBe(1);
		expect(facts.definitions.size).toBe(2);
		expect(facts.references.size).toBe(1);
	});

	it('ignores rows for unsupported object types and rejects unmapped objects', () => {
		const mappings = new Map([[objectKey('PACKAGE', 'demo'), mapping()]]);
		const unsupportedObject = [...truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 9})];
		unsupportedObject[1] = 'TABLE';

		expect(readOracleTruth({rows: [unsupportedObject], mappings}).identifierRows).toBe(0);
		expect(() => readOracleTruth({rows: [truthRow({name: 'demo', type: 'PACKAGE', usage: 'DECLARATION', line: 1, column: 9})], mappings: new Map()})).toThrow(
			/Cannot map PL\/Scope object/u,
		);
	});

	it('compares supported kinds and bounds disagreement samples', () => {
		const truth = new Map<string, PositionedTruthType>([
			['kept', {path: 'a', line: 1, column: 1, name: 'kept', type: 'VARIABLE'}],
			['missing', {path: 'a', line: 2, column: 1, name: 'missing', type: 'VARIABLE'}],
		]);
		const actual = new Map<string, CodeOccurrenceType>([
			['kept', {path: 'a', line: 1, column: 1, name: 'kept', kind: 'variable'}],
			['extra', {path: 'a', line: 3, column: 1, name: 'extra', kind: 'variable'}],
			['ignored', {path: 'a', line: 4, column: 1, name: 'ignored', kind: 'unsupported'}],
		]);

		expect(compareFacts(truth, actual)).toMatchObject({
			truth: 2,
			actual: 2,
			matched: 1,
			missing: 1,
			extra: 1,
			recall: 0.5,
			precision: 0.5,
		});
		expect(compareFacts(truth, actual).samplesMissing).toStrictEqual([truth.get('missing')]);
		expect(compareFacts(truth, actual).samplesExtra).toStrictEqual([actual.get('extra')]);
		expect(compareFacts(new Map(), new Map())).toMatchObject({recall: 1, precision: 1, missing: 0, extra: 0});
		expect(gateOf({recall: 0.9, precision: 1}, 0.9)).toStrictEqual({ok: true, recall: true, precision: true});
		expect(gateOf({recall: 0.8, precision: 0.9}, 0.9)).toStrictEqual({ok: false, recall: false, precision: false});
	});
});

describe('Oracle truth dependencies', () => {
	afterEach(removeTemporaryDirectories);

	it('keeps supported package edges and skips unsupported rows', () => {
		const mappings = new Map([[objectKey('PACKAGE', 'demo'), mapping()]]);
		const dependencies = readTruthDependencies(
			[
				['demo', 'PACKAGE', '', 'other', 'PACKAGE', ''],
				['demo', 'PACKAGE', '', 'demo', 'PACKAGE', ''],
				['demo', 'PACKAGE', '', 'absent', 'PACKAGE', ''],
				['demo', 'PACKAGE', '', 'other', 'TABLE', ''],
				['demo'],
				['unknown', 'PACKAGE', '', 'other', 'PACKAGE', ''],
			],
			mappings,
			new Set(['other']),
		);

		expect([...dependencies]).toStrictEqual([`source.pkg\u0000other`]);
	});
});
