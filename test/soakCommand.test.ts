import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Command} from 'commander';
import debugFactory from 'debug';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type ConfigType} from '../src/core/config/config.ts';
import {benchmarkCorpusCounts} from '../src/core/benchmark/corpus.ts';
import {addSoakCommand, outputPathsOf, planOf, runOptionsOf, type SoakCommandOptionsType} from '../src/core/benchmark/soakCommand.ts';
import {type SoakRunOptionsType} from '../src/core/benchmark/soakScenario.ts';
import {type SoakReportType} from '../src/core/benchmark/soakTypes.ts';
import {parseCommandAsync} from '../src/transports/cli/commanderSupport.ts';

const {join} = path;
const noop = (): void => {
	void 0;
};
const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(join(tmpdir(), 'codeindex-soak-command-'));
	temporaryDirectories.push(directory);
	return directory;
};

const cleanupDirectories = (): void => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {recursive: true, force: true});
	}
};

const optionsOf = (overrides: Partial<SoakCommandOptionsType> = {}): SoakCommandOptionsType => ({
	profile: 'small',
	rounds: '8',
	burstEdits: '3',
	failures: '1',
	restarts: '1',
	debounceMs: '500',
	timeoutMs: '60000',
	durationMs: '0',
	idleSampleMs: '10000',
	output: join('benchmark', 'results', 'soak.json'),
	keepWorkspace: false,
	debug: false,
	...overrides,
});

const configOf = (): ConfigType => ({
	projectName: 'soak',
	rootDir: '/workspace',
	extractorId: 'typescript',
	extractorOptions: {},
	projectFilePath: '/workspace/tsconfig.json',
	projects: [{name: 'root', projectFilePath: '/workspace/tsconfig.json'}],
	storageDirectory: '/storage',
	databasePath: '/storage/index.sqlite',
	analyticsEnabled: false,
	analyticsPath: '/storage/analytics.jsonl',
	maxResultBytes: 32_768,
	maxReadLines: 200,
	semanticDiagnostics: false,
	projectId: 'project',
	logLevel: 'error',
	configPath: null,
});

const latency = (p95Ms: number | null = 12): SoakReportType['latency'] => ({count: 2, p50Ms: 10, p95Ms, p99Ms: 14, maxMs: 20});

const reportOf = (overrides: Partial<SoakReportType> = {}): SoakReportType => ({
	recordType: 'operational-soak',
	schemaVersion: 2,
	planHash: 'a'.repeat(64),
	editScriptHash: 'b'.repeat(64),
	generatedAt: '2026-10-24T00:00:00.000Z',
	machine: {nodeVersion: 'v26.0.0', platform: 'darwin', arch: 'arm64', cpuModel: 'CPU', cpuCount: 8, memoryBytes: 1024},
	runtime: {workerEntry: true, watch: true, analytics: false},
	workspace: {...benchmarkCorpusCounts('small'), profile: 'small', expected: benchmarkCorpusCounts('small')},
	plan: {...planOf(optionsOf()), targetPaths: ['src/target.ts']},
	coldBuild: {
		durationMs: 10,
		generationId: 'generation',
		files: 1,
		symbols: 1,
		resources: {cpuUserMs: 1, cpuSystemMs: 1, rssStartBytes: 1, rssPeakBytes: 1, rssEndBytes: 1},
		storage: {generations: 1, contentVersions: 1, extractionArtifacts: 1, databaseBytes: 1, walBytes: 0, shmBytes: 0, totalBytes: 1},
	},
	events: [],
	elapsedMs: 0,
	latency: latency(),
	failures: [],
	buildFailures: [],
	failureCauses: {},
	recovery: {injectedFailures: 0, recoveredFailures: 0, manualInterventions: 0, automatic: true},
	staleRefusal: null,
	restarts: [],
	retention: {
		policy: {publishedGenerations: 1, supersededGenerations: 1, contentVersionsPerGeneration: 1, extractionArtifactsPerContentVersion: 2},
		observations: [],
		maxima: {generations: 1, contentVersions: 1, extractionArtifacts: 1, databaseBytes: 1},
		bounds: {generations: 2, contentVersions: 3, extractionArtifacts: 6},
		satisfied: true,
	},
	idle: {windowMs: 1000, cpuUserMs: 1, cpuSystemMs: 0, averagePercent: 0.1, medianPercent: 0.1, samplesPercent: [0.1]},
	resources: {cpuUserMs: 1, cpuSystemMs: 1, rssStartBytes: 1, rssPeakBytes: 1, rssEndBytes: 1},
	freshness: {state: 'current', dirtyFileCount: 0, checkedAt: '2026-10-24T00:00:00.000Z', staleFiles: 0, sourceChanged: false},
	gates: [{id: 'soak.gate', result: 'pass', detail: 'ok'}],
	passed: true,
	blocking: [],
	...overrides,
});

