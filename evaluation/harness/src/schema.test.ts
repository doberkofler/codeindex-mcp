import assert from 'node:assert/strict';
import {spawnSync, type SpawnSyncReturns} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {CASE_SCHEMA_VERSION, SUITE_SCHEMA_VERSION, canonicalJson, caseHashOf, caseOf, hashOf, suiteFieldsOf} from './schema.ts';
import {loadSuite, planHashOf, planOf, selectCases} from './suite.ts';
import {treatmentHashOf} from './treatment.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const gitIn = (cwd: string, args: readonly string[]): string => {
	const result = spawnSync('git', args, {cwd, encoding: 'utf8'});

	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}

	return result.stdout;
};

const baseCase = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	schemaVersion: CASE_SCHEMA_VERSION,
	id: 'case-a',
	title: 'Case A',
	class: 'locate',
	tags: ['locate'],
	prompt: 'Which file defines A?',
	scope: ['src/**'],
	expectedFiles: ['src/a.ts'],
	contextFiles: [],
	forbiddenFiles: [],
	workflow: {maxTotalCalls: 12, requiredFirstTool: null, maxOutputBytes: 1000},
	timeoutMs: 1000,
	...overrides,
});

const ordinaryTools = ['bash', 'glob', 'grep', 'list', 'read'];

const baseTreatments = (): readonly Record<string, unknown>[] => [
	{id: 'no-index', kind: 'no-index', ordinaryTools, codeMode: 'absent', artifact: null, mcp: null},
	{
		id: 'accepted',
		kind: 'codeindex',
		ordinaryTools,
		codeMode: 'absent',
		artifact: {id: 'accepted-artifact', root: 'artifacts/accepted', entryPoint: 'mcp.mjs'},
		mcp: {server: 'codeindex', codemode: false},
	},
	{
		id: 'candidate',
		kind: 'codeindex',
		ordinaryTools,
		codeMode: 'absent',
		artifact: {id: 'candidate-artifact', root: 'artifacts/candidate', entryPoint: 'mcp.mjs'},
		mcp: {server: 'codeindex', codemode: false},
	},
];

const baseSuite = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	schemaVersion: SUITE_SCHEMA_VERSION,
	id: 'suite-a',
	version: 1,
	status: 'draft',
	revision: 'abc1234',
	model: 'ollama/qwen3:8b',
	repetitions: 1,
	treatments: baseTreatments(),
	cases: ['case-a'],
	...overrides,
});

