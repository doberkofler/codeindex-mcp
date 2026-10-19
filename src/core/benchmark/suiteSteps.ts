import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {type SuiteStepResultType} from './suiteManifest.ts';
import {cleanChildEnvironment, failureDetail, runCommand} from './suiteCommand.ts';
import {type BenchmarkSuiteGeneratedType, type BenchmarkSuitePublicProjectType, type BenchmarkSuiteType} from './suiteTypes.ts';

const {dirname, join, relative, resolve, sep} = path;

export type PlannedStepType = Readonly<{
	id: string;
	kind: 'generated' | 'public' | 'reference';
	title: string;
	args: (input: Readonly<{cliPath: string; baselinePath: string | null; referencePath: string | null}>) => readonly string[];
	baselinePath: string | null;
	/** Earlier report used as the relative reference; availability is checked at execution. */
	referencePath: string | null;
	environment?: Readonly<Record<string, string>>;
	artifacts: readonly string[];
	logPath: string;
	stdoutPath?: string;
	cwd?: string;
	cleanupPaths?: readonly string[];
}>;

const relativePosix = (root: string, filePath: string): string => relative(root, filePath).split(sep).join('/');

const generatedColdStep = (
	input: Readonly<{
		entry: BenchmarkSuiteGeneratedType;
		workDir: string;
		outputDir: string;
		suffix: string;
	}>,
): PlannedStepType => {
	const coldPath = join(input.outputDir, 'generated', input.entry.profile, `cold-${input.suffix}.json`);

	return {
		id: `generated:${input.entry.profile}:cold:${input.suffix}`,
		kind: 'generated',
		title: `${input.entry.profile} cold build in a fresh process (run ${input.suffix})`,
		args: ({cliPath}) => [
			cliPath,
			'benchmark',
			'--profile',
			input.entry.profile,
			'--workspace',
			input.workDir,
			'--scenarios',
			'cold',
			'--iterations',
			String(input.entry.iterations),
			'--output',
			coldPath,
		],
		baselinePath: null,
		referencePath: null,
		artifacts: [coldPath],
		logPath: join(input.outputDir, 'logs', `generated-${input.entry.profile}-cold-${input.suffix}.log`),
	};
};

const generatedRunStep = (
	input: Readonly<{
		entry: BenchmarkSuiteGeneratedType;
		workDir: string;
		outputDir: string;
		suffix: string;
		baselinePath: string | null;
		referencePath: string | null;
	}>,
): PlannedStepType => {
	const runPath = join(input.outputDir, 'generated', input.entry.profile, `run-${input.suffix}.json`);
	const summaryPath = runPath.replace(/\.json$/u, '.md');
	const evaluationPath = runPath.replace(/\.json$/u, '.evaluation.json');

	return {
		id: `generated:${input.entry.profile}:run:${input.suffix}`,
		kind: 'generated',
		title: `${input.entry.profile} measured suite (run ${input.suffix})`,
		args: ({cliPath, baselinePath, referencePath}) => {
			const args = [
				cliPath,
				'benchmark',
				'--profile',
				input.entry.profile,
				'--workspace',
				input.workDir,
				'--scenarios',
				input.entry.scenarios.join(','),
				'--iterations',
				String(input.entry.iterations),
				'--edit-rounds',
				String(input.entry.editRounds),
				'--output',
				runPath,
				'--summary',
				summaryPath,
			];

			if (baselinePath !== null) {
				args.push('--baseline', baselinePath, '--evaluation', evaluationPath);
			}

			if (referencePath !== null) {
				args.push('--reference', referencePath);
			}

			return args;
		},
		baselinePath: input.baselinePath,
		referencePath: input.referencePath,
		artifacts: input.baselinePath === null ? [runPath, summaryPath] : [runPath, summaryPath, evaluationPath],
		logPath: join(input.outputDir, 'logs', `generated-${input.entry.profile}-${input.suffix}.log`),
	};
};

