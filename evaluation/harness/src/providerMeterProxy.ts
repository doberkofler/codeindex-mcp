import {type IncomingHttpHeaders, type IncomingMessage, type ServerResponse} from 'node:http';
import {collectUsageChunkOf, usageCollectorOf, usageOfCollector, type UsageCollectorType} from './providerMeterCollector.ts';
import {providerRequestKindOf} from './providerRequestKind.ts';
import {type ProviderRequestKindType} from './providerUsage.ts';
import {
	type ProviderFailureCauseType,
	type ProviderMeterInputType,
	type ProviderMeterLedgerType,
	type ProviderRequestLedgerEntryType,
	type ProviderRequestSettlementType,
} from './providerMeterLedger.ts';

/** Mutable request state held only while one metering session is live. */
export type MutableProviderRequestType = {
	ordinal: number;
	kind: ProviderRequestKindType;
	provider: string;
	model: string | null;
	startedAt: string;
	completedAt: string | null;
	toolNames: readonly string[];
	requestBytes: number;
	responseBytes: number | null;
	settlement: ProviderRequestSettlementType | null;
};

/** Live state of one loopback provider meter. */
export type ProviderMeterStateType = {
	requests: MutableProviderRequestType[];
	inFlight: Set<Promise<void>>;
	closed: boolean;
};

type AbortFlagType = Readonly<{set: () => void; get: () => boolean}>;

type HandlerContextType = Readonly<{
	state: ProviderMeterStateType;
	input: ProviderMeterInputType;
	request: IncomingMessage;
	response: ServerResponse;
	record: MutableProviderRequestType;
	body: Buffer;
	aborted: AbortFlagType;
	controller: AbortController;
}>;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_LENGTH = 200;
const MAX_TOOL_NAME_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const bufferOf = (value: unknown): Buffer => {
	if (Buffer.isBuffer(value)) {
		return value;
	}

	if (value instanceof Uint8Array) {
		return Buffer.from(value);
	}

	if (typeof value === 'string') {
		return Buffer.from(value);
	}

	return Buffer.alloc(0);
};

const abortFlagOf = (): AbortFlagType => {
	let value = false;

	return {
		set: () => {
			value = true;
		},
		get: () => value,
	};
};

const clockOf = (now: (() => Date) | undefined): string => (now ?? (() => new Date()))().toISOString();

const sanitizedTextOf = (value: unknown, maximum: number): string | null => (typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : null);

const toolNamesOf = (body: unknown): readonly string[] => {
	if (!isRecord(body) || !Array.isArray(body['tools'])) {
		return [];
	}

	const names: string[] = [];

	for (const tool of body['tools']) {
		const name = isRecord(tool) && isRecord(tool['function']) ? sanitizedTextOf(tool['function']['name'], MAX_TOOL_NAME_LENGTH) : null;

		if (name !== null) {
			names.push(name);
		}
	}

	return names;
};

const requestHeadersOf = (headers: IncomingHttpHeaders, overrides: Readonly<Record<string, string>> | undefined): Record<string, string> => {
	const result: Record<string, string> = {};

	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();

		if (value === undefined || HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'content-length' || lower.startsWith('x-codeindex-')) {
			continue;
		}

		result[lower] = Array.isArray(value) ? value.join(', ') : value;
	}

	result['accept-encoding'] = 'identity';

	return {...result, ...overrides};
};

const targetUrlOf = (upstreamBaseUrl: string, requestUrl: string | undefined): URL => {
	const base = new URL(upstreamBaseUrl);
	const path = requestUrl ?? '/';

	if (path.startsWith('http://') || path.startsWith('https://')) {
		throw new Error('provider proxy path must be relative');
	}

	const basePath = base.pathname.replace(/\/$/u, '');
	const relative = path.startsWith('/') ? path : `/${path}`;
	const joined = basePath.length === 0 || relative === basePath || relative.startsWith(`${basePath}/`) ? relative : `${basePath}${relative}`;

	return new URL(joined, base.origin);
};

type BodyReadType = Readonly<{ok: true; body: Buffer}> | Readonly<{ok: false; cause: 'request-too-large' | 'client-aborted'}>;

