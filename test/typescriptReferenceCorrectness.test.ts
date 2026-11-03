import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {type ExtractedOccurrenceType} from '../src/core/facts/index.ts';
import {type ConfigType} from '../src/core/config/config.ts';
import {type IndexedSymbolType} from '../src/core/model.ts';
import {extractSymbolFacts} from '@codeindex/adapter-typescript/extractSymbols';
import {loadTypeScriptProject} from '@codeindex/adapter-typescript/loadProject';
import {scanProject} from '@codeindex/adapter-typescript/scanProject';
import {createFixtureConfig} from './helpers/fixture.ts';

type ExtractedFixtureType = Readonly<{
	config: ConfigType;
	symbols: readonly IndexedSymbolType[];
	occurrences: readonly ExtractedOccurrenceType[];
	textOf: (filePath: string, offset: number, length: number) => string;
}>;

const loadFixture = (name: string): Readonly<{fixture: ExtractedFixtureType; cleanup: () => void}> => {
	const {config, cleanup} = createFixtureConfig(name);
	const context = config.projects.at(0);

	if (context === undefined) {
		throw new Error('Fixture requires one project context');
	}

	const scan = scanProject({...config, projects: [context], projectFilePath: context.projectFilePath});
	const project = loadTypeScriptProject(config, context.projectFilePath);
	const facts = extractSymbolFacts({
		project,
		files: scan.files,
		projectId: config.projectId,
		rootDir: config.rootDir,
		context: context.name,
	});
	const contents = new Map(scan.files.map((file) => [file.path, readFileSync(path.join(config.rootDir, file.path), 'utf8')] as const));

	return {
		cleanup,
		fixture: {
			config,
			symbols: facts.symbols,
			occurrences: facts.occurrences,
			textOf: (filePath, offset, length) => (contents.get(filePath) ?? '').slice(offset, offset + length),
		},
	};
};

describe('TypeScript reference correctness', () => {
	let fixture: ExtractedFixtureType | undefined;
	let cleanup: (() => void) | undefined;

	beforeAll(() => {
		const {fixture: loadedFixture, cleanup: loadedCleanup} = loadFixture('reference-correctness');

		fixture = loadedFixture;
		cleanup = loadedCleanup;
	});

	afterAll(() => {
		cleanup?.();
	});

	const occurrencesAt = (filePath: string, offset: number): readonly ExtractedOccurrenceType[] =>
		(fixture?.occurrences ?? []).filter((occurrence) => occurrence.path === filePath && occurrence.startOffset === offset);

	it('keeps transient object-property references', () => {
		const cases = fixture?.textOf('src/cases.ts', 0, 1000) ?? '';
		const fillUsage = cases.indexOf('DEFAULT_FILL', cases.indexOf('DEFAULT_FILL') + 1);
		const titleUsage = cases.lastIndexOf('title');

		expect(occurrencesAt('src/cases.ts', fillUsage)).toHaveLength(1);
		expect(occurrencesAt('src/cases.ts', titleUsage)).toHaveLength(1);
	});

	it('ignores the type-query this keyword and preserves a property named this', () => {
		const cases = fixture?.textOf('src/cases.ts', 0, 1000) ?? '';
		const queryStart = cases.indexOf('typeof this.getElements');
		const queryThis = queryStart + 'typeof '.length;
		const memberOffset = cases.indexOf('getElements', queryThis);
		const namedThis = cases.indexOf('this.named.this') + 'this.named.'.length;

		expect(occurrencesAt('src/cases.ts', queryThis)).toHaveLength(0);
		expect(occurrencesAt('src/cases.ts', memberOffset)).toHaveLength(1);
		expect(fixture?.textOf('src/cases.ts', namedThis, 'this'.length)).toBe('this');
		expect(occurrencesAt('src/cases.ts', namedThis)).toHaveLength(1);
	});

	it('maps a union receiver to exactly one occurrence', () => {
		const cases = fixture?.textOf('src/cases.ts', 0, 2000) ?? '';
		const usage = cases.lastIndexOf('value.shared') + 'value.'.length;

		expect(fixture?.textOf('src/cases.ts', usage, 'shared'.length)).toBe('shared');
		expect(occurrencesAt('src/cases.ts', usage)).toHaveLength(1);
	});

	it('collapses an authored-terminal re-export onto its canonical binding', () => {
		const authoredValue = fixture?.symbols.filter((symbol) => symbol.name === 'authoredValue') ?? [];

		expect(authoredValue).toHaveLength(1);
		expect(fixture?.symbols.some((symbol) => symbol.name === 'aliasValue')).toBe(false);

		const canonicalId = authoredValue[0]?.id;

		for (const [filePath, offset] of [
			['src/facade.ts', 8],
			['src/facade.ts', 25],
			['src/consumer.ts', 8],
			['src/consumer.ts', 67],
		] as const) {
			const occurrences = occurrencesAt(filePath, offset);

			expect(occurrences).toHaveLength(1);
			expect(occurrences[0]?.symbolId).toBe(canonicalId);
		}
	});
});
