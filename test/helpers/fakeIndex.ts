import {CodeIndexError} from '../../src/core/errors/codeIndexError.ts';
import {StaleFileError} from '../../src/core/errors/staleFileError.ts';
import {type McpIndexType} from '../../src/transports/mcp/buildMcpServer.ts';
import {
	type BindingDetailType,
	type BindingSummaryType,
	type DefinitionSiteSummaryType,
	type DependencyConsumerItemType,
	type FindDependenciesInputType,
	type FindDependenciesResultType,
	type FindReferencesInputType,
	type FindReferencesResultType,
	type FindSymbolInputType,
	type FindSymbolItemType,
	type FindSymbolResultType,
	type IndexStatusType,
	type OutlineInputType,
	type OutlineResultType,
	type QueryFreshnessType,
	type ReadSymbolInputType,
	type ReadSymbolResultType,
	type SymbolAtInputType,
	type SymbolAtResultType,
	type SymbolSummaryType,
} from '../../src/core/model.ts';

const FAKE_GENERATION_ID = 'fake-generation';
export const FAKE_SYMBOL_COUNT = 12;
export const FAKE_SOURCE = 'export const formatUser = (user: User): string => user.name;\n';

const FAKE_PATH = 'src/fake.ts';
const FAKE_FRESHNESS: QueryFreshnessType = {
	state: 'current',
	checkedAt: '2026-01-01T00:00:00.000Z',
	dirtyFileCount: 0,
};

const FAKE_STATUS: IndexStatusType = {
	ready: true,
	state: 'published',
	refresh: 'current',
	generationId: FAKE_GENERATION_ID,
	revision: 1,
	building: false,
	scope: {
		root: '/workspace',
		projectName: 'fake-project',
		projectFile: 'tsconfig.json',
		projects: [{name: 'root', projectFile: 'tsconfig.json'}],
		extractor: {id: 'typescript', version: 'fake', compilerVersion: 'fake'},
		projectId: 'fake-project',
		workingCopyId: 'fake-working-copy',
	},
	hashes: {source: 'source-hash', configuration: 'configuration-hash'},
	counts: {files: 4, symbols: 5, occurrences: 7, dependencyEdges: 1, dependencyBindings: 1, diagnostics: 0},
	buildStats: [{language: 'typescript', metric: 'symbols', dim1: '', dim2: '', dim3: '', value: 5}],
	build: {
		startedAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:00.012Z',
		durationMs: 12,
		stages: {scanMs: 1, compilerMs: 2, extractionMs: 3, insertionMs: 4, verificationMs: 1, publicationMs: 1},
	},
	freshness: {...FAKE_FRESHNESS, staleFiles: 0, sourceChanged: false},
	lease: null,
	exclusions: ['node_modules'],
	lastError: null,
};

const siteOf = (index: number): DefinitionSiteSummaryType => ({
	siteId: `site-${index}`,
	path: FAKE_PATH,
	nameStart: index * 10,
	nameEnd: index * 10 + 5,
	extentStart: index * 10,
	extentEnd: index * 10 + 20,
	startLine: index + 1,
	endLine: index + 1,
	declarationKind: 'const',
	forwardDefinition: false,
	primary: true,
	identityAnchor: false,
});

const bindingOf = (index: number): BindingSummaryType => ({
	bindingId: `binding-${index}`,
	name: `fakeSymbol${index}`,
	container: '',
	qualifiedName: `fakeSymbol${index}`,
	exposure: 'published',
	inRequestedContext: true,
});

const bindingDetailOf = (index: number): BindingDetailType => ({
	...bindingOf(index),
	contexts: [{contextName: 'root', exposure: 'published'}],
	contextsTotal: 1,
	contextsTruncated: false,
	sites: [{kind: 'declared', path: FAKE_PATH, start: index * 10, end: index * 10 + 8}],
	sitesTotal: 1,
	sitesTruncated: false,
});

const summaryOf = (index: number): SymbolSummaryType => ({
	id: `symbol-${index}`,
	name: `fakeSymbol${index}`,
	qualifiedName: `fakeSymbol${index}`,
	kind: 'const',
	path: FAKE_PATH,
	startLine: index + 1,
	startColumn: 1,
	endLine: index + 1,
	endColumn: 10,
	enclosingId: null,
	startOffset: index * 10,
	endOffset: index * 10 + 9,
	contexts: ['root'],
});

const symbolItemOf = (index: number): FindSymbolItemType => ({
	...summaryOf(index),
	symbolId: `symbol-${index}`,
	symbolExposure: 'published',
	match: 'exact_name',
	matched: bindingDetailOf(index),
	primary: bindingOf(index),
	otherNames: [],
	namesTotal: 1,
	namesTruncated: false,
	sites: [siteOf(index)],
	sitesTotal: 1,
	sitesTruncated: false,
});

