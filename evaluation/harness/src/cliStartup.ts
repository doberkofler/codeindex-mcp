import path from 'node:path';
import {flagOf, primaryCheckout} from './cliSupport.ts';
import {writeJsonAtomic} from './result.ts';
import {MCP_CALL_P95_BUDGET_MS, STARTUP_P95_BUDGET_MS, measureStartup} from './startupBaseline.ts';

/**
 * Executes the warm-startup baseline command.
 *
 * Sessions are sequential: process spawn and handshake time are the
 * measurement, so overlap would invalidate every sample.
 *
 * @param flags - Parsed command-line flags.
 */
export const startupCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const root = flagOf(flags, 'root');
	const projectFile = flagOf(flags, 'project-file');
	const database = flagOf(flags, 'database');
	const output = flagOf(flags, 'output');

	if (root === undefined || projectFile === undefined || database === undefined || output === undefined) {
		throw new Error('startup requires --root, --project-file, --database, and --output');
	}

	const iterations = Number(flagOf(flags, 'iterations') ?? '20');

	if (!Number.isInteger(iterations) || iterations < 1) {
		throw new Error('--iterations must be a positive integer');
	}

	const entryPoint = path.resolve(flagOf(flags, 'entry') ?? path.join(primaryCheckout, 'dist', 'mcp.mjs'));
	const record = await measureStartup({entryPoint, repositoryRoot: primaryCheckout, root, projectFile, database, iterations});

	writeJsonAtomic(path.resolve(output), record, true);
	process.stdout.write(
		`p50 ${String(record.percentiles.p50Ms)} ms, p95 ${String(record.percentiles.p95Ms)} ms, p99 ${String(record.percentiles.p99Ms)} ms, max ${String(record.percentiles.maxMs)} ms\n`,
	);
	process.stdout.write(`gate ${record.gate.status} (p95 <= ${String(STARTUP_P95_BUDGET_MS)} ms)\n`);
	process.stdout.write(
		`${record.calls.tool} calls ${String(record.calls.iterations)}: p50 ${String(record.calls.percentiles.p50Ms)} ms, p95 ${String(record.calls.percentiles.p95Ms)} ms, max ${String(record.calls.percentiles.maxMs)} ms\n`,
	);
	process.stdout.write(`gate ${record.calls.gate.status} (p95 <= ${String(MCP_CALL_P95_BUDGET_MS)} ms)\n`);

	if (record.gate.status === 'fail' || record.calls.gate.status === 'fail') {
		process.exitCode = 1;
	}
};
