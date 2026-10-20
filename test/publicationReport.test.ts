import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {runPublicationReportCommand} from '../src/core/qualification/publication/publicationCommand.ts';
import {headroomCeilingOf} from '../src/core/qualification/publication/ceilings.ts';
import {type PublicationDiagnosticArtifactType, type PublicationReportType} from '../src/core/qualification/publication/types.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const temporaryDirectories: string[] = [];

const outputDirectory = (): string => {
	const directory = mkdtempSync(path.join(tmpdir(), 'codeindex-publication-report-'));
	temporaryDirectories.push(directory);
	return directory;
};

const capture = (): Readonly<{stdout: string[]; stderr: string[]; io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>}> => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
	};
};

const readReport = (filePath: string): PublicationReportType => JSON.parse(readFileSync(filePath, 'utf8')) as PublicationReportType;

const readDiagnostics = (filePath: string): PublicationDiagnosticArtifactType =>
	JSON.parse(readFileSync(filePath, 'utf8')) as PublicationDiagnosticArtifactType;

const expectMeasuredFacts = (report: PublicationReportType): void => {
	expect(report.schemaVersion).toBe(1);
	expect(report.tool).toBe('publication-report');
	expect(report.facts.symbols).toBeGreaterThan(0);
	expect(report.facts.occurrences).toBeGreaterThan(0);
	expect(report.measurements.m1.status).toBe('measured');
	expect(report.measurements.m2.status).toBe('measured');
	expect(report.measurements.m4.status).toBe('measured');
	expect(report.measurements.m6.status).toBe('measured');
	expect(report.measurements.m7.status).toBe('blocked');
	expect(report.measurements.m13.status).toBe('measured');
	expect(report.measurements.m13.selectedSemantics).toBe('constituent_reachability');
	expect(report.measurements.m14.status).not.toBe('blocked');
	expect(report.measurements.m14.proposedPrecedence.length).toBeGreaterThan(0);
	expect(report.measurements.r1.status).not.toBe('blocked');
	expect(report.measurements.r2.status).toBe('measured');
	expect(report.telemetry.status).toBe('not_collected');
	expect(report.limitations.length).toBeGreaterThan(0);
};

const expectMeasuredProjection = (report: PublicationReportType): void => {
	expect(report.measurements.m11.status).toBe('measured');
	expect(report.measurements.m11.maximumReachabilityStepsPerRoot).toBeGreaterThan(0);
	expect(report.measurements.m11.proposedCeiling).toBeGreaterThanOrEqual(report.measurements.m11.maximumReachabilityStepsPerRoot * 2);
	expect(report.measurements.m11.headroomFactor).toBeGreaterThanOrEqual(2);
	expect(report.measurements.m11.headroomTargetFactor).toBe(2);
	expect(report.measurements.m11.headroomStatus).toBe('computed');
	expect(report.measurements.m12.status).toBe('measured');
	expect(report.measurements.m12.maximumSurfaceBindingsPerRoot).toBeGreaterThan(0);
	expect(report.measurements.m12.proposedCeiling).toBeGreaterThanOrEqual(report.measurements.m12.maximumSurfaceBindingsPerRoot * 2);
	expect(report.measurements.m12.headroomFactor).toBeGreaterThanOrEqual(2);
	expect(report.measurements.m12.headroomTargetFactor).toBe(2);
	expect(report.measurements.m12.headroomStatus).toBe('computed');
};

const runForFixture = async (
	fixtureName: string,
	extractorId: string,
	projectFile: string,
): Promise<Readonly<{report: PublicationReportType; diagnostics: PublicationDiagnosticArtifactType; directory: string}>> => {
	const {config, cleanup} = createFixtureConfig(fixtureName, [{name: 'root', project: projectFile}], extractorId);
	const directory = outputDirectory();
	const reportPath = path.join(directory, 'report.json');
	const diagnosticsPath = path.join(directory, 'diagnostics.json');
	const captured = capture();

	try {
		await expect(
			runPublicationReportCommand(
				[
					'--root',
					config.rootDir,
					'--project-file',
					config.projects[0]?.projectFilePath ?? '',
					'--extractor',
					extractorId,
					'--output',
					reportPath,
					'--diagnostics',
					diagnosticsPath,
				],
				process.env,
				captured.io,
			),
		).resolves.toBe(0);

		expect(captured.stderr).toStrictEqual([]);
		expect(existsSync(reportPath)).toBe(true);
		expect(existsSync(diagnosticsPath)).toBe(true);
		expect(existsSync(config.databasePath)).toBe(false);

		return {report: readReport(reportPath), diagnostics: readDiagnostics(diagnosticsPath), directory};
	} finally {
		cleanup();
	}
};

