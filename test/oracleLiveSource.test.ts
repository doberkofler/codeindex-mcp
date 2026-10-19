import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {assertOracleSourceMatchesSnapshot, oracleSourceUnitsOf} from '../src/core/qualification/oracle/live/oracleLiveSource.ts';
import {createOracleLivePlan} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {type OracleLiveSettingsType} from '../src/core/qualification/oracle/live/oracleLiveSettings.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const fixture = (): ReturnType<typeof createFixtureConfig> => createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

const settingsOf = (outputDir: string): OracleLiveSettingsType => ({
	outputDir,
	sqlplus: 'sqlplus',
	timeoutMs: 1000,
	approval: null,
	connection: null,
});

describe('Oracle live source units', () => {
	it('falls back to the full file when the structural parser recovers only a header', () => {
		const source = 'CREATE OR REPLACE PACKAGE BODY X IS\nPROCEDURE p;\n';
		const units = oracleSourceUnitsOf('x.pkb', source);

		expect(units).toHaveLength(1);
		expect(units[0]?.rawSource).toBe(source);
		expect(units[0]?.source).toContain('procedure p;');
	});
});

describe('Oracle live source drift guards', () => {
	it('rejects an unexpected backup row shape', () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));

			expect(() => {
				assertOracleSourceMatchesSnapshot(plan, [[1]]);
			}).toThrow(/unexpected row shape/u);
		} finally {
			context.cleanup();
		}
	});

	it('rejects a missing installed object', () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));

			expect(() => {
				assertOracleSourceMatchesSnapshot(plan, []);
			}).toThrow(/is missing for the snapshot/u);
		} finally {
			context.cleanup();
		}
	});
});