const decodeOffset = (cursor: string | undefined): number => {
	if (cursor === undefined) {
		return 0;
	}

	const digits = /^offset:(?<offset>\d+)$/u.exec(cursor)?.groups?.['offset'];

	if (digits === undefined) {
		throw new CodeIndexError('invalid_cursor', 'Cursor is malformed');
	}

	return Number(digits);
};

type PageInputType = Readonly<{limit: number; cursor?: string | undefined}>;

type PageType<ItemType> = Readonly<{items: readonly ItemType[]; nextCursor: string | null; truncated: boolean}>;

const pageOf = <ItemType>(items: readonly ItemType[], input: PageInputType): PageType<ItemType> => {
	const offset = decodeOffset(input.cursor);
	const page = items.slice(offset, offset + input.limit);
	const nextOffset = offset + page.length;
	const nextCursor = nextOffset < items.length ? `offset:${nextOffset}` : null;

	return {items: page, nextCursor, truncated: nextCursor !== null};
};

const outlineItems = Array.from({length: 3}, (_, index) => ({
	...summaryOf(index),
	path: 'src/primary.ts',
	startLine: index + 101,
	endLine: index + 102,
	site: siteOf(index),
}));
const symbolItems = Array.from({length: FAKE_SYMBOL_COUNT}, (_, index) => symbolItemOf(index));

const dependencyItemsOf = (input: FindDependenciesInputType): readonly DependencyConsumerItemType[] => {
	const compact: readonly DependencyConsumerItemType[] = [
		{path: 'src/consumer-a.ts', depth: 1, directRoot: 'src/root.ts'},
		{path: 'src/consumer-b.ts', depth: 2, directRoot: 'src/root.ts'},
	];

	if (input.detail !== 'evidence') {
		return compact;
	}

	return compact.map((item) => ({
		...item,
		relationship: item.depth === 1 ? 'direct' : 'transitive',
		evidenceCount: 1,
		evidence: {
			targetPath: null,
			rawTarget: input.target,
			targetIdentifier: input.target,
			kind: 'import',
			startLine: 1,
			startColumn: 1,
			endLine: 1,
			endColumn: 20,
			context: 'root',
			bindings: [{kind: 'import', importedName: 'default', exportedName: null, localName: 'fakeDependency', compileTimeOnly: false}],
		},
	}));
};

export type FakeIndexOptionsType = Readonly<{
	/** Error thrown by every index method; used to assert stable protocol error codes. */
	failure?: Error;
}>;

const failureOf = (options: FakeIndexOptionsType): (() => void) => {
	const fail = (): void => {
		if (options.failure !== undefined) {
			throw options.failure;
		}
	};

	return fail;
};

const statusHandlerOf = (options: FakeIndexOptionsType) => {
	const fail = failureOf(options);

	return (): IndexStatusType => {
		fail();
		return FAKE_STATUS;
	};
};

const outlineHandlerOf = (options: FakeIndexOptionsType) => {
	const fail = failureOf(options);

	return (input: OutlineInputType): OutlineResultType => {
		fail();
		return {
			...pageOf(outlineItems, input),
			generationId: FAKE_GENERATION_ID,
			freshness: FAKE_FRESHNESS,
			reexports: [],
			reexportsTotal: 0,
			reexportsTruncated: false,
		};
	};
};

const symbolHandlerOf = (options: FakeIndexOptionsType) => {
	const fail = failureOf(options);

	return (input: FindSymbolInputType): FindSymbolResultType => {
		fail();

		if (input.query === '' && input.container === undefined) {
			throw new CodeIndexError('invalid_argument', 'Empty query requires a container');
		}

		return {
			...pageOf(symbolItems, input),
			generationId: FAKE_GENERATION_ID,
			freshness: FAKE_FRESHNESS,
			exposure: input.exposure ?? 'visible',
			match: input.match ?? 'name',
		};
	};
};

