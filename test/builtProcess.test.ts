import {appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {type EnvelopeType, textOf} from './helpers/mcpConnection.ts';
import {type ProcessExitType, TappedStdioTransport} from './helpers/tappedStdioTransport.ts';

const TOOL_NAMES = ['find_dependencies', 'find_references', 'find_symbol', 'index_status', 'outline', 'read_symbol', 'symbol_at'] as const;
const SOURCE_FILES = 4;
const POLL_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 20_000;
const DIST_ENTRY = path.resolve(import.meta.dirname, '..', 'dist', 'mcp.mjs');

type StatusType = Readonly<{
	ready: boolean;
	state: string;
	refresh: string;
	generationId: string | null;
	counts: Readonly<{files: number; symbols: number}>;
	lastError: string | null;
}>;

type StatusEnvelopeType = EnvelopeType & Readonly<{data: StatusType}>;
type SymbolItemType = Readonly<{symbolId: string; name: string; path: string; startLine: number}>;
type SymbolEnvelopeType = EnvelopeType & Readonly<{data: {items: readonly SymbolItemType[]}}>;
type SourceEnvelopeType = EnvelopeType & Readonly<{data: {source: string}}>;

type WorkspaceType = Readonly<{root: string; database: string; cleanup: () => void}>;

type ProcessType = Readonly<{
	client: Client;
	transport: TappedStdioTransport;
	stop: () => Promise<ProcessExitType>;
}>;

type AnchorType = Readonly<{status: StatusType; symbolId: string}>;

const envelopeOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): EnvelopeType => JSON.parse(textOf(result)) as EnvelopeType;

const waitFor = async <T>(label: string, attempt: () => Promise<T | null>, timeoutMs = WAIT_TIMEOUT_MS, startedAt = Date.now()): Promise<T> => {
	try {
		const value = await attempt();

		if (value !== null) {
			return value;
		}
	} catch {
		// Startup and rebuild requests are retried until the deadline.
	}

	if (Date.now() - startedAt >= timeoutMs) {
		throw new Error(`Timed out waiting for ${label}`);
	}

	await delay(POLL_INTERVAL_MS);
	return waitFor(label, attempt, timeoutMs, startedAt);
};

const statusOf = async (client: Client): Promise<StatusType> => {
	const envelope = envelopeOf(await client.callTool({name: 'index_status', arguments: {}}));

	if (!envelope.ok) {
		throw new Error(`index_status failed: ${envelope.error?.code ?? 'unknown'}`);
	}

	return (envelope as StatusEnvelopeType).data;
};

const waitForStatus = async (client: Client, predicate: (status: StatusType) => boolean, label: string): Promise<StatusType> => {
	const status = await waitFor(label, async () => {
		const current = await statusOf(client);

		return predicate(current) ? current : null;
	});

	return status;
};

const waitForFreshGeneration = async (client: Client, previous: string, label: string): Promise<StatusType> => {
	const status = await waitForStatus(
		client,
		(current) => current.ready && current.refresh === 'current' && current.generationId !== null && current.generationId !== previous,
		label,
	);

	expect(status.generationId).not.toBe(previous);
	return status;
};

const callEnvelope = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<EnvelopeType> =>
	envelopeOf(await client.callTool({name, arguments: args}));

const symbolsOf = async (client: Client, query: string): Promise<readonly SymbolItemType[]> => {
	const envelope = await callEnvelope(client, 'find_symbol', {query, limit: 20});

	if (!envelope.ok) {
		throw new Error(`find_symbol failed: ${envelope.error?.code ?? 'unknown'}`);
	}

	return (envelope as SymbolEnvelopeType).data.items;
};