const corpus = (
	testContext: TestContext,
	input: Readonly<{suite: Record<string, unknown>; cases: Record<string, Record<string, unknown>>}>,
): Readonly<{root: string; suitePath: string}> => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-'));
	const suiteDir = path.join(root, 'evaluation', 'suites');
	const caseDir = path.join(root, 'evaluation', 'cases');
	mkdirSync(suiteDir, {recursive: true});
	mkdirSync(caseDir, {recursive: true});

	for (const [id, value] of Object.entries(input.cases)) {
		writeFileSync(path.join(caseDir, `${id}.json`), `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
	}

	const suitePath = path.join(suiteDir, 'suite.json');
	writeFileSync(suitePath, `${JSON.stringify(input.suite, null, '\t')}\n`, 'utf8');
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return {root, suitePath};
};

const cliSandbox = (testContext: TestContext): Readonly<{root: string; env: NodeJS.ProcessEnv; marker: string; suitePath: string}> => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-cli-'));
	const bin = path.join(root, 'bin');
	const marker = path.join(root, 'opencode-invoked');
	mkdirSync(bin, {recursive: true});
	writeFileSync(
		path.join(bin, 'probe.mjs'),
		[
			"const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');",
			"const base = config.providers?.['surface-probe']?.settings?.baseURL;",
			'const post = async (tools) => {',
			// oxlint-disable-next-line eslint/no-template-curly-in-string -- The text is generated fixture source; the placeholder interpolates only when that script runs.
			"	await fetch(`${base}/chat/completions`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({tools})});",
			'};',
			'await post([]);',
			"await post([{function: {name: 'glob'}}, {function: {name: 'grep'}}, {function: {name: 'read'}}, {function: {name: 'shell'}}]);",
			"await post([{function: {name: 'glob'}}, {function: {name: 'grep'}}, {function: {name: 'read'}}, {function: {name: 'shell'}}]);",
			'',
		].join('\n'),
		{encoding: 'utf8', mode: 0o644},
	);
	writeFileSync(
		path.join(bin, 'opencode'),
		[
			'#!/bin/sh',
			'for arg in "$@"; do',
			'  if [ "$arg" = "surface-probe/probe" ]; then',
			`    exec node "${path.join(bin, 'probe.mjs')}"`,
			'  fi',
			'done',
			'count=$(cat "$MARKER" 2>/dev/null || printf 0)',
			'count=$((count + 1))',
			'printf "%s" "$count" > "$MARKER"',
			"cat <<'EVENTS'",
			String.raw`{"type":"text","part":{"text":"{\"files\":[\"src/a.ts\"],\"absent\":false}"}}`,
			String.raw`{"type":"step_finish","part":{"tokens":{"input":10,"output":5},"cost":0.001}}`,
			'EVENTS',
			'',
		].join('\n'),
		{encoding: 'utf8', mode: 0o755},
	);

	// The CLI resolves its subject from the harness root, so the fixture is a
	// complete harness with its own subject checkout.
	cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), {recursive: true});
	cpSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
	const subject = path.join(root, 'subject');
	mkdirSync(path.join(subject, 'src'), {recursive: true});
	writeFileSync(path.join(subject, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
	gitIn(subject, ['init', '-q']);
	gitIn(subject, ['config', 'user.email', 'harness@example.invalid']);
	gitIn(subject, ['config', 'user.name', 'Harness']);
	gitIn(subject, ['add', '.']);
	gitIn(subject, ['commit', '-q', '-m', 'fixture']);
	const revision = gitIn(subject, ['rev-parse', 'HEAD']).trim();

	writeFileSync(path.join(root, 'harness.json'), `${JSON.stringify({subjectRepo: subject}, null, '\t')}\n`, 'utf8');
	const caseDir = path.join(root, 'evaluation', 'cases');
	const suiteDir = path.join(root, 'evaluation', 'suites');
	mkdirSync(caseDir, {recursive: true});
	mkdirSync(suiteDir, {recursive: true});
	writeFileSync(path.join(caseDir, 'case-a.json'), `${JSON.stringify(baseCase(), null, '\t')}\n`, 'utf8');
	writeFileSync(path.join(suiteDir, 'suite.json'), `${JSON.stringify(baseSuite({revision}), null, '\t')}\n`, 'utf8');
	testContext.onTestFinished(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return {
		root,
		env: {...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, MARKER: marker, EVALUATION_ROOT: root, EVAL_PACE_MS: '0'},
		marker,
		suitePath: 'evaluation/suites/suite.json',
	};
};

describe('schema', () => {
	it('case schema accepts version 1 and applies empty defaults', () => {
		const parsed = caseOf(baseCase({contextFiles: undefined, forbiddenFiles: undefined}));

		assert.equal(parsed.schemaVersion, CASE_SCHEMA_VERSION);
		assert.deepEqual(parsed.contextFiles, []);
		assert.deepEqual(parsed.forbiddenFiles, []);
		assert.equal(parsed.workflow.requiredFirstTool, null);
	});

	it('case schema rejects missing, unknown, and unsupported fields', () => {
		const missingVersion = baseCase();
		delete missingVersion['schemaVersion'];
		assert.throws(() => caseOf(missingVersion), /schemaVersion.*required/u);
		assert.throws(() => caseOf(baseCase({schemaVersion: 2})), /schemaVersion/u);
		assert.throws(() => caseOf(baseCase({unexpected: true})), /unknown field.*unexpected/u);
		assert.throws(() => caseOf(baseCase({workflow: {maxTotalCalls: 1, requiredFirstTool: null, maxOutputBytes: 1, extra: true}})), /unknown field.*extra/u);
		assert.throws(() => caseOf(baseCase({tags: ['locate', 'locate']})), /duplicates/u);
	});

	it('case schema accepts the semantic class used by class-stratified reports', () => {
		const parsed = caseOf(baseCase({class: 'semantic'}));

		assert.equal(parsed.class, 'semantic');
		assert.throws(() => caseOf(baseCase({class: 'bogus'})), /class.*must be one of/u);
	});

	it('case schema defaults optional workflow and post-run fields', () => {
		const parsed = caseOf(baseCase({check: {command: 'node', args: ['--test'], expectedExitCode: 0}}));

		assert.deepEqual(parsed.workflow.requiredTools, []);
		assert.deepEqual(parsed.workflow.forbiddenTools, []);
		assert.deepEqual(parsed.workflow.maxCallsByFamily, {});
		assert.deepEqual(parsed.workflow.maxOutputBytesByFamily, {});
		assert.equal(parsed.workflow.maxDuplicateReads, null);
		assert.equal(parsed.workflow.maxFallbacksAfterAuthoritative, null);
		assert.equal(parsed.workflow.maxBroadSearches, null);
		assert.equal(parsed.workflow.maxDurationMs, null);
		assert.equal(parsed.workflow.maxTokens, null);
		assert.deepEqual(parsed.check, {
			command: 'node',
			args: ['--test'],
			expectedExitCode: 0,
			timeoutMs: 120_000,
		});
	});

	it('case schema rejects incomplete, overlapping, and subjective ground truth', () => {
		assert.throws(() => caseOf(baseCase({expectedFiles: []})), /expectedFiles.*must not be empty/u);
		assert.throws(() => caseOf(baseCase({contextFiles: ['src/a.ts']})), /expectedFiles.*contextFiles.*overlap/u);
		assert.throws(() => caseOf(baseCase({forbiddenFiles: ['src/a.ts']})), /forbiddenFiles.*overlaps/u);
		assert.throws(
			() => caseOf(baseCase({workflow: {maxTotalCalls: 1, maxOutputBytes: 1, requiredTools: ['read'], forbiddenTools: ['read']}})),
			/requiredTools.*forbiddenTools.*overlap/u,
		);
	});

	it('case schema rejects malformed workflow and post-run predicates', () => {
		assert.throws(() => caseOf(baseCase({workflow: {maxTotalCalls: 1, maxOutputBytes: 1, maxCallsByFamily: {bogus: 1}}})), /unknown tool family/u);
		assert.throws(() => caseOf(baseCase({workflow: {maxTotalCalls: 1, maxOutputBytes: 1, maxCallsByFamily: {search: -1}}})), /non-negative integer/u);
		assert.throws(() => caseOf(baseCase({check: {command: 'node', args: ['--test'], expectedExitCode: 300}})), /expectedExitCode/u);
		assert.throws(() => caseOf(baseCase({check: {command: '', args: []}})), /check.command/u);
	});

	it('suite schema accepts version 2 and rejects unknown or unsupported fields', () => {
		const parsed = suiteFieldsOf(baseSuite());

		assert.equal(parsed.schemaVersion, SUITE_SCHEMA_VERSION);
		assert.equal(parsed.caseHashes, null);
		assert.throws(() => suiteFieldsOf(baseSuite({schemaVersion: 3})), /schemaVersion/u);
		assert.throws(() => suiteFieldsOf(baseSuite({unexpected: true})), /unknown field.*unexpected/u);
		assert.throws(() => suiteFieldsOf(baseSuite({cases: []})), /must not be empty/u);
		assert.throws(() => suiteFieldsOf(baseSuite({schemaVersion: 1})), /schemaVersion/u);
		assert.throws(() => suiteFieldsOf(baseSuite({treatments: []})), /treatments.*non-empty/u);
		assert.throws(() => suiteFieldsOf(baseSuite({treatments: baseTreatments().slice(0, 2)})), /missing treatment/u);
	});

	it('frozen suite requires a hash for every case and rejects changed content', (testContext) => {
		const original = baseCase();
		const pinned = caseHashOf(caseOf(original));
		const suite = baseSuite({status: 'frozen', caseHashes: {'case-a': pinned}});
		const {suitePath} = corpus(testContext, {suite, cases: {'case-a': original}});
		const loaded = loadSuite(suitePath);

		assert.equal(loaded.suite.status, 'frozen');
		assert.deepEqual(loaded.suite.caseHashes, {'case-a': pinned});
		assert.match(loaded.suite.hash, /^[0-9a-f]{64}$/u);

		const changed = baseCase({prompt: 'Changed prompt'});
		writeFileSync(path.join(path.dirname(path.dirname(suitePath)), 'cases', 'case-a.json'), `${JSON.stringify(changed, null, '\t')}\n`, 'utf8');
		assert.throws(() => loadSuite(suitePath), /new suite version/u);
	});

	it('frozen suite rejects a missing case hash set', () => {
		assert.throws(() => suiteFieldsOf(baseSuite({status: 'frozen'})), /caseHashes.*required/u);
		assert.throws(() => suiteFieldsOf(baseSuite({status: 'frozen', caseHashes: {}})), /exactly one entry per listed case/u);
	});

	it('canonical hashing ignores object key order and remains stable', () => {
		assert.equal(canonicalJson({b: 2, a: [1, {d: 4, c: 3}]}), '{"a":[1,{"c":3,"d":4}],"b":2}');
		assert.equal(hashOf({b: 2, a: 1}), hashOf({a: 1, b: 2}));
		assert.notEqual(hashOf({a: 1}), hashOf({a: 2}));
		assert.equal(caseHashOf(caseOf(baseCase())), caseHashOf(caseOf(baseCase())));
	});

	it('suite and treatment hashes are stable and content-bound', (testContext) => {
		const {suitePath} = corpus(testContext, {
			suite: baseSuite(),
			cases: {'case-a': baseCase()},
		});
		const first = loadSuite(suitePath);
		const second = loadSuite(suitePath);

		assert.equal(first.suite.hash, second.suite.hash);
		assert.equal(
			treatmentHashOf({id: 'accepted', artifact: 'a'.repeat(64), tools: ['find_symbol']}),
			treatmentHashOf({id: 'accepted', artifact: 'a'.repeat(64), tools: ['find_symbol']}),
		);
		assert.notEqual(
			treatmentHashOf({id: 'accepted', artifact: 'a'.repeat(64), tools: ['find_symbol']}),
			treatmentHashOf({id: 'accepted', artifact: 'b'.repeat(64), tools: ['find_symbol']}),
		);

		writeFileSync(
			path.join(path.dirname(path.dirname(suitePath)), 'cases', 'case-a.json'),
			`${JSON.stringify(baseCase({prompt: 'Changed prompt'}), null, '\t')}\n`,
			'utf8',
		);
		assert.notEqual(loadSuite(suitePath).suite.hash, first.suite.hash);
	});

	it('case selection is an ordered union and tags intersect', () => {
		const cases = [
			caseOf(baseCase({id: 'case-a', tags: ['locate', 'schema']})),
			caseOf(baseCase({id: 'case-b', tags: ['locate']})),
			caseOf(baseCase({id: 'case-c', tags: ['impact']})),
		];

		assert.deepEqual(
			selectCases(cases, {caseIds: ['case-c', 'case-a', 'case-c']}).map((item) => item.id),
			['case-c', 'case-a'],
		);
		assert.deepEqual(
			selectCases(cases, {tags: ['locate']}).map((item) => item.id),
			['case-a', 'case-b'],
		);
		assert.deepEqual(
			selectCases(cases, {caseIds: ['case-b', 'case-c'], tags: ['locate']}).map((item) => item.id),
			['case-b'],
		);
		assert.throws(() => selectCases(cases, {caseIds: ['missing']}), /unknown case/u);
		assert.throws(() => selectCases(cases, {tags: ['missing']}), /selection is empty/u);
		assert.throws(() => selectCases(cases, {caseIds: ['case-a'], tags: ['impact']}), /selection is empty/u);
	});

	it('repeated selection produces the same ordered plan and hash', () => {
		const cases = [caseOf(baseCase({id: 'case-a'})), caseOf(baseCase({id: 'case-b'}))];
		const first = planOf(selectCases(cases, {caseIds: ['case-b', 'case-a']}), ['no-index', 'accepted'], 2);
		const second = planOf(selectCases(cases, {caseIds: ['case-b', 'case-a']}), ['no-index', 'accepted'], 2);

		assert.deepEqual(first, second);
		assert.deepEqual(
			first.map((entry) => `${entry.caseId}/${entry.treatment}/${entry.repetition}`),
			[
				'case-b/no-index/1',
				'case-b/no-index/2',
				'case-b/accepted/1',
				'case-b/accepted/2',
				'case-a/no-index/1',
				'case-a/no-index/2',
				'case-a/accepted/1',
				'case-a/accepted/2',
			],
		);
		assert.equal(planHashOf(first), planHashOf(second));
	});

	it('--list and --dry-run start no model process', (testContext) => {
		const fixture = cliSandbox(testContext);
		const list = spawnSync(process.execPath, ['src/cli.ts', 'list', '--suite', fixture.suitePath], {
			cwd: fixture.root,
			env: fixture.env,
			encoding: 'utf8',
		});
		const dryRun = spawnSync(process.execPath, ['src/cli.ts', 'evaluate', '--suite', fixture.suitePath, '--case', 'case-a', '--dry-run'], {
			cwd: fixture.root,
			env: fixture.env,
			encoding: 'utf8',
		});

		assert.equal(list.status, 0, list.stderr);
		assert.equal(dryRun.status, 0, dryRun.stderr);
		assert.match(dryRun.stderr, /plan-hash [0-9a-f]{64}/u);
		assert.equal(existsSync(fixture.marker), false);
	});

	it('an empty selection fails before any process starts', (testContext) => {
		const fixture = cliSandbox(testContext);
		const result = spawnSync(process.execPath, ['src/cli.ts', 'evaluate', '--suite', fixture.suitePath, '--case', 'missing-case', '--dry-run'], {
			cwd: fixture.root,
			env: fixture.env,
			encoding: 'utf8',
		});

		assert.equal(result.status, 1);
		assert.match(result.stderr, /unknown case "missing-case"/u);
		assert.equal(existsSync(fixture.marker), false);
	});

	it('resume reuses completed slots and reruns only missing or partial ones', (testContext) => {
		const fixture = cliSandbox(testContext);
		const evaluate = (flags: readonly string[]): SpawnSyncReturns<string> =>
			spawnSync(
				process.execPath,
				['src/cli.ts', 'evaluate', '--suite', fixture.suitePath, '--case', 'case-a', '--treatment', 'no-index', '--repetitions', '2', ...flags],
				{cwd: fixture.root, env: fixture.env, encoding: 'utf8'},
			);
		const resultFiles = (): readonly string[] => {
			const root = path.join(fixture.root, 'results');

			return existsSync(root)
				? readdirSync(root, {recursive: true, encoding: 'utf8'})
						.filter((entry) => /^attempt-\d+\.json$/u.test(path.basename(entry)))
						.map((entry) => path.join(root, entry))
						.sort()
				: [];
		};
		const invocations = (): number => (existsSync(fixture.marker) ? Number(readFileSync(fixture.marker, 'utf8')) : 0);

		const first = evaluate([]);

		assert.equal(first.status, 0, first.stderr);
		assert.equal(invocations(), 2);
		assert.equal(resultFiles().length, 2);

		const resumed = evaluate(['--resume']);

		assert.equal(resumed.status, 0, resumed.stderr);
		assert.equal(invocations(), 2);
		assert.match(resumed.stderr, /resumed attempt 1/u);

		const [truncated, removed] = resultFiles();

		assert.notEqual(truncated, undefined);
		assert.ok(truncated !== undefined && removed !== undefined);
		writeFileSync(truncated, '{"recordType":"result"', 'utf8');
		rmSync(removed);

		const repaired = evaluate(['--resume']);

		assert.equal(repaired.status, 0, repaired.stderr);
		assert.equal(invocations(), 4);
		assert.equal(resultFiles().length, 3);
	});
});
