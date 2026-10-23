import {type IncomingHttpHeaders} from 'node:http';
import {PROVIDER_REQUEST_KINDS, type ProviderRequestKindType} from './providerUsage.ts';

/**
 * Classification hints that only the surface probe supplies.
 *
 * The probe knows the exact prompt it admitted. A tool-less request carrying
 * that prompt is an agent request whose surface is missing; it must never be
 * mistaken for the asynchronously generated session title.
 */
export type ProviderRequestKindHintsType = Readonly<{
	/** Prompt text that identifies an agent request even when it carries no tools. */
	agentPrompt?: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const headerTextOf = (headers: IncomingHttpHeaders, name: string): string | null => {
	const value = headers[name];

	if (typeof value === 'string') {
		return value;
	}

	return Array.isArray(value) ? (value[0] ?? null) : null;
};

const contentTextOf = (value: unknown): readonly string[] => {
	if (typeof value === 'string') {
		return [value];
	}

	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((part) => (isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : []));
};

const promptTextOf = (body: Readonly<Record<string, unknown>>): string => {
	const parts = [...contentTextOf(body['system'])];
	const {messages} = body;

	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (isRecord(message)) {
				parts.push(...contentTextOf(message['content']));
			}
		}
	}

	return parts.join('\n').toLowerCase();
};

const toolNamesOf = (body: unknown): readonly string[] => {
	if (!isRecord(body) || !Array.isArray(body['tools'])) {
		return [];
	}

	return body['tools'].flatMap((tool) => {
		const name = isRecord(tool) && isRecord(tool['function']) ? tool['function']['name'] : undefined;

		return typeof name === 'string' && name.length > 0 ? [name] : [];
	});
};

const isRequestKindOf = (value: string): value is ProviderRequestKindType => (PROVIDER_REQUEST_KINDS as readonly string[]).includes(value);

/**
 * Classifies one provider request from its body and transport headers.
 *
 * The explicit `x-codeindex-request-kind` header wins so a deterministic test
 * can declare the kind. Otherwise a request that offers tools is an agent
 * request, and a tool-less request is classified from its prompt. Prompt text
 * is inspected only for classification and is never retained.
 *
 * @param body - Parsed provider request body.
 * @param headers - Request headers.
 * @param hints - Probe-only agent prompt hint.
 * @returns One closed request kind.
 */
export const providerRequestKindOf = (body: unknown, headers: IncomingHttpHeaders, hints: ProviderRequestKindHintsType = {}): ProviderRequestKindType => {
	const explicit = headerTextOf(headers, 'x-codeindex-request-kind');

	if (explicit !== null && isRequestKindOf(explicit)) {
		return explicit;
	}

	if (toolNamesOf(body).length > 0) {
		return 'agent';
	}

	if (!isRecord(body)) {
		return 'other';
	}

	const text = promptTextOf(body);
	const agentPrompt = hints.agentPrompt?.toLowerCase();

	if (/compact|conversation summary|summari[sz]e (?:the )?(?:conversation|session)/u.test(text)) {
		return 'compaction';
	}

	// Title and compaction prompts can include the user message. Classify the
	// auxiliary request before the agent-prompt hint so its absence of tools
	// cannot be mistaken for an empty agent request.
	if (/generate (?:a|the) (?:short |concise )?title|conversation title|session title|title for (?:this|the) (?:conversation|session)/u.test(text)) {
		return 'title';
	}

	if (agentPrompt !== undefined && agentPrompt.length > 0 && text.includes(agentPrompt)) {
		return 'agent';
	}

	return 'other';
};
