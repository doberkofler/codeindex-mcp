import path from 'node:path';
import {here, parseCommonOptions, run} from './lib.mjs';

const usage = `Usage: node benchmark/oracle-antlr-runtime/run-benchmark.mjs [options]

Runs Go, Rust, and TypeScript independently, then combines their result files.

Options:
  --languages <list>  Comma-separated subset of go,rust,typescript
  --skip-ts           Alias for excluding typescript
  --evidence <path>   Frozen Oracle evidence root
  --iterations <n>    Warm parse samples per file (default: 5)
  --warmups <n>       Warm parse warmups per file (default: 1)
  --cold-repeats <n>  Isolated cold processes per file (default: 3)
  --skip-build        Reuse existing Docker images
  --platform <name>   Docker platform (default: host architecture)
  --help              Show this message
`;

let languages = ['go', 'rust', 'typescript'];
const args = process.argv.slice(2);

if (args.includes('--help')) {
	process.stdout.write(usage);
	process.exit(0);
}

for (let index = 0; index < args.length; index += 1) {
	const argument = args[index];

	if (argument === '--languages') {
		const value = args[index + 1];

		if (value === undefined) {
			throw new Error('Missing value for --languages');
		}

		languages = value.split(',').map((language) => language.trim());

		if (languages.some((language) => !['go', 'rust', 'typescript'].includes(language))) {
			throw new Error('--languages must contain only go, rust, and typescript');
		}

		index += 1;
	}
}

if (args.includes('--skip-ts')) {
	languages = languages.filter((language) => language !== 'typescript');
}

const runnerArgs = [];

for (let index = 0; index < args.length; index += 1) {
	const argument = args[index];

	if (argument === '--languages') {
		index += 1;
		continue;
	}

	if (argument !== '--skip-ts') {
		runnerArgs.push(argument);
	}
}

const options = parseCommonOptions(['node', 'run-benchmark.mjs', ...runnerArgs]);
const common = [
	...(options.evidence === '' ? [] : ['--evidence', options.evidence]),
	'--iterations',
	String(options.iterations),
	'--warmups',
	String(options.warmups),
	'--cold-repeats',
	String(options.coldRepeats),
	'--platform',
	options.platform,
	...(options.skipBuild ? ['--skip-build'] : []),
];

for (const language of languages) {
	process.stdout.write(`\n=== ${language} ===\n`);
	run(process.execPath, [path.join(here, language, 'run.mjs'), ...common], {stdio: 'inherit'});
}

process.stdout.write('\n=== combined ===\n');
run(process.execPath, [path.join(here, 'combine-results.mjs')], {stdio: 'inherit'});
