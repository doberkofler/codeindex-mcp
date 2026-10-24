import {defineConfig} from 'vitest/config';
import packageManifest from './package.json' with {type: 'json'};

// Class membership follows documentation/test-inventory.md. Keep these lists in
// sync with the inventory when a test is added or reclassified. The complete
// gate (`pnpm test`) keeps the directory patterns so an unclassified test can
// never be skipped silently.
const MODULE_TESTS = [
	'test/analytics.test.ts',
	'test/analyticsCommand.test.ts',
	'test/analyticsSummary.test.ts',
	'test/benchmarkResources.test.ts',
	'test/benchmarkSuite.test.ts',
	'test/benchmarkSuiteReporting.test.ts',
	'test/benchmarkSuiteRun.test.ts',
	'test/benchmarkTiming.test.ts',
	'test/buildLeaseHeartbeat.test.ts',
	'test/buildWorker.test.ts',
	'test/buildWorkerClient.test.ts',
	'test/cleanup.test.ts',
	'test/config.test.ts',
	'test/consoleDashboard.test.ts',
	'test/consoleServer.test.ts',
	'test/consoleService.test.ts',
	'test/errors.test.ts',
	'test/externalBuild.test.ts',
	'test/externalCorpus.test.ts',
	'test/frozenSuite.test.ts',
	'test/indexStatus.test.ts',
	'test/logger.test.ts',
	'test/mcpCommand.test.ts',
	'test/multiProjectConfig.test.ts',
	'test/oracleCsv.test.ts',
	'test/oracleDependencies.test.ts',
	'test/oracleDiagnostics.test.ts',
	'test/oracleGrammar.test.ts',
	'test/oracleInventory.test.ts',
	'test/oracleLiveApply.test.ts',
	'test/oracleLiveCommand.test.ts',
	'test/oracleLivePlan.test.ts',
	'test/oracleLiveSource.test.ts',
	'test/oracleProgress.test.ts',
	'test/oracleRecompile.test.ts',
	'test/oracleSymbolIdentity.test.ts',
	'test/publishedFiles.test.ts',
	'test/qualifyCommand.test.ts',
	'test/querySupport.test.ts',
	'test/readSymbolResult.test.ts',
	'test/readSymbolSource.test.ts',
	'test/refreshCoordinator.test.ts',
	'test/routePlan.test.ts',
	'test/runServer.test.ts',
	'test/sourceFiles.test.ts',
	'test/suitePrepare.test.ts',
	'test/toolGuidance.test.ts',
	'test/toolResponses.test.ts',
	'test/vcs.test.ts',
	'test/version.test.ts',
	'test/workspaceWatcher.test.ts',
	'evaluation/harness/src/artifact.test.ts',
	'evaluation/harness/src/calibration.test.ts',
	'evaluation/harness/src/diagnostics.test.ts',
	'evaluation/harness/src/environment.test.ts',
	'evaluation/harness/src/events.test.ts',
	'evaluation/harness/src/frozenSuite.test.ts',
	'evaluation/harness/src/grade.test.ts',
	'evaluation/harness/src/identity.test.ts',
	'evaluation/harness/src/isolation.test.ts',
	'evaluation/harness/src/localEvaluation.test.ts',
	'evaluation/harness/src/postRun.test.ts',
	'evaluation/harness/src/releaseCampaign.test.ts',
	'evaluation/harness/src/report.test.ts',
	'evaluation/harness/src/result.test.ts',
	'evaluation/harness/src/route.test.ts',
	'evaluation/harness/src/routeContractProbe.test.ts',
	'evaluation/harness/src/schema.test.ts',
	'evaluation/harness/src/surface.test.ts',
	'evaluation/harness/src/surfaceProbe.test.ts',
	'evaluation/harness/src/treatment.test.ts',
	'evaluation/harness/src/workflow.test.ts',
	'evaluation/harness/src/workspace.test.ts',
];

const TYPESCRIPT_ADAPTER_TESTS = [
	'test/extractors.test.ts',
	'test/loadProject.test.ts',
	'test/multiProject.test.ts',
	'test/typescriptPublicationSurface.test.ts',
	'test/scanWorkspace.test.ts',
];

