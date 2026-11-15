import {
	PRODUCTION_SCENARIOS,
	ProductionBenchmarkReportSchema,
	productionManifestDigest,
	type ProductionBenchmarkManifestType,
	type ProductionBenchmarkReportType,
	type ProductionScenarioType,
} from './productionContract.ts';

export type ProductionBenchmarkComparisonType = Readonly<{
	readonly schemaVersion: 1;
	readonly status: 'pass' | 'failure';
	readonly manifestSha256: string;
	readonly controlRevision: string;
	readonly candidateRevision: string;
	readonly semanticMismatches: number;
	readonly scenarios: readonly Readonly<{
		readonly scenario: ProductionScenarioType;
		readonly samples: number;
		readonly ownerDurationDeltaPercent: number | null;
		readonly observerWaitDeltaPercent: number | null;
		readonly processTreeRssPeakDeltaPercent: number | null;
		readonly storageDeltaPercent: number | null;
	}>[];
}>;

const expectedRunKeys = (manifest: ProductionBenchmarkManifestType): readonly string[] =>
	Array.from({length: manifest.repetitions}, (_value, index) => index + 1).flatMap((repetition) =>
		manifest.scenarioOrder.map((scenario) => `${String(repetition)}:${scenario}`),
	);

const identityMatches = (manifest: ProductionBenchmarkManifestType, report: ProductionBenchmarkReportType, role: 'control' | 'candidate'): boolean => {
	const expectedEngine = manifest.engines[role];

	return (
		report.manifestSha256 === productionManifestDigest(manifest) &&
		report.engine.revision === expectedEngine.revision &&
		report.engine.bundleSha256 === expectedEngine.bundleSha256 &&
		report.runtime.nodeVersion === manifest.runtime.nodeVersion &&
		report.runtime.platform === manifest.runtime.platform &&
		report.runtime.arch === manifest.runtime.arch &&
		report.corpus.sha256 === manifest.corpus.sha256 &&
		report.corpus.configurationSha256 === manifest.corpus.configurationSha256 &&
		report.thresholdsSha256 === manifest.thresholds.sha256 &&
		report.warmups === manifest.warmups &&
		report.repetitions === manifest.repetitions
	);
};

const assertReportIdentity = (manifest: ProductionBenchmarkManifestType, report: ProductionBenchmarkReportType, role: 'control' | 'candidate'): void => {
	const reportKeys = report.runs.map((run) => `${String(run.repetition)}:${run.scenario}`);
	const expectedKeys = expectedRunKeys(manifest);

	if (report.engine.role !== role) {
		throw new Error(`Expected ${role} report, received ${report.engine.role}`);
	}

	if (!identityMatches(manifest, report, role)) {
		throw new Error(`${role} report identity drifted from the frozen manifest`);
	}

	if (Date.parse(report.completedAt) > Date.parse(manifest.evidenceExpiresAt)) {
		throw new Error(`${role} report is stale: it completed after the evidence expiry`);
	}

	if (Date.parse(report.startedAt) < Date.parse(manifest.declaredAt)) {
		throw new Error(`${role} report predates the frozen manifest`);
	}

	if (
		report.scenarioOrder.some((scenario, index) => scenario !== manifest.scenarioOrder[index]) ||
		reportKeys.some((key, index) => key !== expectedKeys[index]) ||
		reportKeys.length !== expectedKeys.length
	) {
		throw new Error(`${role} report has missing, duplicate, or out-of-order scenario runs`);
	}
};

/**
 * Finalizes measured scenario runs into a manifest-bound report.
 *
 * The caller owns scenario execution against a disposable corpus/database copy;
 * this boundary adds only closed identities and rejects incomplete evidence.
 *
 * @param input - Frozen manifest, engine role, measurement interval, and runs.
 * @returns Complete report ready for retention and comparison.
 */
