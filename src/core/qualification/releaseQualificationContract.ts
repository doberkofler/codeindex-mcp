import {createHash} from 'node:crypto';
import {z} from 'zod';
import {
	RELEASE_QUERY_OPERATIONS as QUERY_OPERATIONS,
	ReleaseEditCaseSchema,
	ReleaseQueryCaseSchema,
	releaseEditMutationDigest,
	releaseEditPathDigest,
	releaseQueryInputDigest,
} from './releaseQualificationCases.ts';

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const REVISION_PATTERN = /^[0-9a-f]{7,64}$/u;

const HashSchema = z.string().regex(HASH_PATTERN);
const IdentifierSchema = z.string().min(1).max(128).regex(ID_PATTERN);
const CountSchema = z.number().int().nonnegative();
const DurationSchema = z.number().nonnegative();

const ReleaseQueryOperationSchema = z.enum(QUERY_OPERATIONS);

export {RELEASE_QUERY_OPERATIONS} from './releaseQualificationCases.ts';

const EngineIdentitySchema = z
	.object({
		revision: z.string().regex(REVISION_PATTERN),
		bundleSha256: HashSchema,
	})
	.strict();

const RuntimeIdentitySchema = z
	.object({
		nodeVersion: z.string().min(1).max(64),
		platform: IdentifierSchema,
		arch: IdentifierSchema,
	})
	.strict();

const WorkspaceIdentitySchema = z
	.object({
		corpusSha256: HashSchema,
		configurationSha256: HashSchema,
	})
	.strict();

const ParserIdentitySchema = z
	.object({
		id: IdentifierSchema,
		version: z.string().min(1).max(128),
		sha256: HashSchema,
	})
	.strict();

const OracleParserIdentitySchema = z
	.object({
		id: IdentifierSchema,
		revision: z.string().min(1).max(128),
		compilerVersion: z.string().min(1).max(128),
		sha256: HashSchema,
	})
	.strict();

const OracleContractIdentitySchema = z
	.object({
		id: z.literal('oracle-o1'),
		version: z.string().min(1).max(32),
		sha256: HashSchema,
	})
	.strict();

const OracleTruthIdentitySchema = z
	.object({
		identifiersSha256: HashSchema,
		dependenciesSha256: HashSchema,
	})
	.strict();

const ArtifactSchema = z
	.object({
		path: z.string().min(1).max(4096),
		sha256: HashSchema,
	})
	.strict();

const ThresholdsSchema = z
	.object({
		ownerP95Ms: DurationSchema,
		observerWaitP95Ms: DurationSchema,
		eventToPublicationP95Ms: DurationSchema,
		processTreeRssPeakBytes: CountSchema,
		processTreeRssIdleBytes: CountSchema,
		databaseBytes: CountSchema,
		walBytes: CountSchema,
		shmBytes: CountSchema,
	})
	.strict();

/**
 * Frozen multi-adapter release identity.
 *
 * Paths may name consumer-owned evidence, but no field can contain an
 * executable command. Every artifact is bound by SHA-256 before evaluation.
 */
export const ReleaseQualificationManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: IdentifierSchema,
		declaredAt: z.iso.datetime(),
		evidenceExpiresAt: z.iso.datetime(),
		engine: EngineIdentitySchema,
		runtime: RuntimeIdentitySchema,
		workspace: WorkspaceIdentitySchema,
		typescript: z
			.object({
				parser: ParserIdentitySchema,
				sampleContractSha256: HashSchema,
				samples: z.literal(200),
				precision: z.literal(1),
			})
			.strict(),
		oracle: z
			.object({
				parser: OracleParserIdentitySchema,
				contract: OracleContractIdentitySchema,
				truth: OracleTruthIdentitySchema,
				ambiguity: z
					.object({
						maximumCount: CountSchema,
						maximumRateNumerator: CountSchema,
					})
					.strict(),
			})
			.strict(),
		queries: z.array(ReleaseQueryCaseSchema).min(QUERY_OPERATIONS.length),
		edits: z.array(ReleaseEditCaseSchema).min(2),
		thresholds: ThresholdsSchema,
		artifacts: z
			.object({
				typescript: ArtifactSchema,
				oracle: ArtifactSchema,
				semantic: ArtifactSchema,
				multiAdapterReport: ArtifactSchema,
				multiAdapterBaseline: ArtifactSchema,
				productionManifest: ArtifactSchema,
				productionControl: ArtifactSchema,
				productionCandidate: ArtifactSchema,
			})
			.strict(),
	})
	.strict()
	.superRefine((manifest, context) => {
		const queryIds = manifest.queries.map((query) => query.id);
		const editIds = manifest.edits.map((edit) => edit.id);

		if (Date.parse(manifest.evidenceExpiresAt) <= Date.parse(manifest.declaredAt)) {
			context.addIssue({code: 'custom', path: ['evidenceExpiresAt'], message: 'evidence expiry must be later than declaration'});
		}

		if (new Set(queryIds).size !== queryIds.length) {
			context.addIssue({code: 'custom', path: ['queries'], message: 'query case IDs must be unique'});
		}

		if (new Set(editIds).size !== editIds.length) {
			context.addIssue({code: 'custom', path: ['edits'], message: 'edit case IDs must be unique'});
		}

		for (const operation of QUERY_OPERATIONS) {
			if (!manifest.queries.some((query) => query.operation === operation)) {
				context.addIssue({
					code: 'custom',
					path: ['queries'],
					message: `missing required query operation ${operation}`,
				});
			}
		}

		if (!manifest.queries.some((query) => query.duplicateName)) {
			context.addIssue({code: 'custom', path: ['queries'], message: 'at least one cross-adapter duplicate-name case is required'});
		}

		for (const adapterId of ['typescript', 'oracle'] as const) {
			if (!manifest.queries.some((query) => query.expectedAdapters.length === 1 && query.expectedAdapters[0] === adapterId)) {
				context.addIssue({code: 'custom', path: ['queries'], message: `an adapter-scoped ${adapterId} query case is required`});
			}
		}

		if (!manifest.queries.some((query) => query.minimumPages >= 2)) {
			context.addIssue({code: 'custom', path: ['queries'], message: 'at least one paginated query case is required'});
		}

		for (const adapterId of ['typescript', 'oracle'] as const) {
			if (!manifest.edits.some((edit) => edit.adapterId === adapterId)) {
				context.addIssue({code: 'custom', path: ['edits'], message: `a deterministic ${adapterId} edit case is required`});
			}
		}
	});

