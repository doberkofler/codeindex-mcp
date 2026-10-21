import {existsSync, mkdirSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashOf, type ArmNameType} from './schema.ts';
import {loadSuite, planHashOf, planOf, selectCases} from './suite.ts';
import {compare} from './report.ts';
import {runOnce, writeResult, type RunResultType} from './runner.ts';
import {applyArm, ensureWorkspaces, restoreWorkspace, unexpectedChanges, workspaceContextOf} from './workspace.ts';

/** Harness schema version recorded in every run identity. */
const HARNESS_VERSION = 5;

/** Pause between executions to stay inside the provider's rolling window. */
const PACE_MS = Number(process.env['EVAL_PACE_MS'] ?? 5_000);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argsOf = (argv: readonly string[]): Readonly<{command: string; flags: Map<string, string[]>}> => {
	const [command = 'help', ...rest] = argv;
	const flags = new Map<string, string[]>();

	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];

		if (!token?.startsWith('--')) {
			continue;
		}

		const next = rest[index + 1];
		const value = next === undefined || next.startsWith('--') ? 'true' : next;

		if (value !== 'true') {
			index += 1;
		}

		flags.set(token.slice(2), [...(flags.get(token.slice(2)) ?? []), value]);
	}

	return {command, flags};
};

const flagOf = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.[0];
const allOf = (flags: Map<string, string[]>, name: string): readonly string[] => flags.get(name) ?? [];

const settingsOf = (): Readonly<{subjectRepo: string}> => {
	const file = path.join(root, 'harness.json');

	if (!existsSync(file)) {
		throw new Error(`missing ${file}`);
	}

	const parsed = JSON.parse(readFileSync(file, 'utf8')) as {subjectRepo?: unknown};

	if (typeof parsed.subjectRepo !== 'string') {
		throw new Error('harness.json must declare "subjectRepo"');
	}

	return {subjectRepo: parsed.subjectRepo};
};

const armsOf = (value: string | undefined, suiteArms: readonly string[]): readonly ArmNameType[] => {
	if (value === undefined || value === 'both') {
		return suiteArms.filter((arm): arm is ArmNameType => arm === 'baseline' || arm === 'indexed');
	}

	if (value !== 'baseline' && value !== 'indexed') {
		throw new Error(`unsupported arm "${value}"`);
	}

	return [value];
};

const listCommand = (flags: Map<string, string[]>): void => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(root, suitePath));
	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});

	process.stdout.write(
		`${suite.id} v${suite.version} schema=${suite.schemaVersion} (${suite.status}) model=${suite.model} revision=${suite.revision}\n`,
	);

	for (const item of selected) {
		process.stdout.write(`  ${item.id}\t${item.class}\t${item.title}\n`);
	}
};

const evaluateCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(root, suitePath));
	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});
	const arms = armsOf(flagOf(flags, 'arm'), suite.arms);
	const repetitions = Number(flagOf(flags, 'repetitions') ?? suite.repetitions);
	const plan = planOf(selected, arms, repetitions);
	const planHash = planHashOf(plan);
	const identityHash = hashOf({
		suite: suite.hash,
		model: suite.model,
		revision: suite.revision,
		arms,
		repetitions,
		harness: HARNESS_VERSION,
		cases: selected.map((item) => item.id),
		planHash,
	}).slice(0, 16);
	const runDir = path.join(root, 'results', `${suite.id}-${identityHash}`);

	process.stderr.write(
		`run ${runDir}\nplan ${plan.length} execution(s): ${selected.length} case(s) x ${arms.length} arm(s) x ${repetitions} repetition(s)\n`,
	);
	process.stderr.write(`plan-hash ${planHash}\n`);

	if (flags.has('dry-run')) {
		for (const entry of plan) {
			process.stderr.write(`  ${entry.caseId} ${entry.arm} rep-${entry.repetition}\n`);
		}

		return;
	}

	const settings = settingsOf();
	const context = workspaceContextOf(root, {subjectRepo: settings.subjectRepo, revision: suite.revision});
	ensureWorkspaces(context);
	mkdirSync(runDir, {recursive: true});

	const manifest = {
		suite: {id: suite.id, version: suite.version, status: suite.status, hash: suite.hash},
		identityHash,
		model: suite.model,
		revision: suite.revision,
		arms,
		repetitions,
		harness: HARNESS_VERSION,
		startedAt: new Date().toISOString(),
		plan,
	};
	writeResult(path.join(runDir, 'run.json'), {...manifest, status: 'running'});

	const results: RunResultType[] = [];

	for (const [index, entry] of plan.entries()) {
		const testCase = selected.find((item) => item.id === entry.caseId);

		if (testCase === undefined) {
			throw new Error(`unknown case ${entry.caseId}`);
		}

		const file = path.join(runDir, entry.caseId, entry.arm, `rep-${entry.repetition}.json`);

		if (flags.has('resume') && existsSync(file)) {
			results.push(JSON.parse(readFileSync(file, 'utf8')) as RunResultType);
			continue;
		}

		restoreWorkspace(context, entry.arm);
		const changes = unexpectedChanges(context, entry.arm);

		if (changes.length > 0) {
			throw new Error(`workspace ${entry.arm} is not clean: ${changes.join('; ')}`);
		}

		applyArm(context, entry.arm);
		process.stderr.write(`[${index + 1}/${plan.length}] ${entry.caseId} ${entry.arm} rep-${entry.repetition}\n`);

		const result = await runOnce({
			cwd: context.workspacePath(entry.arm),
			testCase,
			arm: entry.arm,
			repetition: entry.repetition,
			model: suite.model,
			revision: suite.revision,
			identityHash,
			rawBase: path.join(runDir, 'raw', entry.caseId, entry.arm, `rep-${entry.repetition}`),
		});

		if (result.attempts.length > 1) {
			process.stderr.write(`  retried ${result.attempts.length - 1} time(s); last reason ${result.invalidReason ?? 'accepted'}\n`);
		}

		writeResult(file, result);
		results.push(result);

		if (index < plan.length - 1) {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, PACE_MS);
			});
		}
	}

	const comparison = compare(results);
	writeResult(path.join(runDir, 'report.json'), comparison);
	writeResult(path.join(runDir, 'run.json'), {...manifest, status: 'complete', finishedAt: new Date().toISOString()});

	printSummary(runDir, results, comparison);
};

