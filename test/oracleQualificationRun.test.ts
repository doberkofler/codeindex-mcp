import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {runOracleQualification} from '../src/core/qualification/oracle/runOracleQualification.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-oracle-run-'));
	temporaryDirectories.push(directory);
	return directory;
};

const environmentOf = (input: Readonly<{rootDir: string; extractorId: string; projectFilePath: string; databasePath: string}>): NodeJS.ProcessEnv => ({
	CODE_INDEX_ROOT: input.rootDir,
	CODE_INDEX_EXTRACTOR: input.extractorId,
	CODE_INDEX_PROJECT_FILE: input.projectFilePath,
	CODE_INDEX_DATABASE: input.databasePath,
	CODE_INDEX_ANALYTICS: 'false',
	CODE_INDEX_LOG_LEVEL: 'error',
});

const capture = (): Readonly<{stdout: string[]; io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>}> => {
	const stdout: string[] = [];

	return {
		stdout,
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: () => {
				// Qualification reports go to stdout; stderr is reserved for command failures.
			},
		},
	};
};

const writeCsv = (directory: string, name: string): string => {
	const filePath = path.join(directory, name);
	writeFileSync(filePath, '', {encoding: 'utf8'});
	return filePath;
};

describe('Oracle qualification run', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('selects the ANTLR parser for qualification', async () => {
		const fixture = createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');
		const outputDirectory = temporaryDirectory();
		const identifiers = writeCsv(outputDirectory, 'identifiers.csv');
		const dependencies = writeCsv(outputDirectory, 'dependencies.csv');
		const captured = capture();

		try {
			const code = await runOracleQualification(
				environmentOf({
					rootDir: fixture.config.rootDir,
					extractorId: 'oracle',
					projectFilePath: fixture.config.projectFilePath,
					databasePath: fixture.config.databasePath,
				}),
				captured.io,
				{identifiers, dependencies, parser: 'antlr'},
			);
			const report = JSON.parse(captured.stdout.join('\n')) as {
				parser: {id: string; compilerVersion: string};
				generationId: string;
				corpus: {files: number; objects: number};
				declarations: {actual: number};
			};

			expect(code).toBe(1);
			expect(report.parser.id).toBe('antlr');
			expect(report.parser.compilerVersion).toContain('parser@antlr');
			expect(report.corpus.files).toBeGreaterThan(5);
			expect(report.declarations.actual).toBeGreaterThan(0);
		} finally {
			fixture.cleanup();
		}
	});

	it('requires both truth exports', async () => {
		const captured = capture();

		await expect(runOracleQualification({}, captured.io, {})).rejects.toThrow(/requires --identifiers and --dependencies/u);
	});

	it('rejects non-Oracle configurations', async () => {
		const fixture = createFixtureConfig('simple-project');
		const captured = capture();

		try {
			await expect(
				runOracleQualification(
					environmentOf({
						rootDir: fixture.config.rootDir,
						extractorId: 'typescript',
						projectFilePath: fixture.config.projectFilePath,
						databasePath: fixture.config.databasePath,
					}),
					captured.io,
					{identifiers: '/tmp/identifiers.csv', dependencies: '/tmp/dependencies.csv'},
				),
			).rejects.toThrow(/requires the oracle extractor/u);
		} finally {
			fixture.cleanup();
		}
	});

	it('uses explicit snapshot units when supplied', async () => {
		const fixture = createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');
		const outputDirectory = temporaryDirectory();
		const identifiers = writeCsv(outputDirectory, 'identifiers.csv');
		const dependencies = writeCsv(outputDirectory, 'dependencies.csv');
		const captured = capture();

		try {
			const code = await runOracleQualification(
				environmentOf({
					rootDir: fixture.config.rootDir,
					extractorId: 'oracle',
					projectFilePath: fixture.config.projectFilePath,
					databasePath: fixture.config.databasePath,
				}),
				captured.io,
				{identifiers, dependencies, units: []},
			);
			const report = JSON.parse(captured.stdout.join('\n')) as {
				corpus: {files: number; objects: number};
			};

			expect(code).toBe(1);
			expect(report.corpus.files).toBeGreaterThan(5);
			expect(report.corpus.objects).toBe(0);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('Oracle qualification report', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('indexes the corpus, writes a report, and fails empty truth gates', async () => {
		const fixture = createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');
		const outputDirectory = temporaryDirectory();
		const identifiers = writeCsv(outputDirectory, 'identifiers.csv');
		const dependencies = writeCsv(outputDirectory, 'dependencies.csv');
		const output = path.join(outputDirectory, 'report.json');
		const captured = capture();

		try {
			const code = await runOracleQualification(
				environmentOf({
					rootDir: fixture.config.rootDir,
					extractorId: 'oracle',
					projectFilePath: fixture.config.projectFilePath,
					databasePath: fixture.config.databasePath,
				}),
				captured.io,
				{identifiers, dependencies, output},
			);

			const report = JSON.parse(captured.stdout.join('\n')) as {
				extractor: string;
				generationId: string;
				contract: {id: string; version: string; hash: string; truthPolicy: string; emptyTruth: string};
				corpus: {files: number; objects: number; sourceHash: string; configHash: string};
				policy: {version: string};
				truth: {
					rows: number;
					invalidDeclarationRows: number;
					excludedPackageReferences: number;
					excludedByReason: Record<string, number>;
					malformedRows: number;
					outOfScopeObjectRows: number;
					includedDeclarations: number;
					includedReferences: number;
					excludedTotal: number;
					identifiersSha256: string;
					dependenciesSha256: string;
					ambiguousOverloadDiagnostics: number;
				};
				declarations: {truth: number; actual: number; recall: number; precision: number};
				referenceStrata: Record<string, {truth: number; actual: number}>;
				dependencies: {truth: number; actual: number; recall: number; precision: number};
				gates: {declarations: {ok: boolean}; ok: boolean};
			};

			expect(code).toBe(1);
			expect(report.extractor).toBe('oracle');
			expect(report.generationId.length).toBeGreaterThan(0);
			expect(report.contract).toMatchObject({id: 'oracle-o1', version: '1', truthPolicy: 'v3', emptyTruth: 'fail'});
			expect(report.contract.hash).toMatch(/^[a-f0-9]{64}$/u);
			expect(report.corpus.files).toBeGreaterThan(5);
			expect(report.corpus.objects).toBeGreaterThan(5);
			expect(report.corpus.sourceHash).toMatch(/^[a-f0-9]+$/u);
			expect(report.corpus.configHash).toMatch(/^[a-f0-9]+$/u);
			expect(report.policy.version).toBe('v3');
			expect(report.truth).toStrictEqual({
				rows: 0,
				invalidDeclarationRows: 0,
				excludedPackageReferences: 0,
				excludedByReason: {
					declaration_initializer: 0,
					duplicate_fact: 0,
					invalid_declaration: 0,
					missing_group_declaration: 0,
					omitted_ambiguous_overload: 0,
					package_reference: 0,
					unmapped_usage: 0,
					unsupported_identifier_type: 0,
				},
				malformedRows: 0,
				outOfScopeObjectRows: 0,
				includedDeclarations: 0,
				includedReferences: 0,
				excludedTotal: 0,
				identifiersSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
				dependenciesSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
				ambiguousOverloadDiagnostics: 0,
			});
			expect(report.declarations).toMatchObject({truth: 0, recall: 1});
			expect(report.declarations.actual).toBeGreaterThan(0);
			expect(Object.keys(report.referenceStrata).sort()).toStrictEqual(['iterator', 'member_chain', 'pragma', 'procedural', 'static_sql', 'type_anchor']);
			expect(report.gates.declarations.ok).toBe(false);
			expect(report.gates.ok).toBe(false);
			expect(readFileSync(output, 'utf8')).toBe(`${captured.stdout.join('\n')}\n`);
		} finally {
			fixture.cleanup();
		}
	});
});
