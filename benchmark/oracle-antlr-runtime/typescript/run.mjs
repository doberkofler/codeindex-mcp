import path from 'node:path';
import {
	corpusDir,
	corpusMetadata,
	here,
	machine,
	parseCommonOptions,
	parseJsonOutput,
	resultFile,
	run,
	selectCorpus,
	stats,
	workDir,
	writeJson,
} from '../lib.mjs';

const options = parseCommonOptions(process.argv);

process.stdout.write('TypeScript: selecting corpus\n');
const manifest = selectCorpus({evidence: options.evidence});

run(process.execPath, [path.join(here, 'typescript/build.mjs')]);

const harness = path.join(workDir, 'typescript-bundle/harness.mjs');
const env = {
	...process.env,
	BENCH_MANIFEST: path.join(corpusDir, 'manifest.json'),
	BENCH_FILES: path.join(corpusDir, 'files'),
};

process.stdout.write(`TypeScript: ${String(options.coldRepeats)} isolated cold process(es) per file\n`);
const cold = [];

for (let index = 0; index < manifest.files.length; index += 1) {
	const runs = [];

	for (let repeat = 0; repeat < options.coldRepeats; repeat += 1) {
		const output = parseJsonOutput(run(process.execPath, [harness], {env: {...env, BENCH_INDEX: String(index)}}).stdout);
		runs.push({...output.files[0].cold, rssKb: output.maxRssKb});
	}

	const median = [...runs].sort((left, right) => left.ms - right.ms)[Math.floor((runs.length - 1) / 2)].ms;
	cold.push({runs, coldMs: median});
	process.stdout.write(`  cold ${String(index + 1).padStart(2, '0')}/${String(manifest.files.length)} ${manifest.files[index].path}\n`);
}

process.stdout.write(`TypeScript: ${String(options.warmups)} warmup(s), ${String(options.iterations)} samples per file\n`);
const warmOutput = parseJsonOutput(
	run(process.execPath, [harness], {
		env: {
			...env,
			BENCH_WARM: '1',
			BENCH_WARMUPS: String(options.warmups),
			BENCH_ITERATIONS: String(options.iterations),
		},
	}).stdout,
);
const warm = new Map(warmOutput.files.map((file) => [file.id, file.warm]));

process.stdout.write('TypeScript: one-pass corpus parse (shared DFA)\n');
const passOutput = parseJsonOutput(run(process.execPath, [harness], {env}).stdout);
const pass = new Map(passOutput.files.map((file) => [file.id, file.cold]));

const files = manifest.files.map((file, index) => {
	const coldEntry = cold[index].runs[0];
	const warmEntry = warm.get(file.id);
	const passEntry = pass.get(file.id);

	if (warmEntry === undefined || passEntry === undefined) {
		throw new Error(`Missing TypeScript output for ${file.path}`);
	}

	return {
		id: file.id,
		path: file.path,
		bytes: file.bytes,
		lines: file.lines,
		quantile: file.quantile,
		coldMs: cold[index].coldMs,
		coldRunsMs: cold[index].runs.map((entry) => entry.ms),
		warmMs: warmEntry.ms,
		passMs: passEntry.ms,
		adapterColdMs: coldEntry.totalMs,
		adapterWarmMs: warmEntry.totalMs,
		adapterPassMs: passEntry.totalMs,
		diagnostics: coldEntry.diagnostics,
		llMs: coldEntry.profile.llParseMs,
		rssKb: cold[index].runs[0].rssKb,
	};
});

const result = {
	language: 'typescript',
	generatedAt: new Date().toISOString(),
	machine: machine(),
	corpus: corpusMetadata(manifest),
	config: {
		runtime: 'antlr4ng',
		prediction: 'sll-first-with-ll-fallback',
		metric: 'parser core: lexerMs + sllParseMs + llParseMs',
		iterations: options.iterations,
		warmups: options.warmups,
		coldRepeats: options.coldRepeats,
	},
	files,
	aggregate: {
		cold: stats(files.map((file) => file.coldMs)),
		warm: stats(files.map((file) => file.warmMs)),
		onePass: {
			totalMs: files.reduce((total, file) => total + file.passMs, 0),
			adapterTotalMs: files.reduce((total, file) => total + file.adapterPassMs, 0),
		},
		peakRssKb: Math.max(...files.map((file) => file.rssKb), warmOutput.maxRssKb, passOutput.maxRssKb),
		fallbacks: files.filter((file) => file.llMs > 0).map((file) => file.path),
	},
};

writeJson(resultFile('typescript'), result);
process.stdout.write(
	`TypeScript results: ${resultFile('typescript')}\n` +
		`  cold core p50/p95/max ${result.aggregate.cold.p50Ms.toFixed(3)} / ${result.aggregate.cold.p95Ms.toFixed(3)} / ${result.aggregate.cold.maxMs.toFixed(3)} ms\n` +
		`  warm core p50/p95/max ${result.aggregate.warm.p50Ms.toFixed(3)} / ${result.aggregate.warm.p95Ms.toFixed(3)} / ${result.aggregate.warm.maxMs.toFixed(3)} ms\n` +
		`  one-pass core ${result.aggregate.onePass.totalMs.toFixed(3)} ms\n`,
);
