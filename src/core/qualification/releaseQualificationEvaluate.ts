import {z} from 'zod';
import {
	ReleaseQualificationEvidenceSchema,
	ReleaseQualificationManifestSchema,
	releaseQualificationInternals,
	releaseQualificationManifestDigest,
	type ReleaseQualificationEvidenceType,
	type ReleaseQualificationGateType,
	type ReleaseQualificationManifestType,
	type ReleaseQualificationReportType,
} from './releaseQualificationContract.ts';

const {digest, equals, gate, queryEvidenceMatches, duplicateRoutingMatches, editEvidenceMatches, isolatedEdits, scenarioWithin} = releaseQualificationInternals;

const typeScriptGates = (manifest: ReleaseQualificationManifestType, evidence: ReleaseQualificationEvidenceType): readonly ReleaseQualificationGateType[] => [
	gate(
		'identity.typescript',
		equals(evidence.typescript.parser, manifest.typescript.parser) &&
			evidence.typescript.parser.sha256 === digest({id: evidence.typescript.parser.id, version: evidence.typescript.parser.version}) &&
			evidence.typescript.sampleContractSha256 === manifest.typescript.sampleContractSha256,
	),
	gate(
		'typescript.reference_gate',
		evidence.typescript.gate.ok &&
			evidence.typescript.sampledSymbols === manifest.typescript.samples &&
			evidence.typescript.precision === manifest.typescript.precision &&
			evidence.typescript.pages > 0,
	),
];

const oracleGates = (manifest: ReleaseQualificationManifestType, evidence: ReleaseQualificationEvidenceType): readonly ReleaseQualificationGateType[] => {
	const maximumRate = evidence.oracle.ambiguity.rawCalls === 0 ? 0 : manifest.oracle.ambiguity.maximumRateNumerator / evidence.oracle.ambiguity.rawCalls;

	return [
		gate(
			'identity.oracle',
			equals(evidence.oracle.parser, manifest.oracle.parser) &&
				evidence.oracle.parser.sha256 ===
					digest({
						id: evidence.oracle.parser.id,
						revision: evidence.oracle.parser.revision,
						compilerVersion: evidence.oracle.parser.compilerVersion,
					}) &&
				equals(evidence.oracle.contract, manifest.oracle.contract) &&
				evidence.oracle.truth.identifiersSha256 === manifest.oracle.truth.identifiersSha256 &&
				evidence.oracle.truth.dependenciesSha256 === manifest.oracle.truth.dependenciesSha256,
		),
		gate(
			'oracle.semantic_gate',
			evidence.oracle.truth.rows > 0 &&
				evidence.oracle.gates.declarations &&
				evidence.oracle.gates.references &&
				evidence.oracle.gates.dependencies &&
				evidence.oracle.gates.ok,
		),
		gate(
			'oracle.ambiguity_budget',
			evidence.oracle.gates.ambiguity &&
				evidence.oracle.ambiguity.diagnostics <= manifest.oracle.ambiguity.maximumCount &&
				evidence.oracle.ambiguity.rate <= maximumRate,
		),
	];
};

const queryGates = (manifest: ReleaseQualificationManifestType, evidence: ReleaseQualificationEvidenceType): readonly ReleaseQualificationGateType[] => [
	gate(
		'identity.semantic',
		equals(evidence.semantic.engine, manifest.engine) &&
			equals(evidence.semantic.runtime, manifest.runtime) &&
			equals(evidence.semantic.workspace, manifest.workspace),
	),
	gate('queries.results', queryEvidenceMatches(manifest, evidence)),
	gate('queries.adapter_routing', duplicateRoutingMatches(manifest, evidence)),
	gate('queries.one_generation', evidence.semantic.freshness.oneGenerationPerQuery),
];

