import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type Server} from 'node:http';
import {once} from 'node:events';
import {describe, it, type TestContext} from 'vitest';
import {parseEvents} from './events.ts';
import {
	providerMeterConfigOf,
	reconcileProviderMeterLedger,
	startProviderMeter,
	type ProviderMeterLedgerType,
	type ProviderMeterType,
} from './providerMeter.ts';
import {providerUsageOf, staticTariffCostOf, type ProviderTokenUsageType} from './providerUsage.ts';

const openAiUsage = {
	prompt_tokens: 100,
	completion_tokens: 40,
	prompt_tokens_details: {cached_tokens: 30},
	cache_write_tokens: 10,
	completion_tokens_details: {reasoning_tokens: 5},
	cost_usd: 0.001,
};

const titleUsage = {
	prompt_tokens: 20,
	completion_tokens: 5,
	prompt_tokens_details: {cached_tokens: 0},
	cache_write_tokens: 0,
	cost_usd: 0.0002,
};

const compactionUsage = {
	input_tokens: 50,
	output_tokens: 10,
	cache_read_input_tokens: 5,
	cache_creation: {ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3},
	cost: 0.002,
};

type ReplyType = Readonly<{status?: number; contentType: string; body: string}>;

const readRequestOf = async (request: IncomingMessage): Promise<string> => {
	request.setEncoding('utf8');
	let text = '';

	for await (const chunk of request) {
		text += String(chunk);
	}

	return text;
};

const listenOf = async (server: Server): Promise<number> => {
	const listening = Promise.withResolvers<number>();

	server.once('error', (error: Error) => {
		listening.reject(error);
	});
	server.listen(0, '127.0.0.1', () => {
		const address = server.address();

		if (address === null || typeof address === 'string') {
			listening.reject(new Error('test upstream did not bind'));

			return;
		}

		listening.resolve(address.port);
	});

	const port = await listening.promise;

	return port;
};

type UpstreamType = Readonly<{origin: string; bodies: string[]; close: () => Promise<void>}>;

const upstreamOf = async (testContext: TestContext, reply: (body: string) => ReplyType): Promise<UpstreamType> => {
	const bodies: string[] = [];
	const server = createServer((request, response) => {
		void (async (): Promise<void> => {
			const body = await readRequestOf(request);
			bodies.push(body);
			const result = reply(body);
			response.writeHead(result.status ?? 200, {'content-type': result.contentType});
			response.end(result.body);
		})();
	});
	const port = await listenOf(server);
	const closed = once(server, 'close');
	const close = async (): Promise<void> => {
		server.close();
		server.closeAllConnections();
		await closed;
	};

	testContext.onTestFinished(close);

	return {origin: `http://127.0.0.1:${port}`, bodies, close};
};

const meterOf = async (testContext: TestContext, upstreamOrigin: string): Promise<ProviderMeterType> => {
	const meter = await startProviderMeter({
		upstreamBaseUrl: upstreamOrigin,
		provider: 'deepseek',
		upstreamHeaders: {authorization: 'Bearer provider-secret-not-retained'},
		now: () => new Date('2026-10-23T10:00:00.000Z'),
	});

	testContext.onTestFinished(meter.close);

	return meter;
};

const requestTextOf = (raw: string): string => {
	const body = JSON.parse(raw) as {messages?: {content?: string}[]};

	return (body.messages ?? []).map((message) => message.content ?? '').join(' ');
};

const sseOf = (usage: unknown, text = 'answer'): string =>
	[`data: ${JSON.stringify({choices: [{index: 0, delta: {content: text}}]})}`, `data: ${JSON.stringify({choices: [], usage})}`, 'data: [DONE]', ''].join(
		'\n\n',
	);