const generatedSteps = (
	input: Readonly<{
		entry: BenchmarkSuiteGeneratedType;
		repositoryRoot: string;
		outputDir: string;
	}>,
): readonly PlannedStepType[] => {
	const steps: PlannedStepType[] = [];
	const baselinePath = input.entry.baseline === null ? null : resolve(input.repositoryRoot, input.entry.baseline);

	for (let run = 1; run <= input.entry.runs; run += 1) {
		const suffix = String(run).padStart(2, '0');
		// Edit-to-fresh mutates source; every run starts from a pristine corpus.
		const workDir = join(input.outputDir, 'work', `${input.entry.profile}-${suffix}`);
		const firstRunPath = join(input.outputDir, 'generated', input.entry.profile, 'run-01.json');
		const referencePath = input.entry.reference === 'first-run' && run > 1 ? firstRunPath : null;

		if (input.entry.coldProcess) {
			steps.push(generatedColdStep({entry: input.entry, workDir, outputDir: input.outputDir, suffix}));
		}

		steps.push(generatedRunStep({entry: input.entry, workDir, outputDir: input.outputDir, suffix, baselinePath, referencePath}));
	}

	return steps;
};

const publicRunStep = (
	input: Readonly<{
		entry: BenchmarkSuitePublicProjectType;
		workspace: string;
		outputDir: string;
		suffix: string;
		baselinePath: string | null;
		referencePath: string | null;
	}>,
): PlannedStepType => {
	const runPath = join(input.outputDir, 'public', input.entry.name, `run-${input.suffix}.json`);
	const summaryPath = runPath.replace(/\.json$/u, '.md');
	const evaluationPath = runPath.replace(/\.json$/u, '.evaluation.json');

	return {
		id: `public:${input.entry.name}:run:${input.suffix}`,
		kind: 'public',
		title: `${input.entry.name} at ${input.entry.revision.slice(0, 12)} (run ${input.suffix})`,
		args: ({cliPath, baselinePath, referencePath}) => {
			const args = [
				cliPath,
				'benchmark',
				'--root',
				input.workspace,
				'--project-file',
				join(input.workspace, input.entry.projectFile),
				'--scenarios',
				input.entry.scenarios.join(','),
				'--iterations',
				String(input.entry.iterations),
				'--output',
				runPath,
				'--summary',
				summaryPath,
			];

			if (baselinePath !== null) {
				args.push('--baseline', baselinePath, '--evaluation', evaluationPath);
			}

			if (referencePath !== null) {
				args.push('--reference', referencePath);
			}

			return args;
		},
		baselinePath: input.baselinePath,
		referencePath: input.referencePath,
		artifacts: input.baselinePath === null ? [runPath, summaryPath] : [runPath, summaryPath, evaluationPath],
		logPath: join(input.outputDir, 'logs', `public-${input.entry.name}-${input.suffix}.log`),
	};
};

const publicSteps = (
	input: Readonly<{
		entry: BenchmarkSuitePublicProjectType;
		repositoryRoot: string;
		projectsRoot: string;
		outputDir: string;
	}>,
): readonly PlannedStepType[] => {
	const steps: PlannedStepType[] = [];
	const workspace = join(input.projectsRoot, input.entry.directory);
	const baselinePath = input.entry.baseline === null ? null : resolve(input.repositoryRoot, input.entry.baseline);

	for (let run = 1; run <= input.entry.runs; run += 1) {
		const suffix = String(run).padStart(2, '0');
		const firstRunPath = join(input.outputDir, 'public', input.entry.name, 'run-01.json');
		const referencePath = input.entry.reference === 'first-run' && run > 1 ? firstRunPath : null;

		steps.push(publicRunStep({entry: input.entry, workspace, outputDir: input.outputDir, suffix, baselinePath, referencePath}));
	}

	return steps;
};

