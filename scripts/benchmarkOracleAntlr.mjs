import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {gzipSync} from 'node:zlib';
import {build} from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const defaultEvidence = path.join(os.homedir(), '.local/share/codeindex-mcp/oracle-live/2eb1e36f6ecdada4');
const profilePhases = [
	'tokenizeMs',
	'conditionalMs',
	'retokenizeMs',
	'lexerMs',
	'sllParseMs',
	'llParseMs',
	'declarationsMs',
	'referencesMs',
	'sqlNamesMs',
	'dependenciesMs',
	'recoveryMs',
	'totalMs',
];

const usage = `Usage: node scripts/benchmarkOracleAntlr.mjs [options]

Options:
  --evidence <path>   Oracle live evidence root
  --files <count>     Limit the corpus to the first N paths
  --workers <list>    Comma-separated worker counts (default: 1,4,8)
  --output <path>     Report path (default: benchmark/oracle-phase7/report.json)
`;

const parseArguments = (argv) => {
	const options = {
		evidence: process.env['CODEINDEX_EVIDENCE_ROOT'] ?? defaultEvidence,
		files: null,
		workers: [1, 4, 8],
		output: path.join(root, 'benchmark/oracle-phase7/report.json'),
	};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const value = argv[index + 1];

		if (argument === '--help') {
			process.stdout.write(usage);
			process.exit(0);
		}

		if (value === undefined) {
			throw new Error(`Missing value for ${argument}`);
		}

		switch (argument) {
			case '--evidence': {
				options.evidence = path.resolve(value);
				break;
			}
			case '--files': {
				options.files = Number(value);
				break;
			}
			case '--workers': {
				options.workers = value.split(',').map((entry) => Number(entry.trim()));
				break;
			}
			case '--output': {
				options.output = path.resolve(value);
				break;
			}
			default: {
				throw new Error(`Unknown argument: ${argument}`);
			}
		}

		index += 1;
	}

	if (options.files !== null && (!Number.isInteger(options.files) || options.files < 1)) {
		throw new Error('--files must be a positive integer');
	}

	if (options.workers.some((count) => !Number.isInteger(count) || count < 1)) {
		throw new Error('--workers must contain positive integers');
	}

	return options;
};

const percentileOf = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;

const percentilesOf = (values) => {
	const sorted = [...values].sort((left, right) => left - right);

	return {
		count: sorted.length,
		p50Ms: percentileOf(sorted, 0.5),
		p95Ms: percentileOf(sorted, 0.95),
		p99Ms: percentileOf(sorted, 0.99),
		maxMs: sorted.at(-1) ?? 0,
	};
};

const buildCandidateBundle = async () => {
	const outDir = mkdtempSync(path.join(root, '.oracle-antlr-benchmark-'));

	await build({
		configFile: false,
		logLevel: 'error',
		build: {
			emptyOutDir: true,
			lib: {
				entry: path.join(root, 'src/adapters/oracle/antlrParser.ts'),
				fileName: () => 'antlrParser.mjs',
				formats: ['es'],
			},
			minify: 'oxc',
			outDir,
			sourcemap: false,
			target: 'node26',
		},
	});

	const bundlePath = path.join(outDir, 'antlrParser.mjs');
	const bytes = readFileSync(bundlePath);

	return {
		cleanup: () => rmSync(outDir, {force: true, recursive: true}),
		gzipBytes: gzipSync(bytes, {level: 9}).byteLength,
		path: bundlePath,
		rawBytes: bytes.byteLength,
		url: pathToFileURL(bundlePath).href,
	};
};

const bundleSizeOf = (filePath) => {
	try {
		const bytes = readFileSync(filePath);

		return {gzipBytes: gzipSync(bytes, {level: 9}).byteLength, rawBytes: bytes.byteLength};
	} catch {
		return null;
	}
};

const loadCorpus = (evidence, limit) => {
	const workspace = path.join(evidence, 'workspace');
	const unitsPath = path.join(root, 'benchmark/oracle-phase0/units.json');
	const units = JSON.parse(readFileSync(unitsPath, 'utf8'));
	const paths = units.map((unit) => unit.path).sort();
	const selected = (limit === null ? paths : paths.slice(0, limit)).map((relativePath, index) => {
		const absolutePath = path.join(workspace, relativePath);

		return {absolutePath, bytes: statSync(absolutePath).size, index, path: relativePath};
	});

	return {
		bytes: selected.reduce((total, file) => total + file.bytes, 0),
		evidence: path.basename(evidence),
		files: selected,
		source: path.relative(root, unitsPath),
	};
};

