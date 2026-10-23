import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openMcpSession, type McpCallOutcomeType, type McpSessionType} from './routeClient.ts';
import {type CaseType} from './schema.ts';
import {type TreatmentDefinitionType} from './treatment.ts';
import {EVALUATION_PROJECTS, type WorkspaceContextType} from './workspace.ts';

/** One configured extractor project used by the frozen corpus. */
export type PreflightProjectType = Readonly<{
	name: string;
	projectFile: string;
	scopePrefix: string;
}>;

/** A known declaration used to prove a semantic fixture is indexed. */
export type SymbolProbeType = Readonly<{caseId: string; symbol: string; path: string}>;

/** Known declarations that must be stored before a semantic model call. */
export const SEMANTIC_SYMBOL_PROBES: readonly SymbolProbeType[] = [
	{caseId: 'semantic-renamed-reexport', symbol: 'createProfile', path: 'evaluation/fixtures/controlled-typescript/src/renamed/source.ts'},
	{caseId: 'semantic-barrel-chain', symbol: 'pipelineLimit', path: 'evaluation/fixtures/controlled-typescript/src/barrels/deep/value.ts'},
	{caseId: 'semantic-shadowed-name', symbol: 'Node', path: 'evaluation/fixtures/controlled-typescript/src/shadow/first.ts'},
	{
		caseId: 'semantic-interface-implementations',
		symbol: 'PaymentGateway',
		path: 'evaluation/fixtures/controlled-typescript/src/contracts/gateway.ts',
	},
	{caseId: 'semantic-type-only-import', symbol: 'InvoiceId', path: 'evaluation/fixtures/controlled-typescript/src/types/model.ts'},
	{caseId: 'semantic-default-export', symbol: 'default', path: 'evaluation/fixtures/controlled-typescript/src/defaults/clock.ts'},
];

const INDEX_READY_TIMEOUT_MS = 120_000;
const INDEX_READY_POLL_MS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const itemsOf = (data: unknown): readonly Readonly<Record<string, unknown>>[] =>
	isRecord(data) && Array.isArray(data['items']) ? data['items'].filter(isRecord) : [];

const relativePathOf = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

