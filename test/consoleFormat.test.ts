import {describe, expect, it} from 'vitest';
import {formatBytes, formatClock, formatDuration, formatNumber, formatPercent, formatTimestamp, shortId} from '../src/ui/console/format.ts';

describe('console number formatting', () => {
	it.each([
		[0, '0'],
		[9999, '9,999'],
		[10_000, '10K'],
		[-9999, '-9,999'],
		[-10_000, '-10K'],
	] as const)('formats %s as %s across the compact-number boundary', (value, expected) => {
		expect(formatNumber(value)).toBe(expected);
	});
});

describe('console duration formatting', () => {
	it.each([
		[null, '—'],
		[0, '0 ms'],
		[999, '999 ms'],
		[1000, '1.0 s'],
		[9949, '9.9 s'],
		[10_000, '10 s'],
		[60_000 - 1, '60 s'],
	] as const)('formats %s as %s', (value, expected) => {
		expect(formatDuration(value)).toBe(expected);
	});
});

describe('console byte formatting', () => {
	it.each([
		[0, '0 B'],
		[1023, '1023 B'],
		[1024, '1.0 KB'],
		[10_240, '10 KB'],
		[1_048_575, '1024 KB'],
		[1_048_576, '1.0 MB'],
		[1_073_741_824, '1.0 GB'],
		[1_099_511_627_776, '1024 GB'],
	] as const)('formats %s as %s', (value, expected) => {
		expect(formatBytes(value)).toBe(expected);
	});
});

describe('console percent, timestamp, and identity formatting', () => {
	it('keeps one decimal for tiny non-zero rates and two otherwise', () => {
		expect(formatPercent(0)).toBe('0.00%');
		expect(formatPercent(0.005)).toBe('0.5%');
		expect(formatPercent(0.05)).toBe('5.00%');
		expect(formatPercent(1)).toBe('100.00%');
	});

	it('renders an absent timestamp as a dash and a present one in the local zone', () => {
		expect(formatTimestamp(null)).toBe('—');
		expect(formatTimestamp('2026-10-24T10:00:00.000Z')).toBe(
			new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'medium'}).format(new Date('2026-10-24T10:00:00.000Z')),
		);
		expect(formatClock('2026-10-24T10:00:00.000Z')).toBe(new Intl.DateTimeFormat(undefined, {timeStyle: 'short'}).format(new Date('2026-10-24T10:00:00.000Z')));
	});

	it('shortens identifiers and marks an absent generation', () => {
		expect(shortId(null)).toBe('none');
		expect(shortId('0123456789abcdef')).toBe('01234567');
		expect(shortId('short')).toBe('short');
	});
});
