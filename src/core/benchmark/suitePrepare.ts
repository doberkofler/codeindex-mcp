import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, renameSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Command} from 'commander';
import {configureCommand, parseCommand} from '../../transports/cli/commanderSupport.ts';
import {type BenchmarkIoType} from './finalize.ts';
import {git, lockfileOf, sha256File} from './suiteManifest.ts';
import {loadBenchmarkSuite, resolveProjectsRoot, type BenchmarkSuitePublicProjectType} from './suiteTypes.ts';

type PrepareOptionsType = Readonly<{
	suite?: string | undefined;
	projectsRoot?: string | undefined;
	skipInstall: boolean;
}>;

const checkout = (project: BenchmarkSuitePublicProjectType, directory: string, io: BenchmarkIoType): void => {
	if (existsSync(directory)) {
		const revision = git(directory, ['rev-parse', 'HEAD']);

		if (revision !== project.revision) {
			throw new Error(`${project.name} is at ${revision ?? 'unknown'}, expected ${project.revision}; remove ${directory} to re-clone`);
		}

		io.stdout(`[reuse] ${project.name} at ${project.revision}`);
		return;
	}

	io.stdout(`[clone] ${project.repository} -> ${directory}`);

	if (spawnSync('git', ['clone', '--filter=blob:none', project.repository, directory], {stdio: 'inherit'}).status !== 0) {
		throw new Error(`Failed to clone ${project.repository}`);
	}

	if (spawnSync('git', ['-C', directory, 'checkout', project.revision], {stdio: 'inherit'}).status !== 0) {
		throw new Error(`Failed to check out ${project.revision} in ${directory}`);
	}
};

/** Dependency installation command selected for a public project. */
export type InstallCommand = Readonly<{
	command: string;
	args: readonly string[];
	env?: Readonly<Record<string, string>>;
}>;

/**
 * Selects the dependency installation command for a checkout.
 *
 * Project lifecycle scripts stay disabled: benchmarks index third-party source
 * and must not compile or execute it, and the projects' own Node version pins
 * may disagree with the CodeIndex runtime.
 *
 * @param directory - Public project checkout.
 * @returns The installation command, or `null` when no supported lockfile exists.
 */
export const installCommandFor = (directory: string): InstallCommand | null => {
	if (existsSync(path.join(directory, 'pnpm-lock.yaml'))) {
		return {command: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts']};
	}

	if (existsSync(path.join(directory, 'package-lock.json'))) {
		return {command: 'npm', args: ['ci', '--ignore-scripts']};
	}

	if (existsSync(path.join(directory, 'yarn.lock'))) {
		if (existsSync(path.join(directory, '.yarnrc.yml'))) {
			return {command: 'yarn', args: ['install', '--immutable'], env: {YARN_ENABLE_SCRIPTS: 'false'}};
		}

		return {command: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts']};
	}

	return null;
};

const installWith = (
	input: Readonly<{
		install: InstallCommand;
		directory: string;
		name: string;
		io: BenchmarkIoType;
	}>,
): void => {
	const {install} = input;
	input.io.stdout(`[install] ${install.command} ${install.args.join(' ')} (${input.name})`);

	if (
		spawnSync(install.command, [...install.args], {
			cwd: input.directory,
			stdio: 'inherit',
			...(install.env === undefined ? {} : {env: {...process.env, ...install.env}}),
		}).status !== 0
	) {
		throw new Error(`${install.command} ${install.args.join(' ')} failed for ${input.name}`);
	}
};

const installDependencies = (project: BenchmarkSuitePublicProjectType, directory: string, io: BenchmarkIoType): void => {
	const install = installCommandFor(directory);

	if (install === null) {
		io.stderr(`No supported lockfile found for ${project.name}; skipping dependency installation`);
		return;
	}

	installWith({install, directory, name: project.name, io});
};

const writePreparedManifest = (
	input: Readonly<{
		suitePath: string;
		projectsRoot: string;
		projects: readonly BenchmarkSuitePublicProjectType[];
	}>,
): void => {
	const filePath = path.join(input.projectsRoot, 'prepare.json');
	const temporaryPath = `${filePath}.tmp`;

	writeFileSync(
		temporaryPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				suite: path.basename(input.suitePath),
				projectsRoot: input.projectsRoot,
				projects: input.projects.map((project) => {
					const directory = path.join(input.projectsRoot, project.directory);
					const lockfile = lockfileOf(directory);

					return {
						name: project.name,
						repository: project.repository,
						revision: project.revision,
						lockfile: lockfile === null ? null : path.basename(lockfile),
						lockfileSha256: lockfile === null ? null : sha256File(lockfile),
					};
				}),
			},
			null,
			2,
		)}\n`,
		{encoding: 'utf8'},
	);
	renameSync(temporaryPath, filePath);
};

const executePrepare = (values: PrepareOptionsType, io: BenchmarkIoType, options: Readonly<{cwd?: string; home?: string}>): void => {
	const cwd = options.cwd ?? process.cwd();
	const home = options.home ?? os.homedir();
	const suitePath = path.resolve(cwd, values.suite ?? 'benchmark/suites/typescript-public.json');
	const suite = loadBenchmarkSuite(suitePath);
	const projectsRoot = resolveProjectsRoot(suite, values.projectsRoot, home, cwd);

	mkdirSync(projectsRoot, {recursive: true});

	for (const project of suite.publicProjects) {
		const directory = path.join(projectsRoot, project.directory);
		checkout(project, directory, io);

		if (!values.skipInstall) {
			installDependencies(project, directory, io);
		}
	}

	writePreparedManifest({suitePath, projectsRoot, projects: suite.publicProjects});
	io.stdout(`Prepared ${String(suite.publicProjects.length)} project(s) in ${projectsRoot}`);
};

const prepareCommand = (io: BenchmarkIoType, options: Readonly<{cwd?: string; home?: string}>): Command =>
	configureCommand(
		new Command('benchmark-prepare')
			.description('Clone the suite pinned public projects and install their dependencies; checkout and dependency setup are not measured')
			.option('--suite <path>', 'suite manifest (default: benchmark/suites/typescript-public.json)')
			.option('--projects-root <path>', 'override the checkout root')
			.option('--skip-install', 'clone and check out only', false),
		io,
	).action((values: PrepareOptionsType) => {
		executePrepare(values, io, options);
	});

/**
 * Registers the public-project preparation command.
 *
 * @param program - Root CLI program.
 * @param io - Output sinks.
 * @param options - Injected working and home directories.
 */
export const addBenchmarkPrepareCommand = (program: Command, io: BenchmarkIoType, options: Readonly<{cwd?: string; home?: string}> = {}): void => {
	program.addCommand(prepareCommand(io, options));
};

/**
 * Clones and installs pinned public benchmark projects.
 *
 * @param argv - Arguments after `benchmark-prepare`.
 * @param io - Output sinks.
 * @param options - Injected working and home directories.
 * @returns Process exit code.
 */
export const runBenchmarkPrepareCommand = (argv: readonly string[], io: BenchmarkIoType, options: Readonly<{cwd?: string; home?: string}> = {}): number => {
	const program = new Command('codeindex-cli');
	program.addCommand(prepareCommand(io, options));

	return parseCommand(program, ['benchmark-prepare', ...argv], io, {usageExitCode: 1});
};