const postOf = async (meter: ProviderMeterType, body: unknown, kind?: string): Promise<number> => {
	const response = await fetch(`${meter.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {'content-type': 'application/json', ...(kind === undefined ? {} : {'x-codeindex-request-kind': kind})},
		body: JSON.stringify(body),
	});

	await response.text();

	return response.status;
};

const agentBodyOf = (model = 'deepseek-flash', prompt = 'Which file defines A?', tools = ['read', 'codeindex_find_symbol']): unknown => ({
	model,
	tools: tools.map((name) => ({type: 'function', function: {name}})),
	messages: [{role: 'user', content: prompt}],
});

const titleBodyOf = (model = 'deepseek-flash'): unknown => ({
	model,
	messages: [
		{role: 'system', content: 'Generate a concise title for this conversation.'},
		{role: 'user', content: 'Which file defines A?'},
	],
});

const compactionBodyOf = (model = 'deepseek-flash'): unknown => ({
	model,
	messages: [
		{role: 'system', content: 'Summarize the conversation for compaction.'},
		{role: 'user', content: 'Continue.'},
	],
});

const completedUsageOf = (ledger: ProviderMeterLedgerType, ordinal: number): ProviderTokenUsageType => {
	const request = ledger.requests.find((item) => item.ordinal === ordinal);

	if (request?.settlement?.status !== 'completed') {
		throw new Error(`provider request ${ordinal} has no completed usage`);
	}

	return request.settlement.usage;
};

describe('provider usage', () => {
	it('OpenAI-compatible usage splits non-cached input, cache read, cache write, visible output, and reasoning', () => {
		const usage = providerUsageOf({usage: openAiUsage});

		if (usage === null) {
			throw new Error('expected provider usage');
		}

		assert.deepEqual(
			{
				nonCached: usage.nonCachedInputTokens,
				cacheRead: usage.cacheReadTokens,
				cacheWrite: usage.cacheWriteTokens,
				visible: usage.visibleOutputTokens,
				reasoning: usage.reasoningTokens,
				cost: usage.reportedCostUsd,
			},
			{nonCached: 60, cacheRead: 30, cacheWrite: {default: 10}, visible: 35, reasoning: 5, cost: 0.001},
		);
		assert.equal(usage.complete, true);
		assert.deepEqual(usage.missingFields, []);
	});

	it('Anthropic-compatible cache-write tiers stay separate and provider-reported', () => {
		const usage = providerUsageOf({usage: compactionUsage});

		if (usage === null) {
			throw new Error('expected provider usage');
		}

		assert.equal(usage.nonCachedInputTokens, 50);
		assert.equal(usage.cacheReadTokens, 5);
		assert.deepEqual(usage.cacheWriteTokens, {ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3});
		assert.equal(usage.visibleOutputTokens, 10);
		assert.equal(usage.reasoningTokens, null);
		assert.equal(usage.complete, true);
		assert.deepEqual(usage.missingFields, []);
	});

	it('missing and unparseable usage stay unavailable instead of becoming zero', () => {
		const missing = providerUsageOf({usage: {prompt_tokens: 10, completion_tokens: 2}});
		const invalid = providerUsageOf({usage: {prompt_tokens: 'ten', completion_tokens: 2}});

		if (missing === null || invalid === null) {
			throw new Error('expected provider usage');
		}

		assert.equal(missing.nonCachedInputTokens, 10);
		assert.equal(missing.cacheReadTokens, null);
		assert.deepEqual(missing.cacheWriteTokens, {});
		assert.equal(missing.complete, false);
		assert.deepEqual(missing.missingFields, ['cacheReadTokens']);

		assert.equal(invalid.nonCachedInputTokens, null);
		assert.equal(invalid.complete, false);
		assert.deepEqual(invalid.invalidFields, ['nonCachedInputTokens']);
	});

	it('static tariff arithmetic is labelled sensitivity, never invoice-time cost', () => {
		const totals = {
			state: 'exact' as const,
			nonCachedInputTokens: 60,
			cacheReadTokens: 30,
			cacheWriteTokens: {default: 10},
			visibleOutputTokens: 35,
			reasoningTokens: 5,
			totalTokens: 140,
			reportedCostUsd: null,
		};
		const cost = staticTariffCostOf(totals, {
			id: 'synthetic-2026-10-23',
			currency: 'USD',
			perMillionTokens: {
				nonCachedInput: 1,
				cacheRead: 0.1,
				cacheWrite: {default: 1.25},
				visibleOutput: 2,
				reasoning: 2,
			},
		});

		assert.equal(cost.basis, 'static-tariff-arithmetic');
		assert.equal(cost.claim, 'sensitivity-not-invoice-time');
		assert.equal(cost.invoiceTime, false);
		assert.equal(cost.amount, (60 * 1 + 30 * 0.1 + 10 * 1.25 + 35 * 2 + 5 * 2) / 1_000_000);
	});
});

describe('provider meter', () => {
	it('meters agent, asynchronous title, and compaction requests independently of event order', async (testContext: TestContext) => {
		const upstream = await upstreamOf(testContext, (raw) => {
			const body = JSON.parse(raw) as {tools?: unknown[]};
			const text = requestTextOf(raw);

			if (Array.isArray(body.tools) && body.tools.length > 0) {
				return {contentType: 'text/event-stream', body: sseOf(openAiUsage)};
			}

			if (text.includes('title')) {
				return {contentType: 'application/json', body: JSON.stringify({usage: titleUsage})};
			}

			return {contentType: 'application/json', body: JSON.stringify({usage: compactionUsage})};
		});
		const meter = await meterOf(testContext, upstream.origin);
		const previousDatabase = process.env['OPENCODE_DB'];
		process.env['OPENCODE_DB'] = ':memory:';

		try {
			const agent = await postOf(meter, agentBodyOf('deepseek-flash', 'SECRET_PROMPT_TEXT', ['read', 'codeindex_find_symbol']));

			// OpenCode can emit the terminal session event before the step event and
			// can start title generation asynchronously after the agent response.
			const title = postOf(meter, titleBodyOf());
			const events = parseEvents(`${JSON.stringify({type: 'session.execution.succeeded'})}\n${JSON.stringify({type: 'session.step.ended'})}\n`);

			await title;
			await postOf(meter, compactionBodyOf());

			assert.equal(agent, 200);
			assert.equal(events.steps, 0);
			assert.equal(events.telemetry.inputTokens.state, 'unavailable');

			const ledger = meter.ledger();
			const reconciliation = meter.reconciliation();

			assert.deepEqual(
				ledger.requests.map((request) => [request.ordinal, request.kind, request.model, request.toolNames]),
				[
					[1, 'agent', 'deepseek-flash', ['read', 'codeindex_find_symbol']],
					[2, 'title', 'deepseek-flash', []],
					[3, 'compaction', 'deepseek-flash', []],
				],
			);
			assert.deepEqual(
				ledger.requests.map((request) => request.settlement?.status),
				['completed', 'completed', 'completed'],
			);
			assert.equal(reconciliation.requestCount, 3);
			assert.equal(reconciliation.settledExactlyOnce, true);
			assert.equal(reconciliation.ordinalsContiguous, true);
			assert.equal(reconciliation.economicClaim.state, 'exact');
			assert.equal(reconciliation.total.state, 'exact');
			assert.equal(reconciliation.total.totalTokens, 140 + 25 + 70);
			assert.equal(reconciliation.agentOnly.state, 'exact');
			assert.equal(reconciliation.agentOnly.totalTokens, 140);
			assert.equal(reconciliation.total.reportedCostUsd, 0.0032);

			assert.equal(completedUsageOf(ledger, 2).nonCachedInputTokens, 20);
			assert.equal(JSON.stringify(ledger).includes('SECRET_PROMPT_TEXT'), false);
			assert.equal(JSON.stringify(ledger).includes('provider-secret-not-retained'), false);
			assert.equal(JSON.stringify(ledger).includes('answer'), false);
		} finally {
			if (previousDatabase === undefined) {
				delete process.env['OPENCODE_DB'];
			} else {
				process.env['OPENCODE_DB'] = previousDatabase;
			}
		}
	});

	it('settles upstream errors and missing usage with closed causes and invalidates the claim', async (testContext: TestContext) => {
		const upstream = await upstreamOf(testContext, (raw) => {
			const body = JSON.parse(raw) as {model?: string};

			if (body.model === 'http-error') {
				return {status: 500, contentType: 'application/json', body: '{"error":"upstream"}'};
			}

			if (body.model === 'no-usage') {
				return {contentType: 'application/json', body: '{"choices":[{"message":{"content":"answer"}}]}'};
			}

			if (body.model === 'partial-sse') {
				return {
					contentType: 'text/event-stream',
					body: `data: ${JSON.stringify({choices: [], usage: openAiUsage})}\n\n`,
				};
			}

			return {contentType: 'application/json', body: JSON.stringify({usage: {prompt_tokens: 1, completion_tokens: 1}})};
		});
		const meter = await meterOf(testContext, upstream.origin);

		await postOf(meter, agentBodyOf('http-error'));
		await postOf(meter, agentBodyOf('no-usage'));
		await postOf(meter, agentBodyOf('partial-usage'));
		await postOf(meter, agentBodyOf('partial-sse'));

		const reconciliation = meter.reconciliation();

		assert.deepEqual(
			meter.ledger().requests.map((request) => request.settlement),
			[
				{status: 'failed', cause: 'upstream-http-error', httpStatus: 500},
				{status: 'failed', cause: 'usage-missing', httpStatus: null},
				{status: 'completed', usage: providerUsageOf({usage: {prompt_tokens: 1, completion_tokens: 1}})},
				{status: 'failed', cause: 'response-truncated', httpStatus: null},
			],
		);
		assert.equal(reconciliation.settledExactlyOnce, true);
		assert.equal(reconciliation.completedCount, 1);
		assert.equal(reconciliation.failedCount, 3);
		assert.equal(reconciliation.total.state, 'unavailable');
		assert.equal(reconciliation.total.totalTokens, null);
		assert.equal(reconciliation.economicClaim.state, 'invalid');
		assert.match(reconciliation.economicClaim.reason ?? '', /failed/u);
	});

	it('an unsettled request is never reconciled as complete', () => {
		const reconciliation = reconcileProviderMeterLedger({
			recordType: 'provider-meter',
			provider: 'deepseek',
			requests: [
				{
					ordinal: 1,
					kind: 'agent',
					provider: 'deepseek',
					model: 'deepseek-flash',
					startedAt: '2026-10-23T10:00:00.000Z',
					completedAt: null,
					toolNames: [],
					requestBytes: 10,
					responseBytes: null,
					settlement: null,
				},
			],
		});

		assert.equal(reconciliation.pendingCount, 1);
		assert.equal(reconciliation.settledExactlyOnce, false);
		assert.equal(reconciliation.economicClaim.state, 'invalid');
		assert.equal(reconciliation.total.state, 'unavailable');
	});

	it('records a primary-checkout disclosure without retaining request text', async (testContext: TestContext) => {
		const upstream = await upstreamOf(testContext, () => ({contentType: 'application/json', body: JSON.stringify({usage: openAiUsage})}));
		const primary = '/tmp/primary-checkout';
		const meter = await startProviderMeter({
			upstreamBaseUrl: upstream.origin,
			provider: 'deepseek',
			forbiddenPaths: [primary],
			now: () => new Date('2026-10-23T10:00:00.000Z'),
		});

		testContext.onTestFinished(meter.close);

		await postOf(meter, agentBodyOf('deepseek-flash', `inspect ${primary}/src/a.ts`, ['read']));

		const ledger = meter.ledger();
		const reconciliation = meter.reconciliation();

		assert.equal(ledger.requests[0]?.pathDisclosureCount, 1);
		assert.equal(reconciliation.pathDisclosureCount, 1);
		assert.equal(reconciliation.pathClean, false);
		assert.equal(reconciliation.economicClaim.state, 'invalid');
		assert.match(reconciliation.economicClaim.reason ?? '', /path disclosure/u);
		assert.equal(JSON.stringify(ledger).includes(`${primary}/src/a.ts`), false);
	});

	it('reports the provider configuration that routes OpenCode through the loopback meter', () => {
		const config = providerMeterConfigOf({baseUrl: 'http://127.0.0.1:1234/v1', provider: 'metered-deepseek', modelId: 'deepseek-flash'});

		assert.deepEqual(config, {
			providers: {
				'metered-deepseek': {
					name: 'Metered Provider',
					package: 'aisdk:@ai-sdk/openai-compatible',
					settings: {baseURL: 'http://127.0.0.1:1234/v1'},
					models: {'deepseek-flash': {}},
				},
			},
		});
	});
});
