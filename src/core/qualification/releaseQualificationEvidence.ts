import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {evaluateMultiAdapterReport} from '../benchmark/multiAdapterEvaluate.ts';
import {MultiAdapterBaselineSchema, MultiAdapterReportSchema} from '../benchmark/multiAdapterTypes.ts';
import {compareProductionBenchmarkReports} from '../benchmark/productionComparison.ts';
import {
	ProductionBenchmarkManifestSchema,
	ProductionBenchmarkReportSchema,
	productionManifestDigest,
	type ProductionBenchmarkReportType,
	type ProductionScenarioType,
} from '../benchmark/productionContract.ts';
import {summarize} from '../benchmark/percentiles.ts';
import {
	ReleaseQualificationEvidenceSchema,
	ReleaseQualificationManifestSchema,
	ReleaseSemanticEvidenceSchema,
	releaseQualificationIdentityDigest,
	type ReleaseQualificationEvidenceType,
	type ReleaseQualificationManifestType,
} from './releaseQualification.ts';

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const CountSchema = z.number().int().nonnegative();

const TypeScriptReportSchema = z.object({
	parser: z.object({id: z.literal('typescript'), version: z.string().min(1)}),
	sampleContractSha256: HashSchema,
	coverage: z.object({sampledSymbols: CountSchema}),
	accuracy: z.object({precision: z.number().min(0).max(1)}),
	persistence: z.object({pages: CountSchema}),
	gate: z.object({ok: z.boolean()}),
});

const OracleReportSchema = z.object({
	parser: z.object({
		id: z.enum(['structural', 'antlr']),
		revision: z.string().min(1),
		compilerVersion: z.string().min(1),
	}),
	contract: z.object({
		id: z.literal('oracle-o1'),
		version: z.string().min(1),
		hash: HashSchema,
	}),
	truth: z.object({
		rows: CountSchema,
		identifiersSha256: HashSchema,
		dependenciesSha256: HashSchema,
	}),
	ambiguity: z.object({
		diagnostics: CountSchema,
		rawCalls: CountSchema,
		rate: z.number().min(0).max(1),
	}),
	gates: z.object({
		declarations: z.object({ok: z.boolean()}),
		references: z.object({ok: z.boolean()}),
		dependencies: z.object({ok: z.boolean()}),
		ambiguity: z.object({ok: z.boolean()}),
		ok: z.boolean(),
	}),
});

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

const readArtifact = (manifestPath: string, artifact: Readonly<{path: string; sha256: string}>): unknown => {
	const absolutePath = path.resolve(path.dirname(manifestPath), artifact.path);
	const bytes = readFileSync(absolutePath);
	const actual = sha256(bytes);

	if (actual !== artifact.sha256) {
		throw new Error(`Qualification artifact hash mismatch: ${path.basename(artifact.path)}`);
	}

	return JSON.parse(bytes.toString('utf8'));
};

const p95 = (values: readonly number[]): number => {
	const value = summarize(values).p95Ms;

	if (value === null) {
		throw new Error('Production qualification scenario has no samples');
	}

	return value;
};

const maximum = (values: readonly number[]): number => Math.max(...values);

const productionScenarioOf = (
	scenario: ProductionScenarioType,
	report: ProductionBenchmarkReportType,
): ReleaseQualificationEvidenceType['production']['scenarios'][number] => {
	const runs = report.runs.filter((run) => run.scenario === scenario);

	if (runs.length === 0) {
		throw new Error(`Production qualification scenario has no runs: ${scenario}`);
	}

	return {
		id: scenario,
		ownerP95Ms: p95(runs.map((run) => run.ownerDurationMs)),
		observerWaitP95Ms: p95(runs.map((run) => run.observerWaitMs)),
		eventToPublicationP95Ms: p95(runs.map((run) => run.eventToPublicationMs)),
		processTreeRssPeakBytes: maximum(runs.map((run) => run.resources.processTreeRssPeakBytes)),
		processTreeRssIdleBytes: maximum(runs.map((run) => run.resources.processTreeRssIdleBytes)),
		databaseBytes: maximum(runs.map((run) => run.storage.databaseBytes)),
		walBytes: maximum(runs.map((run) => run.storage.walBytes)),
		shmBytes: maximum(runs.map((run) => run.storage.shmBytes)),
	};
};

