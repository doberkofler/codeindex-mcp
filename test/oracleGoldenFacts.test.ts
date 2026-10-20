import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {extractOracleSymbols} from '../src/adapters/oracle/extractSymbols.ts';
import {parseOracleUnits} from '../src/adapters/oracle/parseUnits.ts';
import {resolveOracleReferences} from '../src/adapters/oracle/resolveReferences.ts';
import {tokenizeOracleSource} from '../src/adapters/oracle/tokenize.ts';
import {createExtraClassifier} from '../src/core/qualification/oracle/oracleExtras.ts';
import {type ObjectMappingType} from '../src/core/qualification/oracle/oracleMapping.ts';

const GoldenFactsSchema = z.object({
	path: z.string().min(1),
	facts: z.array(
		z.object({
			role: z.enum(['definition', 'reference']),
			line: z.number().int().positive(),
			column: z.number().int().positive(),
			name: z.string().min(1),
			kind: z.string().min(1),
		}),
	),
});

const fixtureDirectory = path.join(import.meta.dirname, 'fixtures', 'oracle-qualification-v2');

/**
 * Loads the checked-in golden facts for constructs PL/Scope does not record.
 *
 * @returns Parsed golden corpus and facts.
 */
const goldenOf = (): z.infer<typeof GoldenFactsSchema> => {
	const raw: unknown = JSON.parse(readFileSync(path.join(fixtureDirectory, 'golden-facts.json'), 'utf8'));

	return GoldenFactsSchema.parse(raw);
};

describe('Oracle golden facts', () => {
	it('matches the checked-in golden facts', () => {
		const golden = goldenOf();
		const source = readFileSync(path.join(fixtureDirectory, golden.path), 'utf8');
		const parse = parseOracleUnits({tokens: tokenizeOracleSource(source, golden.path).tokens, path: golden.path, defaultSchema: 'APP'});
		const symbols = extractOracleSymbols({projectId: 'golden', context: 'APP', files: [{path: golden.path, parse}]});
		const references = resolveOracleReferences({
			context: 'APP',
			defaultSchema: 'APP',
			files: symbols.analyses,
			packages: symbols.packages,
		});
		const names = new Map(symbols.symbols.map((symbol) => [symbol.id, symbol]));
		const actual = [...symbols.occurrences, ...references.occurrences]
			.map((occurrence) => ({
				role: occurrence.role,
				line: occurrence.startLine,
				column: occurrence.startColumn,
				name: names.get(occurrence.symbolId)?.name.toUpperCase() ?? '',
				kind: names.get(occurrence.symbolId)?.kind ?? '',
			}))
			.sort((left, right) => left.line - right.line || left.column - right.column || left.role.localeCompare(right.role));

		expect(actual).toStrictEqual(golden.facts);
	});

	it('classifies pragma arguments as outside PL/Scope coverage', () => {
		const golden = goldenOf();
		const source = readFileSync(path.join(fixtureDirectory, golden.path), 'utf8');
		const mapping: ObjectMappingType = {path: golden.path, offset: 0, columnShift: 0, lines: source.split('\n')};
		const classify = createExtraClassifier({mappings: new Map([[golden.path, mapping]]), rowsByPath: new Map([[golden.path, 1]])});
		expect(classify({path: golden.path, line: 4, column: 17, name: 'RUN', kind: 'function'})).toBe('outside_plscope');
	});
});
