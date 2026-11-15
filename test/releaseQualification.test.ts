import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
	RELEASE_QUERY_OPERATIONS,
	ReleaseQualificationManifestSchema,
	evaluateReleaseQualification,
	releaseQualificationIdentityDigest,
	releaseQualificationManifestDigest,
	type ReleaseQualificationEvidenceType,
	type ReleaseQualificationManifestType,
} from '../src/core/qualification/releaseQualification.ts';
import {
	releaseEditMutationDigest,
	releaseEditPathDigest,
	releaseQueryInputDigest,
	runReleaseQueryCases,
	runReleaseStaleFileCase,
} from '../src/core/qualification/releaseQualificationCases.ts';
import {loadReleaseQualificationEvidence} from '../src/core/qualification/releaseQualificationEvidence.ts';
import {createMultiAdapterWorkspace} from './helpers/multiAdapterWorkspace.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

const artifact = (artifactPath: string, sha256 = HASH_A): Readonly<{path: string; sha256: string}> => ({path: artifactPath, sha256});

type CountersType = Readonly<{probes: number; scans: number; extractions: number; factWrites: number}>;

const TYPESCRIPT_PARSER = {id: 'typescript', version: '7.1.0-beta'} as const;
const ORACLE_PARSER = {id: 'structural', revision: '3', compilerVersion: 'oracle-static-3'} as const;

const queryInputOf = (operation: (typeof RELEASE_QUERY_OPERATIONS)[number]): unknown => {
	switch (operation) {
		case 'find_symbol': {
			return {query: 'f', limit: 1};
		}
		case 'symbol_at': {
			return {path: 'src/index.ts', line: 1, adapter: 'typescript'};
		}
		case 'find_references': {
			return {query: 'formatUser', adapter: 'typescript', limit: 1};
		}
		case 'find_dependencies': {
			return {target: 'lodash', adapter: 'typescript', limit: 1};
		}
		case 'read_symbol': {
			return {query: 'HR_API', adapter: 'oracle', contextLines: 0};
		}
		default: {
			throw new Error('Unsupported test query operation');
		}
	}
};

const expectedAdaptersOf = (operation: (typeof RELEASE_QUERY_OPERATIONS)[number]): readonly string[] => {
	if (operation === 'find_symbol') {
		return ['oracle', 'typescript'];
	}

	return operation === 'read_symbol' ? ['oracle'] : ['typescript'];
};

const firstEditCase = (manifest: ReleaseQualificationManifestType): ReleaseQualificationManifestType['edits'][number] => {
	const editCase = manifest.edits.at(0);

	if (editCase === undefined) {
		throw new Error('Expected a deterministic edit case');
	}

	return editCase;
};

const manifestOf = (): ReleaseQualificationManifestType =>
	ReleaseQualificationManifestSchema.parse({
		schemaVersion: 1,
		id: 'release-qualification-v1',
		declaredAt: '2026-11-01T00:00:00.000Z',
		evidenceExpiresAt: '2099-12-01T00:00:00.000Z',
		engine: {revision: '1234567', bundleSha256: HASH_A},
		runtime: {nodeVersion: 'v26.6.0', platform: 'darwin', arch: 'arm64'},
		workspace: {corpusSha256: HASH_B, configurationSha256: HASH_C},
		typescript: {
			parser: {...TYPESCRIPT_PARSER, sha256: releaseQualificationIdentityDigest(TYPESCRIPT_PARSER)},
			sampleContractSha256: HASH_D,
			samples: 200,
			precision: 1,
		},
		oracle: {
			parser: {...ORACLE_PARSER, sha256: releaseQualificationIdentityDigest(ORACLE_PARSER)},
			contract: {id: 'oracle-o1', version: '5', sha256: HASH_A},
			truth: {identifiersSha256: HASH_B, dependenciesSha256: HASH_C},
			ambiguity: {maximumCount: 920, maximumRateNumerator: 920},
		},
		queries: RELEASE_QUERY_OPERATIONS.map((operation, index) => ({
			id: `query-${String(index + 1)}`,
			operation,
			input: queryInputOf(operation),
			expectedSha256: index % 2 === 0 ? HASH_A : HASH_B,
			expectedAdapters: expectedAdaptersOf(operation),
			minimumPages: operation === 'find_references' ? 2 : 1,
			duplicateName: operation === 'find_symbol',
		})),
		edits: [
			{id: 'typescript-edit', adapterId: 'typescript', path: 'src/models.ts', append: '\n// release qualification edit\n', symbolQuery: 'formatUser'},
			{id: 'oracle-edit', adapterId: 'oracle', path: 'database/hr_api.pks', append: '\n-- release qualification edit\n', symbolQuery: 'HR_API'},
		],
		thresholds: {
			ownerP95Ms: 10_000,
			observerWaitP95Ms: 10_000,
			eventToPublicationP95Ms: 10_000,
			processTreeRssPeakBytes: 2_000_000_000,
			processTreeRssIdleBytes: 1_000_000_000,
			databaseBytes: 100_000_000,
			walBytes: 10_000_000,
			shmBytes: 10_000_000,
		},
		artifacts: {
			typescript: artifact('typescript.json'),
			oracle: artifact('oracle.json'),
			semantic: artifact('semantic.json'),
			multiAdapterReport: artifact('multi-adapter.json'),
			multiAdapterBaseline: artifact('multi-adapter-baseline.json'),
			productionManifest: artifact('production-manifest.json'),
			productionControl: artifact('production-control.json'),
			productionCandidate: artifact('production-candidate.json'),
		},
	});

