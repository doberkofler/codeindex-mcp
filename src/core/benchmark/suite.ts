import {existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {type BenchmarkIoType} from './finalize.ts';
import {
	artifactsExist,
	git,
	identityOf,
	readManifest,
	repositoryRootOf,
	sameIdentity,
	sha256File,
	verifyPublicProject,
	writeManifest,
	type SuiteManifestType,
} from './suiteManifest.ts';
import {executeStep, resolveStepPaths} from './suiteSteps.ts';
import {buildSuiteSummary} from './suiteSummary.ts';
import {expandHome, loadBenchmarkSuite, resolveProjectsRoot, type BenchmarkSuiteType} from './suiteTypes.ts';

const {isAbsolute, join, relative, resolve, sep} = path;

const usage = `Usage: codeindex-cli benchmark-suite --suite <path> [options]

Runs a declarative reference qualification suite: generated profiles,
pinned public projects, and TypeScript reference verification. Writes an
immutable evidence directory with a manifest, reports, and checksums.

Options:
  --suite <path>         Suite manifest (default: benchmark/suites/reference.json)
  --output <path>        Evidence directory (default: ~/codeindex-evidence/<suite>-<timestamp>)
  --resume               Reuse passed steps from an existing evidence directory
  --allow-dirty          Permit a dirty CodeIndex checkout
  --keep-workspace       Retain generated corpora after the run
  --fail-fast            Stop after the first failed step
  --projects-root <path> Override the public-project checkout root
  --iterations <n>       Override query iterations for every step
  --help                 Print this message
`;

type SuiteOptionsType = Readonly<{
	suite?: string | undefined;
	output?: string | undefined;
	resume: boolean;
	'allow-dirty': boolean;
	'keep-workspace': boolean;
	'fail-fast': boolean;
	'projects-root'?: string | undefined;
	iterations?: string | undefined;
	help: boolean;
}>;

const parseSuiteArgs = (argv: readonly string[]): SuiteOptionsType =>
	parseArgs({
		args: [...argv],
		options: {
			suite: {type: 'string'},
			output: {type: 'string'},
			resume: {type: 'boolean', default: false},
			'allow-dirty': {type: 'boolean', default: false},
			'keep-workspace': {type: 'boolean', default: false},
			'fail-fast': {type: 'boolean', default: false},
			'projects-root': {type: 'string'},
			iterations: {type: 'string'},
			help: {type: 'boolean', default: false},
		},
		allowPositionals: false,
	}).values;

type RunInputsType = Readonly<{
	values: SuiteOptionsType;
	suitePath: string;
	suite: BenchmarkSuiteType;
	repositoryRoot: string;
	outputDir: string;
	projectsRoot: string;
	effectiveSuite: BenchmarkSuiteType;
	dirty: boolean;
}>;

const relativePosix = (root: string, filePath: string): string => relative(root, filePath).split(sep).join('/');

const isInsideRepository = (repositoryRoot: string, candidate: string): boolean => {
	const relativePath = relative(repositoryRoot, candidate);
	return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
};

const collectChecksums = (outputDir: string): readonly string[] => {
	const lines: string[] = [];

	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, {withFileTypes: true})) {
			const absolutePath = join(directory, entry.name);

			if (entry.isDirectory()) {
				walk(absolutePath);
				continue;
			}

			if (entry.isFile() && entry.name !== 'checksums.sha256') {
				lines.push(`${sha256File(absolutePath)}  ${relativePosix(outputDir, absolutePath)}`);
			}
		}
	};

	walk(outputDir);
	return lines.sort();
};

const defaultOutputDir = (suiteId: string, home: string): string =>
	join(home, 'codeindex-evidence', `${suiteId}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`);

const prepareOutput = (input: Readonly<{outputDir: string; resume: boolean}>): void => {
	mkdirSync(input.outputDir, {recursive: true});

	if (!input.resume && readdirSync(input.outputDir).length > 0) {
		throw new Error(`Output directory is not empty: ${input.outputDir}; pass --resume or choose a new directory`);
	}

	if (input.resume && !existsSync(join(input.outputDir, 'manifest.json'))) {
		throw new Error(`Cannot resume: manifest.json not found in ${input.outputDir}`);
	}
};

const iterationsOverrideOf = (values: SuiteOptionsType): number | null => {
	if (values.iterations === undefined) {
		return null;
	}

	const value = Number(values.iterations);

	if (!Number.isInteger(value) || value < 1 || value > 10_000) {
		throw new Error('--iterations must be an integer between 1 and 10000');
	}

	return value;
};