describe('report-only publication qualification', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('rounds a headroom target up to the smallest 1/2/5 x 10^n ceiling', () => {
		expect(headroomCeilingOf(0)).toBeNull();
		expect(headroomCeilingOf(1)).toBe(2);
		expect(headroomCeilingOf(3)).toBe(10);
		expect(headroomCeilingOf(674)).toBe(2000);
		expect(headroomCeilingOf(13_286)).toBe(50_000);
		expect(headroomCeilingOf(6000)).toBe(20_000);
	});

	it('measures TypeScript facts and runs the independent prototypes without creating an index database', async () => {
		const {report, diagnostics, directory} = await runForFixture('simple-project', 'typescript', 'tsconfig.json');

		expectMeasuredFacts(report);
		expectMeasuredProjection(report);
		expect(report.prototypes.p1).not.toBeNull();
		expect(report.prototypes.p2).not.toBeNull();
		expect(report.prototypes.p3).not.toBeNull();
		expect(report.prototypes.p3?.status).toBe('measured');

		const serialized = JSON.stringify(report);

		expect(serialized).not.toContain(directory);
		expect(serialized).not.toContain('describeUser');
		expect(serialized).not.toContain('src/index.ts');

		for (const group of diagnostics.groups) {
			for (const example of group.examples) {
				expect(example.path.startsWith('/')).toBe(false);
				expect(example.path).not.toContain('..');
			}
		}
	});

	it('measures Oracle pairing facts and leaves prototypes disabled', async () => {
		const {report} = await runForFixture('oracle-publication-project', 'oracle', 'oracle-index.json');

		expect(report.extractor.id).toBe('oracle');
		expect(report.facts.symbols).toBeGreaterThan(0);
		expect(report.measurements.m7.status).toBe('measured');
		expect(report.measurements.m7.routinePairs).toBeGreaterThan(0);
		expect(report.measurements.m7.cursorPairs).toBeGreaterThan(0);
		expect(report.measurements.m7.callSpecs).toBeGreaterThan(0);
		expect(report.measurements.m7.polymorphicTableFunctions).toBeGreaterThan(0);
		expect(report.measurements.m7.bodyForwards).toBeGreaterThan(0);
		expect(report.measurements.m7.bodyLessSpec).toBeGreaterThan(0);
		expect(report.prototypes.p1).toBeNull();
		expect(report.prototypes.p2).toBeNull();
		expect(report.prototypes.p3).toBeNull();
		expect(report.measurements.r2.status).toBe('measured');
		expect(report.measurements.r2.o2.classes).toStrictEqual({});
	});

	it('classifies CommonJS export assignments and JavaScript files', async () => {
		const {report} = await runForFixture('commonjs-project', 'typescript', 'tsconfig.json');

		expect(report.measurements.m2.javascriptFiles).toBeGreaterThan(0);
		expect(report.measurements.m2.commonJsFiles).toBeGreaterThan(0);
		expect(report.prototypes.p2?.commonJsModules).toBeGreaterThan(0);
		expect(report.prototypes.p2?.exportEqualsModules).toBeGreaterThan(0);
		expect(report.prototypes.p2?.exportEqualsIdentifierNames).toBeGreaterThan(0);
	});

	it('reports external alias publication gaps through the compiler export table', async () => {
		const {report} = await runForFixture('external-reexport', 'typescript', 'tsconfig.json');

		expect(report.prototypes.p2).not.toBeNull();
		expect(report.prototypes.p2?.namedExternalAliases).toBeGreaterThan(0);
		expect(report.prototypes.p2?.missingPublishedAliasesByKind).toHaveProperty('named');
	});

	it('passes G-A root-export truth after alias, default, and star publication', async () => {
		const {report} = await runForFixture('publication-project', 'typescript', 'tsconfig.json');

		expect(report.prototypes.p1?.gA).toBe('passed');
		expect(report.prototypes.p1?.missingPublishedRoots).toBe(0);
		expect(report.prototypes.p1?.extraPublishedRoots).toBe(0);
		expect(report.prototypes.p1?.gA2).toBe('passed');
		expect(report.prototypes.p1?.gA2TruthDeclarations).toBe(report.prototypes.p1?.gA2VisibleDeclarations);
		expect(report.prototypes.p1?.gA2MissingDeclarations).toBe(0);
		expect(report.prototypes.p1?.gA2ExtraDeclarations).toBe(0);
		expect(report.prototypes.p2?.missingPublishedAliases).toBe(0);
	});
});
