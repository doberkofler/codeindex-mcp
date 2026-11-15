import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {CodeIndexError} from '../src/core/errors/errors.ts';
import {createFixtureIndex, type FixtureContextType, type FixtureProjectType} from './helpers/fixture.ts';

type PageType = Readonly<{
	items: readonly unknown[];
	nextCursor: string | null;
}>;

const MULTI_PROJECTS: readonly FixtureProjectType[] = [
	{name: 'browser', project: 'tsconfig.json'},
	{name: 'contracts', project: 'contracts/tsconfig.json'},
	{name: 'server', project: 'server/tsconfig.json'},
];

const cursorOf = (page: PageType): string => {
	if (page.nextCursor === null) {
		throw new Error('Expected a continuation cursor');
	}

	return page.nextCursor;
};

const expectInvalidCursor = (action: () => unknown): void => {
	try {
		action();
	} catch (error) {
		if (!(error instanceof CodeIndexError)) {
			throw error;
		}

		expect(error.code).toBe('invalid_cursor');
		return;
	}

	throw new Error('Expected invalid_cursor');
};

const publishInPlace = async (fixture: FixtureContextType, relativePath: string): Promise<void> => {
	const before = fixture.index.getStatus();

	if (before.generationId === null || before.revision === null) {
		throw new Error('Expected a published generation');
	}

	appendFileSync(path.join(fixture.config.rootDir, relativePath), '\n// cursor revision\n', 'utf8');
	const report = await fixture.index.ensureReady();
	const after = fixture.index.getStatus();

	expect(report.reused).toBe(false);
	expect(after.generationId).toBe(before.generationId);
	expect(after.revision).toBeGreaterThan(before.revision);
};

describe('global revision-bound query cursors', () => {
	it('invalidates find_symbol, occurrence reference, outline, and read_symbol names cursors after in-place publication', async () => {
		const fixture = await createFixtureIndex('simple-project');

		try {
			const symbol = fixture.index.findSymbols({query: 'formatUser', limit: 1}).items.at(0);

			if (symbol === undefined) {
				throw new Error('Expected formatUser');
			}

			const symbols = fixture.index.findSymbols({query: 'U', limit: 1});
			const references = fixture.index.findReferences({symbolId: symbol.symbolId, limit: 1});
			const outline = fixture.index.getOutline({path: 'src/models.ts', limit: 1});
			const names = fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'names', contextLines: 0, limit: 1});

			if (names.kind !== 'names') {
				throw new Error('Expected names');
			}

			const symbolCursor = cursorOf(symbols);
			const referenceCursor = cursorOf(references);
			const outlineCursor = cursorOf(outline);
			const nameCursor = cursorOf(names);

			fixture.index.findSymbols({query: 'U', limit: 1, cursor: symbolCursor});
			fixture.index.findReferences({symbolId: symbol.symbolId, limit: 1, cursor: referenceCursor});
			fixture.index.getOutline({path: 'src/models.ts', limit: 1, cursor: outlineCursor});
			fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'names', contextLines: 0, limit: 1, cursor: nameCursor});

			await publishInPlace(fixture, 'src/summary.ts');

			expectInvalidCursor(() => fixture.index.findSymbols({query: 'U', limit: 1, cursor: symbolCursor}));
			expectInvalidCursor(() => fixture.index.findReferences({symbolId: symbol.symbolId, limit: 1, cursor: referenceCursor}));
			expectInvalidCursor(() => fixture.index.getOutline({path: 'src/models.ts', limit: 1, cursor: outlineCursor}));
			expectInvalidCursor(() => fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'names', contextLines: 0, limit: 1, cursor: nameCursor}));

			expect(fixture.index.findSymbols({query: 'U', limit: 1}).items).toStrictEqual(symbols.items);
			expect(fixture.index.findReferences({symbolId: symbol.symbolId, limit: 1}).items).toStrictEqual(references.items);
			expect(fixture.index.getOutline({path: 'src/models.ts', limit: 1}).items).toStrictEqual(outline.items);
			expect(fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'names', contextLines: 0, limit: 1})).toMatchObject({
				items: names.items,
			});
		} finally {
			fixture.cleanup();
		}
	});

	it('invalidates manually encoded grouped-reference cursors after in-place publication', async () => {
		const fixture = await createFixtureIndex('reference-grouping');

		try {
			const files = fixture.index.findReferences({query: 'duplicate', group: 'file', limit: 1});
			const owners = fixture.index.findReferences({query: 'duplicate', group: 'owner', limit: 1});

			if (files.kind !== 'files' || owners.kind !== 'owners') {
				throw new Error('Expected grouped references');
			}

			const fileCursor = cursorOf(files);
			const ownerCursor = cursorOf(owners);

			fixture.index.findReferences({query: 'duplicate', group: 'file', limit: 1, cursor: fileCursor});
			fixture.index.findReferences({query: 'duplicate', group: 'owner', limit: 1, cursor: ownerCursor});

			await publishInPlace(fixture, 'src/second.ts');

			expectInvalidCursor(() => fixture.index.findReferences({query: 'duplicate', group: 'file', limit: 1, cursor: fileCursor}));
			expectInvalidCursor(() => fixture.index.findReferences({query: 'duplicate', group: 'owner', limit: 1, cursor: ownerCursor}));

			expect(fixture.index.findReferences({query: 'duplicate', group: 'file', limit: 1})).toMatchObject({items: files.items});
			expect(fixture.index.findReferences({query: 'duplicate', group: 'owner', limit: 1})).toMatchObject({items: owners.items});
		} finally {
			fixture.cleanup();
		}
	});
});

