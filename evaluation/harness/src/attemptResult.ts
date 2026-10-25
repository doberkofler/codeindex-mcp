import {EXECUTION_SCHEMA_VERSION, type ExecutionIdentityType} from './identity.ts';
import {type ProviderMeterReconciliationType} from './providerMeterLedger.ts';
import {type AttemptLogType, type AttemptContextType, type ExecutionIsolationType, type RunArtifactsType, type RunResultType} from './runTypes.ts';
import {type RoutingType, type ToolSurfaceType, type TreatmentDefinitionType} from './treatment.ts';
import {type CaseType} from './schema.ts';

export type AttemptResultType = Readonly<{
	result: Omit<RunResultType, 'attempts' | 'rateLimited'>;
	log: AttemptLogType;
}>;

/**
 * Derives one closed invalidity reason from process, routing, path, and meter facts.
 *
 * @param input - Measured execution facts.
 * @returns The first closed cause, or null when the execution is valid.
 */
export const invalidReasonOf = (
	input: Readonly<{
		timedOut: boolean;
		exitCode: number | null;
		routing: RoutingType;
		/** True when the declared surface intentionally exposes generic execute. */
		executePresent: boolean;
		externalPathAttemptCount: number;
		providerMeter: ProviderMeterReconciliationType | null;
	}>,
): string | null => {
	const {timedOut, exitCode, routing, executePresent, externalPathAttemptCount, providerMeter} = input;

	if (timedOut) {
		return 'timed out';
	}

	if (externalPathAttemptCount > 0) {
		return `denied external-directory access ${externalPathAttemptCount} time(s)`;
	}

	if (exitCode === null || exitCode !== 0) {
		return `agent exited with ${exitCode ?? 'no status'}`;
	}

	if (routing.unknownTools.length > 0) {
		return `unknown tool(s) presented or called: ${routing.unknownTools.join(', ')}`;
	}

	if (routing.executeCalls > 0 && !executePresent) {
		return 'generic execute was called although it is absent from this treatment';
	}

	if (providerMeter !== null && providerMeter.economicClaim.state !== 'exact') {
		return `provider metering is ${providerMeter.economicClaim.state}: ${providerMeter.economicClaim.reason ?? 'unknown reason'}`;
	}

	return null;
};

/**
 * Builds the stored-shape result for one attempt.
 *
 * @param input - Execution identity and declared inputs.
 * @param context - Derived attempt facts.
 * @returns The result without cumulative attempt fields.
 */
export const attemptResultOf = (
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
		defects: [
			...(context.externalPathAttempts.length === 0 && (context.providerMeter?.pathDisclosureCount ?? 0) === 0 ? [] : ['external-path-attempt' as const]),
			...(context.providerMeter !== null && context.providerMeter.economicClaim.state !== 'exact' ? ['metering-incomplete' as const] : []),
		],
		externalPathAttempts: context.externalPathAttempts,
		externalPathAttemptCount: context.externalPathAttempts.reduce((total, attempt) => total + attempt.count, 0),
		isolation: {...input.isolation, restored: false},
		artifacts: input.artifacts,
		usage: context.events.usage,
		telemetry: context.events.telemetry,
		providerCost: context.providerCost,
		providerMeter: context.providerMeter,
		toolCalls: context.events.toolCalls,
		outputBytes: context.events.outputBytes,
		familyBytes: context.events.familyBytes,
		rawEventCount: context.events.rawEventCount,
		malformedEventCount: context.events.malformed.length,
		streamTruncated: context.events.truncated,
		streamComplete: context.events.stream.complete,
		streamIncompleteReasons: context.events.stream.reasons,
		indexCalls: context.routing.codeIndexCalls,
		surface: input.surface,
		routing: context.routing,
		errors: context.events.errors,
		grade: context.grade,
		workflow: context.workflow,
		postRun: context.postRun,
		valid: context.invalidReason === null,
		invalidReason: context.invalidReason,
		finalText: context.events.finalText.slice(0, 4000),
		stderrTail: context.stderr.slice(-4000),
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
