import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {type ConfigType, loadConfig} from '../config/config.ts';
import {createCodeIndex} from '../index/codeIndex.ts';
import {type BuildStagesType, type QueryFreshnessType} from '../index/model.ts';
import {createLogger} from '../logging/logger.ts';
import {IndexDatabase} from '../storage/database.ts';

const {join} = path;

type BenchmarkPercentilesType = Readonly<{
	readonly count: number;
	readonly p50Ms: number | null;
	readonly p95Ms: number | null;
	readonly maxMs: number | null;
}>;

export type BenchmarkReportType = Readonly<{
	readonly generatedAt: string;
	readonly version: number;
	readonly nodeVersion: string;
	readonly platform: string;
	readonly arch: string;
	readonly iterations: number;
	readonly scope: Readonly<{projectId: string; fileCount: number; symbolCount: number; occurrenceCount: number}>;
	readonly build: Readonly<{reused: boolean; durationMs: number; stages: BuildStagesType | null}>;
	readonly freshness: QueryFreshnessType;
	readonly queries: Readonly<Record<string, BenchmarkPercentilesType>>;
}>;

const percentile = (values: readonly number[], fraction: number): number | null => {
	if (values.length === 0) {
		return null;
	}

	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return Math.round(sorted[index] ?? 0);
};

const summarize = (values: readonly number[]): BenchmarkPercentilesType => ({
	count: values.length,
	p50Ms: percentile(values, 0.5),
	p95Ms: percentile(values, 0.95),
	maxMs: values.length === 0 ? null : Math.max(...values),
});

const measure = (action: () => void): number => {
	const startedAt = performance.now();
	action();
	return performance.now() - startedAt;
};

const measureQueries = (
	index: ReturnType<typeof createCodeIndex>,
	outlinePath: string,
	sample: Readonly<{id: string}> | undefined,
	iterations: number,
): Readonly<Record<string, number[]>> => {
	const queries: Record<string, number[]> = {
		status: [],
		find_symbol: [],
		outline: [],
		find_references: [],
		read_symbol: [],
	};

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		queries['status']?.push(
			measure(() => {
				index.getStatus();
			}),
		);
		queries['find_symbol']?.push(
			measure(() => {
				index.findSymbols({query: 'a', limit: 10});
			}),
		);
		queries['outline']?.push(
			measure(() => {
				index.getOutline({path: outlinePath, limit: 50});
			}),
		);

		if (sample !== undefined) {
			queries['find_references']?.push(
				measure(() => {
					index.findReferences({symbolId: sample.id, limit: 50});
				}),
			);
			queries['read_symbol']?.push(
				measure(() => {
					index.readSymbol({symbolId: sample.id, contextLines: 0});
				}),
			);
		}
	}

	return queries;
};

/**
 * Measures build, status, and query latency without any model calls.
 *
 * @param input - Resolved configuration and iteration count.
 * @returns Machine-readable benchmark results.
 * @throws {@link Error} When the index cannot be built or queried.
 */
export const runBenchmarkReport = async (input: Readonly<{config: ConfigType; iterations: number; force: boolean}>): Promise<BenchmarkReportType> => {
	const {config} = input;
	const logger = createLogger({minimumLevel: 'error'});
	const database = IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		extractorId: config.extractorId,
		projectId: config.projectId,
	});
	const index = createCodeIndex(config, database, logger, {watch: false});

	try {
		const build = await index.ensureReady({force: input.force});
		const sample = index.findSymbols({query: 'a', limit: 1}).items.at(0);
		const outlinePath = sample?.path ?? database.listFiles(build.generationId).at(0)?.path;

		if (outlinePath === undefined) {
			throw new Error('Benchmark requires at least one indexed file');
		}

		const queries = measureQueries(index, outlinePath, sample, input.iterations);

		return {
			generatedAt: new Date().toISOString(),
			version: 1,
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			iterations: input.iterations,
			scope: {
				projectId: config.projectId,
				fileCount: build.fileCount,
				symbolCount: build.symbolCount,
				occurrenceCount: build.occurrenceCount,
			},
			build: {reused: build.reused, durationMs: build.durationMs, stages: build.stages},
			freshness: index.getFreshness(),
			queries: {
				status: summarize(queries['status'] ?? []),
				find_symbol: summarize(queries['find_symbol'] ?? []),
				outline: summarize(queries['outline'] ?? []),
				find_references: summarize(queries['find_references'] ?? []),
				read_symbol: summarize(queries['read_symbol'] ?? []),
			},
		};
	} finally {
		await index.close();
	}
};

const usage = `Usage: codeindex-cli benchmark [options]

Measures local build, status, and query latency. Performs no model calls.

Options:
  --iterations <n>     Query iterations (default 20)
  --rebuild            Force one full rebuild before measuring
  --output <path>      Write JSON results to this path
  --config <path>      Load a JSON configuration file
  --root <path>        Override the indexed workspace root
  --extractor <id>     Override the selected extractor
  --project-file <path> Override the extractor project file
  --database <path>    Override the index database path
  --help               Print this message
`;

export type BenchmarkIoType = Readonly<{
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
}>;

/**
 * Runs the local benchmark command.
 *
 * @param argv - Arguments after the `benchmark` command.
 * @param environment - Environment validated by `loadConfig`.
 * @param io - Output sinks used by tests.
 * @returns Process exit code.
 */
export const runBenchmarkCommand = async (argv: readonly string[], environment: NodeJS.ProcessEnv, io: BenchmarkIoType): Promise<number> => {
	try {
		const parsed = parseArgs({
			args: [...argv],
			options: {
				iterations: {type: 'string', default: '20'},
				rebuild: {type: 'boolean', default: false},
				output: {type: 'string'},
				config: {type: 'string'},
				root: {type: 'string'},
				extractor: {type: 'string'},
				'project-file': {type: 'string'},
				database: {type: 'string'},
				help: {type: 'boolean', default: false},
			},
			allowPositionals: false,
		});

		if (parsed.values.help) {
			io.stdout(usage.trimEnd());
			return 0;
		}

		const overrides: Record<string, string> = {};

		for (const [name, value] of [
			['CODE_INDEX_CONFIG', parsed.values.config],
			['CODE_INDEX_ROOT', parsed.values.root],
			['CODE_INDEX_EXTRACTOR', parsed.values.extractor],
			['CODE_INDEX_PROJECT_FILE', parsed.values['project-file']],
			['CODE_INDEX_DATABASE', parsed.values.database],
		] as const) {
			if (value !== undefined) {
				overrides[name] = value;
			}
		}

		const iterations = Number(parsed.values.iterations);

		if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000) {
			throw new Error('--iterations must be an integer between 1 and 10000');
		}

		const report = await runBenchmarkReport({config: loadConfig({...environment, ...overrides}), iterations, force: parsed.values.rebuild});
		const outputPath =
			parsed.values.output ?? join(process.cwd(), 'benchmark', 'results', `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);

		mkdirSync(path.dirname(outputPath), {recursive: true});
		writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {encoding: 'utf8'});
		io.stdout(`Benchmark written to ${outputPath}`);
		io.stdout(JSON.stringify(report.queries, null, 2));
		return 0;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};