const referenceStep = (
	input: Readonly<{
		suite: BenchmarkSuiteType;
		repositoryRoot: string;
		outputDir: string;
	}>,
): PlannedStepType | null => {
	const settings = input.suite.referenceVerification;

	if (settings === undefined || !settings.enabled) {
		return null;
	}

	const root = resolve(input.repositoryRoot, settings.root);
	const reportPath = join(input.outputDir, 'references', 'typescript-language-service.json');
	const databasePath = join(input.outputDir, 'tmp', 'reference-verification.sqlite');

	return {
		id: 'reference:typescript',
		kind: 'reference',
		title: 'TypeScript language-service qualification',
		args: ({cliPath}) => [cliPath, 'qualify', '--extractor', 'typescript'],
		baselinePath: null,
		referencePath: null,
		environment: {
			CODE_INDEX_ROOT: root,
			CODE_INDEX_PROJECT_FILE: resolve(root, settings.projectFile),
			CODE_INDEX_DATABASE: databasePath,
		},
		artifacts: [reportPath],
		logPath: join(input.outputDir, 'logs', 'reference-typescript.log'),
		stdoutPath: reportPath,
		cwd: root,
		cleanupPaths: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
	};
};

/**
 * Expands a suite into its ordered executable steps.
 *
 * @param input - Suite, repository root, evidence directory, and checkout root.
 * @returns Ordered planned steps.
 */
export const resolveStepPaths = (
	input: Readonly<{
		suite: BenchmarkSuiteType;
		repositoryRoot: string;
		outputDir: string;
		projectsRoot: string;
	}>,
): readonly PlannedStepType[] => {
	const steps: PlannedStepType[] = [];

	for (const entry of input.suite.generated) {
		steps.push(...generatedSteps({entry, repositoryRoot: input.repositoryRoot, outputDir: input.outputDir}));
	}

	for (const entry of input.suite.publicProjects) {
		steps.push(...publicSteps({entry, repositoryRoot: input.repositoryRoot, projectsRoot: input.projectsRoot, outputDir: input.outputDir}));
	}

	const reference = referenceStep({suite: input.suite, repositoryRoot: input.repositoryRoot, outputDir: input.outputDir});

	if (reference !== null) {
		steps.push(reference);
	}

	return steps;
};

/**
 * Executes one planned step in a fresh process.
 *
 * @param input - Step, CLI bundle, environment, evidence directory, and repository root.
 * @returns Recorded step result.
 */
export const executeStep = async (
	input: Readonly<{
		step: PlannedStepType;
		cliPath: string;
		environment: NodeJS.ProcessEnv;
		outputDir: string;
		repositoryRoot: string;
		onLine?: (line: string) => void;
	}>,
): Promise<SuiteStepResultType> => {
	const referencePath = input.step.referencePath !== null && existsSync(input.step.referencePath) ? input.step.referencePath : null;
	const args = input.step.args({cliPath: input.cliPath, baselinePath: input.step.baselinePath, referencePath});
	const environment = {...cleanChildEnvironment(input.environment), ...input.step.environment};
	const result = await runCommand({
		command: process.execPath,
		args,
		cwd: input.step.cwd ?? input.repositoryRoot,
		environment,
		logPath: input.step.logPath,
		...(input.onLine === undefined ? {} : {onLine: input.onLine}),
	});

	if (input.step.stdoutPath !== undefined && result.stdout.length > 0) {
		mkdirSync(dirname(input.step.stdoutPath), {recursive: true});
		writeFileSync(input.step.stdoutPath, result.stdout, {encoding: 'utf8'});
	}

	for (const cleanupPath of input.step.cleanupPaths ?? []) {
		rmSync(cleanupPath, {force: true});
	}

	return {
		id: input.step.id,
		kind: input.step.kind,
		title: input.step.title,
		status: result.exitCode === 0 ? 'passed' : 'failed',
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		artifacts: input.step.artifacts.map((artifact) => relativePosix(input.outputDir, artifact)),
		detail: result.exitCode === 0 ? null : failureDetail(result.stderr),
	};
};
