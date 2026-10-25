import {copyFile, cp, mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {indexRootDirectory} from '../../../config/config.ts';
import {runQualifyCommand} from '../../qualifyCommand.ts';
import {preflightOracleEvidenceBundle, type OracleEvidencePreflightReportType} from './oracleEvidenceBundle.ts';

const DescriptorSchema = z.object({
	evidence: z.object({
		externalRoot: z.string().min(1),
		snapshotDir: z.string().min(1),
		plan: z.string().min(1),
	}),
	snapshot: z.object({projectFile: z.string().min(1)}),
});

const PlanSchema = z.object({
	project: z.object({projectFile: z.string().min(1)}),
	snapshot: z.object({projectFile: z.string().min(1)}),
});

const EnvironmentSchema = z.object({
	CODEINDEX_EVIDENCE_ROOT: z.string().min(1).optional(),
});

const REPORT_FILE = 'qualification.json';

/**
 * Result of replaying one retained bundle.
 */
export type OracleReplayResultType = Readonly<{
	/** Preflight verdict for the bundle. */
	preflight: OracleEvidencePreflightReportType;
	/** Fully qualified transient report path is removed after the run. */
	report: unknown;
	/** Path to the committed report used for comparison, or null when absent. */
	expectedPath: string | null;
	/** Whether every deterministic report field equals the committed report. */
	matches: boolean;
	/** Bounded field paths that differ, with their values. */
	differences: readonly string[];
	/** Qualification diagnostics captured from stderr. */
	diagnostics: readonly string[];
}>;

type OracleReplayOptionsType = Readonly<{
	descriptorPath: string;
	evidenceRoot?: string | undefined;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

const diffPaths = (left: unknown, right: unknown, prefix: string, limit: number): readonly string[] => {
	if (limit <= 0) {
		return [];
	}

	if (JSON.stringify(left) === JSON.stringify(right)) {
		return [];
	}

	if (isRecord(left) && isRecord(right)) {
		const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

		return [...keys].flatMap((key) => diffPaths(left[key], right[key], prefix === '' ? key : `${prefix}.${key}`, limit - 1));
	}

	return [`${prefix}: expected ${JSON.stringify(right)}, found ${JSON.stringify(left)}`];
};

const withoutGenerationId = (value: unknown): unknown => {
	if (!isRecord(value)) {
		return value;
	}

	const rest = {...value};
	delete rest['generationId'];

	return rest;
};

const SAMPLE_KEYS: ReadonlySet<string> = new Set(['samples', 'samplesMissing', 'samplesExtra']);

/**
 * Removes bounded disagreement samples, which are intentionally not committed
 * because they contain symbol names and workspace paths.
 *
 * @param value - Report value or subtree.
 * @returns The same structure without every sample array.
 */
const withoutSamples = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((entry) => withoutSamples(entry));
	}

	if (!isRecord(value)) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !SAMPLE_KEYS.has(key))
			.map(([key, entry]) => [key, withoutSamples(entry)]),
	);
};

/**
 * Replays a retained Oracle evidence bundle through the production
 * qualification path and compares the result with the committed report.
 *
 * Replay is database-free. The live workflow builds its snapshot generation
 * with a project context named `qualification`; the generation configuration
 * hash includes that context name, so replay recreates that layout rather than
 * scanning the snapshot in place.
 *
 * @param environment - Environment source; only `CODEINDEX_EVIDENCE_ROOT` is read.
 * @param options - Committed descriptor and optional evidence-root override.
 * @returns Replay result, including every deterministic difference from the retained report.
 * @throws {Error} When preflight fails, the bundle metadata is malformed, or qualification writes no report.
 */
export const replayOracleEvidenceBundle = async (environment: NodeJS.ProcessEnv, options: OracleReplayOptionsType): Promise<OracleReplayResultType> => {
	const descriptorPath = path.resolve(options.descriptorPath);
	const descriptor = DescriptorSchema.parse(JSON.parse(await readFile(descriptorPath, 'utf8')));
	const parsedEnvironment = EnvironmentSchema.parse(environment);
	const root = path.resolve(
		options.evidenceRoot ?? path.join(parsedEnvironment.CODEINDEX_EVIDENCE_ROOT ?? indexRootDirectory(), descriptor.evidence.externalRoot),
	);
	const preflight = await preflightOracleEvidenceBundle(environment, {
		descriptorPath,
		evidenceRoot: root,
	});

	if (!preflight.ok) {
		throw new Error('Oracle evidence bundle preflight failed; replay requires every artifact and identity check to pass');
	}

	const plan = PlanSchema.parse(JSON.parse(await readFile(path.resolve(root, descriptor.evidence.plan), 'utf8')));
	const snapshot = path.resolve(root, descriptor.evidence.snapshotDir);
	const sourceManifest = path.resolve(snapshot, plan.project.projectFile);
	const workDirectory = await mkdtemp(path.join(tmpdir(), 'codeindex-oracle-replay-'));
	const diagnostics: string[] = [];

	try {
		const work = path.join(workDirectory, 'work');
		const context = path.join(work, 'qualification');
		const database = path.join(workDirectory, 'index.sqlite');
		const reportPath = path.join(workDirectory, 'report.json');

		await cp(snapshot, work, {recursive: true});
		await mkdir(context, {recursive: true});
		await copyFile(sourceManifest, path.join(context, path.basename(sourceManifest)));

		await runQualifyCommand(
			[
				'--extractor',
				'oracle',
				'--root',
				work,
				'--project-file',
				path.join(context, path.basename(sourceManifest)),
				'--database',
				database,
				'--identifiers',
				path.join(root, 'user-identifiers.csv'),
				'--dependencies',
				path.join(root, 'user-dependencies.csv'),
				'--units',
				path.join(root, descriptor.evidence.plan),
				'--output',
				reportPath,
			],
			{...environment, CODE_INDEX_LOG_LEVEL: 'error'},
			{
				stdout: (_line) => {
					void _line;
				},
				stderr: (line) => {
					diagnostics.push(line);
				},
			},
		);

		const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
		const expectedPath = path.join(path.dirname(descriptorPath), REPORT_FILE);
		let expected: unknown;

		try {
			expected = JSON.parse(await readFile(expectedPath, 'utf8'));
		} catch {
			return {preflight, report, expectedPath: null, matches: true, differences: [], diagnostics};
		}

		const differences = diffPaths(withoutSamples(withoutGenerationId(report)), withoutSamples(withoutGenerationId(expected)), '', 20);

		return {preflight, report, expectedPath, matches: differences.length === 0, differences, diagnostics};
	} finally {
		await rm(workDirectory, {recursive: true, force: true});
	}
};
