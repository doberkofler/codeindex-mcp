import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {caseOf, type CaseType} from './schema.ts';
import {loadSuite} from './suite.ts';

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVALUATION_ROOT = path.resolve(HARNESS_ROOT, '..');
const FIXTURE_ROOT = path.join(EVALUATION_ROOT, 'fixtures', 'controlled-typescript');
const FIXTURE_PREFIX = 'evaluation/fixtures/controlled-typescript';
const SOURCE_ROOT = path.join(FIXTURE_ROOT, 'src');

type TruthKindType = 'usages' | 'implementations';

type ProbeType = Readonly<{
	caseId: string;
	/** Fixture-relative declaration file. */
	file: string;
	/** Declared symbol name at that file. */
	name: string;
	/** Ground-truth query kind. */
	kind: TruthKindType;
	/** Identifiers a model-free text search could reasonably use. */
	grepIdentifiers: readonly string[];
}>;

const PROBES: readonly ProbeType[] = [
	{
		caseId: 'semantic-renamed-reexport',
		file: 'src/renamed/source.ts',
		name: 'createProfile',
		kind: 'usages',
		grepIdentifiers: ['createProfile', 'createIdentity'],
	},
	{
		caseId: 'semantic-barrel-chain',
		file: 'src/barrels/deep/value.ts',
		name: 'pipelineLimit',
		kind: 'usages',
		grepIdentifiers: ['pipelineLimit', 'maximumPipeline'],
	},
	{
		caseId: 'semantic-shadowed-name',
		file: 'src/shadow/first.ts',
		name: 'Node',
		kind: 'usages',
		grepIdentifiers: ['Node'],
	},
	{
		caseId: 'semantic-interface-implementations',
		file: 'src/contracts/gateway.ts',
		name: 'PaymentGateway',
		kind: 'implementations',
		grepIdentifiers: ['PaymentGateway'],
	},
	{
		caseId: 'semantic-type-only-import',
		file: 'src/types/model.ts',
		name: 'InvoiceId',
		kind: 'usages',
		grepIdentifiers: ['InvoiceId', 'DocumentId'],
	},
	{
		caseId: 'semantic-default-export',
		file: 'src/defaults/clock.ts',
		name: 'MonotonicClock',
		kind: 'usages',
		grepIdentifiers: ['MonotonicClock'],
	},
];

type LanguageServiceType = Readonly<{service: ts.LanguageService; program: ts.Program}>;

const languageServiceOf = (root: string): LanguageServiceType => {
	const configPath = path.join(root, 'tsconfig.json');
	const config = ts.readConfigFile(configPath, ts.sys.readFile);

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
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
	};
	const service = ts.createLanguageService(host, ts.createDocumentRegistry());
	const program = service.getProgram();

	if (program === undefined) {
		throw new Error(`unable to create a program for ${root}`);
	}

	return {service, program};
};

const namedDeclarationOf = (program: ts.Program, file: string, name: string): Readonly<{sourceFile: ts.SourceFile; nameNode: ts.Node}> => {
	const sourceFile = program.getSourceFile(path.join(FIXTURE_ROOT, file));

	if (sourceFile === undefined) {
		throw new Error(`fixture file is missing: ${file}`);
	}

	let found: ts.Node | undefined;

	const visit = (node: ts.Node): void => {
		const named =
			ts.isVariableDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isFunctionDeclaration(node);

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

const posixRelativeOf = (absolute: string): string => path.relative(path.resolve(EVALUATION_ROOT, '..'), absolute).split(path.sep).join('/');

const truthFilesOf = (language: LanguageServiceType, probe: ProbeType): readonly string[] => {
	const absoluteFile = path.join(FIXTURE_ROOT, probe.file);
	const {nameNode} = namedDeclarationOf(language.program, probe.file, probe.name);
	const position = nameNode.getStart();

	if (probe.kind === 'implementations') {
		const implementations = language.service.getImplementationAtPosition(absoluteFile, position) ?? [];

		return [...new Set(implementations.map((implementation) => posixRelativeOf(implementation.fileName)))].sort();
	}

	const symbols = language.service.findReferences(absoluteFile, position) ?? [];
	const files = new Set<string>();

	for (const symbol of symbols) {
		for (const reference of symbol.references) {
			if (reference.isDefinition) {
				continue;
			}

			const sourceFile = language.program.getSourceFile(reference.fileName);

			if (sourceFile === undefined || inImportOrExport(sourceFile, reference.textSpan.start)) {
				continue;
			}

			files.add(posixRelativeOf(reference.fileName));
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

const caseOfId = (caseId: string): CaseType => {
	const file = path.join(EVALUATION_ROOT, 'cases', `${caseId}.json`);
	const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
	const testCase = caseOf(parsed);

	assert.equal(testCase.id, caseId);

	return testCase;
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

const language = languageServiceOf(FIXTURE_ROOT);

test('controlled TypeScript fixture compiles without diagnostics', () => {
	const diagnostics = ts.getPreEmitDiagnostics(language.program);

	assert.deepEqual(
		diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
		[],
	);
});

test('controlled semantic suite loads six semantic cases', () => {
	const {suite, cases} = loadSuite(path.join(EVALUATION_ROOT, 'suites', 'semantic.json'));

	assert.equal(suite.id, 'controlled-typescript-semantic');
	assert.equal(suite.status, 'draft');
	assert.equal(cases.length, 6);
	assert.deepEqual(
		cases.map((testCase) => testCase.class),
		Array.from({length: 6}, () => 'semantic'),
	);
});

for (const probe of PROBES) {
	test(`${probe.caseId} matches the language service and admits no exact identifier grep`, () => {
		const testCase = caseOfId(probe.caseId);
		const expected = [...testCase.expectedFiles].sort();
		const truth = truthFilesOf(language, probe);

		assert.equal(testCase.class, 'semantic');
		assert.deepEqual(testCase.scope, [`${FIXTURE_PREFIX}/src/**`]);
		assert.deepEqual(expected, truth);

		for (const file of [...expected, ...testCase.contextFiles, ...testCase.forbiddenFiles]) {
			assert.match(file, new RegExp(`^${FIXTURE_PREFIX}/`, 'u'));
		}

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
}
