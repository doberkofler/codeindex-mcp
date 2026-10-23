import {createServer, type Server} from 'node:http';
import {once} from 'node:events';
import {EVALUATION_CONTRACT} from './economicContract.ts';
import {hashOf} from './hash.ts';
import {startProviderMeter} from './providerMeter.ts';
import {type RunResultType} from './runTypes.ts';

/** Deterministic validity gate. */
export type ValidityGateType = Readonly<{
	id: 'contract' | 'metering' | 'request-1-surface' | 'corpus' | 'path-isolation';
	passed: boolean;
	evidence: string;
	reason: string | null;
}>;

/** Deterministic validity report; every gate must pass before hosted spend. */
export type DeterministicValidityType = Readonly<{
	recordType: 'deterministic-validity';
	schemaVersion: 1;
	contractDigest: string;
	gates: readonly ValidityGateType[];
	passed: boolean;
}>;

/** Hosted smoke evidence. It is validity evidence only. */
export type ValiditySmokeType = Readonly<{
	recordType: 'validity-smoke';
	schemaVersion: 1;
	claimClass: 'validity-only';
	efficacyClaim: false;
	releaseAuthority: false;
	caseIds: readonly string[];
	executions: number;
	meteringComplete: boolean;
	requestOneSurfacePassed: boolean;
	semanticFixturesIndexed: boolean;
	pathsClean: boolean;
	requestKinds: Readonly<Record<string, number>>;
	passed: boolean;
	reason: string | null;
}>;

/**
 * Proves the loopback meter path and reconciliation without hosted spend.
 *
 * @returns Whether exactly one synthetic request settled with exact usage.
 */
export const providerMeterSelfCheckOf = async (): Promise<
	Readonly<{passed: boolean; requestCount: number; settledExactlyOnce: boolean; economicClaim: string}>
