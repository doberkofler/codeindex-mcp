import {describe, expect, it} from 'vitest';
import {IndexNotReadyError} from '../src/core/errors/errors.ts';

describe('index not ready error', () => {
	it('uses the stable code and default message', () => {
		const error = new IndexNotReadyError();

		expect(error).toMatchObject({
			name: 'IndexNotReadyError',
			code: 'index_not_ready',
			message: 'No published index generation exists yet',
		});
	});

	it('accepts a specific message', () => {
		expect(new IndexNotReadyError('Build still running')).toMatchObject({
			code: 'index_not_ready',
			message: 'Build still running',
		});
	});
});
