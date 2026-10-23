import {type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {agentEnvironmentOf, agentProcessOf} from './agentProcess.ts';
import {runChildOf, signalGroup, TERMINATE_GRACE_MS} from './childProcess.ts';
import {type ExecutionIdentityType} from './identity.ts';
import {type ClientStoreType} from './isolation.ts';
import {attemptResultOf, type AttemptResultType} from './attemptResult.ts';
import {attemptContextOf} from './attemptContext.ts';
import {startExecutionMeterOf, type ExecutionProviderMeterType} from './executionMeter.ts';
import {openReadyServerOf, type OpenCodeServerType} from './opencodeServer.ts';
import {type ProviderMeterReconciliationType} from './providerMeterLedger.ts';
import {type TaskCostVectorType} from './taskCost.ts';
import {type AttemptLogType, type ExecutionIsolationType, type RunArtifactsType, type RunResultType} from './runTypes.ts';
import {promptOf} from './suite.ts';
import {type CaseType} from './schema.ts';
import {type ToolSurfaceType, type TreatmentDefinitionType} from './treatment.ts';

/** Retry policy: bounded attempts with exponential, jittered backoff. */
const MAX_ATTEMPTS = 6;
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
const OTHER_FAILURE_BACKOFF_MS = 10_000;
/** Retry policy for one slot. */
export type RetryPolicyType = Readonly<{
	maxAttempts: number;
	backoffMs: (attempt: number, rateLimited: boolean) => number;
}>;
/** Restoration performed before another attempt may start. */
export type RetryPreparationType = Readonly<{
	restored: boolean;
	reason: string | null;
}>;
const withDirtyIsolation = <Result extends Omit<RunResultType, 'attempts' | 'rateLimited'>>(result: Result, reason: string): Result => ({
	...result,
	outcome: 'failed',
	defects: result.defects.includes('dirty-isolation') ? result.defects : [...result.defects, 'dirty-isolation'],
	valid: false,
	invalidReason: result.invalidReason === null ? reason : `${result.invalidReason}; ${reason}`,
	isolation: {...result.isolation, restored: false},
});
const sleep = async (milliseconds: number): Promise<void> => {
	await delay(milliseconds);
};
const backoffOf = (attempt: number, rateLimited: boolean): number => {
	if (!rateLimited) {
		return OTHER_FAILURE_BACKOFF_MS;
	}
	const base = RATE_LIMIT_BACKOFF_MS[Math.min(attempt - 1, RATE_LIMIT_BACKOFF_MS.length - 1)] ?? 300_000;
	const jitter = Math.round(base * 0.2 * Math.random());
	return base + jitter;
};

const DEFAULT_RETRY: RetryPolicyType = {
	maxAttempts: MAX_ATTEMPTS,
	backoffMs: backoffOf,
};
/** Attempts whose detached model process group is still running. */
const activeAttempts = new Set<ChildProcess>();

let terminationHandlersInstalled = false;

/**
 * Terminates every running attempt's process group.
 *
 * Evaluation children are detached so one timeout reaches the model, its
 * server, and its tool subprocesses. That also means an outer runner's group
 * signal misses them, so the harness forwards its own termination.
 *
 * @param signal - Signal to forward.
 */
export const terminateActiveAttempts = (signal: NodeJS.Signals): void => {
	for (const child of activeAttempts) {
		signalGroup(child, signal);
	}
};

const installTerminationHandlers = (): void => {
	if (terminationHandlersInstalled) {
		return;
	}

	terminationHandlersInstalled = true;

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			terminateActiveAttempts(signal);
			const deadline = Date.now() + TERMINATE_GRACE_MS * 2;
			const finish = (): void => {
				if (activeAttempts.size === 0 || Date.now() >= deadline) {
					for (const child of activeAttempts) {
						signalGroup(child, 'SIGKILL');
					}

					process.exit(signal === 'SIGINT' ? 130 : 143);
				}

				setTimeout(finish, 25);
			};
			setTimeout(finish, 25);
		});
	}
};

