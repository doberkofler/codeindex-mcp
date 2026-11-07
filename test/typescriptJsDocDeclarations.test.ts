import {describe, expect, it} from 'vitest';
import {buildTypeScriptFacts, scanTypeScriptProject} from '@codeindex/adapter-typescript/index';
import {finalizeFacts} from '../src/core/facts/index.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

describe('TypeScript JSDoc type declarations', () => {
	it('does not publish JSDoc type members as symbols', () => {
		const {config, cleanup} = createFixtureConfig('jsdoc-types');

		try {
			const scan = scanTypeScriptProject(config, []);
			const extracted = buildTypeScriptFacts(config, scan);
			const facts = finalizeFacts(extracted, {mode: 'enforce', maxBindingsPerRoot: 2000, extractorId: 'typescript'});
			const names = facts.symbols.map((symbol) => symbol.name);

			expect(names).toContain('context');
			expect(names).toContain('responsiveProperty');
			expect(names).not.toContain('expanded');
			expect(names).not.toContain('disabled');
			expect(names).not.toContain('justDocumented');
		} finally {
			cleanup();
		}
	});
});
