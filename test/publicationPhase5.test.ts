import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {oracleExtractor} from '../src/adapters/oracle/index.ts';
import {parseOracleUnits} from '../src/adapters/oracle/parseUnits.ts';
import {buildSymbolTable} from '../src/adapters/oracle/symbolTables.ts';
import {tokenizeOracleSource} from '../src/adapters/oracle/tokenize.ts';
import {finalizeFacts, type FinalizedFactSetType} from '../src/core/facts/index.ts';
import {measureInvariants} from '../src/core/qualification/publication/invariants.ts';
import {createFixtureConfig, createFixtureIndex} from './helpers/fixture.ts';

const ORACLE_PROJECTS = [{name: 'app', project: 'oracle-index.json'}] as const;

const buildFacts = (): Readonly<{facts: FinalizedFactSetType; cleanup: () => void}> => {
	const {config, cleanup} = createFixtureConfig('oracle-publication-project', ORACLE_PROJECTS, 'oracle');
	const scan = oracleExtractor.scan(config, []);
	const extracted = oracleExtractor.build(config, scan);

	return {facts: finalizeFacts(extracted, {mode: 'enforce', maxBindingsPerRoot: 2000}), cleanup};
};

const symbolNamed = (facts: FinalizedFactSetType, name: string): FinalizedFactSetType['symbols'][number] => {
	const symbol = facts.symbols.find((candidate) => candidate.name === name);

	if (symbol === undefined) {
		throw new Error(`Missing symbol ${name}`);
	}

	return symbol;
};

type ParsedFileType = Readonly<{path: string; parse: ReturnType<typeof parseOracleUnits>}>;

const parsedFileOf = (name: string, source: string): ParsedFileType => {
	const tokenized = tokenizeOracleSource(source, name);

	return {path: name, parse: parseOracleUnits({tokens: tokenized.tokens, path: name, defaultSchema: 'APP'})};
};

const diagnosticCodesOf = (files: readonly ParsedFileType[]): readonly number[] =>
	buildSymbolTable({projectId: 'p', context: 'APP', files}).diagnostics.map((diagnostic) => diagnostic.code);

const usagesOf = (facts: FinalizedFactSetType, name: string, referencePath?: string): readonly number[] => {
	const ids = new Set(facts.symbols.filter((symbol) => symbol.name === name).map((symbol) => symbol.id));

	return facts.occurrences
		.filter(
			(occurrence) => occurrence.role === 'reference' && ids.has(occurrence.symbolId) && (referencePath === undefined || occurrence.path === referencePath),
		)
		.map((occurrence) => occurrence.usage ?? 0);
};

