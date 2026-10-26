import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {z} from 'zod';
import {type BenchmarkReportType} from '../src/core/benchmark/benchTypes.ts';
import {type BundleType, loadReport} from './oraclePerformanceReports.ts';

const {join, resolve} = path;
const LOG_LIMIT = 8 * 1024 * 1024;
const CHILD_TIMEOUT_MS = 30 * 60 * 1000;
const SOURCE_EXTENSIONS = new Set(['.pks', '.pkg', '.pkb', '.prc', '.fnc', '.sql']);

export type OptionsType = Readonly<{
	bundlePath: string;
	thresholdsPath: string;
	summaryPath: string;
	outputPath: string;
	evidenceRoot: string;
	runs: number;
	warmups: number;
	iterations: number;
	editRounds: number;
	maxDepth: number;
	pageLimit: number;
	keepWorkspaces: boolean;
	allowDirty: boolean;
}>;

export type RepetitionType = Readonly<{
	cold: BenchmarkReportType;
	warm: BenchmarkReportType;
	rebuild: BenchmarkReportType;
	deep: BenchmarkReportType;
	edit: BenchmarkReportType;
	databaseSchemaVersion: string;
}>;

type OptionValuesType = Readonly<{
	values: Readonly<Record<string, string | undefined>>;
	keepWorkspaces: boolean;
	allowDirty: boolean;
}>;

const numberArgument = (input: Readonly<{name: string; value: string | undefined; minimum: number; maximum: number; fallback: number}>): number => {
	if (input.value === undefined) {
		return input.fallback;
	}

	const parsed = Number(input.value);

	if (!Number.isInteger(parsed) || parsed < input.minimum || parsed > input.maximum) {
		throw new Error(`${input.name} must be an integer between ${String(input.minimum)} and ${String(input.maximum)}`);
	}

	return parsed;
};

const expandHome = (value: string): string => (value === '~' || value.startsWith('~/') ? join(os.homedir(), value.slice(1)) : value);

const parsePairs = (argv: readonly string[]): OptionValuesType => {
	const values: Record<string, string> = {};
	const flags = new Set<string>();
	let keepWorkspaces = false;
	let allowDirty = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv.at(index);

		if (argument === '--keep-workspaces') {
			keepWorkspaces = true;
			continue;
		}

		if (argument === '--allow-dirty') {
			allowDirty = true;
			continue;
		}

		if (argument === undefined || !argument.startsWith('--')) {
			throw new Error(`Unknown argument: ${String(argument)}`);
		}

		const value = argv.at(index + 1);

		if (value === undefined) {
			throw new Error(`Missing value for ${argument}`);
		}

		const name = argument.slice(2);

		if (flags.has(name)) {
			throw new Error(`Duplicate argument: ${argument}`);
		}

		flags.add(name);
		values[name] = value;
		index += 1;
	}

	return {values, keepWorkspaces, allowDirty};
};

const KNOWN_OPTIONS = new Set([
	'bundle',
	'thresholds',
	'summary',
	'output',
	'evidence-root',
	'runs',
	'warmups',
	'iterations',
	'edit-rounds',
	'max-depth',
	'page-limit',
]);

const buildOptions = (
	input: Readonly<{
		values: Readonly<Record<string, string | undefined>>;
		keepWorkspaces: boolean;
		allowDirty: boolean;
		environment: NodeJS.ProcessEnv;
	}>,
): OptionsType => {
	for (const name of Object.keys(input.values)) {
		if (!KNOWN_OPTIONS.has(name)) {
			throw new Error(`Unknown argument: --${name}`);
		}
	}

	const repositoryRoot = resolve(import.meta.dirname, '..');
	const evidenceRoot = resolve(
		repositoryRoot,
		expandHome(input.values['evidence-root'] ?? input.environment['CODEINDEX_EVIDENCE_ROOT'] ?? join(os.homedir(), '.local/share/codeindex-mcp')),
	);
	const timestamp = new Date()
		.toISOString()
		.replaceAll(':', '')
		.replace(/\.\d{3}Z$/u, 'Z');

	return {
		bundlePath: resolve(repositoryRoot, input.values['bundle'] ?? 'benchmark/oracle-production-20261027/corpus.json'),
		thresholdsPath: resolve(repositoryRoot, input.values['thresholds'] ?? 'benchmark/oracle-performance/thresholds.json'),
		summaryPath: resolve(repositoryRoot, input.values['summary'] ?? 'benchmark/oracle-performance/summary.json'),
		outputPath: resolve(repositoryRoot, input.values['output'] ?? join(evidenceRoot, 'oracle-performance', timestamp)),
		evidenceRoot,
		runs: numberArgument({name: '--runs', value: input.values['runs'], minimum: 1, maximum: 20, fallback: 5}),
		warmups: numberArgument({name: '--warmups', value: input.values['warmups'], minimum: 0, maximum: 5, fallback: 1}),
		iterations: numberArgument({name: '--iterations', value: input.values['iterations'], minimum: 1, maximum: 10_000, fallback: 20}),
		editRounds: numberArgument({name: '--edit-rounds', value: input.values['edit-rounds'], minimum: 1, maximum: 1000, fallback: 5}),
		maxDepth: numberArgument({name: '--max-depth', value: input.values['max-depth'], minimum: 1, maximum: 10_000_000, fallback: 10_000}),
		pageLimit: numberArgument({name: '--page-limit', value: input.values['page-limit'], minimum: 1, maximum: 10_000, fallback: 200}),
		keepWorkspaces: input.keepWorkspaces,
		allowDirty: input.allowDirty,
	};
};

