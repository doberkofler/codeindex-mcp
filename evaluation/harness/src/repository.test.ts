import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {describe, it} from 'vitest';
import ts from 'typescript';
import {caseOf, type CaseType} from './schema.ts';
import {loadSuite} from './suite.ts';

const HARNESS_ROOT = path.resolve(import.meta.dirname, '..');
const EVALUATION_ROOT = path.resolve(HARNESS_ROOT, '..');
const SUBJECT_ROOT = path.resolve(EVALUATION_ROOT, '..');
const SOURCE_ROOT = path.join(SUBJECT_ROOT, 'src');
const SCOPE_PREFIX = 'src/';

type ReferenceProbeType = Readonly<{
	caseId: string;
	/** Repository-relative declaration file. */
	file: string;
	/** Declared symbol name, or the alias name for a renamed re-export. */
	name: string;
	/** How the declaration is reached from the file. */
	kind: 'declaration' | 'alias';
	/** Identifiers a model-free text search could reasonably use. */
	grepIdentifiers: readonly string[];
}>;

type LocateProbeType = Readonly<{
	caseId: string;
	file: string;
	/** Declared symbol that must exist in the file, or null for a literal marker. */
	name: string | null;
	/** Literal text that must occur in the file when name is null. */
	text: string | null;
}>;

const REFERENCE_PROBES: readonly ReferenceProbeType[] = [
	{
		caseId: 'impact-build-generation-references',
		file: 'src/core/generation/buildGeneration.ts',
		name: 'buildGeneration',
		kind: 'declaration',
		grepIdentifiers: ['buildGeneration'],
	},
	{
		caseId: 'impact-hash-content-references',
		file: 'src/core/generation/sourceFiles.ts',
		name: 'hashContent',
		kind: 'declaration',
		grepIdentifiers: ['hashContent'],
	},
	{
		caseId: 'impact-bounded-paged-result-references',
		file: 'src/core/query/querySupport.ts',
		name: 'boundedPagedResult',
		kind: 'declaration',
		grepIdentifiers: ['boundedPagedResult'],
	},
	{
		caseId: 'impact-schema-version-references',
		file: 'src/core/storage/schema.ts',
		name: 'SCHEMA_VERSION',
		kind: 'declaration',
		grepIdentifiers: ['SCHEMA_VERSION'],
	},
	{
		caseId: 'impact-config-load-references',
		file: 'src/core/config/config.ts',
		name: 'loadConfig',
		kind: 'declaration',
		grepIdentifiers: ['loadConfig'],
	},
	{
		caseId: 'impact-codeindex-error-references-v2',
		file: 'src/core/errors/codeIndexError.ts',
		name: 'CodeIndexError',
		kind: 'declaration',
		grepIdentifiers: ['CodeIndexError'],
	},
	{
		caseId: 'semantic-repo-shadowed-projection-depth',
		file: 'src/core/qualification/publication/projectionModel.ts',
		name: 'MAX_PROJECTION_DEPTH',
		kind: 'declaration',
		grepIdentifiers: ['MAX_PROJECTION_DEPTH'],
	},
	{
		caseId: 'semantic-repo-renamed-name-node',
		file: 'src/adapters/typescript/extractSymbols.ts',
		name: 'candidateNameNode',
		kind: 'alias',
		grepIdentifiers: ['candidateNameNode', 'nameNodeOf'],
	},
];

const LOCATE_PROBES: readonly LocateProbeType[] = [
	{
		caseId: 'locate-schema-version',
		file: 'src/core/storage/schema.ts',
		name: 'SCHEMA_VERSION',
		text: null,
	},
	{
		caseId: 'locate-read-symbol-tool',
		file: 'src/transports/mcp/buildMcpServer.ts',
		name: null,
		text: 'read_symbol',
	},
	{
		caseId: 'locate-stale-file-error',
		file: 'src/core/errors/staleFileError.ts',
		name: 'StaleFileError',
		text: null,
	},
	{
		caseId: 'locate-result-size-guard',
		file: 'src/core/query/querySupport.ts',
		name: 'boundedPagedResult',
		text: null,
	},
];

type LanguageServiceType = Readonly<{service: ts.LanguageService; program: ts.Program}>;

const languageServiceOf = (root: string): LanguageServiceType => {
	const configPath = path.join(root, 'tsconfig.json');
	const config = ts.readConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));

	if (config.error !== undefined) {
		throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
	}

	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
	const options: ts.CompilerOptions = {...parsed.options, noEmit: true};
	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => parsed.fileNames,
		getScriptVersion: () => '1',
		getScriptSnapshot: (fileName) => {
			const text = ts.sys.readFile(fileName);

			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
		},
		getCurrentDirectory: () => root,
		getCompilationSettings: () => options,
		getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
		fileExists: ts.sys.fileExists.bind(ts.sys),
		readFile: ts.sys.readFile.bind(ts.sys),
		readDirectory: ts.sys.readDirectory.bind(ts.sys),
		directoryExists: ts.sys.directoryExists.bind(ts.sys),
		getDirectories: ts.sys.getDirectories.bind(ts.sys),
	};
	const service = ts.createLanguageService(host, ts.createDocumentRegistry());
	const program = service.getProgram();

	if (program === undefined) {
		throw new Error(`unable to create a program for ${root}`);
	}

	return {service, program};
};

