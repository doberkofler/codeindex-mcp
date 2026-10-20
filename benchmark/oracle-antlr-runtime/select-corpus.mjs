import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const defaultEvidence = path.join(homedir(), '.local/share/codeindex-mcp/oracle-live/2eb1e36f6ecdada4');
const sourceExtensions = new Set(['.sql', '.pks', '.pkb', '.prc', '.fnc', '.trg', '.typ', '.tyb']);
const quantiles = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 1];

const usage = `Usage: node benchmark/oracle-antlr-runtime/select-corpus.mjs [options]

Options:
  --evidence <path>  Frozen Oracle evidence root
  --out <path>       Output directory (default: benchmark/oracle-antlr-runtime/.work/corpus)
  --help             Show this message
`;

const options = {
	evidence: process.env['CODEINDEX_EVIDENCE_ROOT'] ?? defaultEvidence,
	out: path.resolve(import.meta.dirname, '.work/corpus'),
};

for (let index = 2; index < process.argv.length; index += 1) {
	const argument = process.argv[index];
	const value = process.argv[index + 1];

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
		case '--out': {
			options.out = path.resolve(value);
			break;
		}
		default: {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}

	index += 1;
}

const workspace = path.join(options.evidence, 'workspace');

if (!statSync(workspace, {throwIfNoEntry: false})?.isDirectory()) {
	throw new Error(`Evidence workspace not found: ${workspace}\nRun a live qualification first or pass --evidence.`);
}

const files = readdirSync(workspace, {recursive: true})
	.filter((entry) => typeof entry === 'string')
	.map((entry) => path.join(workspace, entry))
	.filter((file) => sourceExtensions.has(path.extname(file).toLowerCase()))
	.map((file) => ({file, bytes: statSync(file).size}))
	.sort((left, right) => left.bytes - right.bytes || left.file.localeCompare(right.file));

if (files.length === 0) {
	throw new Error(`No Oracle source files found under ${workspace}`);
}

const filesOut = path.join(options.out, 'files');
rmSync(filesOut, {recursive: true, force: true});
mkdirSync(filesOut, {recursive: true});

const selected = [];
const seen = new Set();

for (const quantile of quantiles) {
	const index = Math.round(quantile * (files.length - 1));
	const entry = files[index];

	if (seen.has(entry.file)) {
		continue;
	}

	seen.add(entry.file);

	const id = String(selected.length).padStart(2, '0');
	const target = `${id}-${path.basename(entry.file)}`;

	copyFileSync(entry.file, path.join(filesOut, target));

	selected.push({
		id: selected.length,
		path: path.relative(workspace, entry.file).split(path.sep).join('/'),
		file: target,
		bytes: entry.bytes,
		lines: readFileSync(entry.file, 'utf8').split(/\r?\n/u).length,
		quantile,
		sha256: createHash('sha256').update(readFileSync(entry.file)).digest('hex'),
	});
}

const manifest = {
	evidence: options.evidence,
	workspace,
	sourceFiles: files.length,
	sourceBytes: files.reduce((total, entry) => total + entry.bytes, 0),
	selection: 'Oracle source size quantiles 0,5,10,...,100%',
	files: selected,
};

writeFileSync(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(
	`Selected ${String(selected.length)} of ${String(files.length)} files (${String(manifest.sourceBytes)} bytes)\n` +
		`Manifest: ${path.join(options.out, 'manifest.json')}\n`,
);
