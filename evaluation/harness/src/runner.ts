import {spawn, type ChildProcess} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {type ArtifactRefType} from './artifact.ts';
import {isRateLimited, parseEvents, type RunEventsType, type TelemetryType} from './events.ts';
import {gradeOf, type GradeType} from './grade.ts';
import {EXECUTION_SCHEMA_VERSION, type ExecutionIdentityType} from './identity.ts';
import {type ClientStoreModeType, type ClientStoreType, type IsolationModeType} from './isolation.ts';
import {postRunOf, skippedPostRunOf, type PostRunResultType} from './postRun.ts';
import {type DefectType} from './result.ts';
import {promptOf} from './suite.ts';
import {type CaseType} from './schema.ts';
import {routingOf, type RoutingType, type ToolSurfaceType, type TreatmentDefinitionType} from './treatment.ts';
import {workflowOf, type WorkflowResultType} from './workflow.ts';

/** Final execution outcome, independent of correctness and workflow. */
export type OutcomeType = 'completed' | 'failed' | 'timed-out' | 'aborted';

/** Environment facts verified before an execution and recorded in its result. */
export type ExecutionIsolationType = Readonly<{
	mode: IsolationModeType;
	clientStore: ClientStoreModeType;
	/** True when the workspace was clean at the pinned subject before the run. */
	checkoutClean: boolean;
	/** True when the workspace was at the pinned revision before the run. */
	revisionMatch: boolean;
	/** True when the workspace was restored to the pinned subject after the run. */
	restored: boolean;
}>;

/** Artifact identities recorded with one result. */
export type RunArtifactsType = Readonly<{
	accepted: ArtifactRefType | null;
	candidate: ArtifactRefType | null;
	loaded: ArtifactRefType | null;
}>;

/** One execution attempt, including throttled attempts that are not runs. */
export type AttemptLogType = Readonly<{
	attempt: number;
	startedAt: string;
	durationMs: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	rateLimited: boolean;
	invalidReason: string | null;
	/** Bounded raw event stream for this attempt, when the caller asked for it. */
	rawFile: string | null;
}>;

/** One persisted run result. */
export type RunResultType = Readonly<{
	recordType: 'result';
	schemaVersion: string;
	campaignId: string;
	identity: ExecutionIdentityType;
	identityDigest: string;
	attempt: number;
	caseId: string;
	caseClass: string;
	treatment: string;
	treatmentDefinitionHash: string;
	repetition: number;
	model: string;
	revision: string;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	/** Hard wall-clock bound declared by the case. */
	timeoutMs: number;
	outcome: OutcomeType;
	/** Harness-detected invalidity causes recorded at write time. */
	defects: readonly DefectType[];
	/** Subject and client isolation verified for this execution. */
	isolation: ExecutionIsolationType;
	/** Artifact identities associated with this execution. */
	artifacts: RunArtifactsType;
	usage: RunEventsType['usage'];
	/** Exact-or-unavailable token and cost metrics; never estimated from bytes. */
	telemetry: TelemetryType;
	/** Normalized calls in stream order, including nested, unknown, and failed calls. */
	toolCalls: RunEventsType['toolCalls'];
	outputBytes: number;
	/** Summed output bytes per tool family. */
	familyBytes: RunEventsType['familyBytes'];
	/** Raw event lines examined and malformed lines retained for diagnosis. */
	rawEventCount: number;
	malformedEventCount: number;
	/** True when the captured stream ended in a truncated or malformed line. */
	streamTruncated: boolean;
	indexCalls: number;
	/** Exact tool-name surface captured before this execution. */
	surface: ToolSurfaceType;
	/** Observed routing, including every unknown-tool outcome. */
	routing: RoutingType;
	errors: readonly string[];
	grade: GradeType;
	workflow: WorkflowResultType;
	/** Declared deterministic post-run command result; null when none was declared. */
	postRun: PostRunResultType | null;
	valid: boolean;
	invalidReason: string | null;
	/** True when the accepted attempt was throttled and retried. */
	rateLimited: boolean;
	/** Every attempt, including discarded throttled executions. */
	attempts: readonly AttemptLogType[];
	finalText: string;
	stderrTail: string;
}>;

const FINAL_TEXT_TAIL = 4_000;
const STDERR_TAIL = 4_000;
const RAW_STDOUT_LIMIT = 1_000_000;
const RAW_STDERR_LIMIT = 64_000;

/** Time between the timeout's graceful signal and the group-wide SIGKILL. */
const TERMINATE_GRACE_MS = 2_000;

/** Upper bound on waiting for stdio close after the group has been killed. */
const HARD_CLOSE_GRACE_MS = 5_000;

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

const sleep = async (milliseconds: number): Promise<void> => {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	});
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

/**
 * Signals a process group, falling back to the direct child.
 *
 * The agent is spawned as a process-group leader (`detached: true`), so a
 * negative PID reaches the standalone server and every tool subprocess it
 * started. A group that has already gone away yields ESRCH, which is not an
 * error at this point.
 *
 * @param child - Spawned agent process.
 * @param signal - Signal to deliver.
 */
const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
	if (child.pid === undefined) {
		return;
	}

	if (process.platform === 'win32') {
		child.kill(signal);

		return;
	}

	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
};

