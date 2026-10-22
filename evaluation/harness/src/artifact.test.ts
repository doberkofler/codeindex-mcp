import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {artifactEntriesOf, artifactIdentityOf, artifactRefOf} from './artifact.ts';
import {treatmentOf, type TreatmentDefinitionType} from './treatment.ts';

const temporaryRoot = (testContext: TestContext): string => {
	const root = mkdtempSync(path.join(tmpdir(), 'codeindex-evaluation-artifact-'));
	testContext.after(() => {
		rmSync(root, {recursive: true, force: true});
	});

	return root;
};

const artifactOf = (declaredDigest: string | null = null): TreatmentDefinitionType =>
	treatmentOf({
		id: 'candidate',
		kind: 'codeindex',
		ordinaryTools: ['bash', 'glob', 'grep', 'list', 'read'],
		codeMode: 'absent',
		artifact: {
			id: 'codeindex-mcp-candidate',
			root: 'artifacts/candidate',
			entryPoint: 'mcp.mjs',
			digest: declaredDigest,
		},
		mcp: {server: 'codeindex', codemode: false},
	});

const stagedArtifact = (root: string): void => {
	mkdirSync(path.join(root, 'chunks'), {recursive: true});
	mkdirSync(path.join(root, 'node_modules', 'dependency'), {recursive: true});
	writeFileSync(path.join(root, 'package.json'), '{"name":"artifact","type":"module","dependencies":{}}\n', 'utf8');
	writeFileSync(path.join(root, 'mcp.mjs'), "import './chunks/server.mjs';\n", 'utf8');
	writeFileSync(path.join(root, 'chunks', 'server.mjs'), 'export const server = true;\n', 'utf8');
	writeFileSync(path.join(root, 'node_modules', 'dependency', 'index.js'), 'module.exports = 1;\n', 'utf8');
};

void test('an artifact identity hashes its own files and ignores dependencies', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const artifactRoot = path.join(root, 'artifacts', 'candidate');

	stagedArtifact(artifactRoot);

	const identity = artifactIdentityOf(artifactRoot, artifactOf());

	assert.equal(identity.id, 'codeindex-mcp-candidate');
	assert.equal(identity.entryPoint, 'mcp.mjs');
	assert.equal(identity.declaredDigest, null);
	assert.equal(identity.fileCount, 3);
	assert.equal(identity.dependencies.length, 0);
	assert.match(identity.digest, /^[0-9a-f]{64}$/u);
	assert.deepEqual(artifactRefOf(identity), {id: 'codeindex-mcp-candidate', digest: identity.digest});

	// The digest covers file content, not staging order or mtimes.
	writeFileSync(path.join(artifactRoot, 'chunks', 'server.mjs'), 'export const server = false;\n', 'utf8');
	assert.notEqual(artifactIdentityOf(artifactRoot, artifactOf()).digest, identity.digest);
	assert.equal(
		artifactEntriesOf(artifactRoot).some((entry) => entry.path.startsWith('node_modules/')),
		false,
	);
});

void test('a declared digest is verified before any model starts', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const artifactRoot = path.join(root, 'artifacts', 'candidate');

	stagedArtifact(artifactRoot);

	const computed = artifactIdentityOf(artifactRoot, artifactOf()).digest;
	const verified = artifactIdentityOf(artifactRoot, artifactOf(computed));

	assert.equal(verified.digest, computed);
	assert.equal(verified.declaredDigest, computed);

	assert.throws(() => artifactIdentityOf(artifactRoot, artifactOf('0'.repeat(64))), /artifact codeindex-mcp-candidate digest mismatch/u);

	writeFileSync(path.join(artifactRoot, 'chunks', 'server.mjs'), 'export const server = false;\n', 'utf8');
	assert.throws(() => artifactIdentityOf(artifactRoot, artifactOf(computed)), /digest mismatch/u);
});

void test('a missing entry point or dependency is rejected', (testContext: TestContext) => {
	const root = temporaryRoot(testContext);
	const artifactRoot = path.join(root, 'artifacts', 'candidate');

	stagedArtifact(artifactRoot);
	rmSync(path.join(artifactRoot, 'mcp.mjs'));
	assert.throws(() => artifactIdentityOf(artifactRoot, artifactOf()), /entry point is missing/u);

	stagedArtifact(artifactRoot);
	writeFileSync(path.join(artifactRoot, 'package.json'), '{"name":"artifact","type":"module","dependencies":{"missing-dependency":"1.0.0"}}\n', 'utf8');
	assert.throws(() => artifactIdentityOf(artifactRoot, artifactOf()), /missing dependencies: missing-dependency/u);

	rmSync(path.join(artifactRoot, 'package.json'));
	assert.throws(() => artifactIdentityOf(artifactRoot, artifactOf()), /artifact package is missing/u);
});
