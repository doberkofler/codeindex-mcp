import {cpSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {
	corpusDir,
	corpusMetadata,
	docker,
	here,
	machine,
	median,
	parseCommonOptions,
	parseJsonOutput,
	resultFile,
	run,
	selectCorpus,
	stats,
	workDir,
	writeJson,
} from '../lib.mjs';

const image = 'oracle-go-antlr-bench:local';
const buildDir = path.join(workDir, 'build/go');
const options = parseCommonOptions(process.argv);

process.stdout.write('Go: selecting corpus\n');
const manifest = selectCorpus({evidence: options.evidence});

if (!options.skipBuild) {
	rmSync(buildDir, {recursive: true, force: true});
	mkdirSync(path.join(buildDir, 'grammar'), {recursive: true});

	run(process.execPath, [path.join(here, 'prepare-grammar.mjs'), '--target', 'go', '--out-dir', path.join(buildDir, 'grammar')]);
	cpSync(path.join(here, 'go/Dockerfile'), path.join(buildDir, 'Dockerfile'));
	cpSync(path.join(here, 'go/main.go'), path.join(buildDir, 'main.go'));
	cpSync(path.join(here, 'go/go.mod'), path.join(buildDir, 'go.mod'));
	cpSync(path.join(here, 'go/PlSqlLexerBase.go'), path.join(buildDir, 'PlSqlLexerBase.go'));
	cpSync(path.join(here, 'go/PlSqlParserBase.go'), path.join(buildDir, 'PlSqlParserBase.go'));
	cpSync(corpusDir, path.join(buildDir, 'corpus'), {recursive: true});

	run('docker', ['build', '--platform', options.platform, '-t', image, buildDir]);
}

process.stdout.write(`Go: ${String(options.coldRepeats)} isolated cold process(es) per file\n`);

const cold = [];

for (let index = 0; index < manifest.files.length; index += 1) {
	const runs = [];

	for (let repeat = 0; repeat < options.coldRepeats; repeat += 1) {
		const output = parseJsonOutput(docker(image, ['--index', String(index)]).stdout);
		const file = output.files[0];
		runs.push({...file.cold, rssKb: output.maxRssKb});
	}

	cold.push({file: manifest.files[index], runs, coldMs: median(runs.map((entry) => entry.totalMs))});
	process.stdout.write(`  cold ${String(index + 1).padStart(2, '0')}/${String(manifest.files.length)} ${manifest.files[index].path}\n`);
}

process.stdout.write(`Go: ${String(options.warmups)} warmup(s), ${String(options.iterations)} samples per file\n`);
const warmOutput = parseJsonOutput(docker(image, ['--warm', '--warmups', String(options.warmups), '--iterations', String(options.iterations)]).stdout);
const warm = new Map(warmOutput.files.map((file) => [file.id, file.warm]));

process.stdout.write('Go: one-pass corpus parse (shared DFA)\n');
const passOutput = parseJsonOutput(docker(image, []).stdout);
const pass = new Map(passOutput.files.map((file) => [file.id, file.cold]));

const files = manifest.files.map((file, index) => {
	const coldEntry = cold[index];
	const coldRun = coldEntry.runs[0];
	const warmEntry = warm.get(file.id);
	const passEntry = pass.get(file.id);

	if (warmEntry === undefined || passEntry === undefined) {
		throw new Error(`Missing Go output for ${file.path}`);
	}

	return {
		id: file.id,
		path: file.path,
		bytes: file.bytes,
		lines: file.lines,
		quantile: file.quantile,
		coldMs: coldEntry.coldMs,
		coldRunsMs: coldEntry.runs.map((entry) => entry.totalMs),
		warmMs: warmEntry.totalMs,
		warmSamplesMs: warmEntry.samplesMs,
		passMs: passEntry.totalMs,
		sllMs: coldRun.sllMs,
		llMs: coldRun.llMs,
		fallback: coldRun.fallback,
		errors: coldRun.errors,
		tokens: coldRun.tokens,
		rssKb: coldRun.rssKb,
	};
});

const result = {
	language: 'go',
	generatedAt: new Date().toISOString(),
	machine: machine(),
	corpus: corpusMetadata(manifest),
	config: {
		antlr: '4.13.1',
		runtime: 'github.com/antlr4-go/antlr/v4 v4.13.1',
		toolchain: 'go1.23.12',
		prediction: 'sll-first-with-ll-fallback',
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
			rssKb: passOutput.maxRssKb,
		},
		peakRssKb: Math.max(...files.map((file) => file.rssKb), warmOutput.maxRssKb, passOutput.maxRssKb),
		fallbacks: files.filter((file) => file.fallback).map((file) => file.path),
	},
};

writeJson(resultFile('go'), result);
process.stdout.write(
	`Go results: ${resultFile('go')}\n` +
		`  cold p50/p95/max ${result.aggregate.cold.p50Ms.toFixed(3)} / ${result.aggregate.cold.p95Ms.toFixed(3)} / ${result.aggregate.cold.maxMs.toFixed(3)} ms\n` +
		`  warm p50/p95/max ${result.aggregate.warm.p50Ms.toFixed(3)} / ${result.aggregate.warm.p95Ms.toFixed(3)} / ${result.aggregate.warm.maxMs.toFixed(3)} ms\n` +
		`  one-pass ${result.aggregate.onePass.totalMs.toFixed(3)} ms\n`,
);