const AdapterCountersSchema = z
	.object({
		probes: CountSchema,
		scans: CountSchema,
		extractions: CountSchema,
		factWrites: CountSchema,
	})
	.strict();

const TypeScriptEvidenceSchema = z
	.object({
		parser: ParserIdentitySchema,
		sampleContractSha256: HashSchema,
		sampledSymbols: CountSchema,
		precision: z.number().min(0).max(1),
		pages: CountSchema,
		gate: z.object({ok: z.boolean()}).strict(),
	})
	.strict();

const OracleEvidenceSchema = z
	.object({
		parser: OracleParserIdentitySchema,
		contract: OracleContractIdentitySchema,
		truth: OracleTruthIdentitySchema.extend({rows: CountSchema}).strict(),
		ambiguity: z
			.object({
				diagnostics: CountSchema,
				rawCalls: CountSchema,
				rate: z.number().min(0).max(1),
			})
			.strict(),
		gates: z
			.object({
				declarations: z.boolean(),
				references: z.boolean(),
				dependencies: z.boolean(),
				ambiguity: z.boolean(),
				ok: z.boolean(),
			})
			.strict(),
	})
	.strict();

export const ReleaseSemanticEvidenceSchema = z
	.object({
		schemaVersion: z.literal(1),
		engine: EngineIdentitySchema,
		runtime: RuntimeIdentitySchema,
		workspace: WorkspaceIdentitySchema,
		queries: z.array(
			z
				.object({
					id: IdentifierSchema,
					operation: ReleaseQueryOperationSchema,
					inputSha256: HashSchema,
					sha256: HashSchema,
					adapters: z.array(IdentifierSchema),
					pages: z.number().int().positive(),
					generationIdSha256: HashSchema,
				})
				.strict(),
		),
		edits: z.array(
			z
				.object({
					id: IdentifierSchema,
					adapterId: IdentifierSchema,
					pathSha256: HashSchema,
					mutationSha256: HashSchema,
					target: AdapterCountersSchema,
					nonTarget: AdapterCountersSchema,
				})
				.strict(),
		),
		freshness: z
			.object({
				staleFileRejected: z.boolean(),
				supersededAttempts: CountSchema,
				publishedAttempts: CountSchema,
				oneGenerationPerQuery: z.boolean(),
			})
			.strict(),
		contention: z
			.object({
				processes: z.literal(2),
				owners: CountSchema,
				publications: CountSchema,
				failures: CountSchema,
				observerWaitMs: DurationSchema,
			})
			.strict(),
	})
	.strict();

const MultiAdapterEvidenceSchema = z
	.object({
		status: z.enum(['pass', 'warning', 'failure']),
		warnings: CountSchema,
		isolationFailures: CountSchema,
		freshness: z.string().min(1).max(64),
	})
	.strict();

const ProductionScenarioEvidenceSchema = z
	.object({
		id: IdentifierSchema,
		ownerP95Ms: DurationSchema,
		observerWaitP95Ms: DurationSchema,
		eventToPublicationP95Ms: DurationSchema,
		processTreeRssPeakBytes: CountSchema,
		processTreeRssIdleBytes: CountSchema,
		databaseBytes: CountSchema,
		walBytes: CountSchema,
		shmBytes: CountSchema,
	})
	.strict();

const ProductionEvidenceSchema = z
	.object({
		manifestSha256: HashSchema,
		comparisonStatus: z.enum(['pass', 'failure']),
		semanticMismatches: CountSchema,
		engine: EngineIdentitySchema,
		runtime: RuntimeIdentitySchema,
		workspace: WorkspaceIdentitySchema,
		scenarios: z.array(ProductionScenarioEvidenceSchema).min(1),
	})
	.strict();