describe('Oracle publication vertical slice', () => {
	it('records declaration forms and pairs headings exactly', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const stats = new Map(facts.adapterStats.map((stat) => [`${stat.metric}:${(stat.dimensions ?? []).join(',')}`, stat.value]));

			expect(stats.get('oracle_declaration_forms:specification')).toBeGreaterThan(0);
			expect(stats.get('oracle_declaration_forms:full_definition')).toBeGreaterThan(0);
			expect(stats.get('oracle_declaration_forms:body_forward')).toBeGreaterThan(0);
			expect(stats.get('oracle_declaration_forms:call_spec')).toBe(1);
			expect(stats.get('oracle_declaration_forms:polymorphic_table_function')).toBe(1);
			expect(stats.get('oracle_cursor_pairs:')).toBe(1);
			expect(stats.get('oracle_routine_pairs:')).toBeGreaterThan(0);
			expect(stats.get('oracle_call_specs:')).toBe(1);
			expect(stats.get('oracle_polymorphic_table_functions:')).toBe(1);
		} finally {
			cleanup();
		}
	});

	it('keeps specification identity while serving the full body as primary', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const writeItem = symbolNamed(facts, 'WRITE_ITEM');

			expect(writeItem.exposure).toBe('published');

			const definitions = facts.occurrences.filter((occurrence) => occurrence.role === 'definition' && occurrence.symbolId === writeItem.id);

			expect(definitions.map((occurrence) => occurrence.path).sort()).toStrictEqual(['database/feature_api.pkb', 'database/feature_api.pks']);
			expect(writeItem.path).toBe('database/feature_api.pkb');

			const definitionSite = facts.bindingSites.find(
				(site) => site.bindingId === writeItem.primaryBindingId && site.kind === 'declared' && site.path === writeItem.path,
			);

			expect(definitionSite?.path).toBe('database/feature_api.pkb');
		} finally {
			cleanup();
		}
	});

	it('anchors private body forwards on the full implementation', () => {
		const {facts, cleanup} = buildFacts();

		try {
			for (const name of ['FORWARD_HELPER', 'HELPER']) {
				const symbol = symbolNamed(facts, name);
				const definitions = facts.occurrences.filter((occurrence) => occurrence.role === 'definition' && occurrence.symbolId === symbol.id);
				const forward = definitions.find((occurrence) => occurrence.forwardDefinition === true);
				const full = definitions.find((occurrence) => occurrence.forwardDefinition === false);

				expect(definitions).toHaveLength(2);
				expect(forward).toBeDefined();
				expect(full).toBeDefined();
				expect(symbol.path).toBe(full?.path);
				expect(symbol.startOffset).toBe(full?.extent?.startOffset);

				const primarySite = facts.bindingSites.find(
					(site) => site.bindingId === symbol.primaryBindingId && site.kind === 'declared' && site.range.startOffset === full?.startOffset,
				);

				expect(primarySite?.range.startOffset).toBe(full?.startOffset);
			}
		} finally {
			cleanup();
		}
	});

	it('reports heading mismatches, ambiguity, and missing bodies without silent pairing', () => {
		const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'oracle-publication-project', 'database');
		const spec = readFileSync(path.join(fixtureRoot, 'feature_api.pks'), 'utf8');
		const body = readFileSync(path.join(fixtureRoot, 'feature_api.pkb'), 'utf8');
		const mismatched = body.replace('p_item in out t_item, p_note out varchar2', 'p_item in t_item, p_note out varchar2');
		const missing = body.replace(/procedure write_item[\s\S]*end write_item;/u, '');
		const files = [parsedFileOf('feature_api.pks', spec), parsedFileOf('feature_api_mismatch.pkb', mismatched)];

		expect(diagnosticCodesOf(files)).toContain(9109);
		expect(diagnosticCodesOf([parsedFileOf('feature_api.pks', spec), parsedFileOf('feature_api_missing.pkb', missing)])).toContain(9111);
		expect(
			diagnosticCodesOf([
				parsedFileOf('dup.pks', 'create package p as procedure run(p number); procedure run(p number); end p;\n/'),
				parsedFileOf('dup.pkb', 'create package body p as procedure run(p number) is begin null; end run; end p;\n/'),
			]),
		).toContain(9110);
	});
});

