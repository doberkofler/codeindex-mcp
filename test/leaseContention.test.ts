import {cpSync, existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {type EnvelopeType, textOf} from './helpers/mcpConnection.ts';
import {type ProcessExitType, TappedStdioTransport} from './helpers/tappedStdioTransport.ts';

const DIST_ENTRY = path.resolve(import.meta.dirname, '..', 'dist', 'mcp.mjs');
const POLL_INTERVAL_MS = 20;
const WAIT_TIMEOUT_MS = 30_000;
const HEARTBEAT_WINDOW_MS = 3500;
const EXTENDED_LEASE_MS = 60_000;
const FIXTURE_FILE_COUNT = 1200;
const SOURCE_FILES = 4;
const CONTENTION_SYMBOL = 'leaseContention1199';

type LeaseType = Readonly<{
	ownerId: string;
	processId: number;
	acquiredAt: string;
	heartbeatAt: string;
	expiresAt: string;
}>;

type StatusType = Readonly<{
	ready: boolean;
	state: string;
	refresh: string;
	generationId: string | null;
	revision: number | null;
	counts: Readonly<{files: number; symbols: number}>;
	lease: LeaseType | null;
}>;

type StatusEnvelopeType = EnvelopeType & Readonly<{data: StatusType}>;
type SymbolItemType = Readonly<{symbolId: string; name: string; path: string}>;
type SymbolEnvelopeType = EnvelopeType & Readonly<{data: {items: readonly SymbolItemType[]}}>;

type WorkspaceType = Readonly<{root: string; database: string; cleanup: () => void}>;

type ProcessType = Readonly<{
	client: Client;
	transport: TappedStdioTransport;
	stop: () => Promise<ProcessExitType>;
}>;

type GenerationStateType = Readonly<{id: string; state: string}>;

type LiveBuildType = Readonly<{owner: ProcessType; pid: number; lease: LeaseType}>;

const envelopeOf = (result: Readonly<{content: readonly {type: string; text?: string}[]}>): EnvelopeType => JSON.parse(textOf(result)) as EnvelopeType;

const waitFor = async <T>(label: string, attempt: () => Promise<T | null> | T | null, startedAt = Date.now()): Promise<T> => {
	const value = await attempt();

	if (value !== null) {
		return value;
	}

	if (Date.now() - startedAt >= WAIT_TIMEOUT_MS) {
		throw new Error(`Timed out waiting for ${label}`);
	}

	await delay(POLL_INTERVAL_MS);
	return waitFor(label, attempt, startedAt);
};

const createWorkspace = (): WorkspaceType => {
	const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'code-index-lease-'));
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
	const client = new Client({name: 'code-index-lease-test', version: '0.1.0'});

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

const statusOf = async (client: Client): Promise<StatusType> => {
	const envelope = envelopeOf(await client.callTool({name: 'index_status', arguments: {detail: 'full'}}));

	if (!envelope.ok) {
		throw new Error(`index_status failed: ${envelope.error?.code ?? 'unknown'}`);
	}

	return (envelope as StatusEnvelopeType).data;
};

const waitForStatus = async (client: Client, predicate: (status: StatusType) => boolean, label: string): Promise<StatusType> => {
	const status = await waitFor(label, async () => {
		try {
			const current = await statusOf(client);

			return predicate(current) ? current : null;
		} catch {
			return null;
		}
	});

	return status;
};

const symbolsOf = async (client: Client, query: string): Promise<readonly SymbolItemType[]> => {
	const envelope = envelopeOf(await client.callTool({name: 'find_symbol', arguments: {query, limit: 20}}));

	if (!envelope.ok) {
		throw new Error(`find_symbol failed: ${envelope.error?.code ?? 'unknown'}`);
	}

	return (envelope as SymbolEnvelopeType).data.items;
};

const inspectorOf = (workspace: WorkspaceType): DatabaseSync => {
	const database = new DatabaseSync(workspace.database);

	database.exec('pragma busy_timeout = 5000');
	return database;
};

const leaseRows = (inspector: DatabaseSync): readonly LeaseType[] =>
	inspector
		.prepare('select owner_id, process_id, acquired_at, heartbeat_at, expires_at from build_lease')
		.all()
		.map((row) => ({
			ownerId: String(row['owner_id']),
			processId: Number(row['process_id']),
			acquiredAt: String(row['acquired_at']),
			heartbeatAt: String(row['heartbeat_at']),
			expiresAt: String(row['expires_at']),
		}));

const generationRows = (inspector: DatabaseSync): readonly GenerationStateType[] =>
	inspector
		.prepare('select id, state from generation order by started_at')
		.all()
		.map((row) => ({id: String(row['id']), state: String(row['state'])}));

const publishedRows = (inspector: DatabaseSync): readonly GenerationStateType[] => generationRows(inspector).filter((row) => row.state === 'published');