const capture = (): Readonly<{stdout: string[]; stderr: string[]; io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>}> => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
	};
};

const run = async (
	argv: readonly string[],
	runtime: Readonly<{
		workerEntry?: string | undefined;
		configOf: () => ConfigType;
		run?: (options: SoakRunOptionsType) => Promise<ReturnType<typeof resultOf>>;
		removeWorkspace?: (run: Readonly<{workspace: string; databaseDirectory: string; temporaryWorkspace: boolean}>) => void;
	}>,
): Promise<Readonly<{code: number; stdout: string[]; stderr: string[]}>> => {
	const captured = capture();
	const program = new Command('codeindex-cli');
	addSoakCommand(program, captured.io, runtime);
	const code = await parseCommandAsync(program, argv, captured.io, {usageExitCode: 1});

	return {code, stdout: captured.stdout, stderr: captured.stderr};
};

const resultOf = (
	overrides: Readonly<{report?: Partial<SoakReportType>; workspace?: string; databaseDirectory?: string}> = {},
): Readonly<{report: SoakReportType; workspace: string; databaseDirectory: string; temporaryWorkspace: boolean}> => ({
	report: reportOf(overrides.report),
	workspace: overrides.workspace ?? '/tmp/soak-workspace',
	databaseDirectory: overrides.databaseDirectory ?? '/tmp/soak-database',
	temporaryWorkspace: true,
});

describe('soak command options', () => {
	afterEach(cleanupDirectories);

	it('accepts every numeric minimum, maximum, and interior value', () => {
		expect(planOf(optionsOf()).rounds).toBe(8);
		const cases = [
			['rounds', '1', '100'],
			['burstEdits', '1', '20'],
			['failures', '0', '10'],
			['restarts', '0', '10'],
			['debounceMs', '10', '5000'],
			['timeoutMs', '1000', '600000'],
			['durationMs', '0', '86400000'],
			['idleSampleMs', '0', '600000'],
		] as const;

		for (const [name, minimum, maximum] of cases) {
			expect(planOf(optionsOf({[name]: minimum}))[name]).toBe(Number(minimum));
			expect(planOf(optionsOf({[name]: maximum}))[name]).toBe(Number(maximum));
		}
	});

	it('rejects out-of-range, non-integer, NaN, and empty numeric input', () => {
		const cases: readonly [keyof SoakCommandOptionsType, string, string][] = [
			['rounds', '0', '--rounds must be an integer between 1 and 100'],
			['rounds', '101', '--rounds must be an integer between 1 and 100'],
			['rounds', '1.5', '--rounds must be an integer between 1 and 100'],
			['rounds', 'NaN', '--rounds must be an integer between 1 and 100'],
			['rounds', '', '--rounds must be an integer between 1 and 100'],
			['burstEdits', '0', '--burst-edits must be an integer between 1 and 20'],
			['failures', '11', '--failures must be an integer between 0 and 10'],
			['restarts', '-1', '--restarts must be an integer between 0 and 10'],
			['debounceMs', '9', '--debounce-ms must be an integer between 10 and 5000'],
			['timeoutMs', '999', '--timeout-ms must be an integer between 1000 and 600000'],
			['durationMs', '86400001', '--duration-ms must be an integer between 0 and 86400000'],
			['idleSampleMs', '-1', '--idle-sample-ms must be an integer between 0 and 600000'],
		];

		for (const [name, value, message] of cases) {
			expect(() => planOf(optionsOf({[name]: value}))).toThrow(message);
		}
	});

	it('accepts only the declared profile allow-list', () => {
		for (const profile of ['small', 'medium', 'large', 'xl']) {
			expect(planOf(optionsOf({profile})).profile).toBe(profile);
		}

		expect(() => planOf(optionsOf({profile: 'huge'}))).toThrow('--profile must be one of: small, medium, large, xl');
	});

	it('resolves the default Markdown path beside the report and honours explicit overrides', () => {
		const root = temporaryDirectory();
		const relative = join('results', 'soak.json');

		expect(outputPathsOf(optionsOf({output: relative}))).toStrictEqual({report: path.resolve(relative), markdown: `${path.resolve(relative)}.md`});
		expect(outputPathsOf(optionsOf({output: join(root, 'report.json'), markdown: join(root, 'summary.md')}))).toStrictEqual({
			report: join(root, 'report.json'),
			markdown: join(root, 'summary.md'),
		});
		expect(outputPathsOf(optionsOf({output: join(root, 'report.json'), markdown: 'summary.md'}))).toStrictEqual({
			report: join(root, 'report.json'),
			markdown: path.resolve('summary.md'),
		});
	});
});