const waitForFileState = async (
	client: Client,
	previous: string,
	expected: Readonly<{label: string; files: number; symbol: string; path: string | null}>,
): Promise<StatusType> => {
	let observed = 'no observation';

	try {
		return await waitFor(expected.label, async () => {
			const status = await statusOf(client);
			const items = await symbolsOf(client, expected.symbol);

			observed = JSON.stringify({ready: status.ready, refresh: status.refresh, files: status.counts.files, paths: items.map((item) => item.path)});

			if (!status.ready || status.refresh !== 'current' || status.generationId === previous || status.counts.files !== expected.files) {
				return null;
			}

			if (expected.path === null) {
				return items.length === 0 ? status : null;
			}

			return items.length === 1 && items[0]?.path === expected.path ? status : null;
		});
	} catch (error) {
		throw new Error(`Timed out waiting for ${expected.label}; last observation ${observed}`, {cause: error});
	}
};

const createWorkspace = (): WorkspaceType => {
	const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'code-index-system-'));
	const root = path.join(temporaryRoot, 'workspace');

	cpSync(path.join(import.meta.dirname, 'fixtures', 'simple-project'), root, {recursive: true});

	return {
		root,
		database: path.join(temporaryRoot, 'index.sqlite'),
		cleanup: () => {
			rmSync(temporaryRoot, {recursive: true, force: true});
		},
	};
};

const processEnvironmentOf = (workspace: WorkspaceType): Record<string, string> => {
	const {PATH, HOME} = process.env;

	return {
		PATH: PATH ?? '',
		HOME: HOME ?? '',
		CODE_INDEX_ROOT: workspace.root,
		CODE_INDEX_PROJECT_FILE: path.join(workspace.root, 'tsconfig.json'),
		CODE_INDEX_DATABASE: workspace.database,
		CODE_INDEX_ANALYTICS: 'false',
		CODE_INDEX_ANALYTICS_PATH: path.join(path.dirname(workspace.database), 'analytics', 'events.jsonl'),
		CODE_INDEX_LOG_LEVEL: 'info',
	};
};

const openProcess = async (workspace: WorkspaceType): Promise<ProcessType> => {
	if (!existsSync(DIST_ENTRY)) {
		throw new Error(`Built MCP entry is missing: ${DIST_ENTRY}. Run pnpm build first.`);
	}

	const transport = new TappedStdioTransport({
		command: process.execPath,
		args: [DIST_ENTRY],
		env: processEnvironmentOf(workspace),
		cwd: workspace.root,
	});
	const client = new Client({name: 'code-index-system-test', version: '0.1.0'});

	await client.connect(transport);

	return {
		client,
		transport,
		stop: async (): Promise<ProcessExitType> => {
			await client.close();
			return transport.exit;
		},
	};
};

const assertTransportOnlyStdout = (stdout: string): void => {
	const lines = stdout.split('\n').filter((line) => line.length > 0);

	expect(lines.length).toBeGreaterThan(0);

	for (const line of lines) {
		const message = JSON.parse(line) as {jsonrpc?: string};

		expect(message.jsonrpc).toBe('2.0');
	}
};

const assertProcessStreams = (transport: TappedStdioTransport, root: string): void => {
	assertTransportOnlyStdout(transport.stdout);
	expect(transport.stderr.trimStart().startsWith('codeindex-mcp ')).toBe(true);
	expect(transport.stderr).toContain('code_index_starting');
	expect(transport.stdout).not.toContain('code_index_starting');
	expect(transport.stdout).not.toContain(root);
};

const assertCleanShutdown = (connection: ProcessType, exit: ProcessExitType, root: string): void => {
	expect(exit).toStrictEqual({code: 0, signal: null});
	expect(connection.transport.stderr).toContain('code_index_stopping');
	assertTransportOnlyStdout(connection.transport.stdout);
	expect(connection.transport.stdout).not.toContain(root);
};

const assertToolSurface = async (client: Client): Promise<void> => {
	const listed = await client.listTools();

	expect(listed.tools.map((tool) => tool.name).sort()).toStrictEqual([...TOOL_NAMES]);
};

