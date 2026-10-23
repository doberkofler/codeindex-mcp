import {StringDecoder} from 'node:string_decoder';
import {providerUsageFromRecordsOf, providerUsageOf, providerUsageRecordsOf, type ProviderTokenUsageType} from './providerUsage.ts';

/** Streaming usage collector for one terminal provider response. */
export type UsageCollectorType = {
	mode: 'sse' | 'json';
	text: string;
	decoder: StringDecoder;
	records: Readonly<Record<string, unknown>>[];
	malformed: boolean;
	overflow: boolean;
	terminal: boolean;
	maxBytes: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Creates a collector for one provider response.
 *
 * @param contentType - Upstream content type.
 * @param maximum - Bound for a JSON body or one buffered event-stream line.
 * @returns An empty collector.
 */
export const usageCollectorOf = (contentType: string, maximum: number): UsageCollectorType => ({
	mode: contentType.includes('text/event-stream') ? 'sse' : 'json',
	text: '',
	decoder: new StringDecoder('utf8'),
	records: [],
	malformed: false,
	overflow: false,
	terminal: false,
	maxBytes: maximum,
});

const marksTerminalOf = (value: unknown): boolean => {
	if (!isRecord(value)) {
		return false;
	}

	if (value['type'] === 'message_stop' || value['type'] === 'response.completed') {
		return true;
	}

	const {choices} = value;

	return (
		Array.isArray(choices) && choices.some((choice) => isRecord(choice) && typeof choice['finish_reason'] === 'string' && choice['finish_reason'].length > 0)
	);
};

const observePayloadOf = (collector: UsageCollectorType, payload: string): void => {
	if (payload.length === 0) {
		return;
	}

	if (payload === '[DONE]') {
		collector.terminal = true;

		return;
	}

	try {
		const parsed = JSON.parse(payload) as unknown;

		collector.records = [...collector.records, ...providerUsageRecordsOf(parsed)];
		collector.terminal ||= marksTerminalOf(parsed);
	} catch {
		collector.malformed = true;
	}
};

const observeLineOf = (collector: UsageCollectorType, line: string): void => {
	const trimmed = line.trim();

	if (trimmed.startsWith('data:')) {
		observePayloadOf(collector, trimmed.slice(5).trim());
	}
};

const drainSseLinesOf = (collector: UsageCollectorType): void => {
	let newline = collector.text.indexOf('\n');

	while (newline >= 0) {
		observeLineOf(collector, collector.text.slice(0, newline));
		collector.text = collector.text.slice(newline + 1);
		newline = collector.text.indexOf('\n');
	}

	if (collector.text.length > collector.maxBytes) {
		collector.overflow = true;
		collector.text = collector.text.slice(-collector.maxBytes);
	}
};

/**
 * Adds one response chunk to the collector without retaining any prompt or text content.
 *
 * @param collector - Collector for this response.
 * @param chunk - Decoded response bytes.
 */
export const collectUsageChunkOf = (collector: UsageCollectorType, chunk: Buffer): void => {
	const text = collector.decoder.write(chunk);

	if (collector.mode === 'sse') {
		collector.text += text;
		drainSseLinesOf(collector);

		return;
	}

	if (collector.text.length + text.length > collector.maxBytes) {
		collector.overflow = true;
		collector.text = collector.text.slice(0, collector.maxBytes);

		return;
	}

	collector.text += text;
};

/**
 * Extracts provider usage from the terminal response body.
 *
 * @param collector - Collector for this response.
 * @returns The usage accounting, when the provider reported it.
 */
export const usageOfCollector = (collector: UsageCollectorType): Readonly<{usage: ProviderTokenUsageType | null; unparseable: boolean}> => {
	const tail = collector.decoder.end();

	if (tail.length > 0) {
		collector.text += tail;
	}

	if (collector.mode === 'sse') {
		drainSseLinesOf(collector);

		if (collector.text.trim().length > 0) {
			observeLineOf(collector, collector.text);
		}

		const usage = collector.records.length === 0 ? null : providerUsageFromRecordsOf(collector.records);

		return {usage, unparseable: usage === null && collector.malformed};
	}

	if (collector.text.trim().length === 0) {
		return {usage: null, unparseable: false};
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(collector.text) as unknown;
	} catch {
		return {usage: null, unparseable: true};
	}

	const usage = providerUsageOf(parsed);

	return {usage, unparseable: usage === null && collector.malformed};
};
