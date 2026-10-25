import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delayPromise} from 'node:timers/promises';
import {percentileOf} from './costStudy.ts';
import {openMcpSession} from './routeClient.ts';

/** Declared warm-startup p95 budget from the maintainer guide. */
export const STARTUP_P95_BUDGET_MS = 500;

/** Declared local MCP call p95 budget from the maintainer guide. */
export const MCP_CALL_P95_BUDGET_MS = 100;

/** Tool measured for the local MCP call budget; it has no workspace scan. */
const MCP_CALL_TOOL = 'index_status';

/** Pause between sessions so a closed server can release its process. */
const SETTLE_MS = 50;

export type StartupPercentilesType = Readonly<{
	count: number;
	p50Ms: number | null;
	p95Ms: number | null;
	p99Ms: number | null;
	maxMs: number | null;
}>;

export type StartupBaselineType = Readonly<{
	schemaVersion: 2;
	kind: 'mcp-warm-startup';
	generatedAt: string;
	definition: string;
	artifact: Readonly<{entryPoint: string; sha256: string; commit: string}>;
	machine: Readonly<{
		nodeVersion: string;
		platform: string;
		arch: string;
		cpuModel: string;
		totalMemoryBytes: number;
	}>;
	workspace: Readonly<{projectFile: string}>;
	iterations: number;
	samplesMs: readonly number[];
	percentiles: StartupPercentilesType;
	gate: Readonly<{metric: 'p95Ms'; budgetMs: number; status: 'pass' | 'fail'}>;
	/** Local MCP call latency measured after each handshake. */
	calls: Readonly<{
		tool: string;
		iterations: number;
		samplesMs: readonly number[];
		percentiles: StartupPercentilesType;
		gate: Readonly<{metric: 'p95Ms'; budgetMs: number; status: 'pass' | 'fail'}>;
	}>;
}>;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Summarizes warm-startup observations with nearest-rank percentiles.
 *
 * @param samples - Observed startup durations in milliseconds.
 * @returns Count, p50, p95, p99, and maximum.
 */
export const summarizeStartup = (samples: readonly number[]): StartupPercentilesType => ({
	count: samples.length,
	p50Ms: samples.length === 0 ? null : round1(percentileOf(samples, 0.5)),
	p95Ms: samples.length === 0 ? null : round1(percentileOf(samples, 0.95)),
	p99Ms: samples.length === 0 ? null : round1(percentileOf(samples, 0.99)),
	maxMs: samples.length === 0 ? null : round1(Math.max(...samples)),
});

/**
 * Applies the declared warm-startup gate.
 *
 * @param p95Ms - Observed p95, or null when no sample exists.
 * @returns `pass` only when the p95 is within the budget.
 */
export const startupGateStatusOf = (p95Ms: number | null): 'pass' | 'fail' => (p95Ms !== null && p95Ms <= STARTUP_P95_BUDGET_MS ? 'pass' : 'fail');

/**
 * Applies the declared local MCP call gate.
 *
 * @param p95Ms - Observed p95, or null when no call was measured.
 * @returns `pass` only when the p95 is within the budget.
 */
export const mcpCallGateStatusOf = (p95Ms: number | null): 'pass' | 'fail' => (p95Ms !== null && p95Ms <= MCP_CALL_P95_BUDGET_MS ? 'pass' : 'fail');

const commitOf = (repositoryRoot: string): string => {
	const result = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {encoding: 'utf8'});

	return result.status === 0 ? result.stdout.trim() : 'unknown';
};

const sha256Of = (filePath: string): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');

const delay = async (milliseconds: number): Promise<void> => {
	await delayPromise(milliseconds);
};

const validateInput = (input: Readonly<{entryPoint: string; root: string; projectFile: string; database: string; iterations: number}>): void => {
	if (!existsSync(input.root)) {
		throw new Error(`workspace root does not exist: ${input.root}`);
	}

	const projectFile = path.isAbsolute(input.projectFile) ? input.projectFile : path.join(input.root, input.projectFile);

	if (!existsSync(projectFile)) {
		throw new Error(`project file does not exist: ${projectFile}`);
	}

	if (!existsSync(input.database)) {
		throw new Error(`reusable database does not exist: ${input.database}; build it before measuring`);
	}

	if (!existsSync(input.entryPoint)) {
		throw new Error(`MCP entry point does not exist: ${input.entryPoint}; run pnpm build first`);
	}

	if (!Number.isInteger(input.iterations) || input.iterations < 1) {
		throw new Error('iterations must be a positive integer');
	}
};

/**
 * Measures warm MCP startup against a reusable index database.
 *
 * Each iteration spawns the MCP entry point, completes the official client
 * handshake, and closes the session. Sessions never overlap: process startup
 * and handshake time are the measurement.
 *
 * @param input - Entry point, workspace, reusable database, and sample count.
 * @returns A sanitized startup record with the declared gate result.
 */
export const measureStartup = async (
	input: Readonly<{entryPoint: string; root: string; projectFile: string; database: string; iterations: number; repositoryRoot: string}>,
): Promise<StartupBaselineType> => {
	validateInput(input);
	const root = path.resolve(input.root);
	const database = path.resolve(input.database);
	const entryPoint = path.resolve(input.entryPoint);
	const environment = {
		CODE_INDEX_ROOT: root,
		CODE_INDEX_PROJECT_FILE: input.projectFile,
		CODE_INDEX_DATABASE: database,
	};
	const samples: number[] = [];
	const callSamples: number[] = [];

	for (let iteration = 1; iteration <= input.iterations; iteration += 1) {
		const session = await openMcpSession({entryPoint, cwd: root, env: environment});
		samples.push(round1(session.startupMs));

		const call = await session.callTool(MCP_CALL_TOOL, {});

		if (call.status === 'ok') {
			callSamples.push(round1(call.elapsedMs));
		}

		await session.close();
		await delay(SETTLE_MS);
	}

	const percentiles = summarizeStartup(samples);
	const callPercentiles = summarizeStartup(callSamples);

	return {
		schemaVersion: 2,
		kind: 'mcp-warm-startup',
		generatedAt: new Date().toISOString(),
		definition:
			'spawn the MCP entry point, complete the MCP initialize handshake against a reusable index database, and time one index_status call in the same session',
		artifact: {entryPoint: path.basename(entryPoint), sha256: sha256Of(entryPoint), commit: commitOf(input.repositoryRoot)},
		machine: {
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			cpuModel: os.cpus().at(0)?.model ?? 'unknown',
			totalMemoryBytes: os.totalmem(),
		},
		workspace: {projectFile: input.projectFile},
		iterations: input.iterations,
		samplesMs: samples,
		percentiles,
		gate: {metric: 'p95Ms', budgetMs: STARTUP_P95_BUDGET_MS, status: startupGateStatusOf(percentiles.p95Ms)},
		calls: {
			tool: MCP_CALL_TOOL,
			iterations: callSamples.length,
			samplesMs: callSamples,
			percentiles: callPercentiles,
			gate: {metric: 'p95Ms', budgetMs: MCP_CALL_P95_BUDGET_MS, status: mcpCallGateStatusOf(callPercentiles.p95Ms)},
		},
	};
};