describe('soak command forwarding and help', () => {
	afterEach(cleanupDirectories);

	it('forwards workspace and worker only when provided and writes progress lines', () => {
		const captured = capture();
		const root = temporaryDirectory();
		const without = runOptionsOf(configOf, optionsOf({output: join(root, 'soak.json')}), undefined, captured.io);
		const withValues = runOptionsOf(configOf, optionsOf({workspace: 'workspace', output: join(root, 'soak.json')}), 'worker.mjs', captured.io);

		expect(without).not.toHaveProperty('workspace');
		expect(without).not.toHaveProperty('workerEntry');
		expect(withValues.workspace).toBe(path.resolve('workspace'));
		expect(withValues.workerEntry).toBe('worker.mjs');

		withValues.onProgress?.({iteration: 1, rounds: 2, latencyMs: 10, etaMs: 0});
		withValues.onProgress?.({iteration: 2, rounds: 2, latencyMs: 11, etaMs: 0});

		expect(captured.stderr).toStrictEqual(['[soak] event 1/2: 10 ms, continuing', '[soak] event 2/2: 11 ms']);
	});

	it('selects debug logging only when requested', () => {
		const captured = capture();
		const root = temporaryDirectory();
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

		try {
			const normal = runOptionsOf(configOf, optionsOf({output: join(root, 'soak.json')}), undefined, captured.io);
			const debug = runOptionsOf(configOf, optionsOf({output: join(root, 'soak.json'), debug: true}), undefined, captured.io);

			normal.logger.debug('hidden');
			debug.logger.debug('visible');

			// oxlint-disable-next-line vitest/prefer-to-have-length -- Assert the exact call count without the conflicting mock-call rules.
			expect(stderr.mock.calls.length).toBe(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"event":"visible"'));
		} finally {
			stderr.mockRestore();
		}
	});

	it('declares help text and defaults for every option', () => {
		const program = new Command('codeindex-cli');
		const command = addSoakCommand(program, capture().io, {configOf});
		const help = command.helpInformation();
		const flat = help.replaceAll(/\s+/gu, ' ');

		expect(help).toContain('Run the deterministic operational soak and recovery evaluation');
		for (const option of [
			'--profile <name>',
			'--rounds <n>',
			'--burst-edits <n>',
			'--failures <n>',
			'--restarts <n>',
			'--debounce-ms <n>',
			'--timeout-ms <n>',
			'--workspace <path>',
			'--output <path>',
			'--markdown <path>',
			'--keep-workspace',
			'--debug',
		]) {
			expect(help).toContain(option);
		}

		expect(help).toContain('default: "small"');
		expect(help).toContain('default: "8"');
		expect(help).toContain('default: "3"');
		expect(help).toContain('default: "1"');
		expect(help).toContain('default: "500"');
		expect(flat).toContain('default: "60000"');
	});
});

describe('soak command action', () => {
	afterEach(cleanupDirectories);

	it('writes both reports, prints the success summary, and removes the workspace by default', async () => {
		const root = temporaryDirectory();
		const output = join(root, 'report.json');
		const removed: string[] = [];
		const result = await run(['soak', '--output', output], {
			configOf,
			run: async () => {
				await Promise.resolve();
				return resultOf({report: {latency: latency(25)}});
			},
			removeWorkspace: (completed) => {
				removed.push(completed.workspace);
			},
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toStrictEqual(['soak PASS: 0 events, p95 25 ms, 0 failure(s), 0 restart(s)', `report: ${output}`, `summary: ${output}.md`]);
		expect(result.stderr).toStrictEqual([]);
		expect(existsSync(output)).toBe(true);
		expect(existsSync(`${output}.md`)).toBe(true);
		expect(readFileSync(`${output}.md`, 'utf8')).toContain('# Operational soak report');
		expect(removed).toStrictEqual(['/tmp/soak-workspace']);
	});

	it('keeps the workspace and prints its paths when requested', async () => {
		const root = temporaryDirectory();
		const output = join(root, 'report.json');
		const remove = vi.fn<(completed: Readonly<{workspace: string; databaseDirectory: string; temporaryWorkspace: boolean}>) => void>();
		const result = await run(['soak', '--output', output, '--markdown', join(root, 'summary.md'), '--keep-workspace'], {
			configOf,
			run: async () => {
				await Promise.resolve();
				return resultOf({workspace: '/tmp/kept', databaseDirectory: '/tmp/kept-db'});
			},
			removeWorkspace: remove,
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toStrictEqual([
			'soak PASS: 0 events, p95 12 ms, 0 failure(s), 0 restart(s)',
			`report: ${output}`,
			`summary: ${join(root, 'summary.md')}`,
			'workspace: /tmp/kept',
			'database: /tmp/kept-db',
		]);
		expect(remove).not.toHaveBeenCalled();
		expect(existsSync(join(root, 'summary.md'))).toBe(true);
	});
});

describe('soak command failure and forwarding', () => {
	afterEach(cleanupDirectories);

	it('writes both reports, exits one, names blocking causes, and still cleans a failed run', async () => {
		const root = temporaryDirectory();
		const output = join(root, 'report.json');
		const removed: string[] = [];
		const result = await run(['soak', '--output', output], {
			configOf,
			run: async () => {
				await Promise.resolve();
				return resultOf({report: {passed: false, blocking: ['soak.latency', 'soak.stale']}});
			},
			removeWorkspace: (completed) => {
				removed.push(completed.workspace);
			},
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toStrictEqual(['soak blocked: soak.latency, soak.stale']);
		expect(result.stdout).toContain(`report: ${output}`);
		expect(result.stdout).toContain(`summary: ${output}.md`);
		expect(existsSync(output)).toBe(true);
		expect(existsSync(`${output}.md`)).toBe(true);
		expect(removed).toStrictEqual(['/tmp/soak-workspace']);
	});

	it('forwards parsed workspace, worker, and progress without running a real soak', async () => {
		const root = temporaryDirectory();
		const seen: SoakRunOptionsType[] = [];
		const result = await run(['soak', '--output', join(root, 'report.json'), '--workspace', 'workspace', '--profile', 'medium', '--rounds', '2'], {
			configOf,
			workerEntry: 'worker.mjs',
			run: async (options) => {
				await Promise.resolve();
				seen.push(options);
				options.onProgress?.({iteration: 1, rounds: 2, latencyMs: 10, etaMs: 0});
				options.onProgress?.({iteration: 2, rounds: 2, latencyMs: 11, etaMs: 0});
				return resultOf();
			},
			removeWorkspace: noop,
		});

		expect(result.code).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({profile: 'medium', workerEntry: 'worker.mjs', workspace: path.resolve('workspace')});
		expect(seen[0]?.plan.rounds).toBe(2);
		expect(result.stderr).toStrictEqual(['[soak] event 1/2: 10 ms, continuing', '[soak] event 2/2: 11 ms']);
	});

	it('enables trace output only for an explicit --debug run', async () => {
		const root = temporaryDirectory();

		try {
			const result = await run(['soak', '--debug', '--output', join(root, 'report.json')], {
				configOf,
				run: async () => {
					await Promise.resolve();
					return resultOf();
				},
				removeWorkspace: noop,
			});

			expect(result.code).toBe(0);
			expect(debugFactory.enabled('codeindex:build')).toBe(true);
		} finally {
			debugFactory.disable();
		}
	});

	it('rejects invalid numeric and profile options before running', async () => {
		const numeric = await run(['soak', '--rounds', '0'], {
			configOf,
			run: async () => {
				await Promise.resolve();
				return resultOf();
			},
		});
		const profile = await run(['soak', '--profile', 'huge'], {
			configOf,
			run: async () => {
				await Promise.resolve();
				return resultOf();
			},
		});

		expect(numeric.code).toBe(1);
		expect(numeric.stderr).toStrictEqual(['--rounds must be an integer between 1 and 100']);
		expect(profile.code).toBe(1);
		expect(profile.stderr).toStrictEqual(['--profile must be one of: small, medium, large, xl']);
	});
});