const partitionFiles = (files, count) => {
	const buckets = Array.from({length: count}, () => ({bytes: 0, files: []}));

	for (const file of [...files].sort((left, right) => right.bytes - left.bytes)) {
		const bucket = buckets.reduce((smallest, candidate) => (candidate.bytes < smallest.bytes ? candidate : smallest));
		bucket.files.push(file);
		bucket.bytes += file.bytes;
	}

	return buckets.filter((bucket) => bucket.files.length > 0).map((bucket) => bucket.files);
};

const runWorker = (fileSet, bundleUrl, defaultSchema) =>
	new Promise((resolve, reject) => {
		const worker = new Worker(path.join(root, 'scripts/oracleAntlrBenchmarkWorker.mjs'), {
			workerData: {bundleUrl, defaultSchema, files: fileSet.files},
		});
		let settled = false;

		worker.once('message', (message) => {
			settled = true;
			worker.terminate().then(() => resolve(message), reject);
		});
		worker.once('error', reject);
		worker.once('exit', (code) => {
			if (!settled && code !== 0) {
				reject(new Error(`Benchmark worker exited with code ${String(code)}`));
			}
		});
	});

const sumProfiles = (rows) => {
	const totals = Object.fromEntries(profilePhases.map((phase) => [phase, 0]));
	let fallbackFiles = 0;
	let fallbackSllMs = 0;
	let recoveredFiles = 0;

	for (const row of rows) {
		if (row.profile === null) {
			continue;
		}

		for (const phase of profilePhases) {
			totals[phase] += row.profile[phase];
		}

		if (row.profile.prediction === 'sll-fallback-ll') {
			fallbackFiles += 1;
			fallbackSllMs += row.profile.sllParseMs;
		}

		recoveredFiles += row.profile.recovered ? 1 : 0;
	}

	return {fallbackFiles, fallbackSllMs, recoveredFiles, totals};
};

const summarizeRun = (workerCount, wallMs, peakRssBytes, rows) => {
	const {fallbackFiles, fallbackSllMs, recoveredFiles, totals} = sumProfiles(rows);
	const fileCount = rows.length;

	return {
		workerCount,
		wallMs,
		wallMinusSumMs: wallMs - rows.reduce((total, row) => total + row.ms, 0),
		peakRssBytes,
		fileCount,
		bytes: rows.reduce((total, row) => total + row.bytes, 0),
		diagnostics: rows.reduce((total, row) => total + row.diagnostics, 0),
		failedFiles: rows.filter((row) => row.failed).length,
		fallbackFiles,
		fallbackSllMs,
		recoveredFiles,
		percentiles: percentilesOf(rows.map((row) => row.ms)),
		phaseTotalsMs: totals,
		slowestFiles: [...rows]
			.sort((left, right) => right.ms - left.ms)
			.slice(0, 20)
			.map((row) => ({path: row.path, bytes: row.bytes, ms: row.ms, profile: row.profile})),
	};
};

const runPool = async (files, workerCount, bundleUrl, defaultSchema) => {
	const partitions = partitionFiles(files, workerCount);
	const startedAt = performance.now();
	let peakRssBytes = process.memoryUsage().rss;
	const sampler = setInterval(() => {
		peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
	}, 50);
	sampler.unref();

	try {
		const results = await Promise.all(partitions.map((partition) => runWorker({files: partition}, bundleUrl, defaultSchema)));
		const wallMs = performance.now() - startedAt;
		const rows = results.flatMap((result) => result.rows);
		const workerPeak = results.reduce((peak, result) => Math.max(peak, result.peakRssBytes), 0);

		return summarizeRun(workerCount, wallMs, Math.max(peakRssBytes, workerPeak), rows);
	} finally {
		clearInterval(sampler);
	}
};