const ORACLE_ADAPTER_TESTS = [
	'test/oracle.test.ts',
	'test/oracleAntlr.test.ts',
	'test/oracleAntlrDeclarations.test.ts',
	'test/oracleAntlrDependencies.test.ts',
	'test/oracleAntlrReferences.test.ts',
	'test/oracleGrammarGaps.test.ts',
	'test/oracleOverloadResolution.test.ts',
	'test/oracleParserBinding.test.ts',
	'test/oraclePublicationSurface.test.ts',
];

const REFERENCE_CORPUS_TESTS = [
	'test/oracleGoldenFacts.test.ts',
	'test/publicationReport.test.ts',
	'test/referenceVerification.test.ts',
	'evaluation/harness/src/repository.test.ts',
	'evaluation/harness/src/semantic.test.ts',
];

const CORE_INTEGRATION_TESTS = [
	'test/cli.test.ts',
	'test/codeIndex.test.ts',
	'test/database.test.ts',
	'test/databaseFacts.test.ts',
	'test/dependencyCases.test.ts',
	'test/oracleCodeFacts.test.ts',
	'test/publicationFacts.test.ts',
	'test/publicationDefaultsAndEnforcement.test.ts',
	'test/referenceGrouping.test.ts',
	'test/storage.test.ts',
];

const MCP_PROTOCOL_TESTS = [
	'test/mcp.test.ts',
	'test/mcpGuidance.test.ts',
	'test/mcpServerAnalytics.test.ts',
	'test/mcpSmoke.test.ts',
	'test/mcpStatus.test.ts',
];

const MCP_FAKE_INDEX_TESTS = ['test/mcp.test.ts', 'test/mcpGuidance.test.ts', 'test/mcpServerAnalytics.test.ts', 'test/mcpStatus.test.ts'];

const DETERMINISTIC_SYSTEM_TESTS = [
	'test/builtProcess.test.ts',
	'test/leaseContention.test.ts',
	'test/soak.test.ts',
	'evaluation/harness/src/runner.test.ts',
	'evaluation/harness/src/runnerRecovery.test.ts',
];

const WORKFLOWS = {
	all: ['test/**/*.test.ts', 'evaluation/harness/src/**/*.test.ts'],
	fast: [...MODULE_TESTS, ...TYPESCRIPT_ADAPTER_TESTS, ...ORACLE_ADAPTER_TESTS, ...CORE_INTEGRATION_TESTS, ...MCP_FAKE_INDEX_TESTS],
	typescript: [...TYPESCRIPT_ADAPTER_TESTS, ...REFERENCE_CORPUS_TESTS],
	mcp: MCP_PROTOCOL_TESTS,
	system: DETERMINISTIC_SYSTEM_TESTS,
} as const satisfies Readonly<Record<string, readonly string[]>>;

// A fast-class test that needs the built process or the reference corpus has grown
// into the system or qualification class. Reclassify it instead of stretching the
// fast budget.
const assertFastClassBoundary = (): void => {
	const restrictedTests = new Set([...DETERMINISTIC_SYSTEM_TESTS, ...REFERENCE_CORPUS_TESTS]);
	const violations = WORKFLOWS.fast.filter((testFile) => restrictedTests.has(testFile));

	if (violations.length > 0) {
		throw new Error(`Fast-class tests cannot also belong to the system or qualification class: ${violations.join(', ')}`);
	}
};

assertFastClassBoundary();

type WorkflowNameType = keyof typeof WORKFLOWS;

const isWorkflowName = (value: string): value is WorkflowNameType => Object.hasOwn(WORKFLOWS, value);

const selectedWorkflow = process.env['CODE_INDEX_TEST_WORKFLOW'] ?? 'all';

if (!isWorkflowName(selectedWorkflow)) {
	throw new Error(`Unknown CODE_INDEX_TEST_WORKFLOW: ${selectedWorkflow}`);
}

export default defineConfig({
	define: {
		PROGRAM_VERSION_AT_BUILD: JSON.stringify(packageManifest.version),
	},
	test: {
		environment: 'node',
		include: [...WORKFLOWS[selectedWorkflow]],
		reporters: ['default'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		coverage: {
			enabled: true,
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/ui/**', 'src/**/generated/**'],
			reporter: ['text', 'html'],
			thresholds: {
				statements: 90,
				lines: 90,
				functions: 90,
				branches: 75,
			},
		},
	},
});