const effectiveSuiteOf = (suite: BenchmarkSuiteType, iterations: number | null): BenchmarkSuiteType => ({
	...suite,
	generated: suite.generated.map((entry) => ({...entry, ...(iterations === null ? {} : {iterations})})),
	publicProjects: suite.publicProjects.map((entry) => ({...entry, ...(iterations === null ? {} : {iterations})})),
});

const resolveRunInputs = (
	input: Readonly<{
		values: SuiteOptionsType;
		cwd: string;
		home: string;
	}>,
): RunInputsType => {
	const suitePath = resolve(input.cwd, input.values.suite ?? 'benchmark/suites/reference.json');
	const suite = loadBenchmarkSuite(suitePath);
	const repositoryRoot = repositoryRootOf(input.cwd);
	const outputDir = resolve(input.cwd, expandHome(input.values.output ?? defaultOutputDir(suite.id, input.home), input.home));
	const projectsRoot = resolveProjectsRoot(suite, input.values['projects-root'], input.home, input.cwd);

	return {
		values: input.values,
		suitePath,
		suite,
		repositoryRoot,
		outputDir,
		projectsRoot,
		effectiveSuite: effectiveSuiteOf(suite, iterationsOverrideOf(input.values)),
		dirty: (git(repositoryRoot, ['status', '--porcelain']) ?? '') !== '',
	};
};

const baselinePathsOf = (suite: BenchmarkSuiteType, repositoryRoot: string): readonly string[] => [
	...new Set([
		...suite.generated.flatMap((entry) => (entry.baseline === null ? [] : [resolve(repositoryRoot, entry.baseline)])),
		...suite.publicProjects.flatMap((entry) => (entry.baseline === null ? [] : [resolve(repositoryRoot, entry.baseline)])),
	]),
];

const validateRun = (inputs: RunInputsType, cliPath: string): readonly string[] => {
	if (inputs.dirty && !inputs.values['allow-dirty'] && !inputs.values.resume) {
		throw new Error('CodeIndex checkout is dirty; commit or stash changes, or pass --allow-dirty');
	}

	if (!existsSync(cliPath)) {
		throw new Error(`CLI bundle not found at ${cliPath}; run pnpm build first`);
	}

	if (isInsideRepository(inputs.repositoryRoot, inputs.outputDir)) {
		throw new Error(`Evidence directory must be outside the repository: ${inputs.outputDir}`);
	}

	const baselines = baselinePathsOf(inputs.effectiveSuite, inputs.repositoryRoot);

	for (const baselinePath of baselines) {
		if (!existsSync(baselinePath)) {
			throw new Error(`Baseline not found: ${baselinePath}`);
		}
	}

	return baselines;
};

const completeSteps = (
	input: Readonly<{
		manifest: SuiteManifestType;
		steps: ReturnType<typeof resolveStepPaths>;
		completed: ReadonlyMap<string, SuiteManifestType['steps'][number]>;
		cliPath: string;
		environment: NodeJS.ProcessEnv;
		repositoryRoot: string;
		outputDir: string;
		failFast: boolean;
		io: BenchmarkIoType;
	}>,
): Readonly<{manifest: SuiteManifestType; failed: boolean}> => {
	const manifest: SuiteManifestType = {...input.manifest, steps: [...input.manifest.steps]};
	let failed = false;

	for (const step of input.steps) {
		const existing = input.completed.get(step.id);

		if (existing !== undefined) {
			manifest.steps.push(existing);
			input.io.stdout(`[skip] ${step.id} (resume)`);
			continue;
		}

		input.io.stdout(`[run]  ${step.id} — ${step.title}`);
		const result = executeStep({
			step,
			cliPath: input.cliPath,
			environment: input.environment,
			outputDir: input.outputDir,
			repositoryRoot: input.repositoryRoot,
		});
		manifest.steps.push(result);
		writeManifest(input.outputDir, manifest);
		input.io.stdout(`[${result.status === 'passed' ? 'ok' : 'fail'}] ${step.id} (${(result.durationMs / 1000).toFixed(1)} s)`);

		if (result.status === 'failed') {
			failed = true;

			if (result.detail !== null) {
				input.io.stderr(result.detail);
			}

			if (input.failFast) {
				break;
			}
		}
	}

	return {manifest, failed};
};

