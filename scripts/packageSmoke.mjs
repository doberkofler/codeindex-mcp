#!/usr/bin/env node
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- NOTE: untyped Node tooling script; inputs are literal argument arrays. */
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const work = mkdtempSync(path.join(tmpdir(), 'codeindex-packages-'));
const packs = path.join(work, 'packs');
mkdirSync(packs, {recursive: true});
const RUNTIME_DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {cwd: options.cwd ?? root, encoding: 'utf8', env: {...process.env, ...options.env}, stdio: options.stdio ?? 'pipe'});

	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
	}

	return result;
};

const pack = (filter) => {
	run('pnpm', ['--filter', filter, 'pack', '--pack-destination', packs]);
};

const manifestOf = (packageDirectory) => JSON.parse(readFileSync(path.join(root, packageDirectory, 'package.json'), 'utf8'));

// `pnpm pack` derives the artifact name from the package name and version, so
// the smoke test must derive it the same way instead of pinning a release.
const tarballOf = (packageDirectory) => {
	const {name, version} = manifestOf(packageDirectory);

	return path.join(packs, `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`);
};

const packedManifestOf = (tarball) => JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']).stdout);

// Published consumers install only runtime dependencies. A `workspace:` spec that
// survives packing cannot be resolved outside this repository, so the release must
// fail here rather than at the first consumer installation.
const assertNoWorkspaceSpecs = (label, manifest) => {
	for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
		for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
			if (typeof spec === 'string' && spec.startsWith('workspace:')) {
				throw new Error(`${label} publishes an unresolvable workspace dependency: ${section}.${name}=${spec}`);
			}
		}
	}
};

const install = (consumer, tarballs) => {
	writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({name: path.basename(consumer), private: true, type: 'module'}, null, '\t'));
	run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], {cwd: consumer});
};

const cli = (consumer, args, env) =>
	run(process.execPath, [path.join(consumer, 'node_modules', 'codeindex-mcp', 'dist', 'cli.mjs'), ...args], {cwd: consumer, env});

const statusJson = (consumer, env) => {
	const parsed = JSON.parse(cli(consumer, ['status', '--json'], env).stdout);
	return parsed;
};

const assertAbsent = (consumer, name) => {
	if (existsSync(path.join(consumer, 'node_modules', name))) {
		throw new Error(`unexpected installed package: ${name}`);
	}
};