describe('Oracle publication usage and queries', () => {
	it('emits call, read, write, and type-reference usage bits including OUT arguments', () => {
		const {facts, cleanup} = buildFacts();

		try {
			expect(usagesOf(facts, 'WRITE_ITEM', 'database/feature_usage.prc')).toContain(1);
			expect(usagesOf(facts, 'EXTERNAL_PROC', 'database/feature_usage.prc')).toContain(1);
			expect(usagesOf(facts, 'G_ITEM', 'database/feature_usage.prc')).toContain(6);
			expect(usagesOf(facts, 'G_NOTE', 'database/feature_usage.prc')).toContain(4);
			expect(usagesOf(facts, 'G_NOTE', 'database/feature_usage.prc')).toContain(2);
			expect(usagesOf(facts, 'ID', 'database/feature_usage.prc')).toContain(8);
			expect(usagesOf(facts, 'ID', 'database/feature_usage.prc')).toContain(4);
			expect(usagesOf(facts, 'ID', 'database/feature_usage.prc')).toContain(2);

			const definitions = facts.occurrences.filter((occurrence) => occurrence.role === 'definition');

			expect(definitions.every((occurrence) => (occurrence.usage ?? 0) === 0)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it('keeps cross-file references on published or reachable targets', () => {
		const {facts, cleanup} = buildFacts();

		try {
			const pathById = new Map(facts.symbols.map((symbol) => [symbol.id, symbol.path]));
			const exposureById = new Map(facts.symbols.map((symbol) => [symbol.id, symbol.exposure]));
			const crossFile = facts.occurrences.filter((occurrence) => occurrence.role === 'reference' && pathById.get(occurrence.symbolId) !== occurrence.path);

			expect(crossFile.length).toBeGreaterThan(0);

			for (const occurrence of crossFile) {
				expect(exposureById.get(occurrence.symbolId)).not.toBe('internal_only');
			}

			const referenceIds = new Set(facts.occurrences.filter((occurrence) => occurrence.role === 'reference').map((occurrence) => occurrence.symbolId));
			const symbolIds = new Set(facts.symbols.map((symbol) => symbol.id));

			for (const id of referenceIds) {
				expect(symbolIds.has(id)).toBe(true);
			}
		} finally {
			cleanup();
		}
	});

	it('passes the structural invariant checks after finalization', () => {
		const {config, cleanup} = createFixtureConfig('oracle-publication-project', ORACLE_PROJECTS, 'oracle');

		try {
			const scan = oracleExtractor.scan(config, []);
			const extracted = oracleExtractor.build(config, scan);
			const facts = finalizeFacts(extracted, {mode: 'enforce', maxBindingsPerRoot: 2000});
			const invariants = measureInvariants(extracted, facts, 'oracle');

			expect(facts.issues).toStrictEqual([]);
			expect(invariants.report.s3.violations).toBe(0);
			expect(invariants.report.o2.violations).toBe(0);
			expect(invariants.report.l1.violations).toBe(0);
			expect(invariants.report.f1.violations).toBe(0);
		} finally {
			cleanup();
		}
	});

	it('serves Oracle bindings, exposure filters, usage filters, and primary source', () => {
		const fixture = createFixtureIndex('oracle-publication-project', ORACLE_PROJECTS, 'oracle');

		try {
			const writeItem = fixture.index.findSymbols({query: 'WRITE_ITEM', exposure: 'published', limit: 5}).items.at(0);

			if (writeItem === undefined) {
				throw new Error('Missing WRITE_ITEM');
			}

			expect(writeItem.primary.qualifiedName).toBe('owner["APP"]::FEATURE_API.WRITE_ITEM');
			expect(fixture.index.findSymbols({query: 'WRITE_ITEM', exposure: 'internal', limit: 5}).items).toHaveLength(0);

			const names = fixture.index.readSymbol({symbolId: writeItem.symbolId, mode: 'names', contextLines: 0, limit: 20});
			const listed = names.kind === 'names' ? names.items : [];

			expect(names.kind).toBe('names');
			expect(listed.map((item) => item.qualifiedName)).toContain('owner["APP"]::FEATURE_API.WRITE_ITEM');

			const note = fixture.index.findSymbols({query: 'G_NOTE', limit: 5}).items.at(0);

			if (note === undefined) {
				throw new Error('Missing G_NOTE');
			}

			expect(fixture.index.findReferences({symbolId: note.id, usage: 4, limit: 20}).items.length).toBeGreaterThan(0);

			const source = fixture.index.readSymbol({symbolId: writeItem.symbolId, contextLines: 0});

			expect(source.kind).toBe('text');
			expect(source.kind === 'text' ? source.path : '').toBe('database/feature_api.pkb');
			expect(fixture.index.getStatus().buildStats.some((stat) => stat.metric === 'occurrences_stored')).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});
