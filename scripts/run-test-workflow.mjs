import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const vitestArguments = ['exec', 'vitest', 'run', '--coverage.enabled=false'];

/**
 * @typedef {object} WorkflowStep
 * @property {readonly string[]} arguments - Arguments passed to pnpm.
 * @property {Readonly<Record<string, string>>} [environment] - Extra environment for the step.
 */

/**
 * @typedef {object} Workflow
 * @property {number} budgetMs - Wall-clock budget for the complete workflow.
 * @property {readonly WorkflowStep[]} steps - Ordered commands that make up the workflow.
 */

/** @type {Readonly<Record<string, Workflow>>} */
const workflows = {
	fast: {
		budgetMs: 10_000,
		steps: [{arguments: vitestArguments, environment: {CODE_INDEX_TEST_WORKFLOW: 'fast'}}],
	},
	typescript: {
		budgetMs: 15_000,
		steps: [{arguments: vitestArguments, environment: {CODE_INDEX_TEST_WORKFLOW: 'typescript'}}],
	},
	mcp: {
		budgetMs: 15_000,
		steps: [{arguments: vitestArguments, environment: {CODE_INDEX_TEST_WORKFLOW: 'mcp'}}],
	},
	system: {
		budgetMs: 60_000,
		steps: [{arguments: ['run', 'build']}, {arguments: vitestArguments, environment: {CODE_INDEX_TEST_WORKFLOW: 'system'}}],
	},
	'verify:pr': {
		budgetMs: 120_000,
		steps: [{arguments: ['run', 'build']}, {arguments: ['run', 'verify']}, {arguments: ['run', 'qualify:typescript:fixture:built']}],
	},
};

/**
 * Runs one workflow step and returns its exit code.
 * @param {WorkflowStep} step - Command and environment for the step.
 * @returns {number} Exit code of the step.
 */
const runStep = (step) => {
	const result = spawnSync(pnpmCommand, step.arguments, {
		env: {...process.env, ...step.environment},
		stdio: 'inherit',
	});

	if (result.error !== undefined) {
		throw result.error;
	}

	if (result.signal !== null) {
		throw new Error(`Workflow step terminated by signal ${result.signal}.`);
	}

	return result.status ?? 1;
};

/**
 * Runs a named workflow and fails when it exceeds its budget.
 * @returns {void}
 */
const main = () => {
	/** @type {string | undefined} */
	const name = process.argv.at(2);
	const workflow = name === undefined ? undefined : workflows[name];

	if (workflow === undefined) {
		throw new Error(`Unknown test workflow: ${name ?? '(missing)'}`);
	}

	const startedAt = performance.now();
	let exitCode = 0;

	for (const step of workflow.steps) {
		exitCode = runStep(step);

		if (exitCode !== 0) {
			break;
		}
	}

	if (exitCode !== 0) {
		process.exitCode = exitCode;
		return;
	}

	const elapsedMs = performance.now() - startedAt;
	const elapsedSeconds = (elapsedMs / 1000).toFixed(2);
	const budgetSeconds = (workflow.budgetMs / 1000).toFixed(0);

	if (elapsedMs > workflow.budgetMs) {
		process.stderr.write(`[budget] ${name} took ${elapsedSeconds} s; the budget is ${budgetSeconds} s.\n`);
		process.stderr.write('[budget] Move slower checks to the system or qualification class, or restore the fast path.\n');
		process.exitCode = 1;
		return;
	}

	process.stderr.write(`[budget] ${name} ${elapsedSeconds} s / ${budgetSeconds} s\n`);
};

try {
	main();
} catch (error) {
	process.stderr.write(`[budget] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
