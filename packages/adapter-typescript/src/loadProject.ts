import {existsSync} from 'node:fs';
import {type AdapterConfigType, toRepositoryPath, debugFor, type DiagnosticType} from '@codeindex/adapter-sdk';
import * as ts from './compiler.ts';
import {type TypeScriptInputSnapshotType} from './inputSnapshot.ts';

const debug = debugFor('project');
const MAX_STORED_DIAGNOSTICS = 500;

export type LoadedProjectType = Readonly<{
	readonly program: ts.Program;
	readonly checker: ts.TypeChecker;
	readonly project: ts.Project;
	readonly diagnostics: readonly DiagnosticType[];
	readonly diagnosticCount: number;
	readonly programFileCount: number;
	readonly rootFileNames: readonly string[];
	readonly moduleResolver: ts.ModuleResolver;
	/**
	 * Releases the module resolver, any program this load created, and — when
	 * this load owns it — the compiler API process. A program supplied by an
	 * input snapshot stays alive until the snapshot is disposed.
	 */
	readonly dispose: () => void;
}>;

const CATEGORY_NAMES: ReadonlyMap<number, DiagnosticType['category']> = new Map<number, DiagnosticType['category']>([
	[ts.DiagnosticCategory.Error, 'error'],
	[ts.DiagnosticCategory.Warning, 'warning'],
	[ts.DiagnosticCategory.Suggestion, 'suggestion'],
	[ts.DiagnosticCategory.Message, 'message'],
]);

const categoryName = (category: number): DiagnosticType['category'] => CATEGORY_NAMES.get(category) ?? 'message';

const repositoryPathOrNull = (config: AdapterConfigType, fileName: string): string | null => {
	try {
		return toRepositoryPath(config.rootDir, fileName);
	} catch {
		return null;
	}
};

const toDiagnostic = (diagnostic: ts.Diagnostic, config: AdapterConfigType): DiagnosticType => {
	const position = diagnostic.startPosition;

	return {
		category: categoryName(diagnostic.category),
		code: diagnostic.code,
		message: ts.diagnosticText(diagnostic),
		path: diagnostic.fileName === undefined ? null : repositoryPathOrNull(config, diagnostic.fileName),
		startLine: position === undefined ? null : position.line + 1,
		startColumn: position === undefined ? null : position.character + 1,
	};
};

const collectDiagnostics = (program: ts.Program, config: AdapterConfigType): Readonly<{items: readonly DiagnosticType[]; total: number}> => {
	// Global diagnostics force a full check of the default library. They only
	// add value when the caller asked for semantic checking; requesting them for
	// a syntax-only build dominated construction time on large projects.
	const diagnostics: readonly ts.Diagnostic[] = config.semanticDiagnostics
		? [...program.getProgramDiagnostics(), ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
		: [...program.getProgramDiagnostics(), ...program.getSyntacticDiagnostics()];

	const stored: DiagnosticType[] = [];

	for (const diagnostic of diagnostics.slice(0, MAX_STORED_DIAGNOSTICS)) {
		stored.push(toDiagnostic(diagnostic, config));
	}

	return {items: stored, total: diagnostics.length};
};

const parseProjectFile = (api: ts.API, projectFilePath: string, snapshot: TypeScriptInputSnapshotType | undefined): ts.ParsedCommandLine => {
	const captured = snapshot?.projectOf(projectFilePath)?.parsed;

	if (captured !== undefined) {
		return captured;
	}

	const configFile = api.readConfigFile(projectFilePath);

	if (configFile.error !== undefined) {
		throw new Error(`Cannot read TypeScript configuration ${projectFilePath}: ${ts.diagnosticText(configFile.error)}`);
	}

	return api.parseJsonConfigFileContent(configFile.config, {configFileName: projectFilePath});
};

const createProgramFor = (api: ts.API, parsed: ts.ParsedCommandLine): ts.Program =>
	api.createProgram(parsed.fileNames, parsed.options, parsed.projectReferences === undefined ? undefined : {projectReferences: parsed.projectReferences});

/**
 * Loads the configured TypeScript project with the compiler API.
 *
 * When an input snapshot is supplied, configuration parsing, program creation,
 * and every compiler read use the snapshot's captured bytes and its compiler
 * API process. The snapshot also supplies the program, so extraction queries
 * the exact program whose construction captured the manifest. The loaded
 * project therefore observes one immutable version even if the filesystem
 * changes during the build.
 *
 * @param config - Resolved project configuration.
 * @param projectFilePath - Project file to load; defaults to the first configured project.
 * @param snapshot - Optional captured input snapshot.
 * @returns The loaded program, checker, diagnostics, and disposal handle.
 * @throws {@link Error} When the tsconfig is missing or the program cannot be
 * constructed.
 */
export const loadTypeScriptProject = (
	config: AdapterConfigType,
	projectFilePath = config.projectFilePath,
	snapshot?: TypeScriptInputSnapshotType,
): LoadedProjectType => {
	const startedAt = performance.now();

	if (!existsSync(projectFilePath) && snapshot === undefined) {
		throw new Error(`TypeScript configuration does not exist: ${projectFilePath}`);
	}

	const ownsApi = snapshot === undefined;
	const api = snapshot?.api ?? new ts.API({cwd: config.rootDir});
	const capturedProgram = snapshot?.programOf(projectFilePath);
	const ownsProgram = capturedProgram === undefined;
	let program: ts.Program | undefined = capturedProgram;
	let moduleResolver: ts.ModuleResolver | undefined;

	try {
		const parsed = parseProjectFile(api, projectFilePath, snapshot);
		const createdProgram = capturedProgram ?? createProgramFor(api, parsed);
		const createdResolver = api.createModuleResolver(parsed.options);

		program = createdProgram;
		moduleResolver = createdResolver;

		const project = createdProgram.getProject();
		const {checker} = project;
		const diagnostics = collectDiagnostics(createdProgram, config);
		const rootFileNames = [...parsed.fileNames];

		debug('project loaded', {
			rootNames: rootFileNames.length,
			sourceFiles: createdProgram.getSourceFileNames().length,
			diagnostics: diagnostics.total,
			semanticDiagnostics: config.semanticDiagnostics,
			durationMs: Math.round(performance.now() - startedAt),
		});

		return {
			program: createdProgram,
			checker,
			project,
			diagnostics: diagnostics.items,
			diagnosticCount: diagnostics.total,
			programFileCount: createdProgram.getSourceFileNames().length,
			rootFileNames,
			moduleResolver: createdResolver,
			dispose: (): void => {
				createdResolver[Symbol.dispose]();

				if (ownsProgram) {
					createdProgram[Symbol.dispose]();
				}

				if (ownsApi) {
					api[Symbol.dispose]();
				}
			},
		};
	} catch (error) {
		moduleResolver?.[Symbol.dispose]();

		if (ownsProgram) {
			program?.[Symbol.dispose]();
		}

		if (ownsApi) {
			api[Symbol.dispose]();
		}

		throw error;
	}
};
