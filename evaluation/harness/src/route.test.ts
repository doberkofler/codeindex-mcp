import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'vitest';
import {loadRoutePlan, routePlanHashOf, routePlanOf, validateRoutePlan} from './routePlan.ts';
import {openMcpSession, takeDebugTimings} from './routeClient.ts';
import {runRoute} from './route.ts';
import {runReadStep, runSearchStep} from './routeText.ts';
import {routeReportOf, summarizeRouteTreatment, type RouteCaseReportType} from './routeReport.ts';
import {loadSuite} from './suite.ts';
import {baseRunOf, outcomeOf, runOf, sessionOf, tempWorkspace, writeFile} from './routeTestSupport.ts';

const EVALUATION_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RELEASE_PLAN = path.join(EVALUATION_ROOT, 'routes', 'codeindex-release.json');
const RELEASE_SUITE = path.join(EVALUATION_ROOT, 'suites', 'release.json');

describe('route', () => {
	it('release route plan validates against the frozen suite and hashes deterministically', () => {
		const {suite, cases} = loadSuite(RELEASE_SUITE);
		const plan = loadRoutePlan(RELEASE_PLAN);

		validateRoutePlan(plan, suite, cases);
		assert.equal(plan.routes.length, 18);
		assert.equal(routePlanHashOf(plan), routePlanHashOf(routePlanOf(JSON.parse(readFileSync(RELEASE_PLAN, 'utf8')) as unknown)));
		assert.equal(new Set(plan.routes.map((route) => route.caseId)).size, 18);
	});

	it('route plan rejects unknown fields, duplicate steps, invalid patterns, and partial coverage', () => {
		const {suite, cases} = loadSuite(RELEASE_SUITE);
		const plan = loadRoutePlan(RELEASE_PLAN);
		const withField = {...plan, unexpected: true};

		assert.throws(() => routePlanOf(withField), /unknown field/u);

		const duplicate = {
			...plan,
			routes: plan.routes.map((route, index) =>
				index === 0
					? {
							...route,
							codeindex: [
								{...route.codeindex[0], id: 'find-declaration'},
								{...route.codeindex[0], id: 'find-declaration'},
							],
						}
					: route,
			),
		};

		assert.throws(() => routePlanOf(duplicate), /repeats step id/u);

		const badPattern = {
			...plan,
			routes: plan.routes.map((route, index) => (index === 0 ? {...route, text: [{...route.text[0], pattern: '('}]} : route)),
		};

		assert.throws(() => routePlanOf(badPattern), /valid Unicode regular expression/u);

		assert.throws(() => {
			validateRoutePlan({...plan, routes: plan.routes.slice(1)}, suite, cases);
		}, /exactly the 18 suite cases/u);
	});

	it('ordinary search filters paths and retains matching lines', () => {
		const workspace = tempWorkspace();

		try {
			writeFile(workspace, 'src/a.ts', "export const value = 'hit';\n");
			writeFile(workspace, 'src/b.ts', "export const value = 'miss';\n");
			writeFile(workspace, 'src/c.js', "export const value = 'hit';\n");

			const result = runSearchStep({
				workspace,
				step: {kind: 'search', id: 'search', pattern: String.raw`\bhit\b`, path: 'src', extensions: ['.ts'], excludePaths: ['src/c.js'], collect: true},
			});

			assert.deepEqual(result.paths, ['src/a.ts']);
			assert.equal(result.calls, 1);
			assert.equal(result.matches.length, 1);
			assert.equal(result.matches[0]?.line, 1);
			assert.ok(result.bytes > 0);
		} finally {
			rmSync(workspace, {recursive: true, force: true});
		}
	});

	it('ordinary read counts one call and refuses a path outside the workspace', () => {
		const workspace = tempWorkspace();

		try {
			writeFile(workspace, 'src/a.ts', 'const value = 1;\n');
			const result = runReadStep({workspace, step: {kind: 'read', id: 'read', path: 'src/a.ts', collect: true}});

			assert.deepEqual(result.paths, ['src/a.ts']);
			assert.equal(result.calls, 1);
			assert.equal(result.bytes, Buffer.byteLength('const value = 1;\n', 'utf8'));
			assert.throws(() => runReadStep({workspace, step: {kind: 'read', id: 'escape', path: '../outside.ts', collect: true}}), /escapes the workspace/u);
		} finally {
			rmSync(workspace, {recursive: true, force: true});
		}
	});

	it('complete route resolves a symbol, follows cursor pages, and collects reference paths', async () => {
		const workspace = tempWorkspace();
		let referenceCalls = 0;

		try {
			writeFile(workspace, 'src/a.ts', 'export const value = 1;\n');
			writeFile(workspace, 'src/b.ts', 'export const other = 1;\n');

			const session = sessionOf((tool, args) => {
				if (tool === 'find_symbol') {
					return outcomeOf({items: [{symbolId: 'symbol-1', path: 'src/a.ts', name: 'value', match: 'exact_name'}]});
				}

				referenceCalls += 1;

				if (referenceCalls === 1) {
					assert.equal(args['symbolId'], 'symbol-1');
					return outcomeOf({items: [{path: 'src/b.ts', role: 'reference'}], truncated: true, nextCursor: 'page-2'});
				}

				return outcomeOf({items: [{path: 'src/c.ts', role: 'reference'}], truncated: false, nextCursor: null});
			});
			const run = await runRoute({
				caseId: 'case',
				treatment: 'accepted',
				steps: [
					{
						kind: 'mcp',
						id: 'find',
						tool: 'find_symbol',
						arguments: {query: 'value'},
						collect: 'none',
					},
					{
						kind: 'mcp',
						id: 'refs',
						tool: 'find_references',
						arguments: {role: 'reference'},
						symbolFrom: {fromStep: 'find', path: 'src/a.ts', name: 'value'},
						collect: 'reference-paths',
						followCursor: true,
					},
				],
				workspace,
				expectedFiles: ['src/b.ts', 'src/c.ts'],
				client: session,
			});

			assert.equal(run.valid, true);
			assert.equal(run.exact, true);
			assert.deepEqual(run.answerFiles, ['src/b.ts', 'src/c.ts']);
			assert.equal(run.metrics.callCount, 3);
			assert.equal(run.metrics.coreMs.state, 'exact');
			assert.equal(run.metrics.coreMs.value, 3);
		} finally {
			rmSync(workspace, {recursive: true, force: true});
		}
	});

	it('complete route keeps only files whose source matches the declared pattern', async () => {
		const workspace = tempWorkspace();

		try {
			writeFile(workspace, 'src/implementer.ts', 'class Gateway implements Contract {}\n');
			writeFile(workspace, 'src/consumer.ts', 'type Factory = (gateway: Contract) => void;\n');

			const session = sessionOf((tool) => {
				if (tool === 'find_symbol') {
					return outcomeOf({items: [{symbolId: 'contract', path: 'src/contract.ts', name: 'Contract', match: 'exact_name'}]});
				}

				return outcomeOf({
					items: [
						{path: 'src/implementer.ts', role: 'reference'},
						{path: 'src/consumer.ts', role: 'reference'},
					],
					truncated: false,
					nextCursor: null,
				});
			});
			const run = await runRoute({
				caseId: 'case',
				treatment: 'candidate',
				steps: [
					{kind: 'mcp', id: 'find', tool: 'find_symbol', arguments: {query: 'Contract'}, collect: 'none'},
					{
						kind: 'mcp',
						id: 'refs',
						tool: 'find_references',
						arguments: {role: 'reference'},
						symbolFrom: {fromStep: 'find'},
						collect: 'reference-paths',
						keepFilesMatching: String.raw`\bimplements\s+Contract\b`,
					},
				],
				workspace,
				expectedFiles: ['src/implementer.ts'],
				client: session,
			});

			assert.equal(run.exact, true);
			assert.deepEqual(run.answerFiles, ['src/implementer.ts']);
			assert.equal(run.metrics.callCount, 4);
		} finally {
			rmSync(workspace, {recursive: true, force: true});
		}
	});

	it('complete route reports an unresolved symbol as invalid evidence', async () => {
		const workspace = tempWorkspace();

		try {
			const session = sessionOf(() => outcomeOf({items: []}));
			const run = await runRoute({
				caseId: 'case',
				treatment: 'accepted',
				steps: [
					{kind: 'mcp', id: 'find', tool: 'find_symbol', arguments: {query: 'missing'}, collect: 'none'},
					{kind: 'mcp', id: 'refs', tool: 'find_references', arguments: {}, symbolFrom: {fromStep: 'find'}, collect: 'reference-paths'},
				],
				workspace,
				expectedFiles: ['src/a.ts'],
				client: session,
			});

			assert.equal(run.valid, false);
			assert.equal(run.exact, false);
			assert.match(run.defects[0] ?? '', /could not resolve a symbol/u);
		} finally {
			rmSync(workspace, {recursive: true, force: true});
		}
	});

	it('complete route waits for a published index and counts every readiness poll', async () => {
		const workspace = tempWorkspace();
		let statusCalls = 0;

		try {
			writeFile(workspace, 'src/a.ts', 'export const value = 1;\n');
			const session = sessionOf((tool) => {
				if (tool === 'index_status') {
					statusCalls += 1;

					return outcomeOf({ready: statusCalls > 1, state: statusCalls > 1 ? 'published' : 'building'});
				}

				return outcomeOf({items: [{symbolId: 'symbol-1', path: 'src/a.ts', name: 'value', match: 'exact_name'}]});
			});
			const run = await runRoute({
				caseId: 'case',
				treatment: 'accepted',
				steps: [
					{
						kind: 'mcp',
						id: 'find',
						tool: 'find_symbol',
						arguments: {query: 'value'},
						collect: 'exact-name-paths',
						exactName: 'value',
					},
				],
				workspace,
				expectedFiles: ['src/a.ts'],
				client: session,
				awaitIndexReady: true,
			});

			assert.equal(run.exact, true);
			assert.equal(run.metrics.callCount, 3);
			assert.equal(run.calls[0]?.stepId, 'index-ready');
			assert.equal(run.calls[0].status, 'ok');
			assert.equal(run.calls[1]?.stepId, 'index-ready');
		} finally {
			rmSync(workspace, {recursive: true, force: true});
		}
	});

	it('route summaries use medians and report unavailable core time', () => {
		const runs = [
			{...baseRunOf(1, 1), caseId: 'a', treatment: 'accepted' as const, answerFiles: [], expectedFiles: [], calls: [], defects: []},
			{...baseRunOf(3, 3), caseId: 'b', treatment: 'accepted' as const, answerFiles: [], expectedFiles: [], calls: [], defects: []},
		];
		const summary = summarizeRouteTreatment(runs);
		const [first] = runs;

		assert.ok(first !== undefined);
		assert.equal(summary.caseCount, 2);
		assert.equal(summary.medianCallCount, 2);
		assert.equal(summary.medianResponseBytes, 20);
		assert.equal(summary.medianElapsedMs, 4);
		assert.equal(summary.coreMs.value, 2);
		assert.equal(summarizeRouteTreatment([{...first, metrics: {...first.metrics, coreMs: {value: null, state: 'unavailable'}}}]).coreMs.state, 'unavailable');
	});

	it('route report passes only when equality, measurements, and contracts all pass', () => {
		const cases: readonly RouteCaseReportType[] = [
			{
				caseId: 'locate-schema-version',
				class: 'locate',
				expectedFiles: ['src/a.ts'],
				treatments: {'no-index': runOf('locate-schema-version', 'no-index', true), accepted: runOf('locate-schema-version', 'accepted', true)},
				answerEquality: true,
			},
		];
		const contract = {accepted: [{kind: 'pagination' as const, result: 'pass' as const, detail: '', observations: {}}]};
		const passed = routeReportOf({
			generatedAt: '2026-10-21T00:00:00.000Z',
			suite: {id: 'codeindex-release', version: 1, status: 'frozen', hash: 'suite-hash', revision: 'revision'},
			plan: {id: 'plan', hash: 'plan-hash'},
			subject: {mode: 'detached-worktree', revision: 'revision', contentManifestHash: 'content'},
			artifacts: {accepted: {id: 'accepted', digest: 'digest'}, candidate: null},
			cases,
			runs: [runOf('locate-schema-version', 'no-index', true), runOf('locate-schema-version', 'accepted', true)],
			contract,
			treatments: ['no-index', 'accepted'],
		});

		assert.equal(passed.passed, true);
		assert.deepEqual(
			passed.gates.map((gate) => gate.result),
			['pass', 'pass', 'pass'],
		);

		const [firstCase] = cases;

		assert.ok(firstCase !== undefined);

		const missed = routeReportOf({
			...passed,
			cases: [{...firstCase, treatments: {'no-index': runOf('locate-schema-version', 'no-index', false)}}],
			runs: [runOf('locate-schema-version', 'no-index', false)],
			treatments: ['no-index'],
		});

		assert.equal(missed.gates[0]?.result, 'fail');

		const unavailable = routeReportOf({
			...passed,
			cases: [{...firstCase, treatments: {accepted: runOf('locate-schema-version', 'accepted', true, 'unavailable')}}],
			runs: [runOf('locate-schema-version', 'accepted', true, 'unavailable')],
			treatments: ['accepted'],
		});

		assert.equal(unavailable.gates[1]?.result, 'invalid');

		const brokenContract = routeReportOf({
			...passed,
			runs: [runOf('locate-schema-version', 'accepted', true)],
			treatments: ['accepted'],
			contract: {accepted: [{kind: 'pagination', result: 'fail', detail: 'broken', observations: {}}]},
		});
		assert.equal(brokenContract.gates[2]?.result, 'fail');
	});

	it('debug timings survive multiline inspect output and retain an incomplete tail', () => {
		const buffer = {
			text: [
				'2026-10-21T20:00:00.000Z codeindex:mcp tool call complete {',
				"  tool: 'find_symbol',",
				'  durationMs: 12,',
				'  bytes: 100',
				'}',
				'',
				"2026-10-21T20:00:01.000Z codeindex:mcp tool call complete {tool: 'outline', durationMs: 3}",
				"2026-10-21T20:00:02.000Z codeindex:mcp tool call complete {tool: 'read_symbol', durationMs:",
			].join('\n'),
		};
		const timings = takeDebugTimings(buffer);

		assert.deepEqual(timings, [
			{tool: 'find_symbol', durationMs: 12},
			{tool: 'outline', durationMs: 3},
		]);
		assert.match(buffer.text, /read_symbol/u);
	});

	it('official client session reads structured data and server-reported core time from a stdio server', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'codeindex-route-client-'));
		const entry = path.join(directory, 'server.mjs');

		try {
			writeFileSync(
				entry,
				[
					"import {createInterface} from 'node:readline';",
					'const rl = createInterface({input: process.stdin});',
					'rl.on("line", (line) => {',
					'  const message = JSON.parse(line);',
					'  if (message.id === undefined) { return; }',
					'  let result = {};',
					'  if (message.method === "initialize") {',
					'    result = {protocolVersion: "2025-06-18", capabilities: {tools: {}}, serverInfo: {name: "route-fixture", version: "1"}};',
					'  } else if (message.method === "tools/list") {',
					'    result = {tools: [{name: "echo", description: "", inputSchema: {type: "object"}}]};',
					'  } else if (message.method === "tools/call") {',
					String.raw`    process.stderr.write("2026-10-21T20:00:00.000Z codeindex:mcp tool call complete {tool: 'echo', durationMs: 4}\n");`,
					'    result = {content: [{type: "text", text: "hello"}], structuredContent: {ok: true, data: {items: [{path: "src/a.ts"}]}}};',
					'  }',
					// oxlint-disable-next-line eslint/no-template-curly-in-string -- The text is generated fixture source; the placeholder interpolates only when that script runs.
					'  process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, result})}\\n`);',
					'});',
				].join('\n'),
				'utf8',
			);

			const session = await openMcpSession({entryPoint: entry, cwd: directory});

			try {
				const outcome = await session.callTool('echo', {});

				assert.equal(outcome.status, 'ok');
				assert.equal(outcome.responseBytes, 5);
				assert.equal(outcome.coreMs, 4);
				assert.deepEqual(outcome.structured, {items: [{path: 'src/a.ts'}]});
				assert.equal(session.serverName, 'route-fixture');
			} finally {
				await session.close();
			}
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});
});
