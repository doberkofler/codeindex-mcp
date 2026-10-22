import {spawn, type ChildProcess} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {runChildOf, signalGroup, TERMINATE_GRACE_MS} from './childProcess.ts';
import {isRateLimited, parseEvents} from './events.ts';
import {gradeOf} from './grade.ts';
import {EXECUTION_SCHEMA_VERSION, type ExecutionIdentityType} from './identity.ts';
import {type ClientStoreType} from './isolation.ts';
import {type PostRunResultType, postRunOf, skippedPostRunOf} from './postRun.ts';
import {isolatedProcessEnvironmentOf} from './processEnvironment.ts';
import {
	type AttemptContextType,
	type AttemptLogType,
	type ExecutionIsolationType,
	type OutcomeType,
	type RunArtifactsType,
	type RunResultType,
} from './runTypes.ts';
import {promptOf} from './suite.ts';
import {type CaseType} from './schema.ts';
import {routingOf, type RoutingType, type ToolSurfaceType, type TreatmentDefinitionType} from './treatment.ts';
import {workflowOf} from './workflow.ts';

const FINAL_TEXT_TAIL = 4000;
const STDERR_TAIL = 4000;
const RAW_STDOUT_LIMIT = 1_000_000;
const RAW_STDERR_LIMIT = 64_000;

/** Default executable; tests replace it with a controlled agent script. */
const AGENT_COMMAND = 'opencode';

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

type AttemptResultType = Readonly<{
	result: Omit<RunResultType, 'attempts' | 'rateLimited'>;
	log: AttemptLogType;
}>;

const agentProcessOf = (input: Readonly<{cwd: string; model: string; clientStore: ClientStoreType; command?: string}>, prompt: string): ChildProcess =>
	spawn(input.command ?? AGENT_COMMAND, ['run', '--standalone', '--agent', 'evaluator', '--model', input.model, '--format', 'json', '--auto', prompt], {
		cwd: input.cwd,
		// A new process group lets the timeout reach the standalone server and
		// every tool subprocess. The group is never the harness's own.
		detached: process.platform !== 'win32',
		// OpenCode resolves the project from PWD, which spawn does not update.
		// OPENCODE_DB is always explicit; an inherited value is never reused.
		env: isolatedProcessEnvironmentOf({
			PWD: input.cwd,
			OPENCODE_DB: input.clientStore.opencodeDb,
			OPENCODE_DISABLE_TELEMETRY: '1',
		}),
		stdio: ['ignore', 'pipe', 'pipe'],
	});

const postRunCheckOf = async (testCase: CaseType, cwd: string, timedOut: boolean): Promise<PostRunResultType | null> => {
	if (testCase.check === null) {
		return null;
	}

	if (timedOut) {
		return skippedPostRunOf(testCase.check, 'the agent timed out before the post-run command could execute');
	}

	const result = await postRunOf(testCase.check, cwd);

	return result;
};

const invalidReasonOf = (timedOut: boolean, exitCode: number | null, routing: RoutingType): string | null => {
	if (timedOut) {
		return 'timed out';
	}

	if (exitCode === null || exitCode !== 0) {
		return `agent exited with ${exitCode ?? 'no status'}`;
	}

	if (routing.unknownTools.length > 0) {
		return `unknown tool(s) presented or called: ${routing.unknownTools.join(', ')}`;
	}

	if (routing.executeCalls > 0) {
		return 'generic execute was called although it is absent from every treatment';
	}

	return null;
};

const rawStreamsOf = (rawBase: string | null, attempt: number, stdout: string, stderr: string): string | null => {
	if (rawBase === null) {
		return null;
	}

	const rawFile = `${rawBase}.attempt-${attempt}.jsonl`;

	mkdirSync(path.dirname(rawFile), {recursive: true});
	writeFileSync(rawFile, stdout.slice(0, RAW_STDOUT_LIMIT), 'utf8');
	writeFileSync(`${rawBase}.attempt-${attempt}.stderr.txt`, stderr.slice(0, RAW_STDERR_LIMIT), 'utf8');

	return rawFile;
};

