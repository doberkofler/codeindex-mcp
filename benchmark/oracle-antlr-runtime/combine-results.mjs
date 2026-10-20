import {existsSync} from 'node:fs';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {readJson, resultFile, resultsDir, writeJson} from './lib.mjs';

const languages = ['go', 'rust', 'typescript'];
const labels = {go: 'Go', rust: 'Rust', typescript: 'TS core'};
const results = {};

for (const language of languages) {
	const file = resultFile(language);

	if (existsSync(file)) {
		results[language] = readJson(file);
	}
}

const available = Object.keys(results);

if (available.length === 0) {
	throw new Error('No language results found. Run go/run.mjs, rust/run.mjs, or typescript/run.mjs first.');
}

const corpus = results[available[0]].corpus;
const files = new Map();

for (const language of available) {
	for (const file of results[language].files) {
		if (!files.has(file.path)) {
			files.set(file.path, {path: file.path, bytes: file.bytes});
		}
	}
}

const rows = [...files.values()];

const value = (language, file, key) => results[language]?.files.find((entry) => entry.path === file.path)?.[key];

const number = (input) => (typeof input === 'number' ? input.toFixed(3) : '—');

const table = [
	`| File | Bytes | ${languages.map((language) => `${labels[language]} cold`).join(' | ')} | ${languages.map((language) => `${labels[language]} warm`).join(' | ')} | ${languages.map((language) => `${labels[language]} pass`).join(' | ')} |`,
	`| --- | ---: | ${languages.map(() => '---:').join(' | ')} | ${languages.map(() => '---:').join(' | ')} | ${languages.map(() => '---:').join(' | ')} |`,
	...rows.map((file) => {
		const cells = [file.path, String(file.bytes)];

		for (const key of ['coldMs', 'warmMs', 'passMs']) {
			for (const language of languages) {
				cells.push(number(value(language, file, key)));
			}
		}

		return `| ${cells.join(' | ')} |`;
	}),
].join('\n');

const aggregate = [
	'| Language | Cold p50 | Cold p95 | Cold max | Warm p50 | Warm p95 | Warm max | One-pass | Peak RSS |',
	'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
	...available.map((language) => {
		const entry = results[language].aggregate;
		return `| ${labels[language]} | ${entry.cold.p50Ms.toFixed(3)} | ${entry.cold.p95Ms.toFixed(3)} | ${entry.cold.maxMs.toFixed(3)} | ${entry.warm.p50Ms.toFixed(3)} | ${entry.warm.p95Ms.toFixed(3)} | ${entry.warm.maxMs.toFixed(3)} | ${entry.onePass.totalMs.toFixed(3)} | ${(entry.peakRssKb / 1024).toFixed(1)} MB |`;
	}),
].join('\n');

const relative = [];

if (results.go !== undefined) {
	for (const language of available) {
		if (language !== 'go') {
			relative.push(
				`| ${labels[language]} vs Go one-pass | ${(results[language].aggregate.onePass.totalMs / results.go.aggregate.onePass.totalMs).toFixed(2)}× |`,
			);
		}
	}
}

const relativeTable = relative.length === 0 ? '' : ['| Comparison | Ratio |', '| --- | ---: |', ...relative].join('\n');

const summary = {
	generatedAt: new Date().toISOString(),
	corpus,
	languages: Object.fromEntries(
		available.map((language) => [
			language,
			{
				config: results[language].config,
				aggregate: results[language].aggregate,
				files: results[language].files,
			},
		]),
	),
};

mkdirSync(resultsDir, {recursive: true});
writeJson(path.join(resultsDir, 'summary.json'), summary);

const markdown = [
	`# Oracle ANTLR Runtime Comparison`,
	'',
	table,
	'',
	'## Aggregate',
	'',
	aggregate,
	...(relativeTable === '' ? [] : ['', relativeTable]),
	'',
].join('\n');

writeFileSync(path.join(resultsDir, 'summary.md'), markdown);
process.stdout.write(`\n${table}\n\n${aggregate}\n`);
if (relativeTable !== '') {
	process.stdout.write(`\n${relativeTable}\n`);
}
process.stdout.write(`\nCombined results: ${path.join(resultsDir, 'summary.json')}\n`);
