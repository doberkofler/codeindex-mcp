import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parseWithAntlrProfiled} from '../../../src/adapters/oracle/antlrParser.ts';

const manifestPath = process.env.BENCH_MANIFEST;
const filesRoot = process.env.BENCH_FILES;
const index = process.env.BENCH_INDEX === undefined ? -1 : Number(process.env.BENCH_INDEX);
const warm = process.env.BENCH_WARM === '1';
const iterations = Number(process.env.BENCH_ITERATIONS ?? '5');
const warmups = Number(process.env.BENCH_WARMUPS ?? '1');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const selected = index >= 0 ? [manifest.files[index]] : manifest.files;

const parseOnce = (source, file) => {
	const started = performance.now();
	const {result, profile} = parseWithAntlrProfiled({source, path: file.path, defaultSchema: 'BENCH'});
	const totalMs = performance.now() - started;
	// Compare the Go lexer+parser harness with the TypeScript lexer+parser core,
	// not with tokenization, conditional preparation, or semantic visitors.
	const coreMs = profile.lexerMs + profile.sllParseMs + profile.llParseMs;
	return {ms: coreMs, totalMs, diagnostics: result.diagnostics.length, profile};
};

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const results = [];
for (const file of selected) {
	const source = readFileSync(path.join(filesRoot, file.file), 'utf8');
	const result = {id: file.id, path: file.path, bytes: file.bytes, lines: file.lines, quantile: file.quantile};
	if (warm) {
		for (let i = 0; i < warmups; i += 1) {
			parseOnce(source, file);
		}
		const samples = [];
		let last;
		for (let i = 0; i < iterations; i += 1) {
			last = parseOnce(source, file);
			samples.push(last.ms);
		}
		result.warm = {ms: median(samples), totalMs: last.totalMs, diagnostics: last.diagnostics};
		result.samplesMs = samples;
	} else {
		result.cold = parseOnce(source, file);
	}
	results.push(result);
}

const rss = process.resourceUsage().maxRSS;
process.stdout.write(
	JSON.stringify({mode: warm ? 'warm-in-process' : index >= 0 ? 'cold-isolated-process' : 'cold-single-process', maxRssKb: rss, files: results}, null, 2) +
		'\n',
);