const readBodyOf = async (request: IncomingMessage, maximum: number, aborted: () => boolean): Promise<BodyReadType> => {
	const chunks: Buffer[] = [];
	let total = 0;

	try {
		for await (const chunk of request) {
			const buffer = bufferOf(chunk);

			total += buffer.length;

			if (total > maximum) {
				return {ok: false, cause: 'request-too-large'};
			}

			chunks.push(buffer);
		}
	} catch {
		return {ok: false, cause: aborted() ? 'client-aborted' : 'request-too-large'};
	}

	return {ok: true, body: Buffer.concat(chunks)};
};

const parseBodyOf = (body: Buffer): unknown => {
	if (body.length === 0) {
		return null;
	}

	try {
		return JSON.parse(body.toString('utf8')) as unknown;
	} catch {
		return null;
	}
};

const settleOf = (request: MutableProviderRequestType, settlement: ProviderRequestSettlementType, now: string): void => {
	if (request.settlement !== null) {
		return;
	}

	request.settlement = settlement;
	request.completedAt = now;
};

const copyResponseHeadersOf = (response: ServerResponse, upstream: Response): void => {
	for (const [name, value] of upstream.headers) {
		const lower = name.toLowerCase();

		if (HOP_BY_HOP.has(lower) || lower === 'content-encoding' || lower === 'content-length') {
			continue;
		}

		response.setHeader(name, value);
	}
};

const relayErrorOf = async (input: Readonly<{response: ServerResponse; upstream: Response; settled: (status: number) => void}>): Promise<void> => {
	copyResponseHeadersOf(input.response, input.upstream);
	input.response.writeHead(input.upstream.status);

	if (input.upstream.body !== null) {
		for await (const chunk of input.upstream.body) {
			input.response.write(chunk);
		}
	}

	input.response.end();
	input.settled(input.upstream.status);
};

const consumeSuccessOf = async (
	input: Readonly<{
		response: ServerResponse;
		upstream: Response;
		collector: UsageCollectorType;
		aborted: () => boolean;
	}>,
): Promise<Readonly<{bytes: number; clientAborted: boolean}>> => {
	copyResponseHeadersOf(input.response, input.upstream);
	input.response.writeHead(input.upstream.status);

	if (input.upstream.body === null) {
		input.response.end();

		return {bytes: 0, clientAborted: input.aborted()};
	}

	let bytes = 0;

	for await (const chunk of input.upstream.body) {
		const buffer = bufferOf(chunk);
		bytes += buffer.length;

		if (!input.aborted()) {
			input.response.write(buffer);
		}

		collectUsageChunkOf(input.collector, buffer);
	}

	input.response.end();

	return {bytes, clientAborted: input.aborted()};
};

const failResponseOf = (response: ServerResponse, aborted: boolean): void => {
	if (!response.headersSent) {
		response.writeHead(aborted ? 499 : 502, {'content-type': 'application/json'});
		response.end('{}');
	} else if (!response.writableEnded) {
		response.destroy();
	}
};

const successSettlementOf = (
	record: MutableProviderRequestType,
	collector: UsageCollectorType,
	responseBytes: number,
): ProviderRequestSettlementType | null => {
	if (collector.overflow) {
		return {status: 'failed', cause: 'response-too-large', httpStatus: null};
	}

	if (collector.mode === 'sse' && !collector.terminal) {
		return {status: 'failed', cause: 'response-truncated', httpStatus: null};
	}

	const {usage, unparseable} = usageOfCollector(collector);

	record.responseBytes = responseBytes;

	if (usage !== null) {
		return {status: 'completed', usage};
	}

	return {status: 'failed', cause: unparseable ? 'usage-unparseable' : 'usage-missing', httpStatus: null};
};

const consumeAndSettleOf = async (context: HandlerContextType, upstream: Response): Promise<void> => {
	const collector = usageCollectorOf(upstream.headers.get('content-type') ?? '', context.input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);

	try {
		const consumed = await consumeSuccessOf({response: context.response, upstream, collector, aborted: context.aborted.get});

		if (consumed.clientAborted) {
			settleOf(context.record, {status: 'failed', cause: 'client-aborted', httpStatus: null}, clockOf(context.input.now));

			return;
		}

		const settlement = successSettlementOf(context.record, collector, consumed.bytes);

		if (settlement !== null) {
			settleOf(context.record, settlement, clockOf(context.input.now));
		}
	} catch {
		failResponseOf(context.response, context.aborted.get());
		settleOf(
			context.record,
			{status: 'failed', cause: context.aborted.get() ? 'client-aborted' : 'response-truncated', httpStatus: null},
			clockOf(context.input.now),
		);
	}
};