const lifecycleGates = (manifest: ReleaseQualificationManifestType, evidence: ReleaseQualificationEvidenceType): readonly ReleaseQualificationGateType[] => {
	const contentionScenario = evidence.production.scenarios.find((scenario) => scenario.id === 'two_process_contention');
	const {contention} = evidence.semantic;

	return [
		gate('edits.identity', editEvidenceMatches(manifest, evidence)),
		gate('edits.isolation', isolatedEdits(evidence) && evidence.multiAdapter.isolationFailures === 0),
		gate('freshness.current', evidence.multiAdapter.freshness === 'current'),
		gate('freshness.stale_file', evidence.semantic.freshness.staleFileRejected),
		gate('freshness.supersession', evidence.semantic.freshness.supersededAttempts > 0 && evidence.semantic.freshness.publishedAttempts > 0),
		gate(
			'contention.single_owner',
			contention.owners === 1 &&
				contention.publications === 1 &&
				contention.failures === 0 &&
				contention.observerWaitMs > 0 &&
				contentionScenario !== undefined &&
				contentionScenario.observerWaitP95Ms > 0,
		),
		gate('multi_adapter.status', evidence.multiAdapter.status === 'pass'),
		gate('multi_adapter.warnings', evidence.multiAdapter.warnings === 0),
	];
};

const productionGates = (manifest: ReleaseQualificationManifestType, evidence: ReleaseQualificationEvidenceType): readonly ReleaseQualificationGateType[] => [
	gate(
		'identity.production',
		equals(evidence.production.engine, manifest.engine) &&
			equals(evidence.production.runtime, manifest.runtime) &&
			equals(evidence.production.workspace, manifest.workspace),
	),
	gate('production.semantic_gate', evidence.production.comparisonStatus === 'pass' && evidence.production.semanticMismatches === 0),
	gate('latency.owner', scenarioWithin(evidence, 'ownerP95Ms', manifest.thresholds.ownerP95Ms)),
	gate('latency.observer', scenarioWithin(evidence, 'observerWaitP95Ms', manifest.thresholds.observerWaitP95Ms)),
	gate('latency.event_to_publication', scenarioWithin(evidence, 'eventToPublicationP95Ms', manifest.thresholds.eventToPublicationP95Ms)),
	gate('resources.peak_rss', scenarioWithin(evidence, 'processTreeRssPeakBytes', manifest.thresholds.processTreeRssPeakBytes)),
	gate('resources.idle_rss', scenarioWithin(evidence, 'processTreeRssIdleBytes', manifest.thresholds.processTreeRssIdleBytes)),
	gate('storage.database', scenarioWithin(evidence, 'databaseBytes', manifest.thresholds.databaseBytes)),
	gate('storage.wal', scenarioWithin(evidence, 'walBytes', manifest.thresholds.walBytes)),
	gate('storage.shm', scenarioWithin(evidence, 'shmBytes', manifest.thresholds.shmBytes)),
];

const evidenceIsCurrent = (manifest: ReleaseQualificationManifestType, evaluatedAt: string): boolean => {
	const evaluated = Date.parse(evaluatedAt);
	return evaluated >= Date.parse(manifest.declaredAt) && evaluated <= Date.parse(manifest.evidenceExpiresAt);
};

/**
 * Aggregates every frozen semantic and operational gate.
 *
 * @param rawManifest - Frozen release identity and expected cases.
 * @param rawEvidence - Specialized semantic and operational evidence.
 * @param evaluatedAt - Qualification time used only for the evidence-expiry gate.
 * @returns Privacy-safe aggregate report.
 */
export const evaluateReleaseQualification = (
	rawManifest: ReleaseQualificationManifestType,
	rawEvidence: ReleaseQualificationEvidenceType,
	evaluatedAt: string = new Date().toISOString(),
): ReleaseQualificationReportType => {
	const manifest = ReleaseQualificationManifestSchema.parse(rawManifest);
	const evidence = ReleaseQualificationEvidenceSchema.parse(rawEvidence);
	const gates = [
		gate('evidence.current', evidenceIsCurrent(manifest, z.iso.datetime().parse(evaluatedAt))),
		...typeScriptGates(manifest, evidence),
		...oracleGates(manifest, evidence),
		...queryGates(manifest, evidence),
		...lifecycleGates(manifest, evidence),
		...productionGates(manifest, evidence),
	];
	const failure = gates.filter((entry) => entry.status === 'failure').length;
	const manifestSha256 = releaseQualificationManifestDigest(manifest);

	return {
		schemaVersion: 1,
		manifestSha256,
		semanticReportIdentity: digest({manifestSha256, evidence, gates}),
		status: failure === 0 ? 'pass' : 'failure',
		summary: {pass: gates.length - failure, failure},
		gates,
	};
};