const runSuite = (
	input: Readonly<{
		values: SuiteOptionsType;
		environment: NodeJS.ProcessEnv;
		io: BenchmarkIoType;
		cliPath: string;
		cwd: string;
		home: string;
	}>,
): number => {
	const inputs = resolveRunInputs({values: input.values, cwd: input.cwd, home: input.home});
	const baselinePaths = validateRun(inputs, input.cliPath);
	const projects = inputs.effectiveSuite.publicProjects.map((entry) => verifyPublicProject({entry, projectsRoot: inputs.projectsRoot}));
	prepareOutput({outputDir: inputs.outputDir, resume: inputs.values.resume});
	const identity = identityOf({repositoryRoot: inputs.repositoryRoot, cliPath: input.cliPath});
	const suiteSha256 = sha256File(inputs.suitePath);
	const baselines = baselinePaths.map((baselinePath) => ({path: baselinePath, sha256: sha256File(baselinePath)}));
	const previous = inputs.values.resume ? readManifest(inputs.outputDir) : null;

	if (previous !== null) {
		if (previous.suite.sha256 !== suiteSha256) {
			throw new Error('Cannot resume: suite content changed');
		}

		if (!sameIdentity(previous.identity, identity)) {
			throw new Error('Cannot resume: CodeIndex commit, CLI bundle, or machine identity changed');
		}
	}

	const initialManifest: SuiteManifestType = {
		schemaVersion: 1,
		suite: {id: inputs.suite.id, path: relativePosix(inputs.repositoryRoot, inputs.suitePath), sha256: suiteSha256},
		identity,
		startedAt: previous?.startedAt ?? new Date().toISOString(),
		completedAt: null,
		status: 'running',
		baselines,
		projects,
		steps: [],
	};
	const completed = new Map(
		(previous?.steps ?? [])
			.filter((step) => step.status === 'passed' && artifactsExist(inputs.outputDir, step.artifacts))
			.map((step) => [step.id, step] as const),
	);

	writeManifest(inputs.outputDir, initialManifest);
	input.io.stdout(`Suite: ${inputs.suite.id} (${suiteSha256.slice(0, 12)})`);
	input.io.stdout(`Evidence: ${inputs.outputDir}`);

	const steps = resolveStepPaths({
		suite: inputs.effectiveSuite,
		repositoryRoot: inputs.repositoryRoot,
		outputDir: inputs.outputDir,
		projectsRoot: inputs.projectsRoot,
	});
	const result = completeSteps({
		manifest: initialManifest,
		steps,
		completed,
		cliPath: input.cliPath,
		environment: input.environment,
		repositoryRoot: inputs.repositoryRoot,
		outputDir: inputs.outputDir,
		failFast: inputs.values['fail-fast'],
		io: input.io,
	});

	if (!inputs.values['keep-workspace'] && !result.failed) {
		rmSync(join(inputs.outputDir, 'work'), {recursive: true, force: true});
	}

	rmSync(join(inputs.outputDir, 'tmp'), {recursive: true, force: true});
	const completedManifest: SuiteManifestType = {...result.manifest, completedAt: new Date().toISOString(), status: result.failed ? 'failed' : 'passed'};
	writeManifest(inputs.outputDir, completedManifest);
	writeFileSync(join(inputs.outputDir, 'summary.md'), buildSuiteSummary({manifest: completedManifest, outputDir: inputs.outputDir}), {encoding: 'utf8'});
	writeFileSync(join(inputs.outputDir, 'checksums.sha256'), `${collectChecksums(inputs.outputDir).join('\n')}\n`, {encoding: 'utf8'});
	input.io.stdout(`Summary: ${join(inputs.outputDir, 'summary.md')}`);
	input.io.stdout(`Status: ${completedManifest.status}`);

	return result.failed ? 1 : 0;
};

/**
 * Runs a declarative reference qualification suite.
 *
 * Every step spawns the installed CLI bundle in a fresh process. Passed steps
 * are reusable only when the suite, CLI artifact, commit, and machine identity
 * are unchanged.
 *
 * @param argv - Arguments after `benchmark-suite`.
 * @param environment - Environment source passed to child processes.
 * @param io - Output sinks.
 * @param options - Injected CLI path, working directory, and home directory.
 * @returns Process exit code: 1 when any step failed.
 */
export const runBenchmarkSuiteCommand = (
	argv: readonly string[],
	environment: NodeJS.ProcessEnv,
	io: BenchmarkIoType,
	options: Readonly<{cliPath: string; cwd?: string; home?: string}>,
): number => {
	try {
		const values = parseSuiteArgs(argv);

		if (values.help) {
			io.stdout(usage.trimEnd());
			return 0;
		}

		return runSuite({
			values,
			environment,
			io,
			cliPath: resolve(options.cliPath),
			cwd: options.cwd ?? process.cwd(),
			home: options.home ?? os.homedir(),
		});
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};