export const createProductionBenchmarkReport = (
	input: Readonly<{
		manifest: ProductionBenchmarkManifestType;
		role: 'control' | 'candidate';
		startedAt: string;
		completedAt: string;
		runs: ProductionBenchmarkReportType['runs'];
	}>,
): ProductionBenchmarkReportType => {
	const engine = input.manifest.engines[input.role];
	const report = ProductionBenchmarkReportSchema.parse({
		schemaVersion: 1,
		manifestSha256: productionManifestDigest(input.manifest),
		engine: {role: input.role, revision: engine.revision, bundleSha256: engine.bundleSha256},
		runtime: input.manifest.runtime,
		corpus: {
			sha256: input.manifest.corpus.sha256,
			configurationSha256: input.manifest.corpus.configurationSha256,
		},
		thresholdsSha256: input.manifest.thresholds.sha256,
		startedAt: input.startedAt,
		completedAt: input.completedAt,
		complete: true,
		warmups: input.manifest.warmups,
		repetitions: input.manifest.repetitions,
		scenarioOrder: input.manifest.scenarioOrder,
		runs: input.runs,
	});

	assertReportIdentity(input.manifest, report, input.role);
	return report;
};

const totalStorage = (run: ProductionBenchmarkReportType['runs'][number]): number => run.storage.databaseBytes + run.storage.walBytes + run.storage.shmBytes;

const mean = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0) / values.length;

const deltaPercent = (control: readonly number[], candidate: readonly number[]): number | null => {
	const controlMean = mean(control);

	if (controlMean === 0) {
		return mean(candidate) === 0 ? 0 : null;
	}

	return ((mean(candidate) - controlMean) / controlMean) * 100;
};

const runsOf = (report: ProductionBenchmarkReportType, scenario: ProductionScenarioType): readonly ProductionBenchmarkReportType['runs'][number][] =>
	report.runs.filter((run) => run.scenario === scenario);

/**
 * Validates and compares development-checkout control and candidate evidence.
 *
 * Semantic digest drift is a failure. Performance deltas are descriptive here;
 * the frozen threshold contract is evaluated by the production harness.
 *
 * @param manifest - Frozen benchmark identity and scenario contract.
 * @param controlInput - Development-checkout control report.
 * @param candidateInput - Candidate report.
 * @returns Validated semantic verdict and per-scenario performance deltas.
 */
export const compareProductionBenchmarkReports = (
	manifest: ProductionBenchmarkManifestType,
	controlInput: unknown,
	candidateInput: unknown,
): ProductionBenchmarkComparisonType => {
	const control = ProductionBenchmarkReportSchema.parse(controlInput);
	const candidate = ProductionBenchmarkReportSchema.parse(candidateInput);
	assertReportIdentity(manifest, control, 'control');
	assertReportIdentity(manifest, candidate, 'candidate');

	let semanticMismatches = 0;

	for (const [index, controlRun] of control.runs.entries()) {
		const candidateRun = candidate.runs[index];

		if (
			candidateRun === undefined ||
			controlRun.digests.factsSha256 !== candidateRun.digests.factsSha256 ||
			controlRun.digests.queryResultsSha256 !== candidateRun.digests.queryResultsSha256
		) {
			semanticMismatches += 1;
		}
	}

	const scenarios = PRODUCTION_SCENARIOS.map((scenario) => {
		const controlRuns = runsOf(control, scenario);
		const candidateRuns = runsOf(candidate, scenario);

		return {
			scenario,
			samples: candidateRuns.length,
			ownerDurationDeltaPercent: deltaPercent(
				controlRuns.map((run) => run.ownerDurationMs),
				candidateRuns.map((run) => run.ownerDurationMs),
			),
			observerWaitDeltaPercent: deltaPercent(
				controlRuns.map((run) => run.observerWaitMs),
				candidateRuns.map((run) => run.observerWaitMs),
			),
			processTreeRssPeakDeltaPercent: deltaPercent(
				controlRuns.map((run) => run.resources.processTreeRssPeakBytes),
				candidateRuns.map((run) => run.resources.processTreeRssPeakBytes),
			),
			storageDeltaPercent: deltaPercent(
				controlRuns.map((run) => totalStorage(run)),
				candidateRuns.map((run) => totalStorage(run)),
			),
		};
	});

	return {
		schemaVersion: 1,
		status: semanticMismatches === 0 ? 'pass' : 'failure',
		manifestSha256: productionManifestDigest(manifest),
		controlRevision: control.engine.revision,
		candidateRevision: candidate.engine.revision,
		semanticMismatches,
		scenarios,
	};
};