const generationCountOf = (inspector: DatabaseSync, table: string, generationId: string): number => {
	const row = inspector.prepare(`select count(*) as total from ${table} where generation_id = ?`).get(generationId);

	return row === undefined ? 0 : Number(row['total']);
};

const assertPublishedGenerationConsistent = (inspector: DatabaseSync, generationId: string): void => {
	const row = inspector
		.prepare(
			'select file_count, symbol_count, occurrence_count, dependency_edge_count, dependency_binding_count, diagnostic_count from generation where id = ?',
		)
		.get(generationId);

	if (row === undefined) {
		throw new Error(`Missing generation ${generationId}`);
	}

	expect({
		files: generationCountOf(inspector, 'file', generationId),
		symbols: generationCountOf(inspector, 'symbol', generationId),
		occurrences: generationCountOf(inspector, 'occurrence', generationId),
		dependencyEdges: generationCountOf(inspector, 'dependency_edge', generationId),
		dependencyBindings: generationCountOf(inspector, 'dependency_binding', generationId),
		diagnostics: generationCountOf(inspector, 'diagnostic', generationId),
	}).toStrictEqual({
		files: row['file_count'],
		symbols: row['symbol_count'],
		occurrences: row['occurrence_count'],
		dependencyEdges: row['dependency_edge_count'],
		dependencyBindings: row['dependency_binding_count'],
		diagnostics: row['diagnostic_count'],
	});
};

const assertIntegrity = (inspector: DatabaseSync): void => {
	const rows = inspector.prepare('pragma integrity_check').all();

	expect(rows.map((row) => String(row['integrity_check']))).toStrictEqual(['ok']);
};

const writeContentionSources = (workspace: WorkspaceType): void => {
	for (let index = 0; index < FIXTURE_FILE_COUNT; index += 1) {
		const name = `leaseContention${String(index)}`;
		const source = `export interface ${name} { value: string }\nexport const ${name} = (value: string): string => value;\nexport type ${name}Type = ${name};\n`;

		writeFileSync(path.join(workspace.root, 'src', `lease-contention-${String(index)}.ts`), source);
	}
};

const seedPublication = async (workspace: WorkspaceType): Promise<Readonly<{generationId: string; revision: number; symbolId: string}>> => {
	const process = await openProcess(workspace);

	try {
		const status = await waitForStatus(process.client, (current) => current.ready && current.refresh === 'current', 'seed publication');
		const symbols = await symbolsOf(process.client, 'formatUser');
		const symbol = symbols.at(0);

		if (status.generationId === null || status.revision === null || symbol === undefined) {
			throw new Error('Seed publication did not expose the anchor generation and symbol');
		}

		return {generationId: status.generationId, revision: status.revision, symbolId: symbol.symbolId};
	} finally {
		await process.stop();
	}
};

const startFrozenOwner = async (workspace: WorkspaceType, inspector: DatabaseSync): Promise<LiveBuildType> => {
	const owner = await openProcess(workspace);
	const {pid} = owner.transport;

	try {
		if (pid === null) {
			throw new Error('Owner process did not start');
		}

		const lease = await waitFor('owner build', () => {
			const leases = leaseRows(inspector);
			const current = leases.at(0);

			if (leases.length !== 1 || current === undefined || current.processId !== pid) {
				return null;
			}

			return current;
		});

		// Revisions are applied in one transaction, so there is no partial
		// generation to observe. Freeze the owner while it is still extracting.
		await delay(300);

		if (!owner.transport.signal('SIGSTOP')) {
			throw new Error('Could not stop the owner process');
		}

		return {owner, pid, lease};
	} catch (error) {
		owner.transport.signal('SIGKILL');
		await owner.stop();
		throw error;
	}
};

const assertReaderServesPublishedGeneration = async (
	reader: ProcessType,
	inspector: DatabaseSync,
	live: LiveBuildType,
	generationId: string,
): Promise<void> => {
	const status = await waitForStatus(
		reader.client,
		(current) => current.refresh === 'building' && current.lease?.ownerId === live.lease.ownerId,
		'reader waiting on the owner lease',
	);
	const anchorSymbols = await symbolsOf(reader.client, 'formatUser');
	const unpublishedSymbols = await symbolsOf(reader.client, CONTENTION_SYMBOL);

	expect(status).toMatchObject({ready: true, generationId, counts: {files: SOURCE_FILES}});
	expect(status.lease).toMatchObject({ownerId: live.lease.ownerId, processId: live.pid});
	expect(anchorSymbols.map((item) => item.name)).toContain('formatUser');
	expect(unpublishedSymbols).toStrictEqual([]);
	expect(leaseRows(inspector)).toHaveLength(1);
};

