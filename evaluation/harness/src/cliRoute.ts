import path from 'node:path';
import {artifactIdentityOf, artifactRefOf, type ArtifactIdentityType} from './artifact.ts';
import {writeJsonAtomic} from './result.ts';
import {openMcpSession} from './routeClient.ts';
import {runContractProbes} from './routeContract.ts';
import {loadRoutePlan, routePlanHashOf, validateRoutePlan} from './routePlan.ts';
import {routeReportOf, type RouteCaseReportType} from './routeReport.ts';
import {ROUTE_TREATMENTS, runRoute, type RouteRunType, type RouteTreatmentType} from './route.ts';
import {loadSuite, selectCases} from './suite.ts';
import {type CaseClassType} from './schema.ts';
import {type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';
import {subjectIdentityOf, workspaceContextOf} from './workspace.ts';
import {ensureWorkspaces, restoreWorkspace} from './workspaceRestore.ts';
import {allOf, evaluationRoot, flagOf, settingsOf, treatmentsOf} from './cliSupport.ts';

export const routeTreatmentIdsOf = (value: string | undefined, treatments: readonly TreatmentDefinitionType[]): readonly RouteTreatmentType[] =>
	treatmentsOf(value, treatments)
		.map((treatment) => treatment.id)
		.filter((id): id is RouteTreatmentType => (ROUTE_TREATMENTS as readonly string[]).includes(id));

export const stepSummaryOf = (step: ReturnType<typeof loadRoutePlan>['routes'][number]['codeindex'][number]): string =>
	step.kind === 'mcp'
		? `mcp ${step.tool} ${JSON.stringify(step.arguments)}`
		: step.kind === 'search'
			? `search ${step.pattern} in ${step.path}`
			: `read ${step.path}`;

export const sessionKeyOf = (treatment: string, projectFile?: string): string => `${treatment}::${projectFile ?? ''}`;

export const openRouteSession = async (
	context: ReturnType<typeof workspaceContextOf>,
	treatment: TreatmentDefinitionType,
	projectFile?: string,
): Promise<Awaited<ReturnType<typeof openMcpSession>>> => {
	const session = await openMcpSession({
		entryPoint: context.artifactPath(treatment),
		cwd: context.workspacePath(treatment.id),
		...(projectFile === undefined ? {} : {env: {CODE_INDEX_PROJECT_FILE: projectFile}}),
	});

	return session;
};

export const routeOutputOf = (flags: Map<string, string[]>, suiteId: string, planHash: string): string => {
	const explicit = flagOf(flags, 'output');

	if (explicit !== undefined) {
		return path.resolve(evaluationRoot, explicit);
	}

	const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');

	return path.join(evaluationRoot, 'results', 'route', `${suiteId}-${planHash.slice(0, 16)}-${stamp}`);
};

/** One MCP session opened for a route treatment. */
type RouteSessionType = Awaited<ReturnType<typeof openMcpSession>>;

/** One route case binding from the plan. */
type RouteType = ReturnType<typeof loadRoutePlan>['routes'][number];

/** Contract probe results keyed by the CodeIndex treatment they describe. */
type ContractRecordType = Partial<Record<'accepted' | 'candidate', Awaited<ReturnType<typeof runContractProbes>>>>;

const routeForOf = (testCase: {id: string}, routes: ReadonlyMap<string, RouteType>): RouteType => {
	const route = routes.get(testCase.id);

	if (route === undefined) {
		throw new Error(`no route declared for ${testCase.id}`);
	}

	return route;
};

const printDryRunOf = (selected: readonly {id: string}[], routes: ReadonlyMap<string, RouteType>): void => {
	for (const testCase of selected) {
		const route = routeForOf(testCase, routes);

		process.stdout.write(`  ${testCase.id}\n`);
		process.stdout.write(`    text: ${route.text.map((step) => stepSummaryOf(step)).join(' -> ')}\n`);
		process.stdout.write(`    codeindex: ${route.codeindex.map((step) => stepSummaryOf(step)).join(' -> ')}\n`);
	}
};

const artifactMapOf = (
	workspace: ReturnType<typeof workspaceContextOf>,
	treatments: readonly TreatmentDefinitionType[],
): Map<TreatmentIdType, ArtifactIdentityType | null> => {
	const artifacts = new Map<TreatmentIdType, ArtifactIdentityType | null>();

	for (const treatment of treatments) {
		artifacts.set(treatment.id, treatment.artifact === null ? null : artifactIdentityOf(workspace.artifactRoot(treatment), treatment));
	}

	return artifacts;
};

const openSessionsOf = async (
	workspace: ReturnType<typeof workspaceContextOf>,
	treatments: readonly TreatmentDefinitionType[],
	sessions: Map<string, RouteSessionType>,
): Promise<void> => {
	for (const treatment of treatments) {
		if (treatment.kind === 'no-index') {
			continue;
		}

		const session = await openRouteSession(workspace, treatment);

		process.stderr.write(`artifact ${treatment.id} ${session.serverName} ${session.serverVersion} startup ${session.startupMs.toFixed(0)} ms\n`);
		sessions.set(sessionKeyOf(treatment.id), session);
	}
};

const routeSlotOf = async (
	input: Readonly<{
		treatments: readonly TreatmentDefinitionType[];
		sessions: Map<string, RouteSessionType>;
		runs: RouteRunType[];
		workspace: ReturnType<typeof workspaceContextOf>;
	}>,
	testCase: {id: string; expectedFiles: readonly string[]},
	route: RouteType,
	treatment: RouteTreatmentType,
): Promise<void> => {
	const definition = input.treatments.find((item) => item.id === treatment);
	const key = sessionKeyOf(treatment, route.projectFile);
	let client = treatment === 'no-index' ? null : (input.sessions.get(key) ?? null);

	if (treatment !== 'no-index' && client === null && definition !== undefined) {
		client = await openRouteSession(input.workspace, definition, route.projectFile);
		input.sessions.set(key, client);
		process.stderr.write(
			`${treatment} project ${route.projectFile ?? 'root'} ${client.serverName} ${client.serverVersion} startup ${client.startupMs.toFixed(0)} ms\n`,
		);
	}

	const run = await runRoute({
		caseId: testCase.id,
		treatment,
		steps: treatment === 'no-index' ? route.text : route.codeindex,
		workspace: input.workspace.workspacePath(treatment),
		expectedFiles: testCase.expectedFiles,
		client,
		awaitIndexReady: treatment !== 'no-index',
	});

	input.runs.push(run);
	process.stderr.write(
		`${testCase.id} ${treatment} ${run.valid && run.exact ? 'exact' : 'MISS'} calls ${run.metrics.callCount} bytes ${run.metrics.responseBytes} core ${run.metrics.coreMs.state}${run.defects.length === 0 ? '' : ` (${run.defects.join('; ')})`}\n`,
	);
};

const runRoutesOf = async (
	input: Readonly<{
		selected: readonly {id: string; expectedFiles: readonly string[]}[];
		routes: ReadonlyMap<string, RouteType>;
		treatmentIds: readonly RouteTreatmentType[];
		treatments: readonly TreatmentDefinitionType[];
		sessions: Map<string, RouteSessionType>;
		runs: RouteRunType[];
		workspace: ReturnType<typeof workspaceContextOf>;
	}>,
): Promise<void> => {
	for (const testCase of input.selected) {
		const route = routeForOf(testCase, input.routes);

		for (const treatment of input.treatmentIds) {
			await routeSlotOf(input, testCase, route, treatment);
		}
	}
};

const contractForOf = async (
	input: Readonly<{
		workspace: ReturnType<typeof workspaceContextOf>;
		plan: ReturnType<typeof loadRoutePlan>['contract'];
		sessions: Map<string, RouteSessionType>;
		contract: ContractRecordType;
	}>,
	treatment: TreatmentDefinitionType,
): Promise<void> => {
	const session = input.sessions.get(sessionKeyOf(treatment.id));

	if (session === undefined) {
		return;
	}

	const treatmentId = treatment.id === 'accepted' || treatment.id === 'candidate' ? treatment.id : undefined;

	if (treatmentId === undefined) {
		throw new Error(`contract probes do not apply to treatment ${treatment.id}`);
	}

	const probes = await runContractProbes({
		session,
		openSession: async (env) => {
			const probeSession = await openMcpSession({
				entryPoint: input.workspace.artifactPath(treatment),
				cwd: input.workspace.workspacePath(treatment.id),
				env,
			});

			return probeSession;
		},
		workspace: input.workspace.workspacePath(treatment.id),
		plan: input.plan,
		restore: () => {
			const restored = restoreWorkspace(input.workspace, treatment);

			if (!restored.restored) {
				throw new Error(`failed to restore ${treatment.id} after the stale-file probe: ${restored.reason ?? 'unknown reason'}`);
			}
		},
	});

	input.contract[treatmentId] = probes;
	process.stderr.write(`${treatment.id} contract ${probes.map((probe) => `${probe.kind}=${probe.result}`).join(' ')}\n`);
};

const runContractsOf = async (
	input: Readonly<{
		treatments: readonly TreatmentDefinitionType[];
		treatmentIds: readonly RouteTreatmentType[];
		sessions: Map<string, RouteSessionType>;
		workspace: ReturnType<typeof workspaceContextOf>;
		plan: ReturnType<typeof loadRoutePlan>['contract'];
		contract: ContractRecordType;
	}>,
): Promise<void> => {
	for (const treatment of input.treatments) {
		if (treatment.kind === 'no-index' || (treatment.id !== 'accepted' && treatment.id !== 'candidate') || !input.treatmentIds.includes(treatment.id)) {
			continue;
		}

		await contractForOf(input, treatment);
	}
};

const routeCasesOf = (
	selected: readonly {id: string; class: CaseClassType; expectedFiles: readonly string[]}[],
	treatmentIds: readonly RouteTreatmentType[],
	runs: readonly RouteRunType[],
): readonly RouteCaseReportType[] =>
	selected.map((testCase) => {
		const byTreatment: Partial<Record<RouteTreatmentType, RouteRunType>> = {};

		for (const treatment of treatmentIds) {
			const run = runs.find((item) => item.caseId === testCase.id && item.treatment === treatment);

			if (run !== undefined) {
				byTreatment[treatment] = run;
			}
		}

		return {
			caseId: testCase.id,
			class: testCase.class,
			expectedFiles: testCase.expectedFiles,
			treatments: byTreatment,
			answerEquality: treatmentIds.every((treatment) => byTreatment[treatment]?.valid === true && byTreatment[treatment].exact),
		};
	});

const printReportOf = (report: ReturnType<typeof routeReportOf>, treatmentIds: readonly RouteTreatmentType[]): void => {
	for (const treatment of treatmentIds) {
		const summary = report.summaries[treatment];

		if (summary === undefined) {
			continue;
		}

		process.stdout.write(
			`${treatment.padEnd(9)} exact ${summary.exactCount}/${summary.caseCount}  calls ${summary.medianCallCount.toFixed(1)}  bytes ${summary.medianResponseBytes.toFixed(0)}  elapsed ${summary.medianElapsedMs.toFixed(0)} ms  core ${summary.coreMs.state}${summary.coreMs.value === null ? '' : ` ${summary.coreMs.value.toFixed(0)} ms`}\n`,
		);
	}

	for (const gate of report.gates) {
		process.stdout.write(`${gate.result.toUpperCase()} ${gate.id} (${gate.detail})\n`);
	}

	process.stdout.write(`E1 ${report.passed ? 'PASSED' : 'NOT PASSED'}\n`);
};

export const routeCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const planPath = path.resolve(evaluationRoot, flagOf(flags, 'plan') ?? path.join('routes', `${suite.id}.json`));
	const plan = loadRoutePlan(planPath);

	validateRoutePlan(plan, suite, cases);

	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});
	const routes = new Map(plan.routes.map((route) => [route.caseId, route]));
	const treatmentIds = routeTreatmentIdsOf(flagOf(flags, 'treatment'), suite.treatments);
	const planHash = routePlanHashOf(plan);

	process.stdout.write(`route plan ${plan.id} ${planHash}\n`);
	process.stdout.write(`suite ${suite.id} v${suite.version} (${suite.status}) revision ${suite.revision}\n`);
	process.stdout.write(`treatments ${treatmentIds.join(', ')}\n`);

	if (flags.has('dry-run')) {
		printDryRunOf(selected, routes);

		return;
	}

	const treatments = treatmentsOf(flagOf(flags, 'treatment'), suite.treatments);
	const settings = settingsOf();
	const subject = subjectIdentityOf(settings.subjectRepo, suite.revision);
	const context = workspaceContextOf(evaluationRoot, {subjectRepo: settings.subjectRepo, subject});

	ensureWorkspaces(context, treatments);

	const artifacts = artifactMapOf(context, treatments);
	const sessions = new Map<string, RouteSessionType>();
	const runs: RouteRunType[] = [];
	const contract: ContractRecordType = {};

	try {
		await openSessionsOf(context, treatments, sessions);
		await runRoutesOf({selected, routes, treatmentIds, treatments, sessions, runs, workspace: context});
		await runContractsOf({treatments, treatmentIds, sessions, workspace: context, plan: plan.contract, contract});
	} finally {
		for (const session of sessions.values()) {
			await session.close();
		}
	}

	const routeCases = routeCasesOf(selected, treatmentIds, runs);
	const report = routeReportOf({
		generatedAt: new Date().toISOString(),
		suite: {id: suite.id, version: suite.version, status: suite.status, hash: suite.hash, revision: suite.revision},
		plan: {id: plan.id, hash: planHash},
		subject: {mode: subject.mode, revision: subject.revision, contentManifestHash: subject.contentManifestHash},
		artifacts: {
			accepted: artifactRefOf(artifacts.get('accepted') ?? null),
			candidate: artifactRefOf(artifacts.get('candidate') ?? null),
		},
		cases: routeCases,
		runs,
		contract,
		treatments: treatmentIds,
	});
	const output = routeOutputOf(flags, suite.id, planHash);

	writeJsonAtomic(path.join(output, 'report.json'), report);
	process.stdout.write(`report ${path.join(output, 'report.json')}\n`);

	printReportOf(report, treatmentIds);
};