const literalPrefixOf = (scope: string): string => {
	const wildcard = scope.search(/[*?[{]/u);

	return (wildcard === -1 ? scope : scope.slice(0, wildcard)).replace(/\/+$/u, '');
};

/**
 * Resolves the one configured project that must index a case corpus.
 *
 * The longest matching project prefix wins, so the controlled semantic fixture
 * cannot silently fall back to the repository root context.
 *
 * @param testCase - Frozen case with scope and expected paths.
 * @param projects - Configured project contexts.
 * @returns The owning project.
 * @throws {@link Error} When no configured project covers every case path.
 */
export const projectForCaseOf = (
	testCase: Pick<CaseType, 'id' | 'scope' | 'expectedFiles' | 'contextFiles' | 'forbiddenFiles'>,
	projects: readonly PreflightProjectType[] = EVALUATION_PROJECTS,
): PreflightProjectType => {
	const casePaths = [...testCase.scope, ...testCase.expectedFiles, ...testCase.contextFiles, ...testCase.forbiddenFiles].map((item) => literalPrefixOf(item));
	const matches = projects
		.filter((project) => casePaths.every((item) => item === project.scopePrefix || item.startsWith(project.scopePrefix)))
		.sort((left, right) => right.scopePrefix.length - left.scopePrefix.length);
	const [project] = matches;

	if (project === undefined) {
		throw new Error(`case ${testCase.id} is not covered by a configured extractor project`);
	}

	return project;
};

/**
 * Lists every configured project that must index at least one path of a case.
 *
 * A case that changes both `src/` and `test/` needs the root and test project
 * contexts; a controlled fixture case needs the root and fixture contexts. The
 * root project is always required because it anchors the workspace.
 *
 * @param testCase - Frozen case with scope and expected paths.
 * @param projects - Configured project contexts.
 * @returns Required projects in configured order.
 */
export const requiredProjectsForCaseOf = (
	testCase: Pick<CaseType, 'scope' | 'expectedFiles' | 'contextFiles' | 'forbiddenFiles'>,
	projects: readonly PreflightProjectType[] = EVALUATION_PROJECTS,
): readonly PreflightProjectType[] => {
	const casePaths = [...testCase.scope, ...testCase.expectedFiles, ...testCase.contextFiles, ...testCase.forbiddenFiles].map((item) => literalPrefixOf(item));

	return projects.filter(
		(project) => project.scopePrefix === '' || casePaths.some((item) => item === project.scopePrefix || item.startsWith(project.scopePrefix)),
	);
};

/** Evidence for one case in the preflight report. */
export type CasePreflightType = Readonly<{
	caseId: string;
	project: string;
	projectFile: string;
	expectedFiles: readonly string[];
	pathsPresent: boolean;
	symbolProbe: Readonly<{symbol: string; path: string; ok: boolean}> | null;
}>;

/** Evidence for one indexed treatment in the preflight report. */
export type TreatmentPreflightType = Readonly<{
	treatmentId: string;
	artifact: string | null;
	ready: boolean;
	generationId: string | null;
	contexts: readonly string[];
	projectFiles: readonly string[];
	fileCount: number;
	rootMatches: boolean;
	projectsConfigured: boolean;
	filesIndexed: boolean;
	missingPaths: readonly string[];
	unindexedPaths: readonly string[];
	symbolProbes: readonly SymbolProbeType[];
	failures: readonly string[];
}>;

/** Complete deterministic corpus preflight evidence. */
export type CorpusPreflightType = Readonly<{
	recordType: 'corpus-preflight';
	result: 'pass' | 'fail';
	projects: readonly PreflightProjectType[];
	cases: readonly CasePreflightType[];
	treatments: readonly TreatmentPreflightType[];
	failures: readonly string[];
	checkedAt: string;
}>;

/** Input for one deterministic corpus preflight. */
export type CorpusPreflightInputType = Readonly<{
	context: WorkspaceContextType;
	cases: readonly CaseType[];
	treatments: readonly TreatmentDefinitionType[];
	/** Open one artifact session; tests inject a deterministic session. */
	openSession?: (treatment: TreatmentDefinitionType) => Promise<McpSessionType>;
	readyTimeoutMs?: number;
	pollMs?: number;
}>;

const defaultSessionOf =
	(context: WorkspaceContextType) =>
	async (treatment: TreatmentDefinitionType): Promise<McpSessionType> => {
		const session = await openMcpSession({
			entryPoint: context.artifactPath(treatment),
			cwd: context.workspacePath(treatment.id),
			env: context.codeIndexEnvironment(treatment),
		});

		return session;
	};

const readyStatusOf = async (
	input: Readonly<{session: McpSessionType; timeoutMs: number; pollMs: number; failures: string[]}>,
): Promise<Readonly<Record<string, unknown>> | null> => {
	const deadline = Date.now() + input.timeoutMs;

	while (Date.now() <= deadline) {
		const outcome: McpCallOutcomeType = await input.session.callTool('index_status', {});

		if (outcome.status !== 'ok' || !isRecord(outcome.structured)) {
			input.failures.push(`index_status failed: ${outcome.errorCode ?? 'unknown error'}`);
			return null;
		}

		if (outcome.structured['ready'] === true && outcome.structured['refresh'] === 'current' && outcome.structured['building'] !== true) {
			return outcome.structured;
		}

		await delay(input.pollMs);
	}

	input.failures.push(`index did not become ready within ${input.timeoutMs} ms`);

	return null;
};

const outlineProbeOf = async (input: Readonly<{session: McpSessionType; file: string; failures: string[]}>): Promise<boolean> => {
	const outcome = await input.session.callTool('outline', {path: input.file});

	if (outcome.status !== 'ok') {
		input.failures.push(`${input.file} is not stored in the published index (${outcome.errorCode ?? 'outline failed'})`);

		return false;
	}

	return true;
};

const symbolProbeOf = async (input: Readonly<{session: McpSessionType; probe: SymbolProbeType; failures: string[]}>): Promise<boolean> => {
	const outcome = await input.session.callTool('find_symbol', {query: input.probe.symbol, path: input.probe.path});
	const paths = itemsOf(outcome.structured).flatMap((item) => (typeof item['path'] === 'string' ? [item['path']] : []));
	const ok = outcome.status === 'ok' && paths.includes(input.probe.path);

	if (!ok) {
		input.failures.push(`${input.probe.symbol} is not stored at ${input.probe.path}`);
	}

	return ok;
};

const statusEvidenceOf = (
	input: Readonly<{
		status: Readonly<Record<string, unknown>>;
		workspace: string;
		expectedProjects: readonly PreflightProjectType[];
		failures: string[];
	}>,
): Omit<TreatmentPreflightType, 'treatmentId' | 'artifact' | 'unindexedPaths' | 'symbolProbes' | 'failures'> => {
	const scope = isRecord(input.status['scope']) ? input.status['scope'] : {};
	const counts = isRecord(input.status['counts']) ? input.status['counts'] : {};
	const root = typeof scope['root'] === 'string' ? path.resolve(scope['root']) : '';
	const workspace = path.resolve(input.workspace);
	const realWorkspace = existsSync(workspace) ? realpathSync(workspace) : workspace;
	const rootMatches = root === workspace || root === realWorkspace;
	const projects = Array.isArray(scope['projects']) ? scope['projects'].filter(isRecord) : [];
	const relativeProjectFileOf = (file: string): string =>
		[workspace, realWorkspace].map((base) => relativePathOf(base, file)).find((relative) => !relative.startsWith('..')) ?? relativePathOf(realWorkspace, file);
	const configured = projects.flatMap((project) =>
		typeof project['name'] === 'string' && typeof project['projectFile'] === 'string'
			? [{name: project['name'], file: relativeProjectFileOf(project['projectFile'])}]
			: [],
	);
	const projectFiles = configured.map((project) => project.file);
	const missingProjects = input.expectedProjects.filter(
		(expected) => !configured.some((project) => project.name === expected.name && project.file === expected.projectFile),
	);
	const projectsConfigured = missingProjects.length === 0;
	const fileCount = typeof counts['files'] === 'number' ? counts['files'] : 0;

	if (!rootMatches) {
		input.failures.push('index_status scope.root does not match the isolated workspace');
	}

	if (!projectsConfigured) {
		input.failures.push(`index_status is missing configured project(s): ${missingProjects.map((project) => project.name).join(', ')}`);
	}

	if (fileCount === 0) {
		input.failures.push('index_status reports no indexed files');
	}

	return {
		ready: input.status['ready'] === true,
		generationId: typeof input.status['generationId'] === 'string' ? input.status['generationId'] : null,
		contexts: configured.map((project) => project.name),
		projectFiles,
		fileCount,
		rootMatches,
		projectsConfigured,
		filesIndexed: fileCount > 0,
		missingPaths: [],
	};
};

const notReadyEvidenceOf = (treatment: TreatmentDefinitionType, failures: readonly string[]): TreatmentPreflightType => ({
	treatmentId: treatment.id,
	artifact: treatment.artifact?.id ?? null,
	ready: false,
	generationId: null,
	contexts: [],
	projectFiles: [],
	fileCount: 0,
	rootMatches: false,
	projectsConfigured: false,
	filesIndexed: false,
	missingPaths: [],
	unindexedPaths: [],
	symbolProbes: [],
	failures,
});

const expectedProjectsOf = (cases: readonly CaseType[]): readonly PreflightProjectType[] => {
	const names = [...new Set(cases.flatMap((testCase) => requiredProjectsForCaseOf(testCase).map((project) => project.name)))];

	return names.flatMap((name) => {
		const project = EVALUATION_PROJECTS.find((item) => item.name === name);

		return project === undefined ? [] : [project];
	});
};

const corpusProbesOf = async (
	input: Readonly<{session: McpSessionType; cases: readonly CaseType[]; realWorkspace: string; failures: string[]}>,
): Promise<Readonly<{missingPaths: readonly string[]; unindexedPaths: readonly string[]; symbolProbes: readonly SymbolProbeType[]}>> => {
	const missingPaths = [...new Set(input.cases.flatMap((testCase) => testCase.expectedFiles))].filter(
		(file) => !existsSync(path.join(input.realWorkspace, file)),
	);
	const unindexedPaths: string[] = [];
	const probedPaths = new Map<string, boolean>();
	const caseIds = new Set(input.cases.map((testCase) => testCase.id));
	const symbolProbes = SEMANTIC_SYMBOL_PROBES.filter((probe) => caseIds.has(probe.caseId));

	for (const testCase of input.cases) {
		for (const file of testCase.expectedFiles) {
			if (probedPaths.get(file) === true) {
				continue;
			}

			const ok = await outlineProbeOf({session: input.session, file, failures: input.failures});

			probedPaths.set(file, ok);

			if (!ok) {
				unindexedPaths.push(file);
			}
		}
	}

	for (const probe of symbolProbes) {
		if (!(await symbolProbeOf({session: input.session, probe, failures: input.failures}))) {
			unindexedPaths.push(probe.path);
		}
	}

	for (const file of missingPaths) {
		input.failures.push(`expected file is missing from the workspace: ${file}`);
	}

	return {missingPaths, unindexedPaths: [...new Set(unindexedPaths)], symbolProbes};
};

const treatmentPreflightOf = async (
	input: CorpusPreflightInputType &
		Readonly<{treatment: TreatmentDefinitionType; openSession: (treatment: TreatmentDefinitionType) => Promise<McpSessionType>}>,
): Promise<TreatmentPreflightType> => {
	const {treatment, context, cases} = input;
	const failures: string[] = [];
	const session = await input.openSession(treatment);
	const workspace = path.resolve(context.workspacePath(treatment.id));
	const realWorkspace = existsSync(workspace) ? realpathSync(workspace) : workspace;

	try {
		const ready = await readyStatusOf({
			session,
			timeoutMs: input.readyTimeoutMs ?? INDEX_READY_TIMEOUT_MS,
			pollMs: input.pollMs ?? INDEX_READY_POLL_MS,
			failures,
		});

		if (ready === null) {
			return notReadyEvidenceOf(treatment, failures);
		}

		const fullOutcome = await session.callTool('index_status', {detail: 'full'});
		const status = fullOutcome.status === 'ok' && isRecord(fullOutcome.structured) ? fullOutcome.structured : ready;
		const evidence = statusEvidenceOf({status, workspace, expectedProjects: expectedProjectsOf(cases), failures});
		const probes = await corpusProbesOf({session, cases, realWorkspace, failures});

		return {
			...evidence,
			treatmentId: treatment.id,
			artifact: treatment.artifact?.id ?? null,
			...probes,
			failures,
			...(failures.length === 0 ? {} : {filesIndexed: false}),
		};
	} finally {
		await session.close();
	}
};

/**
 * Proves that every selected case maps to a configured, published project and
 * that deterministic path and symbol probes succeed before any model call.
 *
 * @param input - Workspace context, cases, treatments, and session seam.
 * @returns Complete preflight evidence; `result` is `fail` when any probe fails.
 */
export const corpusPreflightOf = async (input: CorpusPreflightInputType): Promise<CorpusPreflightType> => {
	const failures: string[] = [];
	type CaseBaseType = Readonly<{
		caseId: string;
		project: string;
		projectFile: string;
		expectedFiles: readonly string[];
		pathsPresent: boolean;
		symbolProbe: Readonly<{symbol: string; path: string}> | null;
	}>;
	const caseBases: CaseBaseType[] = [];

	for (const testCase of input.cases) {
		const project = projectForCaseOf(testCase);
		const workspace =
			input.treatments.map((treatment) => input.context.workspacePath(treatment.id)).find((candidate) => existsSync(candidate)) ?? input.context.subjectRepo;
		const pathsPresent = testCase.expectedFiles.every((file) => existsSync(path.join(workspace, file)));
		const probe = SEMANTIC_SYMBOL_PROBES.find((item) => item.caseId === testCase.id);

		caseBases.push({
			caseId: testCase.id,
			project: project.name,
			projectFile: project.projectFile,
			expectedFiles: testCase.expectedFiles,
			pathsPresent,
			symbolProbe: probe === undefined ? null : {symbol: probe.symbol, path: probe.path},
		});

		if (!pathsPresent) {
			failures.push(`case ${testCase.id} names an expected file that is missing from the subject checkout`);
		}
	}

	const openSession = input.openSession ?? defaultSessionOf(input.context);
	const treatments: TreatmentPreflightType[] = [];

	for (const treatment of input.treatments) {
		if (treatment.kind === 'no-index') {
			continue;
		}

		const evidence = await treatmentPreflightOf({...input, treatment, openSession});
		const probeFailures = evidence.missingPaths.length + evidence.unindexedPaths.length;

		failures.push(...evidence.failures.map((failure) => `${treatment.id}: ${failure}`));

		if (!evidence.ready) {
			failures.push(`${treatment.id} index is not ready`);
		}

		if (!evidence.rootMatches) {
			failures.push(`${treatment.id} index_status root does not match its workspace`);
		}

		if (!evidence.projectsConfigured) {
			failures.push(`${treatment.id} index_status does not list every configured project`);
		}

		if (!evidence.filesIndexed || probeFailures > 0) {
			failures.push(`${treatment.id} does not store every expected corpus path`);
		}

		treatments.push(evidence);
	}

	const cases: CasePreflightType[] = caseBases.map((item) => ({
		...item,
		symbolProbe:
			item.symbolProbe === null
				? null
				: {...item.symbolProbe, ok: treatments.every((treatment) => !treatment.unindexedPaths.includes(item.symbolProbe?.path ?? ''))},
	}));

	return {
		recordType: 'corpus-preflight',
		result: failures.length === 0 && treatments.every((item) => item.filesIndexed) ? 'pass' : 'fail',
		projects: EVALUATION_PROJECTS.map((project) => ({name: project.name, projectFile: project.projectFile, scopePrefix: project.scopePrefix})),
		cases,
		treatments,
		failures: [...new Set(failures)],
		checkedAt: new Date().toISOString(),
	};
};

/**
 * Requires a passing preflight report.
 *
 * @param report - Preflight evidence.
 * @returns The same report when it passed.
 * @throws {@link Error} With every closed failure cause.
 */
export const assertCorpusPreflight = (report: CorpusPreflightType): CorpusPreflightType => {
	if (report.result !== 'pass') {
		throw new Error(`corpus preflight failed: ${report.failures.join('; ')}`);
	}

	return report;
};