/** Validated, privacy-safe outputs from the specialized qualification runners. */
export const ReleaseQualificationEvidenceSchema = z
	.object({
		typescript: TypeScriptEvidenceSchema,
		oracle: OracleEvidenceSchema,
		semantic: ReleaseSemanticEvidenceSchema,
		multiAdapter: MultiAdapterEvidenceSchema,
		production: ProductionEvidenceSchema,
	})
	.strict();

export type ReleaseQualificationManifestType = z.infer<typeof ReleaseQualificationManifestSchema>;
export type ReleaseQualificationEvidenceType = z.infer<typeof ReleaseQualificationEvidenceSchema>;

export type ReleaseQualificationGateType = Readonly<{
	readonly id: string;
	readonly status: 'pass' | 'failure';
}>;

export type ReleaseQualificationReportType = Readonly<{
	readonly schemaVersion: 1;
	readonly manifestSha256: string;
	readonly semanticReportIdentity: string;
	readonly status: 'pass' | 'failure';
	readonly summary: Readonly<{readonly pass: number; readonly failure: number}>;
	readonly gates: readonly ReleaseQualificationGateType[];
}>;

const canonicalValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalValue(entry));
	}

	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalValue(entry)]),
		);
	}

	return value;
};

const digest = (value: unknown): string =>
	createHash('sha256')
		.update(JSON.stringify(canonicalValue(value)))
		.digest('hex');

/**
 * Returns the location-independent identity of one validated release manifest.
 *
 * @param manifest - Validated frozen release identity.
 * @returns Canonical manifest SHA-256.
 */
export const releaseQualificationManifestDigest = (manifest: ReleaseQualificationManifestType): string => digest(manifest);

/**
 * Hashes one closed qualification identity.
 *
 * @param value - Parser, runtime, workspace, or contract identity.
 * @returns Canonical SHA-256.
 */
export const releaseQualificationIdentityDigest = (value: unknown): string => digest(value);

const equals = (left: unknown, right: unknown): boolean => digest(left) === digest(right);

const gate = (id: string, passes: boolean): ReleaseQualificationGateType => ({
	id,
	status: passes ? 'pass' : 'failure',
});

const queryEvidenceMatches = (manifest: ReleaseQualificationManifestType, evidence: ReleaseQualificationEvidenceType): boolean => {
	if (manifest.queries.length !== evidence.semantic.queries.length) {
		return false;
	}

	return manifest.queries.every((expected, index) => {
		const actual = evidence.semantic.queries[index];
		return (
			actual !== undefined &&
			actual.id === expected.id &&
			actual.operation === expected.operation &&
			actual.inputSha256 === releaseQueryInputDigest(expected) &&
			actual.sha256 === expected.expectedSha256 &&
			actual.pages >= expected.minimumPages &&
			equals(actual.adapters, expected.expectedAdapters)
		);
	});
};

const duplicateRoutingMatches = (manifest: ReleaseQualificationManifestType, evidence: ReleaseQualificationEvidenceType): boolean =>
	manifest.queries
		.filter((query) => query.duplicateName)
		.every((expected) => {
			const actual = evidence.semantic.queries.find((query) => query.id === expected.id);
			return actual !== undefined && equals(actual.adapters, expected.expectedAdapters) && actual.adapters.length >= 2;
		});

const editEvidenceMatches = (manifest: ReleaseQualificationManifestType, evidence: ReleaseQualificationEvidenceType): boolean => {
	if (manifest.edits.length !== evidence.semantic.edits.length) {
		return false;
	}

	return manifest.edits.every((expected, index) => {
		const actual = evidence.semantic.edits[index];
		return (
			actual !== undefined &&
			actual.id === expected.id &&
			actual.adapterId === expected.adapterId &&
			actual.pathSha256 === releaseEditPathDigest(expected) &&
			actual.mutationSha256 === releaseEditMutationDigest(expected)
		);
	});
};

const isolatedEdits = (evidence: ReleaseQualificationEvidenceType): boolean =>
	evidence.semantic.edits.every(
		(edit) => edit.target.extractions > 0 && edit.target.factWrites > 0 && edit.nonTarget.extractions === 0 && edit.nonTarget.factWrites === 0,
	);

const scenarioWithin = (
	evidence: ReleaseQualificationEvidenceType,
	field: keyof ReleaseQualificationEvidenceType['production']['scenarios'][number],
	maximum: number,
): boolean =>
	evidence.production.scenarios.every((scenario) => {
		const value = scenario[field];
		return typeof value === 'number' && value <= maximum;
	});

/** Internal helpers shared with the aggregate evaluator. */
export const releaseQualificationInternals = {
	digest,
	equals,
	gate,
	queryEvidenceMatches,
	duplicateRoutingMatches,
	editEvidenceMatches,
	isolatedEdits,
	scenarioWithin,
};