const counters = (input: Partial<CountersType> = {}): CountersType => ({
	probes: 0,
	scans: 0,
	extractions: 0,
	factWrites: 0,
	...input,
});

const evidenceOf = (manifest: ReleaseQualificationManifestType): ReleaseQualificationEvidenceType => ({
	typescript: {
		parser: manifest.typescript.parser,
		sampleContractSha256: manifest.typescript.sampleContractSha256,
		sampledSymbols: 200,
		precision: 1,
		pages: 201,
		gate: {ok: true},
	},
	oracle: {
		parser: manifest.oracle.parser,
		contract: manifest.oracle.contract,
		truth: {...manifest.oracle.truth, rows: 10_000},
		ambiguity: {diagnostics: 900, rawCalls: 10_000, rate: 0.09},
		gates: {declarations: true, references: true, dependencies: true, ambiguity: true, ok: true},
	},
	semantic: {
		schemaVersion: 1,
		engine: manifest.engine,
		runtime: manifest.runtime,
		workspace: manifest.workspace,
		queries: manifest.queries.map((query) => ({
			id: query.id,
			operation: query.operation,
			inputSha256: releaseQueryInputDigest(query),
			sha256: query.expectedSha256,
			adapters: query.expectedAdapters,
			pages: query.minimumPages,
			generationIdSha256: HASH_C,
		})),
		edits: manifest.edits.map((edit) => ({
			id: edit.id,
			adapterId: edit.adapterId,
			pathSha256: releaseEditPathDigest(edit),
			mutationSha256: releaseEditMutationDigest(edit),
			target: counters({probes: 1, scans: 1, extractions: 1, factWrites: 10}),
			nonTarget: counters(),
		})),
		freshness: {
			staleFileRejected: true,
			supersededAttempts: 1,
			publishedAttempts: 1,
			oneGenerationPerQuery: true,
		},
		contention: {processes: 2, owners: 1, publications: 1, failures: 0, observerWaitMs: 50},
	},
	multiAdapter: {
		status: 'pass',
		warnings: 0,
		isolationFailures: 0,
		freshness: 'current',
	},
	production: {
		manifestSha256: HASH_D,
		comparisonStatus: 'pass',
		semanticMismatches: 0,
		engine: manifest.engine,
		runtime: manifest.runtime,
		workspace: manifest.workspace,
		scenarios: [
			{
				id: 'cold_full_build',
				ownerP95Ms: 1000,
				observerWaitP95Ms: 0,
				eventToPublicationP95Ms: 1000,
				processTreeRssPeakBytes: 500_000_000,
				processTreeRssIdleBytes: 250_000_000,
				databaseBytes: 1_000_000,
				walBytes: 100_000,
				shmBytes: 32_768,
			},
			{
				id: 'two_process_contention',
				ownerP95Ms: 1000,
				observerWaitP95Ms: 50,
				eventToPublicationP95Ms: 1000,
				processTreeRssPeakBytes: 500_000_000,
				processTreeRssIdleBytes: 250_000_000,
				databaseBytes: 1_000_000,
				walBytes: 100_000,
				shmBytes: 32_768,
			},
		],
	},
});

describe('release qualification manifest', () => {
	it('validates the complete frozen identity and hashes key order canonically', () => {
		const manifest = manifestOf();
		const reordered = {...manifest, engine: {bundleSha256: manifest.engine.bundleSha256, revision: manifest.engine.revision}};

		expect(releaseQualificationManifestDigest(manifest)).toBe(releaseQualificationManifestDigest(ReleaseQualificationManifestSchema.parse(reordered)));
	});

	it('rejects an artifact before parsing when its pinned hash drifts', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'codeindex-release-qualification-'));
		const manifest = manifestOf();
		const manifestPath = path.join(directory, 'manifest.json');

		try {
			writeFileSync(path.join(directory, manifest.artifacts.typescript.path), '{}', {encoding: 'utf8'});

			expect(() => loadReleaseQualificationEvidence(manifest, manifestPath)).toThrow('artifact hash mismatch');
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('executes typed query cases through pagination on one generation', async () => {
		const workspace = await createMultiAdapterWorkspace();
		const manifest = manifestOf();

		try {
			const results = runReleaseQueryCases(workspace.index, manifest.queries);
			const paginated = results.find((result) => result.operation === 'find_symbol');
			const editCase = firstEditCase(manifest);

			expect(results.map((result) => result.operation)).toStrictEqual(RELEASE_QUERY_OPERATIONS);
			expect(results.every((result) => result.generationIdSha256.length === 64)).toBe(true);
			expect(paginated?.pages).toBeGreaterThanOrEqual(2);
			expect(paginated?.adapters).toStrictEqual(['oracle', 'typescript']);
			expect(
				runReleaseStaleFileCase({
					index: workspace.index,
					rootDir: workspace.root,
					workspace: 'disposable_copy',
					editCase,
				}),
			).toBe(true);
		} finally {
			workspace.cleanup();
		}
	});

	it('rejects missing query coverage, duplicate IDs, and unknown command fields', () => {
		const manifest = manifestOf();
		const duplicateQueries = manifest.queries.map((query, index) => (index === 1 ? {...query, id: manifest.queries[0]?.id} : query));

		expect(() => ReleaseQualificationManifestSchema.parse({...manifest, queries: manifest.queries.slice(1)})).toThrow('query operation');
		expect(() => ReleaseQualificationManifestSchema.parse({...manifest, queries: duplicateQueries})).toThrow('unique');
		expect(() => ReleaseQualificationManifestSchema.parse({...manifest, command: 'pnpm verify'})).toThrow('Unrecognized key');
	});
});

