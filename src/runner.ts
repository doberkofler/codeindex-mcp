import {spawn} from 'node:child_process';
import {mkdirSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {isRateLimited, parseEvents, type RunEventsType} from './events.ts';
import {gradeOf, type GradeType} from './grade.ts';
import {promptOf} from './suite.ts';
import {type ArmNameType, type CaseType} from './schema.ts';

/** Workflow assessment kept separate from correctness. */
export type WorkflowResultType = Readonly<{compliant: boolean; violations: readonly string[]}>;

/** One execution attempt, including throttled attempts that are not runs. */
export type AttemptLogType = Readonly<{
	attempt: number;
	startedAt: string;
	durationMs: number;
	exitCode: number | null;
	timedOut: boolean;
	rateLimited: boolean;
	invalidReason: string | null;
	/** Bounded raw event stream for this attempt, when the caller asked for it. */
	rawFile: string | null;
}>;

/** One persisted run result. */
export type RunResultType = Readonly<{
	identityHash: string;
	caseId: string;
	caseClass: string;
	arm: ArmNameType;
	repetition: number;
	model: string;
	revision: string;
	startedAt: string;
	durationMs: number;
	exitCode: number | null;
	timedOut: boolean;
	usage: RunEventsType['usage'];
	toolCalls: RunEventsType['toolCalls'];
	outputBytes: number;
	indexCalls: number;
	errors: readonly string[];
	grade: GradeType;
	workflow: WorkflowResultType;
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

/** Retry policy: bounded attempts with exponential, jittered backoff. */
const MAX_ATTEMPTS = 6;
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
const OTHER_FAILURE_BACKOFF_MS = 10_000;

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

/**
 * Assesses the declarative workflow gates for one run.
 *
 * @param testCase - Case policy.
 * @param events - Parsed events.
 * @returns Compliance and the violated gates.
 */
export const workflowOf = (testCase: CaseType, events: RunEventsType): WorkflowResultType => {
	const violations: string[] = [];

	if (events.toolCalls.length > testCase.workflow.maxTotalCalls) {
		violations.push(`tool calls ${events.toolCalls.length} > ${testCase.workflow.maxTotalCalls}`);
	}

	if (events.outputBytes > testCase.workflow.maxOutputBytes) {
		violations.push(`output bytes ${events.outputBytes} > ${testCase.workflow.maxOutputBytes}`);
	}

	const required = testCase.workflow.requiredFirstTool;

	if (required !== null && events.toolCalls[0]?.tool !== required) {
		violations.push(`first tool ${events.toolCalls[0]?.tool ?? 'none'} != ${required}`);
	}

	return {compliant: violations.length === 0, violations};
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
		arm: ArmNameType;
		repetition: number;
		model: string;
		revision: string;
		identityHash: string;
		rawBase: string | null;
	}>,
	attempt: number,
): Promise<AttemptResultType> => {
	const startedAt = new Date().toISOString();
	const started = Date.now();
	const prompt = promptOf(input.testCase);

	const child = spawn(
		'opencode',
		['run', '--standalone', '--agent', 'evaluator', '--model', input.model, '--format', 'json', '--auto', prompt],
		{
			cwd: input.cwd,
			// OpenCode resolves the project from PWD, which spawn does not update.
			env: {...process.env, PWD: input.cwd, OPENCODE_DISABLE_TELEMETRY: '1'},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);

	let stdout = '';
	let stderr = '';
	let timedOut = false;

	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGKILL');
	}, input.testCase.timeoutMs);

	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});

	const exitCode = await new Promise<number | null>((resolve) => {
		child.on('close', (code) => resolve(code));
		child.on('error', () => resolve(null));
	});
	clearTimeout(timer);

	const durationMs = Date.now() - started;
	const events = parseEvents(stdout);
	const grade = gradeOf(input.testCase, events.finalText);
	const workflow = workflowOf(input.testCase, events);
	const invalidReason = timedOut
		? 'timed out'
		: exitCode === null || exitCode !== 0
			? `agent exited with ${exitCode ?? 'no status'}`
			: !events.usage.available
				? 'client emitted no token usage'
				: null;
	const throttled = isRateLimited(stdout, stderr, events.errors.join('\n'));
	const rawFile = input.rawBase === null ? null : `${input.rawBase}.attempt-${attempt}.jsonl`;

	if (rawFile !== null) {
		mkdirSync(path.dirname(rawFile), {recursive: true});
		writeFileSync(rawFile, stdout.slice(0, RAW_STDOUT_LIMIT), 'utf8');
		writeFileSync(`${input.rawBase}.attempt-${attempt}.stderr.txt`, stderr.slice(0, RAW_STDERR_LIMIT), 'utf8');
	}

	return {
		result: {
			identityHash: input.identityHash,
			caseId: input.testCase.id,
			caseClass: input.testCase.class,
			arm: input.arm,
			repetition: input.repetition,
			model: input.model,
			revision: input.revision,
			startedAt,
			durationMs,
			exitCode,
			timedOut,
			usage: events.usage,
			toolCalls: events.toolCalls,
			outputBytes: events.outputBytes,
			indexCalls: events.toolCalls.filter((call) => call.tool.startsWith('codeindex') || /codeindex[._]/.test(call.inputText)).length,
			errors: events.errors,
			grade,
			workflow,
			valid: invalidReason === null,
			invalidReason,
			finalText: events.finalText.slice(0, FINAL_TEXT_TAIL),
			stderrTail: stderr.slice(-STDERR_TAIL),
		},
		log: {attempt, startedAt, durationMs, exitCode, timedOut, rateLimited: throttled, invalidReason, rawFile},
	};
};

/**
 * Runs one arm/repetition pair, retrying throttled or failed attempts.
 *
 * Retries are not repetitions: the accepted attempt is what the result records,
 * and every discarded attempt is retained in `attempts` for audit.
 *
 * @param input - Workspace, case, arm, repetition, and model.
 * @returns The persisted-shape result.
 */
export const runOnce = async (
	input: Readonly<{
		cwd: string;
		testCase: CaseType;
		arm: ArmNameType;
		repetition: number;
		model: string;
		revision: string;
		identityHash: string;
		rawBase: string | null;
	}>,
): Promise<RunResultType> => {
	const attempts: AttemptLogType[] = [];
	let last: AttemptResultType | null = null;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		last = await attemptOnce(input, attempt);
		attempts.push(last.log);

		if (last.result.valid) {
			break;
		}

		if (attempt < MAX_ATTEMPTS) {
			await sleep(backoffOf(attempt, last.log.rateLimited));
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
 * Writes a result file atomically.
 *
 * @param file - Destination path.
 * @param value - JSON-serializable result.
 */
export const writeResult = (file: string, value: unknown): void => {
	mkdirSync(path.dirname(file), {recursive: true});
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
	renameSync(temporary, file);
};