export const parseOptions = (argv: readonly string[], environment: NodeJS.ProcessEnv): OptionsType | null => {
	if (argv.includes('--help')) {
		return null;
	}

	const pairs = parsePairs(argv);
	return buildOptions({...pairs, environment});
};

export const cleanEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
	const cleaned: NodeJS.ProcessEnv = {};

	for (const [name, value] of Object.entries(environment)) {
		if (!name.startsWith('CODE_INDEX_')) {
			cleaned[name] = value;
		}
	}

	return {...cleaned, CODE_INDEX_ANALYTICS: 'false', CODE_INDEX_PROJECT_ID: 'oracle-production-20261025', NO_COLOR: '1'};
};

const appendBounded = (current: string, chunk: string): string => (current.length >= LOG_LIMIT ? current : (current + chunk).slice(0, LOG_LIMIT));

const writeLog = (
	input: Readonly<{logPath: string; arguments: readonly string[]; exitCode: number; durationMs: number; stdout: string; stderr: string}>,
): void => {
	mkdirSync(path.dirname(input.logPath), {recursive: true});
	writeFileSync(
		input.logPath,
		[
			`$ ${process.execPath} ${input.arguments.join(' ')}`,
			`exit: ${String(input.exitCode)}`,
			`duration: ${input.durationMs.toFixed(1)} ms`,
			'',
			'--- stdout ---',
			input.stdout,
			'--- stderr ---',
			input.stderr,
			'',
		].join('\n'),
		{encoding: 'utf8'},
	);
};

export const executeCli = (
	input: Readonly<{
		cliPath: string;
		arguments: readonly string[];
		environment: NodeJS.ProcessEnv;
		logPath: string;
	}>,
): void => {
	const startedAt = performance.now();
	const result = spawnSync(process.execPath, [input.cliPath, ...input.arguments], {
		cwd: resolve(import.meta.dirname, '..'),
		env: input.environment,
		encoding: 'utf8',
		maxBuffer: LOG_LIMIT,
		timeout: CHILD_TIMEOUT_MS,
	});
	const durationMs = performance.now() - startedAt;
	const stdout = appendBounded('', result.stdout);
	const stderr = `${appendBounded('', result.stderr)}${result.error === undefined ? '' : `\n${result.error.message}`}`;
	const exitCode = result.status ?? 1;

	writeLog({logPath: input.logPath, arguments: [input.cliPath, ...input.arguments], exitCode, durationMs, stdout, stderr});

	if (result.status !== 0) {
		throw new Error(`CLI failed with exit code ${String(exitCode)}: ${stderr.trim().split('\n').slice(-5).join(' ')}`);
	}
};

const sourceFilesOf = (root: string): readonly Readonly<{path: string; bytes: number}>[] => {
	const files: Readonly<{path: string; bytes: number}>[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, {withFileTypes: true})) {
			const absolutePath = join(directory, entry.name);

			if (entry.isDirectory()) {
				visit(absolutePath);
			} else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
				files.push({path: path.relative(root, absolutePath).split(path.sep).join('/'), bytes: statSync(absolutePath).size});
			}
		}
	};

	visit(root);
	return files.sort((left, right) => left.bytes - right.bytes || left.path.localeCompare(right.path));
};

export const readHash = (filePath: string): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');

export const medianEditTargetOf = (workspace: string): Readonly<{relativePath: string; bytes: number; sha256: string}> => {
	const files = sourceFilesOf(workspace);
	const target = files.at(Math.floor((files.length - 1) / 2));

	if (target === undefined) {
		throw new Error('The frozen corpus contains no Oracle source file');
	}

	return {relativePath: target.path, bytes: target.bytes, sha256: readHash(join(workspace, target.path))};
};

export const sqliteVersion = (): string => {
	const database = new DatabaseSync(':memory:');

	try {
		return z.object({version: z.string()}).parse(database.prepare('select sqlite_version() as version').get()).version;
	} finally {
		database.close();
	}
};

export const schemaVersionOf = (databasePath: string): string => {
	const database = new DatabaseSync(databasePath, {readOnly: true});

	try {
		return z.object({value: z.string()}).parse(database.prepare("select value from metadata where key = 'schema_version'").get()).value;
	} finally {
		database.close();
	}
};

