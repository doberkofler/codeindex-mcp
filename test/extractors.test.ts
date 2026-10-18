import {describe, expect, it} from 'vitest';
import {availableExtractors, extractorFor} from '../src/extractors/registry.ts';
import {createFixtureIndex} from './helpers/fixture.ts';

describe('extractor registry', () => {
	it('exposes the TypeScript adapter', () => {
		expect(availableExtractors().map((extractor) => extractor.id)).toStrictEqual(['typescript']);
		expect(extractorFor('typescript').displayName).toBe('TypeScript / JavaScript');
	});

	it('rejects an unknown extractor', () => {
		expect(() => extractorFor('cobol')).toThrow(/Unknown code index extractor: cobol/u);
	});
});

describe('JavaScript projects', () => {
	it('indexes JavaScript declarations when the project enables allowJs', () => {
		const fixture = createFixtureIndex('javascript-project');

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
