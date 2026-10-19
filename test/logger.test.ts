import {afterEach, describe, expect, it, vi} from 'vitest';
import {debugFor, enableDebug} from '../src/core/logging/debug.ts';
import {createLogger} from '../src/core/logging/logger.ts';

describe('logger', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('writes every level at or above the minimum to stderr', () => {
		const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const logger = createLogger({minimumLevel: 'warn'});

		logger.debug('debug_event', {value: 1});
		logger.info('info_event');
		logger.warn('warn_event', {value: 2});
		logger.error('error_event');

		expect(write).toHaveBeenCalledTimes(2);

		const lines = write.mock.calls.map(([line]) => String(line).trim());
		expect(lines.map((line) => (JSON.parse(line) as {event: string}).event)).toStrictEqual(['warn_event', 'error_event']);
		expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({level: 'warn', event: 'warn_event', value: 2});
	});

	it('defaults to info and emits all four levels', () => {
		const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const logger = createLogger({});

		logger.debug('debug_event');
		logger.info('info_event', {});
		logger.warn('warn_event', {});
		logger.error('error_event', {});

		expect(write).toHaveBeenCalledTimes(3);
	});

	it('creates namespaced trace channels and enables them', () => {
		const trace = debugFor('test');

		expect(trace.namespace).toBe('codeindex:test');
		expect(() => {
			enableDebug();
		}).not.toThrow();
	});
});