describe('global revision-bound dependency cursors', () => {
	it('invalidates find_dependencies cursors after in-place publication', async () => {
		const fixture = await createFixtureIndex('dependency-impact');

		try {
			const dependencies = fixture.index.findDependencies({target: 'lodash', transitive: true, limit: 1});
			const dependencyCursor = cursorOf(dependencies);

			fixture.index.findDependencies({target: 'lodash', transitive: true, limit: 1, cursor: dependencyCursor});

			await publishInPlace(fixture, 'src/boundary/barrel.ts');

			expectInvalidCursor(() => fixture.index.findDependencies({target: 'lodash', transitive: true, limit: 1, cursor: dependencyCursor}));
			expect(fixture.index.findDependencies({target: 'lodash', transitive: true, limit: 1}).items).toStrictEqual(dependencies.items);
		} finally {
			fixture.cleanup();
		}
	});
});

describe('global revision-bound read_symbol site cursors', () => {
	it('invalidates read_symbol sites and binding-sites cursors after in-place publication', async () => {
		const fixture = await createFixtureIndex('reference-edges');

		try {
			const symbol = fixture.index.findSymbols({query: 'EdgeMerged', limit: 1}).items.at(0);

			if (symbol === undefined) {
				throw new Error('Expected EdgeMerged');
			}

			const names = fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'names', contextLines: 0, limit: 100});

			if (names.kind !== 'names') {
				throw new Error('Expected EdgeMerged binding');
			}

			const binding = names.items.at(0);

			if (binding === undefined) {
				throw new Error('Expected EdgeMerged binding');
			}

			const {bindingId} = binding;
			const sites = fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'sites', contextLines: 0, limit: 1});
			const bindingSites = fixture.index.readSymbol({
				symbolId: symbol.symbolId,
				mode: 'binding_sites',
				bindingId,
				contextLines: 0,
				limit: 1,
			});

			if (sites.kind !== 'sites' || bindingSites.kind !== 'binding_sites') {
				throw new Error('Expected site lists');
			}

			const siteCursor = cursorOf(sites);
			const bindingSiteCursor = cursorOf(bindingSites);

			fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'sites', contextLines: 0, limit: 1, cursor: siteCursor});
			fixture.index.readSymbol({
				symbolId: symbol.symbolId,
				mode: 'binding_sites',
				bindingId,
				contextLines: 0,
				limit: 1,
				cursor: bindingSiteCursor,
			});

			await publishInPlace(fixture, 'edges.ts');

			expectInvalidCursor(() => fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'sites', contextLines: 0, limit: 1, cursor: siteCursor}));
			expectInvalidCursor(() =>
				fixture.index.readSymbol({
					symbolId: symbol.symbolId,
					mode: 'binding_sites',
					bindingId,
					contextLines: 0,
					limit: 1,
					cursor: bindingSiteCursor,
				}),
			);

			expect(fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'sites', contextLines: 0, limit: 1})).toMatchObject({
				items: sites.items,
			});
			expect(fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'binding_sites', bindingId, contextLines: 0, limit: 1})).toMatchObject({
				items: bindingSites.items,
			});
		} finally {
			fixture.cleanup();
		}
	});
});

describe('global revision-bound read_symbol context cursors', () => {
	it('invalidates read_symbol binding-context cursors after in-place publication', async () => {
		const fixture = await createFixtureIndex('multi-project', MULTI_PROJECTS);

		try {
			const symbol = fixture.index.findSymbols({query: 'ServiceRequest', limit: 1}).items.at(0);

			if (symbol === undefined) {
				throw new Error('Expected ServiceRequest');
			}

			const names = fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'names', contextLines: 0, limit: 100});

			if (names.kind !== 'names') {
				throw new Error('Expected ServiceRequest binding');
			}

			const binding = names.items.at(0);

			if (binding === undefined) {
				throw new Error('Expected ServiceRequest binding');
			}

			const {bindingId} = binding;
			const contexts = fixture.index.readSymbol({
				symbolId: symbol.symbolId,
				mode: 'binding_contexts',
				bindingId,
				contextLines: 0,
				limit: 1,
			});

			if (contexts.kind !== 'binding_contexts') {
				throw new Error('Expected binding contexts');
			}

			const contextCursor = cursorOf(contexts);

			fixture.index.readSymbol({
				symbolId: symbol.symbolId,
				mode: 'binding_contexts',
				bindingId,
				contextLines: 0,
				limit: 1,
				cursor: contextCursor,
			});

			await publishInPlace(fixture, 'contracts/src/service.ts');

			expectInvalidCursor(() =>
				fixture.index.readSymbol({
					symbolId: symbol.symbolId,
					mode: 'binding_contexts',
					bindingId,
					contextLines: 0,
					limit: 1,
					cursor: contextCursor,
				}),
			);
			expect(fixture.index.readSymbol({symbolId: symbol.symbolId, mode: 'binding_contexts', bindingId, contextLines: 0, limit: 1})).toMatchObject({
				items: contexts.items,
			});
		} finally {
			fixture.cleanup();
		}
	});
});