const referenceHandlerOf = (options: FakeIndexOptionsType) => {
	const fail = failureOf(options);

	return (input: FindReferencesInputType): FindReferencesResultType => {
		fail();

		if (input.symbolId === 'missing') {
			throw new CodeIndexError('symbol_not_found', 'Unknown symbol: missing');
		}

		if (input.query === 'MissingThing') {
			return {
				kind: 'none',
				selector: 'query',
				generationId: FAKE_GENERATION_ID,
				freshness: FAKE_FRESHNESS,
				reason: 'no_stored_match',
				fallback: 'text_search',
				message: 'No stored match',
				limitations: [],
			};
		}

		const groups = [
			{path: 'src/consumer-a.ts', count: 2, usage: 0, contexts: ['root'], contextsTruncated: false},
			{path: 'src/consumer-b.ts', count: 1, usage: 0, contexts: ['root'], contextsTruncated: false},
		];

		return {
			...pageOf(groups, input),
			kind: 'files',
			group: 'file',
			selector: input.symbolId === undefined ? 'query' : 'symbolId',
			generationId: FAKE_GENERATION_ID,
			freshness: FAKE_FRESHNESS,
			groupsTotal: groups.length,
			unclassifiedReferences: 0,
			crossFileRefsObserved: true,
			occurrencesTotal: 3,
			definitionsTotal: 1,
		};
	};
};

const dependencyHandlerOf = (options: FakeIndexOptionsType) => {
	const fail = failureOf(options);

	return (input: FindDependenciesInputType): FindDependenciesResultType => {
		fail();

		if (input.root !== undefined && input.transitive !== true) {
			throw new CodeIndexError('invalid_argument', 'root requires transitive: true');
		}

		const items = dependencyItemsOf(input);

		return {
			...pageOf(items, input),
			generationId: FAKE_GENERATION_ID,
			freshness: FAKE_FRESHNESS,
			queryMeaning: input.transitive === true ? 'dependency_impact' : 'direct_usage',
			summary: {totalConsumers: items.length, directConsumers: 1, transitiveConsumers: items.length - 1, roots: [{path: 'src/root.ts', consumerCount: 2}]},
		};
	};
};

const readSymbolHandlerOf = (options: FakeIndexOptionsType) => {
	const fail = failureOf(options);

	return (input: ReadSymbolInputType): ReadSymbolResultType => {
		fail();

		if (input.query === 'ambiguous') {
			return {
				kind: 'ambiguous',
				generationId: FAKE_GENERATION_ID,
				freshness: FAKE_FRESHNESS,
				selector: 'query',
				candidates: [0, 1].map((index) => ({...summaryOf(index), symbolId: `symbol-${index}`, match: 'prefix_name' as const})),
				candidatesTotal: 2,
				candidatesTruncated: false,
			};
		}

		if (input.query === 'missing') {
			return {
				kind: 'none',
				generationId: FAKE_GENERATION_ID,
				freshness: FAKE_FRESHNESS,
				selector: 'query',
				reason: 'no_stored_match',
				fallback: 'text_search',
				message: 'No stored symbol matched this query.',
				limitations: ['Only configured extractor projects are indexed.'],
			};
		}

		if (input.symbolId === 'stale') {
			throw new StaleFileError(FAKE_PATH);
		}

		if (input.symbolId === 'missing') {
			throw new CodeIndexError('symbol_not_found', 'Unknown symbol: missing');
		}

		return {
			kind: 'text',
			generationId: FAKE_GENERATION_ID,
			freshness: FAKE_FRESHNESS,
			symbol: summaryOf(0),
			site: siteOf(0),
			path: FAKE_PATH,
			startLine: 1,
			endLine: 1,
			source: FAKE_SOURCE,
			truncated: false,
			truncatedReason: null,
		};
	};
};

const symbolAtHandlerOf = (options: FakeIndexOptionsType) => {
	const fail = failureOf(options);

	return (input: SymbolAtInputType): SymbolAtResultType => {
		fail();

		return {
			generationId: FAKE_GENERATION_ID,
			freshness: FAKE_FRESHNESS,
			path: input.path,
			line: input.line,
			column: input.column ?? null,
			candidates: [{symbol: summaryOf(0), site: siteOf(0)}],
			ambiguous: false,
			ancestors: [],
			reason: null,
		};
	};
};

/**
 * Builds a controlled index with fixed status, symbol, reference, dependency, and source facts.
 *
 * Protocol tests must not compile a workspace. The fake owns only the query
 * surface the MCP adapter invokes, returns deterministic facts, and can inject
 * one failure to exercise the stable error envelope.
 *
 * @param options - Optional failure injected into every method.
 * @returns An index facade with fixed results.
 */
export const createFakeIndex = (options: FakeIndexOptionsType = {}): McpIndexType => ({
	getStatus: statusHandlerOf(options),
	getOutline: outlineHandlerOf(options),
	findSymbols: symbolHandlerOf(options),
	findReferences: referenceHandlerOf(options),
	findDependencies: dependencyHandlerOf(options),
	readSymbol: readSymbolHandlerOf(options),
	symbolAt: symbolAtHandlerOf(options),
});