export const bundlesOf = (repositoryRoot: string): Readonly<Record<'mcp' | 'cli', Readonly<{rawBytes: number; gzipBytes: number; sha256: string}>>> => {
	const measure = (name: string): Readonly<{rawBytes: number; gzipBytes: number; sha256: string}> => {
		const filePath = join(repositoryRoot, 'dist', name);

		if (!existsSync(filePath)) {
			throw new Error(`Built bundle is missing: dist/${name}. Run pnpm build first.`);
		}

		const content = readFileSync(filePath);
		return {rawBytes: content.byteLength, gzipBytes: gzipSync(content, {level: 9}).byteLength, sha256: createHash('sha256').update(content).digest('hex')};
	};

	return {mcp: measure('mcp.mjs'), cli: measure('cli.mjs')};
};

export const gitIdentity = (repositoryRoot: string): Readonly<{commit: string; dirty: boolean}> => {
	const commit = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: repositoryRoot, encoding: 'utf8'});
	const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: repositoryRoot, encoding: 'utf8'});

	if (commit.status !== 0 || status.status !== 0) {
		throw new Error('Unable to read the Git identity of the runtime commit');
	}

	return {commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0};
};

export const writeChecksums = (directory: string): void => {
	const entries: string[] = [];
	const visit = (current: string): void => {
		for (const entry of readdirSync(current, {withFileTypes: true})) {
			const absolutePath = join(current, entry.name);

			if (entry.isDirectory()) {
				visit(absolutePath);
			} else if (entry.isFile() && entry.name !== 'checksums.sha256') {
				entries.push(`${readHash(absolutePath)}  ${path.relative(directory, absolutePath).split(path.sep).join('/')}`);
			}
		}
	};

	visit(directory);
	writeFileSync(join(directory, 'checksums.sha256'), `${entries.sort((left, right) => left.localeCompare(right)).join('\n')}\n`, {encoding: 'utf8'});
};

const nodeArgumentsOf = (options: OptionsType, input: Readonly<{root: string; projectFile: string; database: string}>): readonly string[] => [
	'benchmark',
	'--root',
	input.root,
	'--project-file',
	input.projectFile,
	'--extractor',
	'oracle',
	'--database',
	input.database,
	'--disposable',
	'--iterations',
	String(options.iterations),
	'--max-depth',
	String(options.maxDepth),
	'--page-limit',
	String(options.pageLimit),
];

const runReports = (
	input: Readonly<{
		options: OptionsType;
		cliPath: string;
		environment: NodeJS.ProcessEnv;
		id: string;
		directory: string;
		base: readonly string[];
		editTarget: string;
	}>,
): Omit<RepetitionType, 'databaseSchemaVersion'> => {
	const run = (name: string, scenarios: string, extra: readonly string[] = []): BenchmarkReportType => {
		const outputPath = join(input.directory, `${name}.json`);
		executeCli({
			cliPath: input.cliPath,
			arguments: [...input.base, '--scenarios', scenarios, ...extra, '--output', outputPath],
			environment: input.environment,
			logPath: join(input.options.outputPath, 'logs', `${input.id}-${name}.log`),
		});
		return loadReport(outputPath);
	};

	return {
		cold: run('cold', 'cold'),
		warm: run('warm', 'warm'),
		rebuild: run('rebuild', 'rebuild'),
		deep: run('deep', 'deep'),
		edit: run('edit', 'edit', ['--edit-target', input.editTarget, '--edit-rounds', String(input.options.editRounds)]),
	};
};

export const executeRepetition = (
	input: Readonly<{
		kind: 'warmup' | 'measured';
		index: number;
		options: OptionsType;
		bundle: BundleType;
		workspace: string;
		editTarget: string;
		cliPath: string;
		environment: NodeJS.ProcessEnv;
	}>,
): RepetitionType => {
	const id = `${input.kind}-${String(input.index).padStart(2, '0')}`;
	const directory = join(input.options.outputPath, input.kind === 'warmup' ? 'warmups' : 'runs', id);
	const workspace = join(directory, 'workspace');
	const database = join(directory, 'index.sqlite');

	mkdirSync(directory, {recursive: true});
	cpSync(input.workspace, workspace, {recursive: true});
	const startedAt = performance.now();

	try {
		const reports = runReports({
			options: input.options,
			cliPath: input.cliPath,
			environment: input.environment,
			id,
			directory,
			base: nodeArgumentsOf(input.options, {root: workspace, projectFile: join(workspace, input.bundle.snapshot.projectFile), database}),
			editTarget: input.editTarget,
		});
		const databaseSchemaVersion = schemaVersionOf(database);
		const durationMs = performance.now() - startedAt;

		writeFileSync(
			join(directory, 'repetition.json'),
			`${JSON.stringify({id, kind: input.kind, startedAt: new Date(Date.now() - durationMs).toISOString(), durationMs}, null, 2)}\n`,
			{encoding: 'utf8'},
		);

		return {...reports, databaseSchemaVersion};
	} finally {
		if (!input.options.keepWorkspaces) {
			rmSync(workspace, {recursive: true, force: true});
			for (const suffix of ['', '-wal', '-shm']) {
				rmSync(`${database}${suffix}`, {force: true});
			}
		}
	}
};
