import path from 'node:path';
import ts from 'typescript';
import {type ConfigType, loadConfig} from '../../core/config/config.ts';
import {extractSymbolFacts} from './extractSymbols.ts';
import {loadTypeScriptProject} from './loadProject.ts';
import {type IndexedSymbolType} from '../../core/model.ts';
import {scanProject} from './scanProject.ts';
import {debugFor} from '../../core/logging/debug.ts';

const {relative, resolve} = path;
const debug = debugFor('verify');

const SAMPLE_PER_KIND = 10;
const MAX_SAMPLES = 50;

type LocationType = Readonly<{path: string; start: number}>;

type ReferenceComparisonType = Readonly<{
	symbolId: string;
	name: string;
	kind: string;
	path: string;
	expectedCount: number;
	actualCount: number;
	matchedCount: number;
	missing: readonly LocationType[];
	extra: readonly LocationType[];
}>;

const toRelative = (rootDir: string, fileName: string): string => relative(rootDir, fileName).split('\\').join('/');

const locationKey = (location: LocationType): string => `${location.path}:${location.start}`;

const isDeclarationNode = (node: ts.Node): node is ts.Declaration =>
	ts.isDeclarationStatement(node) ||
	ts.isMethodDeclaration(node) ||
	ts.isMethodSignature(node) ||
	ts.isPropertyDeclaration(node) ||
	ts.isPropertySignature(node) ||
	ts.isGetAccessorDeclaration(node) ||
	ts.isSetAccessorDeclaration(node) ||
	ts.isVariableDeclaration(node) ||
	ts.isBindingElement(node) ||
	ts.isEnumMember(node);

const findDefinitionNameNode = (node: ts.Node): ts.Identifier | undefined => {
	if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
		return node.name;
	}

	if (!isDeclarationNode(node)) {
		return undefined;
	}

	const name = ts.getNameOfDeclaration(node);

	return name !== undefined && ts.isIdentifier(name) ? name : undefined;
};

