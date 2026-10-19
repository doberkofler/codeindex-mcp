import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, renameSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {type BenchmarkIoType} from './finalize.ts';
import {git, lockfileOf, sha256File} from './suiteManifest.ts';
import {loadBenchmarkSuite, resolveProjectsRoot, type BenchmarkSuitePublicProjectType} from './suiteTypes.ts';

const prepareUsage = `Usage: codeindex-cli benchmark-prepare --suite <path> [options]

Clones the suite's pinned public projects and installs their dependencies.
Checkout and dependency setup are not part of any measured scenario.

Options:
  --suite <path>         Suite manifest (default: benchmark/suites/public-projects.json)
  --projects-root <path> Override the checkout root
  --skip-install         Clone and check out only
  --help                 Print this message
`;

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

const installWith = (input: Readonly<{command: string; args: readonly string[]; directory: string; name: string; io: BenchmarkIoType}>): void => {
	input.io.stdout(`[install] ${input.command} ${input.args.join(' ')} (${input.name})`);

	if (spawnSync(input.command, [...input.args], {cwd: input.directory, stdio: 'inherit'}).status !== 0) {
		throw new Error(`${input.command} ${input.args.join(' ')} failed for ${input.name}`);
	}
};

const installDependencies = (project: BenchmarkSuitePublicProjectType, directory: string, io: BenchmarkIoType): void => {
	if (existsSync(path.join(directory, 'pnpm-lock.yaml'))) {
		installWith({command: 'pnpm', args: ['install', '--frozen-lockfile'], directory, name: project.name, io});
		return;
	}

	if (existsSync(path.join(directory, 'package-lock.json'))) {
		installWith({command: 'npm', args: ['ci'], directory, name: project.name, io});
		return;
	}

	if (existsSync(path.join(directory, 'yarn.lock'))) {
		const args = existsSync(path.join(directory, '.yarnrc.yml')) ? ['install', '--immutable'] : ['install', '--frozen-lockfile'];
		installWith({command: 'yarn', args, directory, name: project.name, io});
		return;
	}

	io.stderr(`No supported lockfile found for ${project.name}; skipping dependency installation`);
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

/**
 * Clones and installs pinned public benchmark projects.
 *
 * @param argv - Arguments after `benchmark-prepare`.
 * @param io - Output sinks.
 * @param options - Injected working and home directories.
 * @returns Process exit code.
 */
export const runBenchmarkPrepareCommand = (argv: readonly string[], io: BenchmarkIoType, options: Readonly<{cwd?: string; home?: string}> = {}): number => {
	try {
		const {values} = parseArgs({
			args: [...argv],
			options: {
				suite: {type: 'string'},
				'projects-root': {type: 'string'},
				'skip-install': {type: 'boolean', default: false},
				help: {type: 'boolean', default: false},
			},
			allowPositionals: false,
		});

		if (values.help) {
			io.stdout(prepareUsage.trimEnd());
			return 0;
		}

		const cwd = options.cwd ?? process.cwd();
		const home = options.home ?? os.homedir();
		const suitePath = path.resolve(cwd, values.suite ?? 'benchmark/suites/public-projects.json');
		const suite = loadBenchmarkSuite(suitePath);
		const projectsRoot = resolveProjectsRoot(suite, values['projects-root'], home, cwd);

		mkdirSync(projectsRoot, {recursive: true});

		for (const project of suite.publicProjects) {
			const directory = path.join(projectsRoot, project.directory);
			checkout(project, directory, io);

			if (!values['skip-install']) {
				installDependencies(project, directory, io);
			}
		}

		writePreparedManifest({suitePath, projectsRoot, projects: suite.publicProjects});
		io.stdout(`Prepared ${String(suite.publicProjects.length)} project(s) in ${projectsRoot}`);
		return 0;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};