describe('release qualification aggregate', () => {
	it('passes only when every semantic and operational gate passes', () => {
		const manifest = manifestOf();
		const report = evaluateReleaseQualification(manifest, evidenceOf(manifest));

		expect(report.status).toBe('pass');
		expect(report.summary).toStrictEqual({pass: report.gates.length, failure: 0});
		expect(report.gates.every((gate) => gate.status === 'pass')).toBe(true);
	});

	it('fails cross-adapter leakage, stale-file omission, contention, warnings, and resource overruns independently', () => {
		const manifest = manifestOf();
		const evidence = evidenceOf(manifest);
		const report = evaluateReleaseQualification(manifest, {
			...evidence,
			semantic: {
				...evidence.semantic,
				edits: evidence.semantic.edits.map((edit, index) => (index === 0 ? {...edit, nonTarget: counters({extractions: 1, factWrites: 1})} : edit)),
				freshness: {...evidence.semantic.freshness, staleFileRejected: false},
				contention: {...evidence.semantic.contention, owners: 2},
			},
			multiAdapter: {...evidence.multiAdapter, status: 'warning', warnings: 1},
			production: {
				...evidence.production,
				scenarios: evidence.production.scenarios.map((scenario, index) =>
					index === 0 ? {...scenario, processTreeRssPeakBytes: manifest.thresholds.processTreeRssPeakBytes + 1} : scenario,
				),
			},
		});

		expect(report.status).toBe('failure');
		expect(report.gates.find((gate) => gate.id === 'edits.isolation')?.status).toBe('failure');
		expect(report.gates.find((gate) => gate.id === 'freshness.stale_file')?.status).toBe('failure');
		expect(report.gates.find((gate) => gate.id === 'contention.single_owner')?.status).toBe('failure');
		expect(report.gates.find((gate) => gate.id === 'multi_adapter.warnings')?.status).toBe('failure');
		expect(report.gates.find((gate) => gate.id === 'resources.peak_rss')?.status).toBe('failure');
	});

	it('fails identity drift and produces a different semantic report identity', () => {
		const manifest = manifestOf();
		const passing = evaluateReleaseQualification(manifest, evidenceOf(manifest));
		const repeated = evaluateReleaseQualification(manifest, evidenceOf(manifest));
		const evidence = evidenceOf(manifest);
		const drifted = evaluateReleaseQualification(manifest, {
			...evidence,
			semantic: {...evidence.semantic, workspace: {...evidence.semantic.workspace, corpusSha256: HASH_D}},
		});

		expect(drifted.status).toBe('failure');
		expect(drifted.gates.find((gate) => gate.id === 'identity.semantic')?.status).toBe('failure');
		expect(drifted.semanticReportIdentity).not.toBe(passing.semanticReportIdentity);
		expect(repeated.semanticReportIdentity).toBe(passing.semanticReportIdentity);
	});

	it('fails query result, routing, and pagination drift', () => {
		const manifest = manifestOf();
		const evidence = evidenceOf(manifest);
		const queries = evidence.semantic.queries.map((query, index) => (index === 0 ? {...query, sha256: HASH_D, adapters: ['typescript'], pages: 1} : query));
		const paginatedIndex = manifest.queries.findIndex((query) => query.minimumPages > 1);
		const driftedQueries = queries.map((query, index) => (index === paginatedIndex ? {...query, pages: 1} : query));
		const report = evaluateReleaseQualification(manifest, {
			...evidence,
			semantic: {...evidence.semantic, queries: driftedQueries},
		});

		expect(report.status).toBe('failure');
		expect(report.gates.find((gate) => gate.id === 'queries.results')?.status).toBe('failure');
		expect(report.gates.find((gate) => gate.id === 'queries.adapter_routing')?.status).toBe('failure');
	});

	it('fails closed when the frozen evidence is stale', () => {
		const manifest = manifestOf();
		const report = evaluateReleaseQualification(manifest, evidenceOf(manifest), '2100-01-01T00:00:00.000Z');

		expect(report.status).toBe('failure');
		expect(report.gates.find((gate) => gate.id === 'evidence.current')?.status).toBe('failure');
	});
});
