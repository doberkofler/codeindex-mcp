import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {parseEvents, toolFamilyOf} from './events.ts';

const lines = (...events: readonly unknown[]): string => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const partOf = (callID: string, action: string, fallbackRequired: boolean): unknown => ({
	type: 'tool',
	callID,
	tool: 'codeindex_find_symbol',
	state: {
		status: 'completed',
		input: {query: 'A'},
		output: JSON.stringify({ok: true, data: {items: [{}]}, guidance: {action, fallbackRequired, message: 'guidance'}}),
	},
});

describe('events', () => {
	it('exact token, cache, and cost telemetry stays exact', () => {
		const stdout = lines(
			{type: 'step_start', timestamp: 1, part: {type: 'step-start'}},
			{type: 'text', timestamp: 2, part: {type: 'text', text: 'answer'}},
			{
				type: 'step_finish',
				timestamp: 3,
				part: {
					type: 'step-finish',
					tokens: {input: 10, output: 5, reasoning: 2, cache: {read: 3, write: 4}},
					cost: 0.25,
				},
			},
		);

		const events = parseEvents(stdout);

		assert.equal(events.finalText, 'answer');
		assert.equal(events.steps, 1);
		assert.equal(events.usage.available, true);
		assert.deepEqual(events.telemetry.inputTokens, {value: 10, state: 'exact', unit: 'tokens', source: 'step_finish'});
		assert.deepEqual(events.telemetry.outputTokens, {value: 5, state: 'exact', unit: 'tokens', source: 'step_finish'});
		assert.deepEqual(events.telemetry.reasoningTokens, {value: 2, state: 'exact', unit: 'tokens', source: 'step_finish'});
		assert.deepEqual(events.telemetry.cacheReadTokens, {value: 3, state: 'exact', unit: 'tokens', source: 'step_finish.cache.read'});
		assert.deepEqual(events.telemetry.cacheWriteTokens, {value: 4, state: 'exact', unit: 'tokens', source: 'step_finish.cache.write'});
		assert.deepEqual(events.telemetry.reportedCost, {value: 0.25, state: 'exact', unit: 'usd', source: 'step_finish.cost'});
		assert.deepEqual(
			events.events.map((event) => event.type),
			['step_start', 'text', 'step_finish'],
		);
	});

	it('missing usage is unavailable and is never estimated from bytes', () => {
		const stdout = lines({type: 'text', part: {type: 'text', text: 'a'.repeat(1000)}});
		const events = parseEvents(stdout);

		assert.equal(events.usage.available, false);
		assert.equal(events.usage.input, 0);

		for (const entry of [
			events.telemetry.inputTokens,
			events.telemetry.outputTokens,
			events.telemetry.reasoningTokens,
			events.telemetry.cacheReadTokens,
			events.telemetry.cacheWriteTokens,
			events.telemetry.reportedCost,
		]) {
			assert.equal(entry.state, 'unavailable');
			assert.equal(entry.value, null);
		}
	});

	it('a partially reported step marks only the absent components unavailable', () => {
		const stdout = lines({
			type: 'step_finish',
			part: {type: 'step-finish', tokens: {input: 7, output: 3, reasoning: -1}, cost: 0.01},
		});
		const events = parseEvents(stdout);

		assert.deepEqual(events.telemetry.inputTokens, {value: 7, state: 'exact', unit: 'tokens', source: 'step_finish'});
		assert.deepEqual(events.telemetry.outputTokens, {value: 3, state: 'exact', unit: 'tokens', source: 'step_finish'});
		assert.equal(events.telemetry.reasoningTokens.state, 'unavailable');
		assert.equal(events.telemetry.reasoningTokens.value, null);
		assert.equal(events.telemetry.cacheReadTokens.state, 'unavailable');
		assert.equal(events.telemetry.reportedCost.state, 'exact');
		assert.equal(events.usage.available, true);
	});

	it('model-free executions report token telemetry as not applicable', () => {
		const events = parseEvents('', {modelFree: true});

		assert.equal(events.usage.available, false);

		for (const entry of [
			events.telemetry.inputTokens,
			events.telemetry.outputTokens,
			events.telemetry.reasoningTokens,
			events.telemetry.cacheReadTokens,
			events.telemetry.cacheWriteTokens,
			events.telemetry.reportedCost,
		]) {
			assert.equal(entry.state, 'not-applicable');
			assert.equal(entry.value, null);
		}

		const withUsage = parseEvents(lines({type: 'step_finish', part: {type: 'step-finish', tokens: {input: 1, output: 1}, cost: 0}}), {modelFree: true});

		assert.equal(withUsage.telemetry.inputTokens.state, 'not-applicable');
	});

	it('top-level, server-envelope, and nested tool calls normalize into one sequence', () => {
		const stdout = lines(
			{
				type: 'tool_use',
				timestamp: 10,
				part: {
					type: 'tool',
					callID: 'call-1',
					tool: 'grep',
					state: {
						status: 'completed',
						input: {pattern: 'SCHEMA_VERSION'},
						output: 'é',
						time: {start: 100, end: 115},
					},
				},
			},
			{
				type: 'message.part.updated',
				timestamp: 20,
				properties: {
					part: {
						type: 'tool',
						callID: 'call-2',
						tool: 'codeindex_find_symbol',
						state: {
							status: 'error',
							input: {query: 'parseEvents'},
							error: 'symbol not found',
							time: {start: 200, end: 203},
						},
					},
				},
			},
			{
				type: 'tool_use',
				part: {
					type: 'tool',
					callID: 'call-3',
					tool: 'task',
					state: {status: 'running', input: {description: 'explore'}, time: {start: 300}},
					parts: [
						{
							type: 'tool',
							callID: 'call-4',
							tool: 'read',
							state: {status: 'completed', input: {filePath: 'src/events.ts'}, output: 'abcd', time: {start: 310, end: 314}},
						},
					],
				},
			},
		);

		const events = parseEvents(stdout);

		assert.deepEqual(
			events.toolCalls.map((call) => [call.index, call.tool, call.family, call.status, call.parentIndex]),
			[
				[1, 'grep', 'search', 'completed', null],
				[2, 'codeindex_find_symbol', 'index', 'error', null],
				[3, 'task', 'task', 'running', null],
				[4, 'read', 'read', 'completed', 3],
			],
		);
		assert.equal(events.toolCalls[0]?.outputBytes, 2);
		assert.equal(events.toolCalls[0].durationMs, 15);
		assert.equal(events.toolCalls[1]?.durationMs, 3);
		assert.equal(events.toolCalls[1].error, 'symbol not found');
		assert.equal(events.toolCalls[2]?.durationMs, null);
		assert.deepEqual(events.toolCalls[0].input, {pattern: 'SCHEMA_VERSION'});
		assert.equal(events.toolCalls[0].inputValid, true);
		assert.equal(events.toolCalls[3]?.outputBytes, 4);
		assert.equal(events.outputBytes, 22);
		assert.deepEqual(events.familyBytes, {
			index: 16,
			search: 2,
			read: 4,
			list: 0,
			write: 0,
			execute: 0,
			task: 0,
			other: 0,
		});
		assert.deepEqual(
			events.events.flatMap((event) => (event.type === 'tool' ? [event.callIndex] : [])),
			[1, 2, 3, 4],
		);
	});

	it('the OpenCode shell event name normalizes to the declared bash tool', () => {
		const events = parseEvents(
			lines({
				type: 'tool_use',
				part: {
					type: 'tool',
					callID: 'call-shell',
					tool: 'shell',
					state: {status: 'completed', input: {command: 'pwd'}, output: 'workspace'},
				},
			}),
		);

		assert.equal(events.toolCalls[0]?.tool, 'bash');
		assert.equal(events.toolCalls[0].family, 'execute');
	});

	it('explicit result guidance marks authority independently of output size', () => {
		const events = parseEvents(
			lines(
				{type: 'tool_use', part: partOf('stop', 'stop', false)},
				{type: 'tool_use', part: partOf('cursor', 'follow_cursor', false)},
				{type: 'tool_use', part: {type: 'tool', callID: 'plain', tool: 'codeindex_find_symbol', state: {status: 'completed', input: {}, output: '{}'}}},
			),
		);

		assert.deepEqual(
			events.toolCalls.map((call) => call.authoritative),
			[true, false, null],
		);
	});

	it('the same provider call is not counted twice across envelopes', () => {
		const part = {
			type: 'tool',
			callID: 'call-duplicate',
			tool: 'read',
			state: {status: 'completed', input: {filePath: 'src/a.ts'}, output: 'abcd'},
		};
		const events = parseEvents(lines({type: 'tool_use', part}, {type: 'message.part.updated', properties: {part}}));

		assert.equal(events.toolCalls.length, 1);
		assert.equal(events.toolCalls[0]?.id, 'call-duplicate');
		assert.equal(events.outputBytes, 4);
	});

	it('unknown and failed tools stay visible with their observed shape', () => {
		const stdout = lines(
			{
				type: 'tool_use',
				part: {
					type: 'tool',
					callID: 'call-unknown',
					tool: 'mystery_tool',
					state: {status: 'failed', input: 'not-an-object'},
				},
			},
			{type: 'tool_use', part: {type: 'tool', callID: 'call-empty'}},
		);

		const events = parseEvents(stdout);

		assert.equal(events.toolCalls.length, 2);
		assert.equal(events.toolCalls[0]?.tool, 'mystery_tool');
		assert.equal(events.toolCalls[0].family, 'other');
		assert.equal(events.toolCalls[0].status, 'unknown');
		assert.equal(events.toolCalls[0].input, null);
		assert.equal(events.toolCalls[0].inputValid, false);
		assert.equal(events.toolCalls[1]?.tool, 'unknown');
		assert.equal(events.toolCalls[1].status, 'unknown');
	});

	it('a tool event without a surviving part is retained as unknown', () => {
		const events = parseEvents(lines({type: 'tool_use', part: {type: 'tool'}}));

		assert.equal(events.toolCalls.length, 1);
		assert.equal(events.toolCalls[0]?.tool, 'unknown');
		assert.equal(events.toolCalls[0].status, 'unknown');
	});

	it('malformed and truncated streams retain every preceding event', () => {
		const stdout = `${JSON.stringify({type: 'text', part: {type: 'text', text: 'kept'}})}\nnot-json\n{"type":"step_finish","part":{"tokens":`;
		const events = parseEvents(stdout);

		assert.equal(events.finalText, 'kept');
		assert.equal(events.rawEventCount, 3);
		assert.equal(events.malformed.length, 2);
		assert.deepEqual(
			events.malformed.map((item) => item.line),
			[2, 3],
		);
		assert.equal(events.truncated, true);
		assert.equal(events.telemetry.inputTokens.state, 'unavailable');
	});

	it('a malformed middle line does not mark a complete stream as truncated', () => {
		const stdout = `${JSON.stringify({type: 'text', part: {type: 'text', text: 'before'}})}\n{bad}\n${JSON.stringify({
			type: 'text',
			part: {type: 'text', text: 'after'},
		})}\n`;
		const events = parseEvents(stdout);

		assert.equal(events.truncated, false);
		assert.equal(events.malformed.length, 1);
		assert.equal(events.finalText, 'before\nafter');
		assert.equal(events.stream.complete, false);
		assert.deepEqual(events.stream.reasons, ['1 malformed line(s) retained', 'no completed step was reported']);
	});

	it('proves a complete capture and records the terminal lifecycle event', () => {
		const events = parseEvents(
			lines(
				{type: 'step_start'},
				{
					type: 'tool_use',
					part: {type: 'tool', tool: 'read', state: {status: 'completed', input: {filePath: 'src/a.ts'}, output: 'x'}},
					id: 'call-1',
				},
				{type: 'step_finish', part: {tokens: {input: 1, output: 1}, cost: 0}},
				{type: 'session.execution.succeeded'},
			),
		);

		assert.equal(events.stream.complete, true);
		assert.deepEqual(events.stream.reasons, []);
		assert.equal(events.stream.stepsStarted, 1);
		assert.equal(events.stream.stepsFinished, 1);
		assert.equal(events.stream.terminalEvent, 'session.execution.succeeded');
	});

	it('an unterminated step or tool call is not a complete capture', () => {
		const unterminatedTool = parseEvents(
			lines({
				type: 'tool_use',
				part: {type: 'tool', tool: 'read', state: {status: 'running', input: {filePath: 'src/a.ts'}}},
				id: 'call-1',
			}),
		);
		const balanced = parseEvents(lines({type: 'step_start'}, {type: 'step_finish', part: {tokens: {input: 1, output: 1}}}));

		assert.deepEqual(unterminatedTool.stream.reasons, ['no completed step was reported', '1 tool call(s) have no terminal status']);
		assert.equal(unterminatedTool.stream.complete, false);
		assert.equal(balanced.stream.complete, true);
	});

	it('session errors and nested text events are parsed', () => {
		const stdout = lines(
			{type: 'message.part.updated', properties: {part: {type: 'text', text: 'nested text'}}},
			{type: 'session.error', properties: {error: {name: 'ProviderError', data: {message: 'quota exceeded'}}}},
			{type: 'error', error: {type: 'provider.no-route', message: 'boom'}},
		);
		const events = parseEvents(stdout);

		assert.equal(events.finalText, 'nested text');
		assert.deepEqual(events.errors, ['quota exceeded', 'boom']);
		assert.deepEqual(
			events.events.flatMap((event) => (event.type === 'error' ? [event.message] : [])),
			['quota exceeded', 'boom'],
		);
	});

	it('tool family classification is structural', () => {
		assert.equal(toolFamilyOf('codeindex_find_symbol'), 'index');
		assert.equal(toolFamilyOf('grep'), 'search');
		assert.equal(toolFamilyOf('glob'), 'search');
		assert.equal(toolFamilyOf('read'), 'read');
		assert.equal(toolFamilyOf('list'), 'list');
		assert.equal(toolFamilyOf('bash'), 'execute');
		assert.equal(toolFamilyOf('write'), 'write');
		assert.equal(toolFamilyOf('task'), 'task');
		assert.equal(toolFamilyOf('custom'), 'other');
	});
});
