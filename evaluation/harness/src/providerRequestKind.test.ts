import assert from 'node:assert/strict';
import {type IncomingHttpHeaders} from 'node:http';
import {describe, it} from 'vitest';
import {providerRequestKindOf} from './providerRequestKind.ts';

const headers: IncomingHttpHeaders = {};
const prompt = 'Reply with the JSON object {"files":[],"absent":true} and nothing else.';
const bodyOf = (extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
	messages: [{role: 'user', content: `${prompt}\nGenerate a short title for this conversation`}],
	...extra,
});

describe('providerRequestKind', () => {
	it('classifies a title request before the agent-prompt hint', () => {
		assert.equal(
			providerRequestKindOf({messages: [{role: 'user', content: `${prompt}\nGenerate a short title for this conversation`}]}, headers, {agentPrompt: prompt}),
			'title',
		);
	});

	it('treats a tool-less request carrying the agent prompt as an empty agent request', () => {
		assert.equal(providerRequestKindOf({messages: [{role: 'user', content: prompt}]}, headers, {agentPrompt: prompt}), 'agent');
	});

	it('classifies a request that offers tools as an agent request', () => {
		assert.equal(providerRequestKindOf({tools: [{function: {name: 'read'}}]}, headers), 'agent');
	});

	it('honours the explicit request-kind header', () => {
		assert.equal(providerRequestKindOf(bodyOf(), {'x-codeindex-request-kind': 'compaction'}), 'compaction');
	});
});
