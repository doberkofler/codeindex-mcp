import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it, type TestContext} from 'vitest';
import {identityDigestOf, identityOf, type IdentityType} from './identity.ts';
import {catalogOf} from './mcp.ts';
import {caseOf, suiteFieldsOf, type CaseType, type SuiteType} from './schema.ts';
import {planOf, resolveTreatmentOf} from './suite.ts';
import {routingOf, toolSurfaceOf, treatmentDifferencesOf, treatmentOf, validateTreatmentSet, type TreatmentDefinitionType} from './treatment.ts';

const ORDINARY = ['bash', 'glob', 'grep', 'list', 'read'];

const rawTreatments = (): readonly Record<string, unknown>[] => [
	{id: 'no-index', kind: 'no-index', ordinaryTools: ORDINARY, codeMode: 'absent', artifact: null, mcp: null},
	{
		id: 'accepted',
		kind: 'codeindex',
		ordinaryTools: ORDINARY,
		codeMode: 'absent',
		artifact: {id: 'accepted', root: 'artifacts/accepted', entryPoint: 'mcp.mjs'},
		mcp: {server: 'codeindex', codemode: false},
	},
	{
		id: 'candidate',
		kind: 'codeindex',
		ordinaryTools: ORDINARY,
		codeMode: 'absent',
		artifact: {id: 'candidate', root: 'artifacts/candidate', entryPoint: 'mcp.mjs'},
		mcp: {server: 'codeindex', codemode: false},
	},
];

const treatments = (): readonly TreatmentDefinitionType[] => rawTreatments().map((value) => treatmentOf(value));

const suite = (overrides: Record<string, unknown> = {}): SuiteType => {
	const fields = suiteFieldsOf({
		schemaVersion: 2,
		id: 'suite-a',
		version: 1,
		status: 'draft',
		revision: 'abc1234',
		model: 'ollama/qwen3:8b',
		repetitions: 1,
		treatments: rawTreatments(),
		cases: ['case-a'],
		...overrides,
	});

	return {...fields, hash: 'a'.repeat(64)};
};

const caseA = (): CaseType =>
	caseOf({
		schemaVersion: 1,
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
	});