const assertToolCalls = async (client: Client): Promise<string> => {
	const outline = await callEnvelope(client, 'outline', {path: 'src/models.ts', limit: 20});
	const symbols = await symbolsOf(client, 'formatUser');
	const symbol = symbols.at(0);

	if (symbol === undefined) {
		throw new Error('Expected formatUser in the published generation');
	}

	const references = await callEnvelope(client, 'find_references', {symbolId: symbol.symbolId});
	const dependencies = await callEnvelope(client, 'find_dependencies', {target: '@app/models'});
	const source = await callEnvelope(client, 'read_symbol', {symbolId: symbol.symbolId, contextLines: 0});
	const position = await callEnvelope(client, 'symbol_at', {path: 'src/models.ts', line: symbol.startLine});

	expect((outline.data as {items: readonly {name: string}[]}).items.map((item) => item.name)).toContain('formatUser');
	expect(symbol).toMatchObject({name: 'formatUser', path: 'src/models.ts'});
	expect(references.ok).toBe(true);
	expect(dependencies.ok).toBe(true);
	expect((source as SourceEnvelopeType).data.source).toContain('export const formatUser');
	expect(position.ok).toBe(true);

	return symbol.symbolId;
};

const assertInitialPublication = async (client: Client): Promise<AnchorType> => {
	const status = await waitForStatus(client, (current) => current.ready && current.refresh === 'current', 'initial publication');

	expect(status).toMatchObject({state: 'published', refresh: 'current', counts: {files: SOURCE_FILES}});
	expect(status.generationId).not.toBeNull();
	await assertToolSurface(client);
	const symbolId = await assertToolCalls(client);

	return {status, symbolId};
};

const assertWatcherRebuild = async (client: Client, workspace: WorkspaceType, initial: AnchorType): Promise<StatusType> => {
	const previous = initial.status.generationId ?? '';
	const models = path.join(workspace.root, 'src', 'models.ts');

	appendFileSync(models, "\nexport const systemEdit = 'edited';\n");
	const stale = await client.callTool({name: 'read_symbol', arguments: {symbolId: initial.symbolId, contextLines: 0}});
	const staleEnvelope = envelopeOf(stale);

	expect(stale.isError).toBe(true);
	expect(staleEnvelope.error?.code).toBe('stale_file');

	const edited = await waitForFreshGeneration(client, previous, 'watcher rebuild after edit');
	const edits = await symbolsOf(client, 'systemEdit');

	expect(edits).toMatchObject([{name: 'systemEdit', path: 'src/models.ts'}]);
	expect(edited.counts.files).toBe(SOURCE_FILES);

	return edited;
};

const assertFileLifecycle = async (client: Client, workspace: WorkspaceType, initial: StatusType): Promise<StatusType> => {
	const added = path.join(workspace.root, 'src', 'system-added.ts');
	const original = path.join(workspace.root, 'src', 'system-original.ts');
	const renamed = path.join(workspace.root, 'src', 'system-renamed.ts');
	let previous = initial.generationId ?? '';

	writeFileSync(added, "export const systemAdded = 'added';\n");
	let current = await waitForFileState(client, previous, {
		label: 'watcher rebuild after add',
		files: SOURCE_FILES + 1,
		symbol: 'systemAdded',
		path: 'src/system-added.ts',
	});

	previous = current.generationId ?? '';
	rmSync(added);
	current = await waitForFileState(client, previous, {label: 'watcher rebuild after delete', files: SOURCE_FILES, symbol: 'systemAdded', path: null});

	previous = current.generationId ?? '';
	writeFileSync(original, "export const systemRenamed = 'renamed';\n");
	current = await waitForFileState(client, previous, {
		label: 'watcher rebuild after rename source add',
		files: SOURCE_FILES + 1,
		symbol: 'systemRenamed',
		path: 'src/system-original.ts',
	});

	previous = current.generationId ?? '';
	renameSync(original, renamed);
	current = await waitForFileState(client, previous, {
		label: 'watcher rebuild after rename',
		files: SOURCE_FILES + 1,
		symbol: 'systemRenamed',
		path: 'src/system-renamed.ts',
	});

	return current;
};