try {
	run('pnpm', ['run', 'build:packages']);
	run('pnpm', ['run', 'build']);
	pack('@codeindex/adapter-sdk');
	pack('@codeindex/adapter-typescript');
	pack('@codeindex/adapter-oracle');
	pack('codeindex-mcp');

	const files = {
		sdk: tarballOf('packages/adapter-sdk'),
		typescript: tarballOf('packages/adapter-typescript'),
		oracle: tarballOf('packages/adapter-oracle'),
		host: tarballOf('.'),
	};
	for (const [label, file] of Object.entries(files)) {
		if (!existsSync(file)) {
			throw new Error(`missing ${label} tarball: ${file}`);
		}

		assertNoWorkspaceSpecs(label, packedManifestOf(file));
	}

	const typescriptConsumer = path.join(work, 'typescript-consumer');
	mkdirSync(typescriptConsumer);
	install(typescriptConsumer, [files.sdk, files.host, files.typescript]);
	const typescriptWorkspace = path.join(typescriptConsumer, 'workspace');
	cpSync(path.join(root, 'test', 'fixtures', 'simple-project'), typescriptWorkspace, {recursive: true});
	const storage = path.join(typescriptConsumer, 'storage');
	const env = {CODE_INDEX_ROOT: typescriptWorkspace, CODE_INDEX_DATABASE: path.join(storage, 'index.sqlite'), CODE_INDEX_LOG_LEVEL: 'error'};
	cli(typescriptConsumer, ['update'], env);
	const status = statusJson(typescriptConsumer, env);

	if (!(status.counts?.files > 0)) {
		throw new Error('TypeScript-only consumer published no files');
	}
	assertAbsent(typescriptConsumer, '@codeindex/adapter-oracle');
	assertAbsent(typescriptConsumer, 'antlr4ng');
	assertAbsent(typescriptConsumer, 'oracledb');

	const oracleConsumer = path.join(work, 'oracle-consumer');
	mkdirSync(oracleConsumer);
	install(oracleConsumer, [files.sdk, files.host, files.oracle]);
	const oracleWorkspace = path.join(oracleConsumer, 'workspace');
	cpSync(path.join(root, 'test', 'fixtures', 'oracle-project'), oracleWorkspace, {recursive: true});
	const oracleEnv = {
		CODE_INDEX_ROOT: oracleWorkspace,
		CODE_INDEX_PROJECT_FILE: path.join(oracleWorkspace, 'oracle-index.json'),
		CODE_INDEX_EXTRACTOR: 'oracle',
		CODE_INDEX_DATABASE: path.join(oracleConsumer, 'storage', 'index.sqlite'),
		CODE_INDEX_LOG_LEVEL: 'error',
	};
	cli(oracleConsumer, ['update'], oracleEnv);
	const oracleStatus = statusJson(oracleConsumer, oracleEnv);

	if (!(oracleStatus.counts?.files > 0)) {
		throw new Error('Oracle-only consumer published no files');
	}
	assertAbsent(oracleConsumer, '@codeindex/adapter-typescript');
	assertAbsent(oracleConsumer, 'typescript');
	assertAbsent(oracleConsumer, 'oracledb');

	const fixturePackage = path.join(work, 'fixture-adapter');
	mkdirSync(path.join(fixturePackage, 'dist'), {recursive: true});
	writeFileSync(
		path.join(fixturePackage, 'package.json'),
		JSON.stringify({name: '@fixture/adapter-text', version: '1.0.0', type: 'module', exports: {'.': './dist/index.js'}}, null, '\t'),
	);
	writeFileSync(
		path.join(fixturePackage, 'dist', 'index.js'),
		`import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';\nimport {join} from 'node:path';\nimport {createHash} from 'node:crypto';\n\nconst filesOf = (root) => readdirSync(root, {withFileTypes: true}).flatMap((entry) => {\n\tconst full = join(root, entry.name);\n\treturn entry.isDirectory() ? filesOf(full) : entry.name.endsWith('.txt') ? [full] : [];\n});\n\nexport const codeIndexAdapter = {\n\tmanifest: {protocolVersion: 1, id: 'fixture-text', implementationVersion: '1.0.0', displayName: 'Fixture text'},\n\tcreate: () => ({\n\t\tid: 'fixture-text', version: '1.0.0', displayName: 'Fixture text', discoveryText: 'fixture',\n\t\tsourceExtensions: ['.txt'], ignoredSegments: ['node_modules'], limitations: [],\n\t\tscan: (config) => {\n\t\t\tconst files = filesOf(config.rootDir).map((absolutePath) => {\n\t\t\t\tconst content = readFileSync(absolutePath);\n\t\t\t\tconst relative = absolutePath.slice(config.rootDir.length + 1).split('\\\\').join('/');\n\t\t\t\treturn {path: relative, absolutePath, sha256: createHash('sha256').update(content).digest('hex'), byteCount: content.length, lineCount: 1};\n\t\t\t});\n\t\t\tconst sourceHash = createHash('sha256').update(files.map((file) => file.sha256).join('')).digest('hex');\n\t\t\treturn {rootDir: config.rootDir, projectId: config.projectId, extractorId: 'fixture-text', extractorVersion: '1.0.0', compilerVersion: 'none', declaredCompilerVersion: null, compilerDrift: false, files, sourceHash, configHash: 'fixture', projects: [{name: 'root', projectFile: 'fixture.json', configHash: 'fixture', projectFileCount: 0, configDiagnosticCount: 0}], projectFileCount: 0, excludedFileCount: 0, configDiagnosticCount: 0, scanMs: 0};\n\t\t},\n\t\tbuild: (_config, scan) => ({\n\t\t\tfiles: scan.files,\n\t\t\tsymbols: scan.files.map((file) => ({id: 't_' + file.path, name: file.path, qualifiedName: file.path, kind: 'file', path: file.path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, startOffset: 0, endOffset: 1, enclosingId: null, contexts: ['root']})),\n\t\t\tbindings: scan.files.map((file) => ({symbolId: 't_' + file.path, segments: [['name', file.path]], bindingKey: 'file', container: '', name: file.path, qualifiedName: file.path, exposure: 'internal', hasDeclaredSite: true})), bindingContexts: scan.files.map((file) => ({symbolId: 't_' + file.path, segments: [['name', file.path]], context: 'root', exposure: 'internal'})), bindingSites: scan.files.map((file) => ({symbolId: 't_' + file.path, segments: [['name', file.path]], kind: 'declared', path: file.path, range: {startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, startOffset: 0, endOffset: 1}})), surfaceOrigins: [], occurrences: scan.files.map((file) => ({symbolId: 't_' + file.path, path: file.path, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, startOffset: 0, endOffset: 1, role: 'definition', enclosingId: null, declarationKind: 'file', forwardDefinition: false, extent: {startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, startOffset: 0, endOffset: 1}, anchorRank: 0, primaryRank: 0, contexts: ['root']})), dependencies: {edges: [], bindings: []}, adapterStats: [], diagnostics: [], compilerMs: 0, extractionMs: 0,\n\t\t}),\n\t\tconfigFiles: () => [], isSourceFile: (absolutePath) => absolutePath.endsWith('.txt'),\n\t}),\n};\n`,
	);
	run('pnpm', ['pack', '--pack-destination', packs], {cwd: fixturePackage});

	const fixtureConsumer = path.join(work, 'fixture-consumer');
	mkdirSync(fixtureConsumer);
	install(fixtureConsumer, [files.sdk, files.host, path.join(packs, 'fixture-adapter-text-1.0.0.tgz')]);
	const fixtureWorkspace = path.join(fixtureConsumer, 'workspace');
	mkdirSync(fixtureWorkspace, {recursive: true});
	writeFileSync(path.join(fixtureWorkspace, 'notes.txt'), 'hello\n');
	writeFileSync(path.join(fixtureWorkspace, 'fixture.json'), '{}\n');
	writeFileSync(
		path.join(fixtureConsumer, 'codeindex.config.json'),
		JSON.stringify(
			{project: {name: 'fixture', root: fixtureWorkspace}, extractors: [{id: 'fixture-text', module: '@fixture/adapter-text', project: 'fixture.json'}]},
			null,
			'\t',
		),
	);
	const fixtureEnv = {
		CODE_INDEX_CONFIG: path.join(fixtureConsumer, 'codeindex.config.json'),
		CODE_INDEX_DATABASE: path.join(fixtureConsumer, 'storage', 'index.sqlite'),
		CODE_INDEX_LOG_LEVEL: 'error',
	};
	cli(fixtureConsumer, ['update'], fixtureEnv);
	const fixtureStatus = statusJson(fixtureConsumer, fixtureEnv);

	if (!(fixtureStatus.counts?.symbols > 0)) {
		throw new Error('third-party fixture adapter published no symbols');
	}

	process.stdout.write('package smoke passed\n');
} finally {
	rmSync(work, {recursive: true, force: true});
}