type AttemptResultType = Readonly<{
	result: Omit<RunResultType, 'attempts' | 'rateLimited'>;
	log: AttemptLogType;
}>;

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
		/** Executable override; production uses `opencode`. */
		command?: string;
	}>,
	attempt: number,
): Promise<AttemptResultType> => {
	const startedAt = new Date().toISOString();
	const started = Date.now();
	const prompt = promptOf(input.testCase);

	const child = spawn(
		input.command ?? AGENT_COMMAND,
		['run', '--standalone', '--agent', 'evaluator', '--model', input.model, '--format', 'json', '--auto', prompt],
		{
			cwd: input.cwd,
			// A new process group lets the timeout reach the standalone server and
			// every tool subprocess. The group is never the harness's own.
			detached: process.platform !== 'win32',
			// OpenCode resolves the project from PWD, which spawn does not update.
			// OPENCODE_DB is always explicit; an inherited value is never reused.
			env: {
				...process.env,
				PWD: input.cwd,
				OPENCODE_DB: input.clientStore.opencodeDb,
				OPENCODE_DISABLE_TELEMETRY: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);

	let stdout = '';
	let stderr = '';
	let timedOut = false;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let escalationTimer: NodeJS.Timeout | undefined;
	let hardCloseTimer: NodeJS.Timeout | undefined;

	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});

	const exit = await new Promise<Readonly<{code: number | null; signal: NodeJS.Signals | null}>>((resolve) => {
		let settled = false;

		const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeoutTimer);
			clearTimeout(escalationTimer);
			clearTimeout(hardCloseTimer);
			resolve({code, signal});
		};

		child.on('close', (code, signal) => {
			finish(code, signal);
		});
		child.on('error', () => {
			finish(null, null);
		});

		timeoutTimer = setTimeout(() => {
			timedOut = true;
			signalGroup(child, 'SIGTERM');
			escalationTimer = setTimeout(() => {
				signalGroup(child, 'SIGKILL');
			}, TERMINATE_GRACE_MS);
		}, input.testCase.timeoutMs);

		// A descendant that escaped the group can hold the pipes open. Never wait
		// indefinitely for `close`: the captured streams are complete enough and
		// an open pipe would otherwise keep the harness process alive.
		hardCloseTimer = setTimeout(
			() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.unref();
				finish(null, 'SIGKILL');
			},
			input.testCase.timeoutMs + TERMINATE_GRACE_MS + HARD_CLOSE_GRACE_MS,
		);
	});

	const durationMs = Date.now() - started;
	const completedAt = new Date().toISOString();
	const exitCode = exit.code;
	const events = parseEvents(stdout);
	const grade = gradeOf(input.testCase, events.finalText);
	const workflow = workflowOf(input.testCase, events, durationMs);
	const postRun =
		input.testCase.check === null
			? null
			: timedOut
				? skippedPostRunOf(input.testCase.check, 'the agent timed out before the post-run command could execute')
				: await postRunOf(input.testCase.check, input.cwd);
	const routing = routingOf(
		input.surface,
		events.toolCalls.map((call) => call.tool),
	);
	const unknownTools = routing.unknownTools;
	const invalidReason = timedOut
		? 'timed out'
		: exitCode === null || exitCode !== 0
			? `agent exited with ${exitCode ?? 'no status'}`
			: unknownTools.length > 0
				? `unknown tool(s) presented or called: ${unknownTools.join(', ')}`
				: routing.executeCalls > 0
					? 'generic execute was called although it is absent from every treatment'
					: null;
	const outcome: OutcomeType = timedOut ? 'timed-out' : invalidReason === null ? 'completed' : 'failed';
	const throttled = isRateLimited(stdout, stderr, events.errors.join('\n'));
	const rawFile = input.rawBase === null ? null : `${input.rawBase}.attempt-${attempt}.jsonl`;

	if (rawFile !== null) {
		mkdirSync(path.dirname(rawFile), {recursive: true});
		writeFileSync(rawFile, stdout.slice(0, RAW_STDOUT_LIMIT), 'utf8');
		writeFileSync(`${input.rawBase}.attempt-${attempt}.stderr.txt`, stderr.slice(0, RAW_STDERR_LIMIT), 'utf8');
	}

	return {
		result: {
			recordType: 'result',
			schemaVersion: EXECUTION_SCHEMA_VERSION,
			campaignId: input.campaignId,
			identity: input.identity,
			identityDigest: input.identityDigest,
			attempt,
			caseId: input.testCase.id,
			caseClass: input.testCase.class,
			treatment: input.treatment.id,
			treatmentDefinitionHash: input.treatment.definitionHash,
			repetition: input.repetition,
			model: input.model,
			revision: input.revision,
			startedAt,
			completedAt,
			durationMs,
			exitCode,
			signal: exit.signal,
			timedOut,
			timeoutMs: input.testCase.timeoutMs,
			outcome,
			defects: [],
			isolation: {...input.isolation, restored: false},
			artifacts: input.artifacts,
			usage: events.usage,
			telemetry: events.telemetry,
			toolCalls: events.toolCalls,
			outputBytes: events.outputBytes,
			familyBytes: events.familyBytes,
			rawEventCount: events.rawEventCount,
			malformedEventCount: events.malformed.length,
			streamTruncated: events.truncated,
			indexCalls: routing.codeIndexCalls,
			surface: input.surface,
			routing,
			errors: events.errors,
			grade,
			workflow,
			postRun,
			valid: invalidReason === null,
			invalidReason,
			finalText: events.finalText.slice(0, FINAL_TEXT_TAIL),
			stderrTail: stderr.slice(-STDERR_TAIL),
		},
		log: {attempt, startedAt, durationMs, exitCode, signal: exit.signal, timedOut, rateLimited: throttled, invalidReason, rawFile},
	};
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
		/** Executable override; production uses `opencode`. */
		command?: string;
		/** Retry policy override for focused tests. */
		retry?: RetryPolicyType;
		/** First attempt ordinal, used to continue a slot's stored sequence. */
		firstAttempt?: number;
		/** Called once for every attempt before the next attempt starts. */
		onAttempt?: (result: RunResultType) => void;
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
