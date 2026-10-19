import {type ConfigType} from '../config/config.ts';
import {createCodeIndex} from '../generation/codeIndex.ts';
import {createLogger} from '../logging/logger.ts';
import {IndexDatabase} from '../storage/database.ts';
import {outlineQuerySql, referenceQuerySql, symbolSearchQuerySql} from '../storage/databaseSymbolQueries.ts';
import {type BenchmarkCursorSampleType, type BenchmarkCursorScenarioType} from './benchTypes.ts';
import {measure} from './percentiles.ts';
import {readStorage, startResourceSampler} from './resources.ts';

const LOGGER = createLogger({minimumLevel: 'error'});
const DEFAULT_MAX_DEPTH = 10_000;
const DEFAULT_PAGE_LIMIT = 200;

type PageType = Readonly<{items: readonly unknown[]; nextCursor: string | null}>;
type FetcherType = (cursor: string | undefined) => PageType;

const depthsFor = (maxDepth: number): readonly number[] =>
	[...new Set([0, 1000, 10_000].filter((depth) => depth <= maxDepth))].sort((left, right) => left - right);

const planFlags = (plan: readonly string[], indexes: readonly string[]): Readonly<{usesIndex: boolean; usesTempBTree: boolean}> => ({
	usesIndex: plan.some((line) => indexes.some((index) => line.includes(index))),
	usesTempBTree: plan.some((line) => line.includes('USE TEMP B-TREE')),
});

const fetchPage = (fetch: FetcherType, cursor: string | undefined): Readonly<{elapsedMs: number; page: PageType}> => {
	let page: PageType = {items: [], nextCursor: null};
	const elapsedMs = measure(() => {
		page = fetch(cursor);
	});

	return {elapsedMs, page};
};

const pageAtDepth = (
	input: Readonly<{
		fetch: FetcherType;
		targetDepth: number;
		timeoutPages: number;
	}>,
): Readonly<{elapsedMs: number; depth: number; page: PageType}> => {
	let cursor: string | undefined;
	let depth = 0;

	for (let pageIndex = 0; pageIndex < input.timeoutPages; pageIndex += 1) {
		const isTarget = depth >= input.targetDepth;
		const {elapsedMs, page} = fetchPage(input.fetch, cursor);

		if (isTarget || page.nextCursor === null) {
			return {elapsedMs, depth, page};
		}

		cursor = page.nextCursor;
		depth += page.items.length;
	}

	throw new Error(`Deep cursor did not reach depth ${String(input.targetDepth)}`);
};

const symbolPlanParameters = (input: Readonly<{generationId: string; query: string; limit: number; offset: number}>): readonly (string | number)[] => {
	const upper = `${input.query}\uFFFF`;
	const {generationId, query, limit, offset} = input;

	return [
		generationId,
		query,
		generationId,
		query,
		query,
		generationId,
		query,
		upper,
		query,
		query,
		generationId,
		query,
		upper,
		query,
		query,
		query,
		upper,
		limit,
		offset,
	];
};

const outlineSamples = (
	input: Readonly<{
		index: ReturnType<typeof createCodeIndex>;
		database: IndexDatabase;
		generationId: string;
		path: string;
		depths: readonly number[];
		limit: number;
	}>,
): readonly BenchmarkCursorSampleType[] =>
	input.depths.map((depth) => {
		const result = pageAtDepth({
			targetDepth: depth,
			timeoutPages: 2000,
			fetch: (cursor) => input.index.getOutline({path: input.path, limit: input.limit, ...(cursor === undefined ? {} : {cursor})}),
		});
		const plan = input.database.explainQueryPlan(outlineQuerySql(0), [input.generationId, input.path, input.limit + 1, result.depth]);

		return {kind: 'outline' as const, depth: result.depth, limit: input.limit, elapsedMs: result.elapsedMs, plan, ...planFlags(plan, ['symbol_by_path'])};
	});