> => {
	const responseBody = [
		`data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'ok'}}]})}`,
		`data: ${JSON.stringify({choices: [], usage: {prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: {cached_tokens: 1}, cache_write_tokens: 0, completion_tokens_details: {reasoning_tokens: 0}}})}`,
		'data: [DONE]',
		'',
	].join('\n\n');
	const upstream: Server = createServer((_request, response) => {
		response.writeHead(200, {'content-type': 'text/event-stream'});
		response.end(responseBody);
	});
	const listening = Promise.withResolvers<number>();
	upstream.once('error', (error: Error) => {
		listening.reject(error);
	});
	upstream.listen(0, '127.0.0.1', () => {
		const address = upstream.address();
		listening.resolve(address !== null && typeof address !== 'string' ? address.port : 0);
	});
	const port = await listening.promise;
	const closed = once(upstream, 'close');
	const meter = await startProviderMeter({upstreamBaseUrl: `http://127.0.0.1:${port}`, provider: 'self-check'});

	try {
		const response = await fetch(`${meter.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({model: 'self-check', messages: [{role: 'user', content: 'self check'}], tools: []}),
		});

		await response.text();
	} finally {
		await meter.close();
		upstream.closeAllConnections();
		upstream.close();
		await closed;
	}

	const reconciliation = meter.reconciliation();

	return {
		passed: reconciliation.economicClaim.state === 'exact' && reconciliation.settledExactlyOnce && reconciliation.requestCount === 1,
		requestCount: reconciliation.requestCount,
		settledExactlyOnce: reconciliation.settledExactlyOnce,
		economicClaim: reconciliation.economicClaim.state,
	};
};

/**
 * Composes the deterministic gates that must pass before a hosted call.
 *
 * @param input - Measured zero-spend evidence.
 * @returns The gate record; any failure blocks hosted spend.
 */
export const deterministicValidityOf = (
	input: Readonly<{
		contractAccepted: boolean;
		metering: Readonly<{passed: boolean; detail: string}>;
		surface: readonly Readonly<{treatmentId: string; coldStarts: number; passed: boolean; detail: string}>[];
		corpus: Readonly<{passed: boolean; detail: string}>;
		pathIsolation: Readonly<{passed: boolean; detail: string}>;
	}>,
): DeterministicValidityType => {
	const surfacePassed = input.surface.length > 0 && input.surface.every((item) => item.passed && item.coldStarts >= 20);
	const gates: ValidityGateType[] = [
		{
			id: 'contract',
			passed: input.contractAccepted,
			evidence: EVALUATION_CONTRACT.id,
			reason: input.contractAccepted ? null : 'campaign is not bound to the accepted validity-v2 contract',
		},
		{
			id: 'metering',
			passed: input.metering.passed,
			evidence: input.metering.detail,
			reason: input.metering.passed ? null : 'provider meter self-check did not settle exactly one request',
		},
		{
			id: 'request-1-surface',
			passed: surfacePassed,
			evidence: input.surface.map((item) => `${item.treatmentId}:${item.coldStarts}:${item.passed ? 'pass' : 'fail'}`).join(' '),
			reason: surfacePassed ? null : 'a treatment did not pass twenty request-1 cold starts',
		},
		{
			id: 'corpus',
			passed: input.corpus.passed,
			evidence: input.corpus.detail,
			reason: input.corpus.passed ? null : 'corpus preflight did not cover every expected path and semantic declaration',
		},
		{
			id: 'path-isolation',
			passed: input.pathIsolation.passed,
			evidence: input.pathIsolation.detail,
			reason: input.pathIsolation.passed ? null : 'mutable state or provider requests reached the primary checkout',
		},
	];

	return {
		recordType: 'deterministic-validity',
		schemaVersion: 1,
		contractDigest: hashOf(EVALUATION_CONTRACT),
		gates,
		passed: gates.every((gate) => gate.passed),
	};
};

/**
 * Classifies a hosted smoke as validity evidence, never as an efficacy result.
 *
 * @param input - Stored smoke runs and the corpus preflight that preceded them.
 * @returns The smoke record.
 */
export const validitySmokeOf = (
	input: Readonly<{
		runs: readonly RunResultType[];
		caseIds: readonly string[];
		semanticFixturesIndexed: boolean;
		corpusPreflightPassed: boolean;
		requestOneSurfacePassed?: boolean;
	}>,
): ValiditySmokeType => {
	const requestOneSurfacePassed = input.requestOneSurfacePassed === true;
	const meteringComplete =
		input.runs.length > 0 && input.runs.every((run) => run.providerCost?.state === 'exact' && run.providerMeter?.economicClaim.state === 'exact');
	const pathsClean =
		input.runs.length > 0 && input.runs.every((run) => (run.externalPathAttemptCount ?? 0) === 0 && (run.providerMeter?.pathDisclosureCount ?? 0) === 0);
	const requestKinds: Record<string, number> = {};

	for (const run of input.runs) {
		for (const [kind, count] of Object.entries(run.providerCost?.requestKinds ?? {})) {
			requestKinds[kind] = (requestKinds[kind] ?? 0) + count;
		}
	}

	const failures = [
		...(input.corpusPreflightPassed ? [] : ['corpus preflight failed']),
		...(input.semanticFixturesIndexed ? [] : ['semantic fixture declarations were not all indexed']),
		...(meteringComplete ? [] : ['provider metering was not exact']),
		...(pathsClean ? [] : ['a provider request or external-path denial disclosed the primary checkout']),
		...(input.runs.every((run) => run.valid) ? [] : ['a smoke execution was invalid']),
		...(requestOneSurfacePassed ? [] : ['the request-1 surface gate did not pass']),
	];

	return {
		recordType: 'validity-smoke',
		schemaVersion: 1,
		claimClass: 'validity-only',
		efficacyClaim: false,
		releaseAuthority: false,
		caseIds: input.caseIds,
		executions: input.runs.length,
		meteringComplete,
		requestOneSurfacePassed,
		semanticFixturesIndexed: input.semanticFixturesIndexed,
		pathsClean,
		requestKinds,
		passed: failures.length === 0,
		reason: failures.length === 0 ? null : failures.join('; '),
	};
};
