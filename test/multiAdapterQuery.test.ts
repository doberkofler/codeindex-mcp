import {afterEach, describe, expect, it} from 'vitest';
import {type CodeIndexError} from '../src/core/errors/errors.ts';
import {summaryStatusOf} from '../src/core/freshness/indexStatus.ts';
import {createMultiAdapterWorkspace, type MultiAdapterWorkspaceType} from './helpers/multiAdapterWorkspace.ts';

const errorCodeOf = (action: () => unknown): string | null => {
	try {
		action();
		return null;
	} catch (error) {
		return (error as CodeIndexError).code;
	}
};

describe('multi-adapter query addressing', () => {
	let workspace: MultiAdapterWorkspaceType | undefined;

	afterEach(() => {
		workspace?.cleanup();
		workspace = undefined;
	});

	it('searches every configured adapter by default and names the owning adapter', async () => {
		workspace = await createMultiAdapterWorkspace();
		const result = workspace.index.findSymbols({query: 'f', limit: 100});
		const adapters = [...new Set(result.items.map((item) => item.adapter))].sort();

		expect(adapters).toStrictEqual(['oracle', 'typescript']);
		expect(result.items.every((item) => item.path.startsWith('src/') === (item.adapter === 'typescript'))).toBe(true);
	});

	it('narrows deterministically by adapter and invalidates a cursor under another filter', async () => {
		workspace = await createMultiAdapterWorkspace();
		const all = workspace.index.findSymbols({query: 'f', limit: 100});
		const first = workspace.index.findSymbols({query: 'f', adapter: 'oracle', limit: 1});

		expect(first.items.map((item) => item.adapter)).toStrictEqual(['oracle']);
		expect(first.nextCursor).not.toBeNull();
		expect(errorCodeOf(() => workspace?.index.findSymbols({query: 'f', limit: 1, cursor: first.nextCursor ?? undefined}))).toBe('invalid_cursor');

		const rest = workspace.index.findSymbols({query: 'f', adapter: 'oracle', limit: 100, cursor: first.nextCursor ?? undefined});
		const oracleIds = new Set([...first.items, ...rest.items].map((item) => item.symbolId));
		const allOracleIds = new Set(all.items.filter((item) => item.adapter === 'oracle').map((item) => item.symbolId));

		expect([...oracleIds].sort()).toStrictEqual([...allOracleIds].sort());
		expect(rest.items.some((item) => first.items[0]?.symbolId === item.symbolId)).toBe(false);
	});

	it('rejects unknown adapters and contexts instead of returning an empty success', async () => {
		workspace = await createMultiAdapterWorkspace();

		expect(errorCodeOf(() => workspace?.index.findSymbols({query: 'f', adapter: 'missing', limit: 10}))).toBe('unknown_adapter');
		expect(errorCodeOf(() => workspace?.index.findSymbols({query: 'f', context: 'missing', limit: 10}))).toBe('unknown_context');
		expect(errorCodeOf(() => workspace?.index.findDependencies({target: 'lodash', adapter: 'missing', limit: 10}))).toBe('unknown_adapter');
		expect(errorCodeOf(() => workspace?.index.getOutline({path: 'src/index.ts', adapter: 'missing', limit: 10}))).toBe('unknown_adapter');
	});

	it('requires an adapter when a bare context exists under several adapters', async () => {
		workspace = await createMultiAdapterWorkspace();
		const oracle = workspace.index.findSymbols({query: 'f', adapter: 'oracle', context: 'app', limit: 10});
		const typescript = workspace.index.findSymbols({query: 'f', adapter: 'typescript', context: 'server', limit: 10});

		expect(errorCodeOf(() => workspace?.index.findSymbols({query: 'f', context: 'app', limit: 10}))).toBe('ambiguous_context');
		expect(oracle.items.length).toBeGreaterThan(0);
		expect(oracle.items.every((item) => item.adapter === 'oracle')).toBe(true);
		expect(typescript.items.every((item) => item.adapter === 'typescript')).toBe(true);
	});

	it('rejects an adapter and context pair that does not exist', async () => {
		workspace = await createMultiAdapterWorkspace();

		expect(errorCodeOf(() => workspace?.index.findSymbols({query: 'f', adapter: 'oracle', context: 'server', limit: 10}))).toBe('adapter_context_mismatch');
	});

	it('returns adapter provenance on symbol, source, outline, and reference results', async () => {
		workspace = await createMultiAdapterWorkspace();
		const oracle = workspace.index.findSymbols({query: 'HR_API', adapter: 'oracle', limit: 1}).items.at(0);
		const typescript = workspace.index.findSymbols({query: 'formatUser', adapter: 'typescript', limit: 1}).items.at(0);

		if (oracle === undefined || typescript === undefined) {
			throw new Error('Expected symbols from both adapters');
		}

		const source = workspace.index.readSymbol({symbolId: oracle.symbolId, adapter: 'oracle', contextLines: 0});
		const outline = workspace.index.getOutline({path: oracle.path, adapter: 'oracle', limit: 10});
		const position = workspace.index.symbolAt({path: typescript.path, line: typescript.startLine, adapter: 'typescript'});
		const references = workspace.index.findReferences({symbolId: typescript.symbolId, adapter: 'typescript', limit: 20});

		expect(source.kind === 'text' ? source.symbol.adapter : null).toBe('oracle');
		expect(outline.items.every((item) => item.adapter === 'oracle')).toBe(true);
		expect(position.candidates.every((candidate) => candidate.symbol.adapter === 'typescript')).toBe(true);
		expect(references.items.every((item) => item.adapter === 'typescript')).toBe(true);
	});

	it('rejects path and symbol selectors owned by another adapter', async () => {
		workspace = await createMultiAdapterWorkspace();
		const {items} = workspace.index.findSymbols({query: 'HR_API', adapter: 'oracle', limit: 1});
		const oracleSymbol = items.at(0);

		if (oracleSymbol === undefined) {
			throw new Error('Expected an Oracle symbol');
		}

		expect(errorCodeOf(() => workspace?.index.symbolAt({path: 'database/hr_api.pks', line: 1, adapter: 'typescript'}))).toBe('adapter_path_mismatch');
		expect(errorCodeOf(() => workspace?.index.getOutline({path: 'database/hr_api.pks', adapter: 'typescript', limit: 10}))).toBe('adapter_path_mismatch');
		expect(errorCodeOf(() => workspace?.index.readSymbol({symbolId: oracleSymbol.symbolId, adapter: 'typescript', contextLines: 0}))).toBe(
			'adapter_symbol_mismatch',
		);
		expect(errorCodeOf(() => workspace?.index.findReferences({symbolId: oracleSymbol.symbolId, adapter: 'typescript', limit: 10}))).toBe(
			'adapter_symbol_mismatch',
		);
	});

	it('filters dependency consumers by adapter', async () => {
		workspace = await createMultiAdapterWorkspace('dependency-graph');
		const filtered = workspace.index.findDependencies({target: 'lodash', adapter: 'typescript', limit: 50});
		const absent = workspace.index.findDependencies({target: 'lodash', adapter: 'oracle', limit: 50});

		expect(filtered.items.length).toBeGreaterThan(0);
		expect(filtered.items.every((item) => item.adapter === 'typescript')).toBe(true);
		expect(absent.items).toStrictEqual([]);
	});

	it('reports every configured adapter and keeps the singular projection out of a multi-adapter status', async () => {
		workspace = await createMultiAdapterWorkspace();
		const status = workspace.index.getStatus();
		const summary = summaryStatusOf(status);

		expect(status.scope.adapters.map((adapter) => `${adapter.id}:${adapter.coverage}`)).toStrictEqual(['typescript:present', 'oracle:present']);
		expect(status.scope.extractor).toBeUndefined();
		expect(status.exclusions).toContain('cross-language edges are not indexed');
		expect(summary.scope.extractor).toBeUndefined();
		expect(summary.scope.adapters?.map((adapter) => adapter.id)).toStrictEqual(['typescript', 'oracle']);
		expect(summary.scope.contexts).toStrictEqual(['app', 'server']);
	});
});