/**
 * Loads and binds specialized qualification outputs to one frozen manifest.
 *
 * Every file is hashed before parsing. The loader understands only the
 * committed report contracts; it never evaluates a manifest-provided command.
 *
 * @param rawManifest - Validated manifest identity and artifact references.
 * @param manifestPath - Manifest path used to resolve relative artifacts.
 * @returns Privacy-safe evidence normalized across specialized report contracts.
 */
export const loadReleaseQualificationEvidence = (rawManifest: ReleaseQualificationManifestType, manifestPath: string): ReleaseQualificationEvidenceType => {
	const manifest = ReleaseQualificationManifestSchema.parse(rawManifest);
	const typescript = TypeScriptReportSchema.parse(readArtifact(manifestPath, manifest.artifacts.typescript));
	const oracle = OracleReportSchema.parse(readArtifact(manifestPath, manifest.artifacts.oracle));
	const semantic = ReleaseSemanticEvidenceSchema.parse(readArtifact(manifestPath, manifest.artifacts.semantic));
	const multiAdapterReport = MultiAdapterReportSchema.parse(readArtifact(manifestPath, manifest.artifacts.multiAdapterReport));
	const multiAdapterBaseline = MultiAdapterBaselineSchema.parse(readArtifact(manifestPath, manifest.artifacts.multiAdapterBaseline));
	const multiAdapterEvaluation = evaluateMultiAdapterReport(multiAdapterReport, multiAdapterBaseline);
	const productionManifest = ProductionBenchmarkManifestSchema.parse(readArtifact(manifestPath, manifest.artifacts.productionManifest));
	const productionControl = ProductionBenchmarkReportSchema.parse(readArtifact(manifestPath, manifest.artifacts.productionControl));
	const productionCandidate = ProductionBenchmarkReportSchema.parse(readArtifact(manifestPath, manifest.artifacts.productionCandidate));
	const productionComparison = compareProductionBenchmarkReports(productionManifest, productionControl, productionCandidate);

	return ReleaseQualificationEvidenceSchema.parse({
		typescript: {
			parser: {
				...typescript.parser,
				sha256: releaseQualificationIdentityDigest(typescript.parser),
			},
			sampleContractSha256: typescript.sampleContractSha256,
			sampledSymbols: typescript.coverage.sampledSymbols,
			precision: typescript.accuracy.precision,
			pages: typescript.persistence.pages,
			gate: typescript.gate,
		},
		oracle: {
			parser: {
				...oracle.parser,
				sha256: releaseQualificationIdentityDigest(oracle.parser),
			},
			contract: {
				id: oracle.contract.id,
				version: oracle.contract.version,
				sha256: oracle.contract.hash,
			},
			truth: {
				rows: oracle.truth.rows,
				identifiersSha256: oracle.truth.identifiersSha256,
				dependenciesSha256: oracle.truth.dependenciesSha256,
			},
			ambiguity: oracle.ambiguity,
			gates: {
				declarations: oracle.gates.declarations.ok,
				references: oracle.gates.references.ok,
				dependencies: oracle.gates.dependencies.ok,
				ambiguity: oracle.gates.ambiguity.ok,
				ok: oracle.gates.ok,
			},
		},
		semantic,
		multiAdapter: {
			status: multiAdapterEvaluation.status,
			warnings: multiAdapterEvaluation.summary.warning,
			isolationFailures: multiAdapterEvaluation.gates.filter((entry) => entry.status === 'failure' && entry.code.startsWith('isolation.')).length,
			freshness: multiAdapterReport.freshness.state,
		},
		production: {
			manifestSha256: productionManifestDigest(productionManifest),
			comparisonStatus: productionComparison.status,
			semanticMismatches: productionComparison.semanticMismatches,
			engine: {
				revision: productionCandidate.engine.revision,
				bundleSha256: productionCandidate.engine.bundleSha256,
			},
			runtime: productionCandidate.runtime,
			workspace: {
				corpusSha256: productionCandidate.corpus.sha256,
				configurationSha256: productionCandidate.corpus.configurationSha256,
			},
			scenarios: productionManifest.scenarioOrder.map((scenario) => productionScenarioOf(scenario, productionCandidate)),
		},
	});
};

/**
 * Loads one strict release qualification manifest from disk.
 *
 * @param manifestPath - JSON manifest path.
 * @returns Validated frozen release identity.
 */
export const loadReleaseQualificationManifest = (manifestPath: string): ReleaseQualificationManifestType => {
	const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const result = ReleaseQualificationManifestSchema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid release qualification manifest ${manifestPath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};