const namedDeclarationOf = (program: ts.Program, file: string, name: string): Readonly<{sourceFile: ts.SourceFile; nameNode: ts.Node}> => {
	const sourceFile = program.getSourceFile(path.join(SUBJECT_ROOT, file));

	if (sourceFile === undefined) {
		throw new Error(`repository file is missing: ${file}`);
	}

	let found: ts.Node | undefined;

	const visit = (node: ts.Node): void => {
		const named =
			ts.isVariableDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isPropertyDeclaration(node) ||
			ts.isPropertySignature(node);

		if (named && node.name?.getText(sourceFile) === name) {
			found = node.name;
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	if (found === undefined) {
		throw new Error(`declaration ${name} is missing from ${file}`);
	}

	return {sourceFile, nameNode: found};
};

const aliasDeclarationOf = (program: ts.Program, file: string, name: string): Readonly<{sourceFile: ts.SourceFile; nameNode: ts.Node}> => {
	const sourceFile = program.getSourceFile(path.join(SUBJECT_ROOT, file));

	if (sourceFile === undefined) {
		throw new Error(`repository file is missing: ${file}`);
	}

	let found: ts.Node | undefined;

	const visit = (node: ts.Node): void => {
		if (ts.isExportSpecifier(node) && node.name.text === name) {
			found = node.name;
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);

	if (found === undefined) {
		throw new Error(`re-export alias ${name} is missing from ${file}`);
	}

	return {sourceFile, nameNode: found};
};

const enclosingNodeOf = (sourceFile: ts.SourceFile, position: number): ts.Node | undefined => {
	const find = (node: ts.Node): ts.Node | undefined => {
		if (position < node.getFullStart() || position >= node.getEnd()) {
			return undefined;
		}

		for (const child of node.getChildren(sourceFile)) {
			const found = find(child);

			if (found !== undefined) {
				return found;
			}
		}

		return node;
	};

	return find(sourceFile);
};

const inImportOrExport = (sourceFile: ts.SourceFile, position: number): boolean => {
	let node = enclosingNodeOf(sourceFile, position);

	while (node !== undefined) {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			return true;
		}

		node = node.parent;
	}

	return false;
};

const posixRelativeOf = (absolute: string): string => path.relative(SUBJECT_ROOT, absolute).split(path.sep).join('/');

const truthFilesOf = (language: LanguageServiceType, probe: ReferenceProbeType): readonly string[] => {
	const absoluteFile = path.join(SUBJECT_ROOT, probe.file);
	const declaration =
		probe.kind === 'alias' ? aliasDeclarationOf(language.program, probe.file, probe.name) : namedDeclarationOf(language.program, probe.file, probe.name);
	const symbols = language.service.findReferences(absoluteFile, declaration.nameNode.getStart()) ?? [];
	const files = new Set<string>();

	for (const symbol of symbols) {
		for (const reference of symbol.references) {
			if (reference.isDefinition === true) {
				continue;
			}

			const sourceFile = language.program.getSourceFile(reference.fileName);

			if (sourceFile === undefined || inImportOrExport(sourceFile, reference.textSpan.start)) {
				continue;
			}

			const relative = posixRelativeOf(reference.fileName);

			if (relative.startsWith(SCOPE_PREFIX)) {
				files.add(relative);
			}
		}
	}

	return [...files].sort();
};

const sourceFilesOf = (directory: string): readonly string[] =>
	readdirSync(directory)
		.sort()
		.flatMap((entry) => {
			const full = path.join(directory, entry);

			if (statSync(full).isDirectory()) {
				return sourceFilesOf(full);
			}

			return full.endsWith('.ts') ? [full] : [];
		});

const textSearchFilesOf = (identifier: string): readonly string[] => {
	const pattern = new RegExp(`\\b${identifier}\\b`, 'u');

	return sourceFilesOf(SOURCE_ROOT)
		.filter((file) => pattern.test(readFileSync(file, 'utf8')))
		.map((file) => posixRelativeOf(file))
		.sort();
};

type GrepMeasurementType = Readonly<{
	identifier: string;
	matched: readonly string[];
	precision: number;
	missing: readonly string[];
}>;

const grepMeasurementOf = (identifier: string, expected: readonly string[]): GrepMeasurementType => {
	const matched = textSearchFilesOf(identifier);
	const expectedFiles = new Set(expected);
	const intersection = matched.filter((file) => expectedFiles.has(file));

	return {
		identifier,
		matched,
		precision: matched.length === 0 ? 0 : intersection.length / matched.length,
		missing: expected.filter((file) => !matched.includes(file)),
	};
};

const caseOfId = (caseId: string): CaseType => {
	const file = path.join(EVALUATION_ROOT, 'cases', `${caseId}.json`);
	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
	const testCase = caseOf(parsed);

	assert.equal(testCase.id, caseId);

	return testCase;
};

const language = languageServiceOf(SUBJECT_ROOT);
const repositorySuite = loadSuite(path.join(EVALUATION_ROOT, 'suites', 'repository.json'));

describe('repository', () => {
	it('repository suite pins one CodeIndex revision and covers four task classes', () => {
		assert.equal(repositorySuite.suite.id, 'codeindex-repository');
		assert.equal(repositorySuite.suite.status, 'draft');
		assert.match(repositorySuite.suite.revision, /^[0-9a-f]{40}$/u);
		assert.equal(repositorySuite.cases.length, 14);

		const counts = new Map<string, number>();

		for (const testCase of repositorySuite.cases) {
			counts.set(testCase.class, (counts.get(testCase.class) ?? 0) + 1);
		}

		assert.deepEqual(Object.fromEntries([...counts.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))), {
			impact: 6,
			implementation: 2,
			locate: 4,
			semantic: 2,
		});
	});

	it('every declared repository path exists at the pinned source tree', () => {
		for (const testCase of repositorySuite.cases) {
			for (const file of [...testCase.expectedFiles, ...testCase.contextFiles, ...testCase.forbiddenFiles]) {
				assert.ok(existsSync(path.join(SUBJECT_ROOT, file)), `${testCase.id} references missing path ${file}`);
			}

			if (testCase.class !== 'implementation') {
				assert.deepEqual(testCase.scope, ['src/**']);
			}
		}
	});

	it('locate cases name the authoritative declaration or marker', () => {
		for (const probe of LOCATE_PROBES) {
			const testCase = caseOfId(probe.caseId);
			const text = readFileSync(path.join(SUBJECT_ROOT, probe.file), 'utf8');

			assert.equal(testCase.class, 'locate');
			assert.deepEqual(testCase.expectedFiles, [probe.file]);

			if (probe.name === null) {
				assert.ok(text.includes(probe.text ?? ''), `${probe.caseId} marker is missing from ${probe.file}`);
			} else {
				assert.doesNotThrow(() => namedDeclarationOf(language.program, probe.file, probe.name ?? ''));
			}
		}
	});

	it('impact and repository semantic cases match the language service', () => {
		for (const probe of REFERENCE_PROBES) {
			const testCase = caseOfId(probe.caseId);
			const expected = [...testCase.expectedFiles].sort();
			const truth = truthFilesOf(language, probe);

			assert.equal(testCase.class, probe.caseId.startsWith('semantic-') ? 'semantic' : 'impact', probe.caseId);
			assert.deepEqual(expected, truth, `${probe.caseId} expected file set differs from the language service`);
		}
	});

	it.each(REFERENCE_PROBES.filter((item) => item.caseId.startsWith('semantic-')))('$caseId admits no exact identifier grep', (probe) => {
		const testCase = caseOfId(probe.caseId);
		const expected = [...testCase.expectedFiles].sort();
		const measurements = probe.grepIdentifiers.map((identifier) => grepMeasurementOf(identifier, expected));
		const best = measurements.reduce((left, right) => {
			if (right.precision !== left.precision) {
				return right.precision > left.precision ? right : left;
			}

			return right.missing.length < left.missing.length ? right : left;
		});

		assert.ok(
			best.precision <= 0.5 || best.missing.length > 0,
			`${probe.caseId} admits identifier grep "${best.identifier}" with precision ${best.precision.toFixed(2)} and no missing expected file`,
		);
	});

	it('implementation cases declare exact changed files and deterministic checks', () => {
		for (const testCase of repositorySuite.cases.filter((item) => item.class === 'implementation')) {
			assert.ok(testCase.check !== null, `${testCase.id} declares no post-run check`);
			assert.ok(
				testCase.check.args.some((argument) => argument.startsWith('test/')),
				`${testCase.id} check does not run a test file`,
			);
			assert.ok(
				testCase.check.args.some((argument) => argument === '--coverage.enabled=false'),
				`${testCase.id} check must disable unrelated coverage thresholds`,
			);

			const testFile = testCase.check.args.find((argument) => argument.startsWith('test/'));

			assert.ok(testFile !== undefined);
			assert.ok(testCase.expectedFiles.includes(testFile), `${testCase.id} check test is outside the allowed changed-file set`);
			assert.ok(existsSync(path.join(SUBJECT_ROOT, testFile)), `${testCase.id} check test is missing`);

			const sourceFile = testCase.expectedFiles.find((file) => file.startsWith(SCOPE_PREFIX));

			assert.ok(sourceFile !== undefined, `${testCase.id} declares no source file`);
			assert.ok(existsSync(path.join(SUBJECT_ROOT, sourceFile)), `${testCase.id} source file is missing`);

			for (const file of testCase.expectedFiles) {
				assert.ok(testCase.prompt.includes(file), `${testCase.id} prompt does not name ${file}`);
			}
		}
	});
});
