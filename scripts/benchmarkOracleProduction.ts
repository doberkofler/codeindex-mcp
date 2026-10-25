import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {oracleParserIdentityOf} from '../src/adapters/oracle/parserIdentity.ts';
import {
	aggregateOraclePerformanceSamples,
	collectOraclePerformanceSamples,
	evaluateOraclePerformance,
	loadOraclePerformanceThresholds,
	verifyOraclePerformanceRuns,
	type OraclePerformanceEvaluationType,
	type OraclePerformanceRunType,
} from '../src/core/benchmark/oraclePerformance.ts';
import {
	bundlesOf,
	cleanEnvironment,
	executeCli,
	executeRepetition,
	gitIdentity,
	medianEditTargetOf,
	parseOptions,
	readHash,
	sqliteVersion,
	writeChecksums,
	type OptionsType,
	type RepetitionType,
} from './oraclePerformanceHarness.ts';
import {loadBundle, loadPackageVersion, type BundleType} from './oraclePerformanceReports.ts';

const {join, resolve} = path;
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

const usage = `Usage: node --experimental-strip-types scripts/benchmarkOracleProduction.ts [options]

Options:
  --bundle <path>        frozen Oracle corpus descriptor
  --thresholds <path>    declared warning/failure thresholds
  --summary <path>       bounded aggregate summary
  --output <path>        external evidence directory
  --evidence-root <path> override the external evidence root
  --runs <n>             measured repetitions (default 5)
  --warmups <n>          discarded warmup repetitions (default 1)
  --iterations <n>       query iterations per report (default 20)
  --edit-rounds <n>      one-file edits per repetition (default 5)
  --max-depth <n>        deep cursor maximum offset (default 10000)
  --page-limit <n>       deep cursor page size (default 200)
  --keep-workspaces      retain source copies and databases
  --allow-dirty          allow a measurement from a dirty working tree
`;

type CodeIdentityType = Readonly<{
	commit: string;
	dirty: boolean;
	packageVersion: string;
	nodeVersion: string;
	sqliteVersion: string;
	bundles: ReturnType<typeof bundlesOf>;
}>;

type SummaryType = Readonly<{
	schemaVersion: 1;
	generatedAt: string;
	measurement: Readonly<{
		startedAt: string;
		durationMs: number;
		warmups: number;
		runs: number;
		iterations: number;
		editRounds: number;
		maxDepth: number;
		pageLimit: number;
	}>;
	identities: Readonly<{
		code: CodeIdentityType;
		machine: Readonly<{platform: string; arch: string; cpuModel: string; totalMemoryBytes: number}>;
		parser: ReturnType<typeof oracleParserIdentityOf>;
		corpus: Readonly<{
			bundleSha256: string;
			sourceHash: string;
			configHash: string;
			fileCount: number;
			unitCount: number;
			databaseSchemaVersion: string;
		}>;
		thresholds: Readonly<{sha256: string}>;
		editTarget: Readonly<{label: string; bytes: number; sha256: string}>;
	}>;
	metrics: ReturnType<typeof aggregateOraclePerformanceSamples>;
	evaluation: OraclePerformanceEvaluationType;
}>;

type PreparedType = Readonly<{
	options: OptionsType;
	bundle: BundleType;
	thresholds: ReturnType<typeof loadOraclePerformanceThresholds>;
	bundleSha256: string;
	thresholdsSha256: string;
	identity: CodeIdentityType;
	cliPath: string;
	workspace: string;
	environment: NodeJS.ProcessEnv;
	editTarget: Readonly<{relativePath: string; bytes: number; sha256: string}>;
	startedAt: string;
	startedMs: number;
}>;

type MeasuredType = Readonly<{
	runs: readonly OraclePerformanceRunType[];
	repetitions: readonly Readonly<{id: string; kind: string}>[];
	databaseSchemaVersion: string;
}>;