const killOwnerAndAssertNoPublication = async (live: LiveBuildType, inspector: DatabaseSync, generationId: string): Promise<LeaseType> => {
	expect(live.owner.transport.signal('SIGKILL')).toBe(true);
	await live.owner.transport.exit;

	const leases = leaseRows(inspector);
	const deadLease = leases.at(0);

	expect(leases).toHaveLength(1);

	if (deadLease === undefined) {
		throw new Error('Dead owner lease disappeared');
	}

	expect(publishedRows(inspector)).toStrictEqual([{id: generationId, state: 'published'}]);
	expect(generationRows(inspector)).toStrictEqual([{id: generationId, state: 'published'}]);
	assertIntegrity(inspector);
	assertPublishedGenerationConsistent(inspector, generationId);

	return deadLease;
};

const assertStaleLeaseIsNotRenewed = async (inspector: DatabaseSync, deadLease: LeaseType): Promise<void> => {
	// Hold the dead lease open while proving its heartbeat does not advance.
	// The next step expires it to trigger takeover.
	inspector.prepare('update build_lease set expires_at = ? where owner_id = ?').run(new Date(Date.now() + EXTENDED_LEASE_MS).toISOString(), deadLease.ownerId);
	await delay(HEARTBEAT_WINDOW_MS);
	const staleLease = leaseRows(inspector).at(0);

	if (staleLease === undefined) {
		throw new Error('Stale owner lease disappeared');
	}

	expect(staleLease).toMatchObject({
		ownerId: deadLease.ownerId,
		acquiredAt: deadLease.acquiredAt,
		heartbeatAt: deadLease.heartbeatAt,
	});
	expect(Date.parse(staleLease.expiresAt)).toBeGreaterThan(Date.now());
};

const expireLease = (inspector: DatabaseSync, ownerId: string): void => {
	inspector.prepare('update build_lease set expires_at = ? where owner_id = ?').run(new Date(Date.now() - 1).toISOString(), ownerId);
};

const assertTakeoverPublication = async (
	reader: ProcessType,
	inspector: DatabaseSync,
	previousRevision: number,
	previousGenerationId: string,
): Promise<void> => {
	const takeover = await waitForStatus(
		reader.client,
		(status) =>
			status.ready &&
			status.refresh === 'current' &&
			status.generationId !== null &&
			status.revision !== null &&
			status.revision > previousRevision &&
			status.counts.files === SOURCE_FILES + FIXTURE_FILE_COUNT,
		'waiting reader takeover publication',
	);
	const takeoverSymbols = await symbolsOf(reader.client, CONTENTION_SYMBOL);
	const retainedSymbols = await symbolsOf(reader.client, 'formatUser');
	const takeoverGeneration = takeover.generationId ?? '';

	// Publication revises the stable generation identifier instead of replacing it.
	expect(takeoverGeneration).toBe(previousGenerationId);
	expect([...new Set(takeoverSymbols.map((item) => item.path))]).toStrictEqual(['src/lease-contention-1199.ts']);
	expect(retainedSymbols.map((item) => item.name)).toContain('formatUser');
	expect(publishedRows(inspector)).toStrictEqual([{id: takeoverGeneration, state: 'published'}]);
	expect(generationRows(inspector)).toStrictEqual([{id: takeoverGeneration, state: 'published'}]);
	expect(leaseRows(inspector)).toStrictEqual([]);
	assertIntegrity(inspector);
	assertPublishedGenerationConsistent(inspector, takeoverGeneration);
};

describe('build lease contention', () => {
	let workspace: WorkspaceType | undefined;
	let inspector: DatabaseSync | undefined;
	let owner: ProcessType | undefined;
	let reader: ProcessType | undefined;

	afterEach(async () => {
		owner?.transport.signal('SIGKILL');
		await owner?.stop();
		await reader?.stop();
		inspector?.close();
		workspace?.cleanup();
		owner = undefined;
		reader = undefined;
		inspector = undefined;
		workspace = undefined;
	});

	it('keeps one owner, serves readers, and takes over an expired dead lease without a half publication', async () => {
		workspace = createWorkspace();
		const seed = await seedPublication(workspace);
		writeContentionSources(workspace);

		const database = inspectorOf(workspace);
		inspector = database;

		const live = await startFrozenOwner(workspace, database);
		({owner} = live);

		expect(publishedRows(database)).toStrictEqual([{id: seed.generationId, state: 'published'}]);
		expect(generationRows(database)).toStrictEqual([{id: seed.generationId, state: 'published'}]);

		reader = await openProcess(workspace);
		await assertReaderServesPublishedGeneration(reader, database, live, seed.generationId);

		const deadLease = await killOwnerAndAssertNoPublication(live, database, seed.generationId);
		owner = undefined;

		await assertStaleLeaseIsNotRenewed(database, deadLease);
		expireLease(database, deadLease.ownerId);
		await assertTakeoverPublication(reader, database, seed.revision, seed.generationId);
	});
});