const assertFailedBuildIsolation = async (client: Client, workspace: WorkspaceType, initial: StatusType): Promise<StatusType> => {
	const published = initial.generationId ?? '';
	const target = path.join(workspace.root, 'src', 'models.ts');
	const backup = path.join(workspace.root, 'src', '.system-failure-backup');
	const trigger = path.join(workspace.root, 'src', 'index.ts');

	renameSync(target, backup);
	mkdirSync(target);
	appendFileSync(trigger, '\nexport const failureTrigger = 1;\n');

	const failed = await waitForStatus(client, (current) => current.refresh === 'failed', 'failed build');

	const failedSymbols = await symbolsOf(client, 'formatUser');

	expect(failed).toMatchObject({ready: true, generationId: published});
	expect(failed.lastError).not.toBeNull();
	expect(failedSymbols.length).toBeGreaterThan(0);

	rmSync(target, {recursive: true, force: true});
	renameSync(backup, target);
	appendFileSync(trigger, '\nexport const recoveryTrigger = 1;\n');

	const recovered = await waitForFreshGeneration(client, published, 'failed-build recovery');
	const recoveredSymbols = await symbolsOf(client, 'formatUser');

	expect(recovered.counts.files).toBe(initial.counts.files);
	expect(recoveredSymbols.length).toBeGreaterThan(0);

	return recovered;
};

const assertRestartReuse = async (connection: ProcessType, initial: StatusType): Promise<StatusType> => {
	const status = await waitForStatus(connection.client, (current) => current.ready && current.refresh === 'current', 'restart publication');

	expect(status.generationId).toBe(initial.generationId);
	expect(status.counts).toStrictEqual(initial.counts);
	expect(connection.transport.stderr).toContain('code_index_starting');

	return status;
};

const assertOfflineReconciliation = async (connection: ProcessType, initial: StatusType): Promise<StatusType> => {
	const status = await waitForFreshGeneration(connection.client, initial.generationId ?? '', 'offline change reconciliation');
	const offlineSymbols = await symbolsOf(connection.client, 'systemOffline');

	expect(offlineSymbols).toMatchObject([{path: 'src/system-offline.ts'}]);
	expect(status.counts.files).toBe(initial.counts.files + 1);

	return status;
};

describe('built MCP process', () => {
	let workspace: WorkspaceType | undefined;
	let connection: ProcessType | undefined;

	afterEach(async () => {
		await connection?.stop();
		workspace?.cleanup();
		connection = undefined;
		workspace = undefined;
	});

	it('publishes, serves every tool, refreshes, isolates failures, restarts, and shuts down cleanly', async () => {
		workspace = createWorkspace();
		connection = await openProcess(workspace);

		const initial = await assertInitialPublication(connection.client);

		expect(initial.status.ready).toBe(true);
		assertProcessStreams(connection.transport, workspace.root);

		const edited = await assertWatcherRebuild(connection.client, workspace, initial);
		const lifecycle = await assertFileLifecycle(connection.client, workspace, edited);
		const recovered = await assertFailedBuildIsolation(connection.client, workspace, lifecycle);

		assertCleanShutdown(connection, await connection.stop(), workspace.root);

		connection = await openProcess(workspace);
		const reused = await assertRestartReuse(connection, recovered);

		assertCleanShutdown(connection, await connection.stop(), workspace.root);

		// The server is stopped, so no watcher event can deliver this file. The
		// next startup reconciliation scan must discover it.
		writeFileSync(path.join(workspace.root, 'src', 'system-offline.ts'), "export const systemOffline = 'offline';\n");

		connection = await openProcess(workspace);
		await assertOfflineReconciliation(connection, reused);

		assertCleanShutdown(connection, await connection.stop(), workspace.root);
		connection = undefined;
	});
});