const prepare = (options: OptionsType): PreparedType => {
	const bundle = loadBundle(options.bundlePath);
	const thresholds = loadOraclePerformanceThresholds(options.thresholdsPath);

	if (
		bundle.snapshot.sourceHash !== thresholds.corpus.sourceHash ||
		bundle.snapshot.configHash !== thresholds.corpus.configHash ||
		bundle.snapshot.fileCount !== thresholds.corpus.fileCount
	) {
		throw new Error('The declared thresholds were not written for this frozen corpus identity');
	}

	const cliPath = join(REPOSITORY_ROOT, 'dist', 'cli.mjs');

	if (!existsSync(cliPath)) {
		throw new Error('Built CLI is missing: dist/cli.mjs. Run pnpm build first.');
	}

	const identity = gitIdentity(REPOSITORY_ROOT);

	if (identity.dirty && !options.allowDirty) {
		throw new Error('The working tree is dirty. Commit the measured code or pass --allow-dirty.');
	}

	const workspace = join(resolve(options.evidenceRoot, bundle.evidence.externalRoot), bundle.evidence.snapshotDir);

	if (!existsSync(workspace)) {
		throw new Error('The frozen corpus workspace is absent; run the bundle preflight first');
	}

	mkdirSync(options.outputPath, {recursive: true});
	const environment = {...cleanEnvironment(process.env), CODEINDEX_EVIDENCE_ROOT: options.evidenceRoot};

	executeCli({
		cliPath,
		arguments: ['oracle-preflight', '--bundle', options.bundlePath],
		environment,
		logPath: join(options.outputPath, 'preflight.log'),
	});

	return {
		options,
		bundle,
		thresholds,
		bundleSha256: readHash(options.bundlePath),
		thresholdsSha256: readHash(options.thresholdsPath),
		identity: {
			commit: identity.commit,
			dirty: identity.dirty,
			packageVersion: loadPackageVersion(join(REPOSITORY_ROOT, 'package.json')),
			nodeVersion: process.version,
			sqliteVersion: sqliteVersion(),
			bundles: bundlesOf(REPOSITORY_ROOT),
		},
		cliPath,
		workspace,
		environment,
		editTarget: medianEditTargetOf(workspace),
		startedAt: new Date().toISOString(),
		startedMs: performance.now(),
	};
};

const measure = (prepared: PreparedType): MeasuredType => {
	const {options} = prepared;
	const runs: OraclePerformanceRunType[] = [];
	const repetitions: Readonly<{id: string; kind: string}>[] = [];
	const schemaVersions = new Set<string>();

	for (let index = 1; index <= options.warmups + options.runs; index += 1) {
		const kind = index <= options.warmups ? 'warmup' : 'measured';
		const measuredIndex = index - options.warmups;
		const repetition: RepetitionType = executeRepetition({
			kind,
			index: kind === 'warmup' ? index : measuredIndex,
			options,
			bundle: prepared.bundle,
			workspace: prepared.workspace,
			editTarget: prepared.editTarget.relativePath,
			cliPath: prepared.cliPath,
			environment: prepared.environment,
		});

		schemaVersions.add(repetition.databaseSchemaVersion);
		repetitions.push({id: `${kind}-${String(kind === 'warmup' ? index : measuredIndex).padStart(2, '0')}`, kind});

		if (kind === 'measured') {
			runs.push({cold: repetition.cold, warm: repetition.warm, rebuild: repetition.rebuild, deep: repetition.deep, edit: repetition.edit});
		}

		process.stdout.write(`[oracle-performance] ${kind} ${String(kind === 'warmup' ? index : measuredIndex)} complete\n`);
	}

	const databaseSchemaVersion = [...schemaVersions].at(0);

	if (schemaVersions.size !== 1 || databaseSchemaVersion === undefined) {
		throw new Error('Measured repetitions did not publish exactly one database schema version');
	}

	return {runs, repetitions, databaseSchemaVersion};
};