const forwardOf = async (context: HandlerContextType): Promise<void> => {
	const parsedBody = parseBodyOf(context.body);

	context.record.kind = providerRequestKindOf(parsedBody, context.request.headers);
	context.record.model = isRecord(parsedBody) ? sanitizedTextOf(parsedBody['model'], MAX_MODEL_LENGTH) : null;
	context.record.toolNames = toolNamesOf(parsedBody);

	try {
		const upstream = await fetch(targetUrlOf(context.input.upstreamBaseUrl, context.request.url), {
			method: context.request.method ?? 'POST',
			headers: requestHeadersOf(context.request.headers, context.input.upstreamHeaders),
			...(context.request.method === 'GET' || context.request.method === 'HEAD' ? {} : {body: context.body}),
			signal: context.controller.signal,
		});

		if (!upstream.ok) {
			await relayErrorOf({
				response: context.response,
				upstream,
				settled: (status) => {
					settleOf(context.record, {status: 'failed', cause: 'upstream-http-error', httpStatus: status}, clockOf(context.input.now));
				},
			});

			return;
		}

		await consumeAndSettleOf(context, upstream);
	} catch {
		failResponseOf(context.response, context.aborted.get());
		const cause: ProviderFailureCauseType = context.aborted.get() ? 'client-aborted' : 'upstream-unreachable';
		settleOf(context.record, {status: 'failed', cause, httpStatus: null}, clockOf(context.input.now));
	}
};

const recordOf = (state: ProviderMeterStateType, input: ProviderMeterInputType): MutableProviderRequestType => ({
	ordinal: state.requests.length + 1,
	kind: 'other',
	provider: input.provider,
	model: null,
	startedAt: clockOf(input.now),
	completedAt: null,
	toolNames: [],
	requestBytes: 0,
	responseBytes: null,
	settlement: null,
});

/**
 * Handles one provider request through the metering proxy.
 *
 * The request is recorded before its body is read, so every started request has
 * exactly one settlement even when it is oversized or the client disconnects.
 *
 * @param state - Live meter state.
 * @param input - Meter configuration.
 * @param request - Incoming provider request.
 * @param response - Response back to the client.
 */
export const handleMeteredRequestOf = async (
	state: ProviderMeterStateType,
	input: ProviderMeterInputType,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> => {
	const record = recordOf(state, input);
	state.requests.push(record);

	if (state.closed) {
		response.writeHead(503, {'content-type': 'application/json'});
		response.end('{}');
		settleOf(record, {status: 'failed', cause: 'proxy-error', httpStatus: null}, clockOf(input.now));

		return;
	}

	const aborted = abortFlagOf();
	const controller = new AbortController();
	const abort = (): void => {
		aborted.set();
		controller.abort();
	};
	request.on('aborted', abort);
	response.on('close', () => {
		if (!response.writableEnded) {
			abort();
		}
	});

	const body = await readBodyOf(request, input.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES, aborted.get);

	if (!body.ok) {
		if (!response.headersSent) {
			response.writeHead(body.cause === 'request-too-large' ? 413 : 499, {'content-type': 'application/json'});
			response.end('{}');
		}

		settleOf(record, {status: 'failed', cause: body.cause, httpStatus: null}, clockOf(input.now));

		return;
	}

	record.requestBytes = body.body.length;

	await forwardOf({state, input, request, response, record, body: body.body, aborted, controller});
};

/**
 * Copies live request state into the sanitized ledger.
 *
 * @param state - Live meter state.
 * @param provider - Actual provider identity.
 * @returns Sanitized ledger.
 */
export const ledgerOf = (state: ProviderMeterStateType, provider: string): ProviderMeterLedgerType => ({
	recordType: 'provider-meter',
	provider,
	requests: state.requests.map((request): ProviderRequestLedgerEntryType => ({
		ordinal: request.ordinal,
		kind: request.kind,
		provider: request.provider,
		model: request.model,
		startedAt: request.startedAt,
		completedAt: request.completedAt,
		toolNames: request.toolNames,
		requestBytes: request.requestBytes,
		responseBytes: request.responseBytes,
		settlement: request.settlement,
	})),
});