const cleanupAttemptOf = async (
	openCode: OpenCodeServerType | null,
	meter: Awaited<ReturnType<typeof startExecutionMeterOf>>,
): Promise<Readonly<{cost: TaskCostVectorType | null; reconciliation: ProviderMeterReconciliationType | null; error: Error | null}>> => {
	let error: Error | null = null;

	try {
		await openCode?.close();
	} catch (error_) {
		error = error_ instanceof Error ? error_ : new Error('OpenCode server cleanup failed', {cause: error_});
	}

	try {
		const measured = await meter.finish();

		return {cost: measured.cost, reconciliation: measured.reconciliation, error};
	} catch (error_) {
		return {
			cost: null,
			reconciliation: null,
			error: error_ instanceof Error ? error_ : new Error('provider meter cleanup failed', {cause: error_}),
		};
	}
};
/**
 * Executes one attempt and derives its graded result.
 *
 * Raw stdout and stderr are persisted before parsing so an unexpected event
 * shape can be diagnosed without reproducing the execution.
 *
 * @param input - Execution input.
 * @param attempt - One-based attempt number.
 * @param rawBase - Path prefix for persisted raw streams.
 * @returns The derived result and its attempt log.
 */
const attemptOnce = async (
	input: Readonly<{
		cwd: string;
		testCase: CaseType;
		treatment: TreatmentDefinitionType;
		surface: ToolSurfaceType;
		repetition: number;
		model: string;
		revision: string;
		campaignId: string;
		identity: ExecutionIdentityType;
		identityDigest: string;
		clientStore: ClientStoreType;
		/** Verified pre-execution isolation state. */
		isolation: Omit<ExecutionIsolationType, 'restored'>;
		/** Artifact identities recorded with the result. */
		artifacts: RunArtifactsType;
		rawBase: string | null;
		/** Wall-clock bound override, used to cap a slot at its campaign budget. */
		timeoutMs?: number;
		/** Executable override; production uses `opencode`. */
		command?: string;
		/** Configured MCP servers that must connect before the prompt is admitted. */
		mcpServers?: readonly string[];
		/** Loopback provider meter; when absent, no virtual provider is injected. */
		providerMeter?: ExecutionProviderMeterType | null;
	}>,
	attempt: number,
): Promise<AttemptResultType> => {
	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	const timeoutMs = input.timeoutMs ?? input.testCase.timeoutMs;
	const meter = await startExecutionMeterOf(input.providerMeter ?? null);
	let openCode: OpenCodeServerType | null = null;

	try {
		if (input.command === undefined) {
			// A fresh private server is made ready before the prompt exists. The
			// `run` process connects to it, so request 1 cannot be composed while an
			// expected MCP server is still registering.
			const ready = await openReadyServerOf({
				cwd: input.cwd,
				env: {...agentEnvironmentOf(input), ...meter.environment},
				expectedServers: input.mcpServers ?? [],
			});

			openCode = ready.server;
		}
	} catch (error) {
		await meter.finish();
		throw error;
	}

	let child: ChildProcess;
	let executed: Awaited<ReturnType<typeof runChildOf>>;
	let providerCost: TaskCostVectorType | null;
	let providerMeter: ProviderMeterReconciliationType | null;
	let cleanupError: Error | null;

	try {
		child = agentProcessOf({...input, environmentOverrides: meter.environment}, promptOf(input.testCase), openCode);
	} catch (error) {
		await openCode?.close();
		await meter.finish();
		throw error;
	}

	installTerminationHandlers();
	activeAttempts.add(child);

	try {
		executed = await runChildOf({child, timeoutMs});
	} finally {
		// The private server may still be settling an asynchronous title request,
		// so it closes before the meter reconciles. Signal handlers may exit only
		// after both cleanup operations settle.
		const cleanup = await cleanupAttemptOf(openCode, meter);

		providerCost = cleanup.cost;
		providerMeter = cleanup.reconciliation;
		cleanupError = cleanup.error;
		activeAttempts.delete(child);
	}

	if (cleanupError !== null) {
		throw cleanupError;
	}

	const context = await attemptContextOf({
		attempt,
		startedAt,
		startedMs,
		timeoutMs,
		testCase: input.testCase,
		cwd: input.cwd,
		surface: input.surface,
		stdout: executed.stdout,
		stderr: executed.stderr,
		timedOut: executed.timedOut,
		exitCode: executed.exit.code,
		signal: executed.exit.signal,
		rawBase: input.rawBase,
		providerCost,
		providerMeter,
	});

	return attemptResultOf(input, context);
};

/**
 * Runs one arm/repetition pair, retrying throttled or failed attempts.
 *
 * Retries are not repetitions: the accepted attempt is what the result records,
 * and every discarded attempt is retained in `attempts` for audit. A hard
 * timeout is terminal for the slot, because re-running a timed-out execution
 * would substitute a different observation.
 *
 * @param input - Workspace, case, arm, repetition, model, and isolation.
 * @returns The persisted-shape result.
 */