const summaryOf = (
	input: Readonly<{
		prepared: PreparedType;
		measured: MeasuredType;
		code: CodeIdentityType;
		machine: Readonly<{platform: string; arch: string; cpuModel: string; totalMemoryBytes: number}>;
		metrics: ReturnType<typeof aggregateOraclePerformanceSamples>;
		evaluation: OraclePerformanceEvaluationType;
	}>,
): SummaryType => ({
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	measurement: {
		startedAt: input.prepared.startedAt,
		durationMs: performance.now() - input.prepared.startedMs,
		warmups: input.prepared.options.warmups,
		runs: input.prepared.options.runs,
		iterations: input.prepared.options.iterations,
		editRounds: input.prepared.options.editRounds,
		maxDepth: input.prepared.options.maxDepth,
		pageLimit: input.prepared.options.pageLimit,
	},
	identities: {
		code: input.code,
		machine: input.machine,
		parser: oracleParserIdentityOf('structural'),
		corpus: {
			bundleSha256: input.prepared.bundleSha256,
			sourceHash: input.prepared.bundle.snapshot.sourceHash,
			configHash: input.prepared.bundle.snapshot.configHash,
			fileCount: input.prepared.bundle.snapshot.fileCount,
			unitCount: input.prepared.bundle.snapshot.unitCount,
			databaseSchemaVersion: input.measured.databaseSchemaVersion,
		},
		thresholds: {sha256: input.prepared.thresholdsSha256},
		editTarget: {label: 'median-size source file', bytes: input.prepared.editTarget.bytes, sha256: input.prepared.editTarget.sha256},
	},
	metrics: input.metrics,
	evaluation: input.evaluation,
});

const publish = (prepared: PreparedType, measured: MeasuredType): number => {
	const {options} = prepared;
	const {bundles} = prepared.identity;
	const metrics = aggregateOraclePerformanceSamples(collectOraclePerformanceSamples({runs: measured.runs, bundles}));
	const evaluation = evaluateOraclePerformance({
		aggregates: metrics,
		thresholds: prepared.thresholds,
		integrity: verifyOraclePerformanceRuns({
			runs: measured.runs,
			expected: {
				sourceHash: prepared.bundle.snapshot.sourceHash,
				configHash: prepared.bundle.snapshot.configHash,
				fileCount: prepared.bundle.snapshot.fileCount,
				editRounds: options.editRounds,
			},
		}),
	});
	const machine = {
		platform: process.platform,
		arch: process.arch,
		cpuModel: os.cpus().at(0)?.model ?? 'unknown',
		totalMemoryBytes: os.totalmem(),
	};
	const summary = summaryOf({prepared, measured, code: prepared.identity, machine, metrics, evaluation});
	const summaryJson = `${JSON.stringify(summary, null, 2)}\n`;

	mkdirSync(path.dirname(options.summaryPath), {recursive: true});
	writeFileSync(options.summaryPath, summaryJson, {encoding: 'utf8'});

	writeFileSync(
		join(options.outputPath, 'manifest.json'),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				generatedAt: summary.generatedAt,
				bundle: {
					sha256: prepared.bundleSha256,
					sourceHash: prepared.bundle.snapshot.sourceHash,
					configHash: prepared.bundle.snapshot.configHash,
					fileCount: prepared.bundle.snapshot.fileCount,
				},
				thresholds: {sha256: prepared.thresholdsSha256, declaredAt: prepared.thresholds.declaredAt},
				code: summary.identities.code,
				machine,
				repetitions: measured.repetitions,
				databaseSchemaVersion: measured.databaseSchemaVersion,
				summarySha256: createHash('sha256').update(summaryJson).digest('hex'),
			},
			null,
			2,
		)}\n`,
		{encoding: 'utf8'},
	);
	writeChecksums(options.outputPath);

	process.stdout.write(
		[
			`Oracle production performance: ${evaluation.status.toUpperCase()} (${String(options.runs)} measured runs, ${String(options.warmups)} warmups)`,
			`  gates: ${String(evaluation.summary.pass)} pass, ${String(evaluation.summary.warning)} warning, ${String(evaluation.summary.failure)} failure`,
			`  summary: ${path.relative(REPOSITORY_ROOT, options.summaryPath)}`,
			`  evidence: ${options.outputPath}`,
			'',
		].join('\n'),
	);

	return evaluation.status === 'failure' ? 1 : 0;
};

const main = (): number => {
	if (process.argv.slice(2).includes('--help')) {
		process.stdout.write(usage);
		return 0;
	}

	const options = parseOptions(process.argv.slice(2), process.env);

	if (options === null) {
		return 0;
	}

	const prepared = prepare(options);
	return publish(prepared, measure(prepared));
};

try {
	process.exitCode = main();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