const findNamePosition = (program: ts.Program, symbol: IndexedSymbolType, rootDir: string): number | undefined => {
	const sourceFile = program.getSourceFile(resolve(rootDir, symbol.path));

	if (sourceFile === undefined) {
		return undefined;
	}

	let found: number | undefined;

	const visit = (node: ts.Node): void => {
		if (found !== undefined) {
			return;
		}

		if (node.getStart(sourceFile) === symbol.startOffset) {
			const name = findDefinitionNameNode(node);

			if (name !== undefined) {
				found = name.getStart(sourceFile);
				return;
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return found;
};

const createLanguageService = (config: ConfigType, program: ts.Program): ts.LanguageService => {
	const rootNames = [...program.getRootFileNames()];
	const options = program.getCompilerOptions();

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => rootNames,
		getScriptVersion: () => '0',
		getScriptSnapshot: (fileName) => {
			const text = ts.sys.readFile(fileName);
			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
		},
		getCurrentDirectory: () => config.rootDir,
		getCompilationSettings: () => options,
		getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
		fileExists: (fileName) => ts.sys.fileExists(fileName),
		readFile: (fileName) => ts.sys.readFile(fileName),
		readDirectory: (...args: Parameters<typeof ts.sys.readDirectory>) => ts.sys.readDirectory(...args),
	};

	return ts.createLanguageService(host);
};

const sampleSymbols = (symbols: readonly IndexedSymbolType[]): readonly IndexedSymbolType[] => {
	const byKind = new Map<string, IndexedSymbolType[]>();

	for (const symbol of symbols) {
		const group = byKind.get(symbol.kind) ?? [];
		group.push(symbol);
		byKind.set(symbol.kind, group);
	}

	const sampled: IndexedSymbolType[] = [];

	for (const group of byKind.values()) {
		const step = Math.max(1, Math.floor(group.length / SAMPLE_PER_KIND));

		for (let index = 0; index < group.length && sampled.length < MAX_SAMPLES; index += step) {
			const symbol = group[index];

			if (symbol !== undefined) {
				sampled.push(symbol);
			}

			if (sampled.filter((candidate) => candidate.kind === group[0]?.kind).length >= SAMPLE_PER_KIND) {
				break;
			}
		}
	}

	return sampled.slice(0, MAX_SAMPLES);
};

const compareSymbol = (
	input: Readonly<{config: ConfigType; program: ts.Program; service: ts.LanguageService; symbol: IndexedSymbolType; occurrences: readonly LocationType[]}>,
): ReferenceComparisonType => {
	const position = findNamePosition(input.program, input.symbol, input.config.rootDir);
	const expected = new Map<string, LocationType>();

	if (position !== undefined) {
		const references = input.service.findReferences(resolve(input.config.rootDir, input.symbol.path), position) ?? [];

		for (const referenced of references) {
			const {definition} = referenced;
			const definitionFile = definition.fileName;
			const definitionLocation = {path: toRelative(input.config.rootDir, definitionFile), start: definition.textSpan.start};
			expected.set(locationKey(definitionLocation), definitionLocation);

			for (const reference of referenced.references) {
				const location = {path: toRelative(input.config.rootDir, reference.fileName), start: reference.textSpan.start};
				expected.set(locationKey(location), location);
			}
		}
	}

	const actual = new Map(input.occurrences.map((location) => [locationKey(location), location]));
	const matched = [...expected.keys()].filter((key) => actual.has(key));
	const missing = [...expected.values()].filter((location) => !actual.has(locationKey(location)));
	const extra = [...actual.values()].filter((location) => !expected.has(locationKey(location)));

	return {
		symbolId: input.symbol.id,
		name: input.symbol.name,
		kind: input.symbol.kind,
		path: input.symbol.path,
		expectedCount: expected.size,
		actualCount: actual.size,
		matchedCount: matched.length,
		missing,
		extra,
	};
};

/**
 * Samples indexed symbols and compares their occurrences with the TypeScript
 * language service's reference results.
 *
 * The comparison is diagnostic only. It reports recall and precision so the
 * prototype gate can be evaluated without hiding disagreements.
 *
 * @param config - Resolved project configuration.
 * @returns Sample count, recall, precision, and per-symbol comparisons.
 */
export type ReferenceVerificationReportType = Readonly<{
	samples: number;
	recall: number;
	precision: number;
	comparisons: readonly ReferenceComparisonType[];
}>;

export const runReferenceVerification = (config: ConfigType): ReferenceVerificationReportType => {
	const scan = scanProject(config);
	const project = loadTypeScriptProject(config);
	const facts = extractSymbolFacts({project, files: scan.files, projectId: config.projectId, rootDir: config.rootDir});
	const service = createLanguageService(config, project.program);
	const sampled = sampleSymbols(facts.symbols);
	const occurrencesBySymbol = new Map<string, LocationType[]>();

	for (const occurrence of facts.occurrences) {
		const group = occurrencesBySymbol.get(occurrence.symbolId) ?? [];
		group.push({path: occurrence.path, start: occurrence.startOffset});
		occurrencesBySymbol.set(occurrence.symbolId, group);
	}

	const comparisons = sampled.map((symbol) =>
		compareSymbol({
			config,
			program: project.program,
			service,
			symbol,
			occurrences: occurrencesBySymbol.get(symbol.id) ?? [],
		}),
	);
	const expectedTotal = comparisons.reduce((total, comparison) => total + comparison.expectedCount, 0);
	const actualTotal = comparisons.reduce((total, comparison) => total + comparison.actualCount, 0);
	const matchedTotal = comparisons.reduce((total, comparison) => total + comparison.matchedCount, 0);
	debug('reference comparison complete', {samples: comparisons.length, expectedTotal, actualTotal, matchedTotal});

	return {
		samples: comparisons.length,
		recall: expectedTotal === 0 ? 1 : matchedTotal / expectedTotal,
		precision: actualTotal === 0 ? 1 : matchedTotal / actualTotal,
		comparisons,
	};
};

/**
 * Runs the reference comparison and writes its JSON report to stdout.
 *
 * @param environment - Environment source validated by `loadConfig`.
 * @returns Process exit code: 0 when recall and precision are at least 95%.
 */
export const runVerification = (environment: NodeJS.ProcessEnv): number => {
	const config = loadConfig(environment);
	debug('verification start', {rootDir: config.rootDir, projectFile: config.projectFilePath});
	const report = runReferenceVerification(config);
	debug('verification complete', {samples: report.samples, recall: report.recall, precision: report.precision});

	process.stdout.write(
		`${JSON.stringify(
			{
				samples: report.samples,
				recall: Number(report.recall.toFixed(4)),
				precision: Number(report.precision.toFixed(4)),
				disagreements: report.comparisons.filter((comparison) => comparison.missing.length > 0 || comparison.extra.length > 0).length,
				comparisons: report.comparisons.map((comparison) => ({
					name: comparison.name,
					kind: comparison.kind,
					path: comparison.path,
					expected: comparison.expectedCount,
					actual: comparison.actualCount,
					matched: comparison.matchedCount,
					missing: comparison.missing,
					extra: comparison.extra,
				})),
			},
			null,
			2,
		)}\n`,
	);

	return report.recall >= 0.95 && report.precision >= 0.95 ? 0 : 1;
};
