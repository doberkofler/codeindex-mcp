import {describe, expect, it} from 'vitest';
import {normalizeOracleQueryName} from '../src/adapters/oracle/queryNames.ts';

describe('Oracle query name normalization', () => {
	it('folds unquoted identifiers to their canonical upper-case spelling', () => {
		expect(normalizeOracleQueryName('getAllCIData')).toBe('GETALLCIDATA');
		expect(normalizeOracleQueryName('LAS_MOD_CIHeader_JSON.getAllCIData')).toBe('LAS_MOD_CIHEADER_JSON.GETALLCIDATA');
		expect(normalizeOracleQueryName('LAS_SQL_JPos.reorderPos')).toBe('LAS_SQL_JPOS.REORDERPOS');
	});

	it('preserves delimited identifiers exactly', () => {
		expect(normalizeOracleQueryName('"myMixedCase"')).toBe('"myMixedCase"');
		expect(normalizeOracleQueryName('pkg."myMixedCase"')).toBe('PKG."myMixedCase"');
		expect(normalizeOracleQueryName('"quoted""name"')).toBe('"quoted""name"');
	});

	it('leaves canonical display forms unchanged', () => {
		const display = 'owner["LJ_UNITTEST"]::LAS_MOD_CIHEADER_JSON.GETALLCIDATA';

		expect(normalizeOracleQueryName(display)).toBe(display);
		expect(normalizeOracleQueryName('module["src/a.ts"]::User.find')).toBe('module["src/a.ts"]::User.find');
	});

	it('keeps an empty query empty', () => {
		expect(normalizeOracleQueryName('')).toBe('');
	});
});
