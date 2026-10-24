import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {providerUsageOf} from './providerUsage.ts';

describe('provider usage token components', () => {
	it('derives the non-cached remainder from an OpenAI-style cache subset without a cache-write tier', () => {
		const usage = providerUsageOf({
			usage: {prompt_tokens: 12, prompt_tokens_details: {cached_tokens: 7}, completion_tokens: 5, total_tokens: 17},
		});

		if (usage === null) {
			throw new Error('expected provider usage');
		}

		assert.equal(usage.nonCachedInputTokens, 5);
		assert.equal(usage.cacheReadTokens, 7);
		assert.deepEqual(usage.cacheWriteTokens, {});
		assert.equal(usage.visibleOutputTokens, 5);
		assert.equal(usage.complete, true);
		assert.deepEqual(usage.missingFields, []);
	});
});