const measureSample = (parseWithAntlrProfiled, file, defaultSchema, rounds) => {
	const source = readFileSync(file.absolutePath, 'utf8');
	const parse = () => parseWithAntlrProfiled({source, path: file.path, defaultSchema});
	parse();
	const samples = [];

	for (let round = 0; round < rounds; round += 1) {
		const startedAt = performance.now();
		parse();
		samples.push(performance.now() - startedAt);
	}

	return {bytes: file.bytes, path: file.path, samplesMs: samples, percentiles: percentilesOf(samples)};
};

const measureReconciliation = async (bundle, files, defaultSchema) => {
	const {parseWithAntlrProfiled} = await import(bundle.url);
	const sorted = [...files].sort((left, right) => left.bytes - right.bytes);
	const largest = sorted.at(-1);
	const median = sorted[Math.floor(sorted.length / 2)];

	return {
		largest: largest === undefined ? null : measureSample(parseWithAntlrProfiled, largest, defaultSchema, 5),
		median: median === undefined ? null : measureSample(parseWithAntlrProfiled, median, defaultSchema, 5),
		note: 'Warm process, cached source, parser only; no scan, storage, or publication.',
	};
};

const compareWithBaseline = (runs) => {
	const phase0Path = path.join(root, 'benchmark/oracle-phase0/benchmark.json');
	const report = JSON.parse(readFileSync(phase0Path, 'utf8'));
	const cold = report.scenarios.find((scenario) => scenario.name === 'cold_build');
	const rebuild = report.scenarios.find((scenario) => scenario.name === 'warm_rebuild');
	const sequential = runs.find((run) => run.workerCount === 1) ?? runs[0];
	const structuralCompilerMs = cold.build.stages.compilerMs;

	return {
		baseline: {
			coldBuildWallMs: cold.wallMs,
			structuralCompilerMs,
			warmRebuildWallMs: rebuild.wallMs,
		},
		candidate: {
			coldBuildWallMs: sequential.wallMs,
			parserOnlyMs: sequential.phaseTotalsMs.totalMs,
		},
		ratios: {
			coldBuildWall: sequential.wallMs / cold.wallMs,
			parserToStructuralCompiler: sequential.phaseTotalsMs.totalMs / structuralCompilerMs,
			warmRebuildWall: sequential.wallMs / rebuild.wallMs,
		},
	};
};

const editGate = (sequential) => ({
	failurePassed: sequential.percentiles.maxMs <= 15_000,
	p95Ms: sequential.percentiles.p95Ms,
	warningPassed: sequential.percentiles.p95Ms <= 5_000,
});

const machineOf = () => ({
	arch: process.arch,
	cpuModel: os.cpus().at(0)?.model ?? 'unknown',
	nodeVersion: process.version,
	platform: process.platform,
	totalMemoryBytes: os.totalmem(),
});

const writeReport = (output, report) => {
	mkdirSync(path.dirname(output), {recursive: true});
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
};

const main = async () => {
	const options = parseArguments(process.argv.slice(2));
	const corpus = loadCorpus(options.evidence, options.files);
	const defaultSchema = 'LJ_UNITTEST';
	const bundle = await buildCandidateBundle();

	try {
		const runs = [];

		for (const workerCount of options.workers) {
			process.stderr.write(`Benchmarking ${String(workerCount)} worker(s) over ${String(corpus.files.length)} files\n`);
			runs.push(await runPool(corpus.files, workerCount, bundle.url, defaultSchema));
		}

		const sequential = runs.find((run) => run.workerCount === 1) ?? runs[0];
		const report = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			machine: machineOf(),
			corpus: {bytes: corpus.bytes, evidence: corpus.evidence, fileCount: corpus.files.length, source: corpus.source},
			bundle: {
				candidate: {gzipBytes: bundle.gzipBytes, rawBytes: bundle.rawBytes},
				baselineMcp: bundleSizeOf(path.join(root, 'dist/mcp.mjs')),
				baselineCli: bundleSizeOf(path.join(root, 'dist/cli.mjs')),
				note: 'Candidate contains the ANTLR adapter only; baseline artifacts do not import it.',
			},
			runs,
			reconciliation: await measureReconciliation(bundle, corpus.files, defaultSchema),
			comparison: compareWithBaseline(runs),
			editGate: editGate(sequential),
		};

		writeReport(options.output, report);
		process.stdout.write(`${options.output}\n`);
	} finally {
		bundle.cleanup();
	}
};

await main();
