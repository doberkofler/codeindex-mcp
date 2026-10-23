import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {externalPathAttemptCountOf, externalPathAttemptsOf} from './externalPath.ts';

describe('external path attempts', () => {
	it('records every denial in stdout and stderr with its channel and line', () => {
		const stdout = ['before', '{"type":"tool","permission":"external_directory","path":"../outside.ts"}', 'after'].join('\n');
		const stderr = 'external_directory denied\nexternal_directory denied twice external_directory';
		const attempts = externalPathAttemptsOf(stdout, stderr);

		assert.deepEqual(attempts, [
			{channel: 'stdout', line: 2, count: 1, target: '../outside.ts'},
			{channel: 'stderr', line: 1, count: 1, target: null},
			{channel: 'stderr', line: 2, count: 2, target: null},
		]);
		assert.equal(externalPathAttemptCountOf(attempts), 4);
	});

	it('returns no evidence for a clean stream', () => {
		assert.deepEqual(externalPathAttemptsOf('ordinary output\n', ''), []);
		assert.equal(externalPathAttemptCountOf([]), 0);
	});
});