export const runOnce = async (
	input: Readonly<{
		cwd: string;
		testCase: CaseType;
		treatment: TreatmentDefinitionType;
		surface: ToolSurfaceType;
		repetition: number;
		model: string;
		revision: string;
		campaignId: string;
		identity: ExecutionIdentityType;
		identityDigest: string;
		clientStore: ClientStoreType;
		/** Verified pre-execution isolation state. */
		isolation: Omit<ExecutionIsolationType, 'restored'>;
		/** Artifact identities recorded with the result. */
		artifacts: RunArtifactsType;
		rawBase: string | null;
		/** Wall-clock bound override, used to cap a slot at its campaign budget. */
		timeoutMs?: number;
		/** Executable override; production uses `opencode`. */
		command?: string;
		/** Configured MCP servers that must connect before each prompt is admitted. */
		mcpServers?: readonly string[];
		/** Loopback provider meter for this slot. */
		providerMeter?: ExecutionProviderMeterType | null;
		/** Retry policy override for focused tests. */
		retry?: RetryPolicyType;
		/** First attempt ordinal, used to continue a slot's stored sequence. */
		firstAttempt?: number;
		/** Called once for every attempt before the next attempt starts. */
		onAttempt?: (result: RunResultType) => void;
		/**
		 * Restores the workspace to the pinned revision before another attempt.
		 * A failed restoration aborts the slot instead of retrying from edits.
		 */
		prepareRetry?: () => RetryPreparationType;
	}>,
): Promise<RunResultType> => {
	const attempts: AttemptLogType[] = [];
	const retry = input.retry ?? DEFAULT_RETRY;
	const firstAttempt = input.firstAttempt ?? 1;
	let last: AttemptResultType | null = null;

	for (let index = 0; index < retry.maxAttempts; index += 1) {
		const attempt = firstAttempt + index;

		last = await attemptOnce(input, attempt);
		attempts.push(last.log);
		input.onAttempt?.({...last.result, attempts: [...attempts], rateLimited: attempts.some((item) => item.rateLimited)});

		if (last.result.valid || last.result.timedOut) {
			break;
		}

		// A denied external-path attempt is retained and never retried until a
		// favorable clean trajectory appears. The affected slot is invalid.
		if ((last.result.externalPathAttemptCount ?? 0) > 0) {
			break;
		}

		if (index < retry.maxAttempts - 1) {
			const preparation = input.prepareRetry?.();

			if (preparation !== undefined && !preparation.restored) {
				const reason = `restoration before retry failed: ${preparation.reason ?? 'unknown'}`;
				const result = withDirtyIsolation(last.result, reason);

				last = {
					result,
					log: {
						...last.log,
						invalidReason: result.invalidReason,
					},
				};
				attempts[attempts.length - 1] = last.log;
				break;
			}

			await sleep(retry.backoffMs(attempt, last.log.rateLimited));
		}
	}

	if (last === null) {
		throw new Error('no execution attempt was made');
	}

	return {
		...last.result,
		rateLimited: attempts.some((item) => item.rateLimited),
		attempts,
	};
};

/**
 * Folds the post-execution restoration outcome into a stored result.
 *
 * A workspace that could not be restored is a harness failure, not a model
 * failure: the result is still written so it can be inspected, and it is
 * marked failed so the affected slot is never counted as evidence. The caller
 * stops the campaign because the next execution would observe edits from the
 * previous one.
 *
 * @param result - Result of the execution.
 * @param restoration - Whether the workspace was restored and why not.
 * @returns The result with its final isolation state.
 */
export const withRestoration = (result: RunResultType, restoration: Readonly<{restored: boolean; reason: string | null}>): RunResultType => {
	if (restoration.restored) {
		return {...result, isolation: {...result.isolation, restored: true}};
	}

	const reason = `restoration failed: ${restoration.reason ?? 'unknown'}`;

	return {
		...result,
		outcome: 'failed',
		defects: result.defects.includes('dirty-isolation') ? result.defects : [...result.defects, 'dirty-isolation'],
		valid: false,
		invalidReason: result.invalidReason === null ? reason : `${result.invalidReason}; ${reason}`,
		isolation: {...result.isolation, restored: false},
	};
};
