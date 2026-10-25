import {existsSync, readFileSync} from 'node:fs';
import {cp, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {indexRootDirectory} from '../src/core/config/config.ts';
import {preflightOracleEvidenceBundle} from '../src/core/qualification/oracle/live/oracleEvidenceBundle.ts';
import {runQualifyCommand} from '../src/core/qualification/qualifyCommand.ts';

const DESCRIPTOR_PATH = 'benchmark/oracle-controlled/corpus.json';

const DescriptorSchema = z.object({
	evidence: z.object({externalRoot: z.string().min(1), snapshotDir: z.string().min(1)}),
	snapshot: z.object({sourceHash: z.string().min(1), fileCount: z.number().int().positive()}),
});

const ReportSchema = z.object({
	extractor: z.literal('oracle'),
	contract: z.object({id: z.literal('oracle-o1'), version: z.string(), truthPolicy: z.string()}),
	corpus: z.object({files: z.number().int(), sourceHash: z.string()}),
	truth: z.object({excludedByReason: z.record(z.string(), z.number())}),
	declarations: z.object({truth: z.number().int(), matched: z.number().int()}),
	references: z.object({truth: z.number().int(), matched: z.number().int()}),
	dependencies: z.object({truth: z.number().int(), matched: z.number().int()}),
	gates: z.object({ok: z.boolean()}),
});

type DescriptorType = z.infer<typeof DescriptorSchema>;

const descriptorOf = (descriptorPath: string): DescriptorType => DescriptorSchema.parse(JSON.parse(readFileSync(descriptorPath, 'utf8')));

const evidenceRootOf = (descriptor: DescriptorType): string =>
	path.join(process.env['CODEINDEX_EVIDENCE_ROOT'] ?? indexRootDirectory(), descriptor.evidence.externalRoot);

const descriptor = descriptorOf(DESCRIPTOR_PATH);
const evidenceRoot = evidenceRootOf(descriptor);
const snapshotSource = path.join(evidenceRoot, descriptor.evidence.snapshotDir);
const available = existsSync(path.join(evidenceRoot, 'plan.json')) && existsSync(snapshotSource);
const required = process.env['CODE_INDEX_ORACLE_BUNDLE_REQUIRED'] === '1';

describe('Oracle controlled bundle availability', () => {
	it('retains the frozen bundle when the bundle tier is selected', () => {
		if (!required) {
			return;
		}

		if (!available) {
			throw new Error(`The bundle tier requires the retained evidence root at ${evidenceRoot}.`);
		}

		expect(available).toBe(true);
	});
});

describe.skipIf(!available)('Oracle controlled bundle replay', () => {
	const workDirectory = {path: ''};

	afterAll(async () => {
		if (workDirectory.path !== '') {
			await rm(workDirectory.path, {recursive: true, force: true});
		}
	});

	it('reproduces every O1 gate from retained truth without a database', async () => {
		workDirectory.path = await mkdtemp(path.join(tmpdir(), 'codeindex-oracle-replay-'));
		const snapshot = path.join(workDirectory.path, 'workspace');
		const database = path.join(workDirectory.path, 'index.sqlite');
		const reportPath = path.join(workDirectory.path, 'report.json');
		const stdout: string[] = [];
		const stderr: string[] = [];
		const environment = {HOME: process.env['HOME'] ?? '', PATH: process.env['PATH'] ?? '', CODE_INDEX_LOG_LEVEL: 'error'};

		await cp(snapshotSource, snapshot, {recursive: true});

		const preflight = await preflightOracleEvidenceBundle(environment, {descriptorPath: DESCRIPTOR_PATH});

		if (!preflight.ok) {
			throw new Error(
				`Bundle preflight failed: ${preflight.identities
					.filter((identity) => identity.status !== 'ok')
					.map((identity) => identity.name)
					.join(', ')}`,
			);
		}

		expect(preflight.ok).toBe(true);

		const code = await runQualifyCommand(
			[
				'--extractor',
				'oracle',
				'--root',
				snapshot,
				'--project-file',
				path.join(snapshot, 'oracle-index.json'),
				'--database',
				database,
				'--identifiers',
				path.join(evidenceRoot, 'user-identifiers.csv'),
				'--dependencies',
				path.join(evidenceRoot, 'user-dependencies.csv'),
				'--units',
				path.join(evidenceRoot, 'plan.json'),
				'--output',
				reportPath,
			],
			environment,
			{
				stdout: (line) => {
					stdout.push(line);
				},
				stderr: (line) => {
					stderr.push(line);
				},
			},
		);

		expect(stderr).toStrictEqual([]);
		expect(code).toBe(0);

		const report = ReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));

		expect(report.contract).toMatchObject({id: 'oracle-o1', version: '2', truthPolicy: 'v4'});
		expect(report.corpus.files).toBe(descriptor.snapshot.fileCount);
		expect(report.corpus.sourceHash).toBe(descriptor.snapshot.sourceHash);
		expect(report.declarations).toMatchObject({truth: 41, matched: 41});
		expect(report.references).toMatchObject({truth: 35, matched: 35});
		expect(report.dependencies).toMatchObject({truth: 7, matched: 7});
		expect(report.gates.ok).toBe(true);
		expect(report.truth.excludedByReason['ephemeral_declaration']).toBeGreaterThan(0);
	});
});