describe('treatment', () => {
	it('treatment definitions are data with a stable hash', () => {
		const first = treatments();
		const second = treatments();

		assert.equal(first.length, 3);
		assert.deepEqual(
			first.map((treatment) => treatment.id),
			['no-index', 'accepted', 'candidate'],
		);
		assert.deepEqual(
			first.map((treatment) => treatment.definitionHash),
			second.map((treatment) => treatment.definitionHash),
		);
		assert.match(first[1]?.definitionHash ?? '', /^[0-9a-f]{64}$/u);
		assert.notEqual(first[1]?.definitionHash, first[2]?.definitionHash);
	});

	it('treatment definitions reject invalid shapes and artifact paths', () => {
		assert.throws(() => treatmentOf({...rawTreatments()[0], codeMode: 'available'}), /codeMode/u);
		assert.throws(() => treatmentOf({...rawTreatments()[0], artifact: {id: 'x', root: 'x', entryPoint: 'x'}}), /neither artifact nor mcp/u);
		assert.throws(() => treatmentOf({...rawTreatments()[1], artifact: null}), /both artifact and mcp/u);
		assert.throws(() => treatmentOf({...rawTreatments()[1], artifact: {id: 'x', root: '/abs', entryPoint: 'mcp.mjs'}}), /relative POSIX path/u);
		assert.throws(() => treatmentOf({...rawTreatments()[1], unexpected: true}), /unknown field/u);
	});

	it('treatment equivalence rejects a tool-list mismatch', () => {
		const changed = treatments().map((treatment, index) =>
			index === 2 ? treatmentOf({...rawTreatments()[2], ordinaryTools: [...ORDINARY, 'webfetch']}) : treatment,
		);

		assert.match(treatmentDifferencesOf(changed).join('\n'), /ordinary tools differ/u);
		assert.throws(() => validateTreatmentSet(changed), /not equivalent/u);
	});

	it('treatment equivalence rejects configuration and MCP mismatches', () => {
		const missing = treatments().slice(0, 2);
		const mcp = treatments().map((treatment, index) =>
			index === 2 ? treatmentOf({...rawTreatments()[2], mcp: {server: 'other', codemode: false}}) : treatment,
		);

		assert.match(treatmentDifferencesOf(missing).join('\n'), /expected 3 treatments|missing treatment/u);
		assert.match(treatmentDifferencesOf(mcp).join('\n'), /MCP server differs/u);
	});

	it('surface capture prefixes native MCP tools and records routing', () => {
		const [, accepted] = treatments();
		assert.ok(accepted !== undefined);
		const surface = toolSurfaceOf(accepted, ['find_symbol', 'read_symbol']);
		const routing = routingOf(surface, ['grep', 'codeindex_find_symbol', 'execute', 'mystery']);

		assert.deepEqual(surface.codeIndex, ['codeindex_find_symbol', 'codeindex_read_symbol']);
		assert.deepEqual(surface.tools, ['bash', 'codeindex_find_symbol', 'codeindex_read_symbol', 'glob', 'grep', 'list', 'read']);
		assert.equal(surface.native, true);
		assert.deepEqual(routing.unknownTools, ['execute', 'mystery']);
		assert.equal(routing.codeIndexCalls, 1);
		assert.equal(routing.executeCalls, 1);
		assert.equal(routing.native, false);

		const [noIndexTreatment] = treatments();

		assert.ok(noIndexTreatment !== undefined);

		const noIndex = toolSurfaceOf(noIndexTreatment);
		assert.deepEqual(noIndex.codeIndex, []);
		assert.deepEqual(noIndex.tools, [...ORDINARY].sort());
	});

	it('Code Mode presents execute while keeping the native catalog callable', () => {
		const direct = treatmentOf({
			id: 'direct-mcp',
			kind: 'codeindex',
			ordinaryTools: ORDINARY,
			codeMode: 'absent',
			artifact: {id: 'candidate', root: 'artifacts/candidate', entryPoint: 'mcp.mjs', digest: null},
			mcp: {server: 'codeindex', codemode: false},
		});
		const wrapped = treatmentOf({
			id: 'code-mode',
			kind: 'codeindex',
			ordinaryTools: ORDINARY,
			codeMode: 'present',
			artifact: {id: 'candidate', root: 'artifacts/candidate', entryPoint: 'mcp.mjs', digest: null},
			mcp: {server: 'codeindex', codemode: true},
		});

		assert.deepEqual(treatmentDifferencesOf([direct, wrapped]), []);

		const surface = toolSurfaceOf(wrapped, ['find_symbol', 'read_symbol']);

		assert.deepEqual(surface.codeIndex, ['codeindex_find_symbol', 'codeindex_read_symbol']);
		assert.deepEqual(surface.tools, ['bash', 'execute', 'glob', 'grep', 'list', 'read']);
		assert.deepEqual(surface.permitted, ['bash', 'codeindex_find_symbol', 'codeindex_read_symbol', 'execute', 'glob', 'grep', 'list', 'read']);
		assert.equal(routingOf(surface, ['execute', 'codeindex_find_symbol']).unknownTools.length, 0);
		assert.equal(routingOf(surface, ['codeindex_find_symbol']).unknownTools.length, 0);
	});

	it('exposure equivalence rejects a different artifact or a non-Code-Mode arm', () => {
		const direct = treatmentOf({
			id: 'direct-mcp',
			kind: 'codeindex',
			ordinaryTools: ORDINARY,
			codeMode: 'absent',
			artifact: {id: 'candidate', root: 'artifacts/candidate', entryPoint: 'mcp.mjs', digest: null},
			mcp: {server: 'codeindex', codemode: false},
		});
		const otherArtifact = treatmentOf({
			id: 'code-mode',
			kind: 'codeindex',
			ordinaryTools: ORDINARY,
			codeMode: 'present',
			artifact: {id: 'accepted', root: 'artifacts/accepted', entryPoint: 'mcp.mjs', digest: null},
			mcp: {server: 'codeindex', codemode: true},
		});

		assert.match(treatmentDifferencesOf([direct, otherArtifact]).join('\n'), /same artifact/u);
		assert.throws(() => treatmentOf({...rawTreatments()[0], codeMode: 'present'}), /codeMode/u);
	});

	it('catalog query returns the native tool names and rejects mismatches', async (testContext: TestContext) => {
		const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-mcp-'));
		const server = path.join(root, 'server.mjs');
		writeFileSync(
			server,
			[
				"import {createInterface} from 'node:readline';",
				"if (process.env.CODE_INDEX_ROOT !== undefined) { throw new Error('inherited CodeIndex configuration'); }",
				'const lines = createInterface({input: process.stdin});',
				"lines.on('line', (line) => {",
				'\tconst message = JSON.parse(line);',
				"\tif (message.method === 'initialize') {",
				"\t\tprocess.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fake', version: '1'}}}) + '\\n');",
				'\t}',
				"\tif (message.method === 'tools/list') {",
				"\t\tprocess.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result: {tools: [{name: 'read_symbol'}, {name: 'find_symbol'}]}}) + '\\n');",
				'\t}',
				'});',
				'',
			].join('\n'),
			'utf8',
		);
		testContext.onTestFinished(() => {
			rmSync(root, {recursive: true, force: true});
		});

		const inheritedRoot = process.env['CODE_INDEX_ROOT'];
		process.env['CODE_INDEX_ROOT'] = '/invalid/inherited/root';
		let catalog: Awaited<ReturnType<typeof catalogOf>>;

		try {
			catalog = await catalogOf(server, root);
		} finally {
			if (inheritedRoot === undefined) {
				delete process.env['CODE_INDEX_ROOT'];
			} else {
				process.env['CODE_INDEX_ROOT'] = inheritedRoot;
			}
		}

		assert.equal(catalog.serverName, 'fake');
		assert.deepEqual(catalog.tools, ['find_symbol', 'read_symbol']);
	});

	it('run identity changes on model, prompt, revision, and configuration', () => {
		const cases = [caseA()];
		const planHash = 'b'.repeat(64);
		const identity = (overrides: Record<string, unknown> = {}, caseOverrides: Record<string, unknown> = {}): IdentityType =>
			identityOf({
				suite: suite({...overrides}),
				cases: [caseOf({...caseA(), ...caseOverrides})],
				treatments: treatments(),
				repetitions: 1,
				planHash,
				harnessVersion: 1,
			});
		const baseline = identityDigestOf(identity());

		assert.equal(identityDigestOf(identity()), baseline);
		assert.notEqual(identityDigestOf(identity({model: 'other/model'})), baseline);
		assert.notEqual(identityDigestOf(identity({revision: 'def5678'})), baseline);
		assert.notEqual(identityDigestOf(identity({}, {prompt: 'Different prompt'})), baseline);
		const changedTools = rawTreatments().map((treatment) => ({...treatment, ordinaryTools: [...ORDINARY, 'webfetch']}));
		assert.notEqual(
			identityDigestOf(
				identityOf({
					suite: suite(),
					cases,
					treatments: changedTools.map((value) => treatmentOf(value)),
					repetitions: 1,
					planHash,
					harnessVersion: 1,
				}),
			),
			baseline,
		);
	});

	it('each planned execution resolves exactly one treatment', () => {
		const plan = planOf([caseA()], ['no-index', 'candidate'], 2);

		assert.equal(plan.length, 4);
		assert.equal(new Set(plan.map((entry) => `${entry.caseId}/${entry.treatment}/${entry.repetition}`)).size, 4);
		const [firstEntry, , thirdEntry] = plan;

		assert.ok(firstEntry !== undefined && thirdEntry !== undefined);
		assert.equal(resolveTreatmentOf(firstEntry, treatments()).id, 'no-index');
		assert.equal(resolveTreatmentOf(thirdEntry, treatments()).id, 'candidate');
		assert.throws(() => resolveTreatmentOf({caseId: 'case-a', treatment: 'missing', repetition: 1}, treatments()), /resolves 0/u);
	});
});
