import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {isRateLimited, parseEvents} from './events.ts';
import {externalPathAttemptsOf} from './externalPath.ts';
import {gradeOf} from './grade.ts';
import {invalidReasonOf} from './attemptResult.ts';
import {surfaceRequestLedgerOf} from './requestSurface.ts';
import {type ProviderMeterReconciliationType} from './providerMeterLedger.ts';
import {type PostRunResultType, postRunOf, skippedPostRunOf} from './postRun.ts';
import {type AttemptContextType, type OutcomeType} from './runTypes.ts';
import {type CaseType} from './schema.ts';
import {type TaskCostVectorType} from './taskCost.ts';
import {routingOf, type ToolSurfaceType} from './treatment.ts';
import {workflowOf} from './workflow.ts';

const RAW_STDOUT_LIMIT = 1_000_000;
const RAW_STDERR_LIMIT = 64_000;

/**
 * Persists bounded raw stdout and stderr for one attempt.
 *
 * @param rawBase - Path prefix for the raw streams, or null to retain none.
 * @param attempt - One-based attempt number.
 * @param stdout - Captured stdout text.
 * @param stderr - Captured stderr text.
 * @returns The retained stdout path, or null.
 */
export const rawStreamsOf = (rawBase: string | null, attempt: number, stdout: string, stderr: string): string | null => {
	if (rawBase === null) {
		return null;
	}

	const rawFile = `${rawBase}.attempt-${attempt}.jsonl`;

	mkdirSync(path.dirname(rawFile), {recursive: true});
	writeFileSync(rawFile, stdout.slice(0, RAW_STDOUT_LIMIT), 'utf8');
	writeFileSync(`${rawBase}.attempt-${attempt}.stderr.txt`, stderr.slice(0, RAW_STDERR_LIMIT), 'utf8');

	return rawFile;
};

const postRunCheckOf = (testCase: CaseType, cwd: string, timedOut: boolean): Promise<PostRunResultType | null> | PostRunResultType | null => {
	if (testCase.check === null) {
		return null;
	}

	if (timedOut) {
		return skippedPostRunOf(testCase.check, 'the agent timed out before the post-run command could execute');
	}

	return postRunOf(testCase.check, cwd);
};

/**
 * Derives every closed attempt fact from the captured process stream.
 *
 * @param input - Process, surface, and provider-meter facts for one attempt.
 * @returns The context stored with the attempt result.
 */
export const attemptContextOf = async (
	input: Readonly<{
		attempt: number;
		startedAt: string;
		startedMs: number;
		timeoutMs: number;
		testCase: CaseType;
		cwd: string;
		surface: ToolSurfaceType;
		stdout: string;
		stderr: string;
		timedOut: boolean;
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		rawBase: string | null;
		providerCost: TaskCostVectorType | null;
		providerMeter: ProviderMeterReconciliationType | null;
	}>,
): Promise<AttemptContextType> => {
	const durationMs = Date.now() - input.startedMs;
	const completedAt = new Date().toISOString();
	const events = parseEvents(input.stdout);
	const routing = routingOf(
		input.surface,
		events.toolCalls.map((call) => call.tool),
	);
	const externalPathAttempts = externalPathAttemptsOf(input.stdout, input.stderr);
	const surfaceLedger = input.providerMeter === null ? null : surfaceRequestLedgerOf(input.surface, input.providerMeter.requests);
	const surfaceReason =
		surfaceLedger === null || surfaceLedger.result === 'pass'
			? null
			: `request-1 surface is ${surfaceLedger.cause ?? 'invalid'}: ${surfaceLedger.differences.join('; ')}`;
	const invalidReason =
		invalidReasonOf({
			timedOut: input.timedOut,
			exitCode: input.exitCode,
			routing,
			executePresent: input.surface.execute === 'present',
			externalPathAttemptCount: externalPathAttempts.reduce((total, attempt) => total + attempt.count, 0),
			providerMeter: input.providerMeter,
		}) ?? surfaceReason;
	const outcome: OutcomeType = input.timedOut ? 'timed-out' : invalidReason === null ? 'completed' : 'failed';

	return {
		attempt: input.attempt,
		startedAt: input.startedAt,
		completedAt,
		durationMs,
		timeoutMs: input.timeoutMs,
		exitCode: input.exitCode,
		signal: input.signal,
		timedOut: input.timedOut,
		outcome,
		invalidReason,
		events,
		routing,
		grade: gradeOf(input.testCase, events.finalText),
		workflow: workflowOf(input.testCase, events, durationMs),
		postRun: await postRunCheckOf(input.testCase, input.cwd, input.timedOut),
		throttled: isRateLimited(input.stdout, input.stderr, events.errors.join('\n')),
		rawFile: rawStreamsOf(input.rawBase, input.attempt, input.stdout, input.stderr),
		stderr: input.stderr,
		externalPathAttempts,
		providerCost: input.providerCost,
		providerMeter: input.providerMeter,
	};
};
