import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {cpus} from 'node:os';
import path from 'node:path';

export const here = import.meta.dirname;
export const repoRoot = path.resolve(here, '../..');
export const workDir = path.join(here, '.work');
export const corpusDir = path.join(workDir, 'corpus');
export const resultsDir = path.join(workDir, 'results');

export const run = (command, args, runOptions = {}) => {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024,
		...runOptions,
	});

	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed with code ${String(result.status)}\n` + `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
		);
	}

	return result;
};

export const parseJsonOutput = (text) => {
	const start = text.indexOf('{');

	if (start < 0) {
		throw new Error(`No JSON object in output:\n${text}`);
	}

	return JSON.parse(text.slice(start));
};

export const stats = (values) => {
	const sorted = [...values].sort((left, right) => left - right);
	const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];

	return {
		count: sorted.length,
		sumMs: sorted.reduce((total, value) => total + value, 0),
		p50Ms: percentile(0.5),
		p95Ms: percentile(0.95),
		maxMs: sorted.at(-1) ?? 0,
	};
};

export const median = (values) => stats(values).p50Ms;

export const machine = () => ({
	platform: process.platform,
	arch: process.arch,
	cpus: cpus().length,
});

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export const writeJson = (file, value) => {
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

export const selectCorpus = ({evidence = ''} = {}) => {
	const args = [path.join(here, 'select-corpus.mjs'), '--out', corpusDir];

	if (evidence !== '') {
		args.push('--evidence', evidence);
	}

	run(process.execPath, args);
	return readJson(path.join(corpusDir, 'manifest.json'));
};

export const copyCorpus = (target) => {
	cpSync(corpusDir, path.join(target, 'corpus'), {recursive: true});
};

export const resultFile = (language) => path.join(resultsDir, `${language}.json`);

export const parseCommonOptions = (argv) => {
	const options = {
		evidence: process.env['CODEINDEX_EVIDENCE_ROOT'] ?? '',
		iterations: 5,
		warmups: 1,
		coldRepeats: 3,
		skipBuild: false,
		platform: process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
	};

	for (let index = 2; index < argv.length; index += 1) {
		const argument = argv[index];
		const value = argv[index + 1];

		if (argument === '--skip-build') {
			options.skipBuild = true;
			continue;
		}

		if (value === undefined) {
			throw new Error(`Missing value for ${argument}`);
		}

		switch (argument) {
			case '--evidence': {
				options.evidence = path.resolve(value);
				break;
			}
			case '--iterations': {
				options.iterations = Number(value);
				break;
			}
			case '--warmups': {
				options.warmups = Number(value);
				break;
			}
			case '--cold-repeats': {
				options.coldRepeats = Number(value);
				break;
			}
			case '--platform': {
				options.platform = value;
				break;
			}
			default: {
				throw new Error(`Unknown argument: ${argument}`);
			}
		}

		index += 1;
	}

	if (!Number.isInteger(options.iterations) || options.iterations < 1) {
		throw new Error('--iterations must be a positive integer');
	}
	if (!Number.isInteger(options.warmups) || options.warmups < 0) {
		throw new Error('--warmups must be a non-negative integer');
	}
	if (!Number.isInteger(options.coldRepeats) || options.coldRepeats < 1) {
		throw new Error('--cold-repeats must be a positive integer');
	}

	return options;
};

export const corpusMetadata = (manifest) => ({
	sourceFiles: manifest.sourceFiles,
	sourceBytes: manifest.sourceBytes,
	files: manifest.files.length,
	sampleBytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
	selection: manifest.selection,
});

export const docker = (image, args, extra = []) =>
	run('docker', ['run', '--rm', '--network', 'none', '--cpus', '4', '--memory', '4g', ...extra, image, ...args]);