const symbolSamples = (
	input: Readonly<{
		index: ReturnType<typeof createCodeIndex>;
		database: IndexDatabase;
		generationId: string;
		query: string;
		depths: readonly number[];
		limit: number;
	}>,
): readonly BenchmarkCursorSampleType[] =>
	input.depths.map((depth) => {
		const result = pageAtDepth({
			targetDepth: depth,
			timeoutPages: 2000,
			fetch: (cursor) => input.index.findSymbols({query: input.query, limit: input.limit, ...(cursor === undefined ? {} : {cursor})}),
		});
		const plan = input.database.explainQueryPlan(
			symbolSearchQuerySql(false),
			symbolPlanParameters({generationId: input.generationId, query: input.query, limit: input.limit + 1, offset: result.depth}),
		);

		return {
			kind: 'find_symbol' as const,
			depth: result.depth,
			limit: input.limit,
			elapsedMs: result.elapsedMs,
			plan,
			...planFlags(plan, ['symbol_by_name', 'symbol_by_qualified_name']),
		};
	});

const referenceSamples = (
	input: Readonly<{
		index: ReturnType<typeof createCodeIndex>;
		database: IndexDatabase;
		generationId: string;
		symbolId: string;
		depths: readonly number[];
		limit: number;
	}>,
): readonly BenchmarkCursorSampleType[] =>
	input.depths.map((depth) => {
		const result = pageAtDepth({
			targetDepth: depth,
			timeoutPages: 2000,
			fetch: (cursor) => input.index.findReferences({symbolId: input.symbolId, limit: input.limit, ...(cursor === undefined ? {} : {cursor})}),
		});
		const plan = input.database.explainQueryPlan(referenceQuerySql(false, false), [input.generationId, input.symbolId, input.limit + 1, result.depth]);

		return {
			kind: 'find_references' as const,
			depth: result.depth,
			limit: input.limit,
			elapsedMs: result.elapsedMs,
			plan,
			...planFlags(plan, ['sqlite_autoindex_occurrence', 'occurrence']),
		};
	});

const outlinePathOf = (input: Readonly<{database: IndexDatabase; generationId: string; explicit: string | undefined}>): string => {
	if (input.explicit !== undefined) {
		return input.explicit;
	}

	const files = input.database.listFiles(input.generationId);
	const outline = files.find((file) => file.path.endsWith('outline.ts')) ?? files.at(0);

	if (outline === undefined) {
		throw new Error('Deep cursor benchmark requires at least one indexed file');
	}

	return outline.path;
};

const referenceSymbolOf = (index: ReturnType<typeof createCodeIndex>, outlinePath: string): string | null => {
	const candidates = index.findSymbols({query: 'hubSymbol', limit: 10}).items;
	const sample = candidates.at(0) ?? index.getOutline({path: outlinePath, limit: 1}).items.at(0);
	return sample?.id ?? null;
};

/**
 * Measures deep page latency and captures the production query plan.
 *
 * @param input - Configuration and depth bounds.
 * @returns Cursor latency and plan samples.
 */
export const runCursorScenario = async (
	input: Readonly<{
		config: ConfigType;
		maxDepth?: number | undefined;
		pageLimit?: number | undefined;
		outlinePath?: string | undefined;
		workerEntry?: string | undefined;
	}>,
): Promise<BenchmarkCursorScenarioType> => {
	const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
	const pageLimit = input.pageLimit ?? DEFAULT_PAGE_LIMIT;
	const depths = depthsFor(maxDepth);
	const scenarioStartedAt = performance.now();
	const resources = startResourceSampler();
	const database = IndexDatabase.open(input.config.databasePath, {
		rootDir: input.config.rootDir,
		projectFilePath: input.config.projectFilePath,
		extractorId: input.config.extractorId,
		projectId: input.config.projectId,
	});
	const index = createCodeIndex(input.config, database, LOGGER, {watch: false, ...(input.workerEntry === undefined ? {} : {workerEntry: input.workerEntry})});

	try {
		const {generationId} = await index.ensureReady();
		const outlinePath = outlinePathOf({database, generationId, explicit: input.outlinePath});
		const samples: BenchmarkCursorSampleType[] = [
			...outlineSamples({index, database, generationId, path: outlinePath, depths, limit: pageLimit}),
			...symbolSamples({index, database, generationId, query: 'feature', depths, limit: pageLimit}),
		];
		const symbolId = referenceSymbolOf(index, outlinePath);

		if (symbolId !== null) {
			samples.push(...referenceSamples({index, database, generationId, symbolId, depths, limit: pageLimit}));
		}

		return {
			kind: 'cursor',
			name: 'deep_cursor',
			wallMs: Math.round(performance.now() - scenarioStartedAt),
			maxDepth,
			pageLimit,
			samples,
			resources: resources.stop(),
			storage: readStorage(database, input.config.databasePath),
		};
	} finally {
		await index.close();
	}
};
