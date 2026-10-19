import {describe, expect, it} from 'vitest';
import {createOracleId} from '../src/adapters/oracle/symbolIdentity.ts';

const identity = {
	projectId: 'project',
	path: 'src/demo.pkb',
	startOffset: 42,
	kind: 'procedure',
	name: 'RUN',
};

describe('Oracle symbol identity', () => {
	it('creates stable 32-character identifiers', () => {
		const first = createOracleId(identity);
		const second = createOracleId(identity);

		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{32}$/u);
	});

	it('includes an optional discriminator', () => {
		const withoutDiscriminator = createOracleId(identity);
		const withDiscriminator = createOracleId({...identity, discriminator: 'overload'});

		expect(withDiscriminator).not.toBe(withoutDiscriminator);
	});

	it('changes when any identity component changes', () => {
		const base = createOracleId(identity);

		expect(createOracleId({...identity, projectId: 'other'})).not.toBe(base);
		expect(createOracleId({...identity, path: 'src/other.pkb'})).not.toBe(base);
		expect(createOracleId({...identity, startOffset: 43})).not.toBe(base);
		expect(createOracleId({...identity, kind: 'function'})).not.toBe(base);
		expect(createOracleId({...identity, name: 'STOP'})).not.toBe(base);
	});
});