const printSummary = (runDir: string, results: readonly RunResultType[], comparison: ReturnType<typeof compare>): void => {
	process.stdout.write(`results ${runDir}\n`);
	process.stdout.write(`runs ${results.length}, valid ${results.filter((run) => run.valid).length}\n`);

	for (const arm of ['baseline', 'indexed'] as const) {
		const summary = arm === 'baseline' ? comparison.baseline : comparison.indexed;
		process.stdout.write(
			`${arm.padEnd(9)} success ${(summary.successRate * 100).toFixed(1)}%  index-use ${(summary.indexUsageRate * 100).toFixed(0)}%  tokens ${summary.medianTokens.toFixed(0)}  calls ${summary.medianToolCalls.toFixed(1)}  bytes ${summary.medianOutputBytes.toFixed(0)}  p95 ${(summary.p95WallMs / 1000).toFixed(1)}s  invalid ${summary.invalidRuns}  retried ${summary.retriedRuns}\n`,
		);
	}

	for (const threshold of comparison.thresholds) {
		process.stdout.write(`${threshold.passed ? 'PASS' : 'FAIL'} ${threshold.name} (${threshold.detail})\n`);
	}

	process.stdout.write(`Q2 ${comparison.passed ? 'PASSED' : 'NOT PASSED'}\n`);
};

const reportCommand = (flags: Map<string, string[]>): void => {
	const runId = flagOf(flags, 'run');
	const resultsRoot = path.join(root, 'results');
	const directory = runId === undefined ? latestRun(resultsRoot) : path.join(resultsRoot, runId);

	if (!existsSync(directory)) {
		throw new Error(`no results at ${directory}`);
	}

	const results: RunResultType[] = [];

	for (const caseId of readdirSync(directory)) {
		const caseDir = path.join(directory, caseId);

		if (!existsSync(path.join(caseDir, 'baseline')) && !existsSync(path.join(caseDir, 'indexed'))) {
			continue;
		}

		for (const arm of ['baseline', 'indexed'] as const) {
			const armDir = path.join(caseDir, arm);

			if (!existsSync(armDir)) {
				continue;
			}

			for (const file of readdirSync(armDir)) {
				if (file.endsWith('.json')) {
					results.push(JSON.parse(readFileSync(path.join(armDir, file), 'utf8')) as RunResultType);
				}
			}
		}
	}

	printSummary(directory, results, compare(results));
};

const latestRun = (resultsRoot: string): string => {
	const entries = existsSync(resultsRoot) ? readdirSync(resultsRoot).sort() : [];
	const last = entries.at(-1);

	if (last === undefined) {
		throw new Error('no runs recorded');
	}

	return path.join(resultsRoot, last);
};

const checkCommand = (flags: Map<string, string[]>): void => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(root, suitePath));
	const settings = settingsOf();
	const context = workspaceContextOf(root, {subjectRepo: settings.subjectRepo, revision: suite.revision});
	ensureWorkspaces(context);

	const changes = (['baseline', 'indexed'] as const).flatMap((arm) => unexpectedChanges(context, arm).map((line) => `${arm}: ${line}`));
	const classes = new Set(cases.map((item) => item.class));

	process.stdout.write(`suite ${suite.id} v${suite.version}, ${cases.length} case(s), classes ${[...classes].join(', ')}\n`);
	process.stdout.write(`model ${suite.model}, revision ${suite.revision}\n`);
	process.stdout.write(`workspaces ready, unexpected changes: ${changes.length}\n`);

	if (changes.length > 0) {
		throw new Error(changes.join('\n'));
	}
};

const {command, flags} = argsOf(process.argv.slice(2));

try {
	if (command === 'evaluate') {
		await evaluateCommand(flags);
	} else if (command === 'report') {
		reportCommand(flags);
	} else if (command === 'check') {
		checkCommand(flags);
	} else if (command === 'list') {
		listCommand(flags);
	} else {
		process.stdout.write('usage: cli.ts <evaluate|report|check|list> --suite <path> [--case id] [--tag tag] [--arm both] [--repetitions n] [--dry-run] [--resume]\n');
		process.exitCode = command === 'help' ? 0 : 2;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
