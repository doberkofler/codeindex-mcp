import {describe, expect, it} from 'vitest';
import {loadConfiguredAdapters} from '../src/adapters/loader.ts';
import {createFixtureConfig, createFixtureIndex} from './helpers/fixture.ts';

describe('adapter loader', () => {
	it('resolves the official adapter aliases', async () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			const typescript = await loadConfiguredAdapters(config);
			const oracle = await loadConfiguredAdapters({...config, extractorId: 'oracle'});

			expect(typescript.adapters.map((adapter) => adapter.id)).toStrictEqual(['typescript']);
			expect(typescript.adapters[0]?.displayName).toBe('TypeScript / JavaScript');
			expect(oracle.adapters.map((adapter) => adapter.id)).toStrictEqual(['oracle']);
			expect(oracle.adapters[0]?.displayName).toBe('Oracle 19c SQL / PL/SQL');
		} finally {
			cleanup();
		}
	});

	it('rejects an unknown adapter without a module specifier', async () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			await expect(loadConfiguredAdapters({...config, extractorId: 'cobol'})).rejects.toMatchObject({code: 'adapter_module_not_found'});
		} finally {
			cleanup();
		}
	});
});

describe('JavaScript projects', () => {
	it('indexes JavaScript declarations when the project enables allowJs', async () => {
		const fixture = await createFixtureIndex('javascript-project');

		try {
			expect(fixture.index.getStatus().counts.files).toBe(2);
			const matches = fixture.index.findSymbols({query: 'greet', limit: 10});

			expect(matches.items.map((symbol) => symbol.name)).toContain('greet');
			expect(matches.items.every((symbol) => symbol.path.endsWith('.js'))).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});