const attemptResultOf = (
	input: Readonly<{
		campaignId: string;
		cwd: string;
		testCase: CaseType;
		treatment: TreatmentDefinitionType;
		surface: ToolSurfaceType;
		repetition: number;
		model: string;
		revision: string;
		identity: ExecutionIdentityType;
		identityDigest: string;
		isolation: Omit<ExecutionIsolationType, 'restored'>;
		artifacts: RunArtifactsType;
	}>,
	context: AttemptContextType,
): AttemptResultType => ({
	result: {
		recordType: 'result',
		schemaVersion: EXECUTION_SCHEMA_VERSION,
		campaignId: input.campaignId,
		identity: input.identity,
		identityDigest: input.identityDigest,
		attempt: context.attempt,
		caseId: input.testCase.id,
		caseClass: input.testCase.class,
		treatment: input.treatment.id,
		treatmentDefinitionHash: input.treatment.definitionHash,
		repetition: input.repetition,
		model: input.model,
		revision: input.revision,
		startedAt: context.startedAt,
		completedAt: context.completedAt,
		durationMs: context.durationMs,
		exitCode: context.exitCode,
		signal: context.signal,
		timedOut: context.timedOut,
		timeoutMs: context.timeoutMs,
		outcome: context.outcome,
		defects: [],
		isolation: {...input.isolation, restored: false},
		artifacts: input.artifacts,
		usage: context.events.usage,
		telemetry: context.events.telemetry,
		toolCalls: context.events.toolCalls,
		outputBytes: context.events.outputBytes,
		familyBytes: context.events.familyBytes,
		rawEventCount: context.events.rawEventCount,
		malformedEventCount: context.events.malformed.length,
		streamTruncated: context.events.truncated,
		indexCalls: context.routing.codeIndexCalls,
		surface: input.surface,
		routing: context.routing,
		errors: context.events.errors,
		grade: context.grade,
		workflow: context.workflow,
		postRun: context.postRun,
		valid: context.invalidReason === null,
		invalidReason: context.invalidReason,
		finalText: context.events.finalText.slice(0, FINAL_TEXT_TAIL),
		stderrTail: context.stderr.slice(-STDERR_TAIL),
	},
	log: {
		attempt: context.attempt,
		startedAt: context.startedAt,
		durationMs: context.durationMs,
		exitCode: context.exitCode,
		signal: context.signal,
		timedOut: context.timedOut,
		rateLimited: context.throttled,
		invalidReason: context.invalidReason,
		rawFile: context.rawFile,
	},
});

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
	}>,
	attempt: number,
): Promise<AttemptResultType> => {
	const startedAt = new Date().toISOString();
	const started = Date.now();
	const prompt = promptOf(input.testCase);
	const timeoutMs = input.timeoutMs ?? input.testCase.timeoutMs;
	const child = agentProcessOf(input, prompt);

	installTerminationHandlers();
	activeAttempts.add(child);

	const {stdout, stderr, timedOut, exit} = await runChildOf({child, timeoutMs});

	activeAttempts.delete(child);

	const durationMs = Date.now() - started;
	const completedAt = new Date().toISOString();
	const exitCode = exit.code;
	const events = parseEvents(stdout);
	const grade = gradeOf(input.testCase, events.finalText);
	const workflow = workflowOf(input.testCase, events, durationMs);
	const postRun = await postRunCheckOf(input.testCase, input.cwd, timedOut);
	const routing = routingOf(
		input.surface,
		events.toolCalls.map((call) => call.tool),
	);
	const invalidReason = invalidReasonOf(timedOut, exitCode, routing);
	const outcome: OutcomeType = timedOut ? 'timed-out' : invalidReason === null ? 'completed' : 'failed';
	const throttled = isRateLimited(stdout, stderr, events.errors.join('\n'));
	const rawFile = rawStreamsOf(input.rawBase, attempt, stdout, stderr);

	return attemptResultOf(input, {
		attempt,
		startedAt,
		completedAt,
		durationMs,
		timeoutMs,
		exitCode,
		signal: exit.signal,
		timedOut,
		outcome,
		invalidReason,
		events,
		routing,
		grade,
		workflow,
		postRun,
		throttled,
		rawFile,
		stderr,
	});
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
