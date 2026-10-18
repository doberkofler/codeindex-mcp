import {existsSync} from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {type ConfigType, toRepositoryPath} from '../../config/config.ts';
import {debugFor} from '../../logging/debug.ts';
import {type DiagnosticType} from '../../index/model.ts';

const {dirname} = path;
const debug = debugFor('project');
const MAX_STORED_DIAGNOSTICS = 500;

export type LoadedProjectType = Readonly<{
	readonly program: ts.Program;
	readonly checker: ts.TypeChecker;
	readonly diagnostics: readonly DiagnosticType[];
	readonly diagnosticCount: number;
	readonly programFileCount: number;
}>;

const categoryName = (category: ts.DiagnosticCategory): DiagnosticType['category'] => {
	switch (category) {
		case ts.DiagnosticCategory.Error: {
			return 'error';
		}
		case ts.DiagnosticCategory.Warning: {
			return 'warning';
		}
		case ts.DiagnosticCategory.Suggestion: {
			return 'suggestion';
		}
		case ts.DiagnosticCategory.Message: {
			return 'message';
		}
		default: {
			return 'message';
		}
	}
};

const repositoryPathOrNull = (config: ConfigType, fileName: string): string | null => {
	try {
		return toRepositoryPath(config.rootDir, fileName);
	} catch {
		return null;
	}
};

const toDiagnostic = (diagnostic: ts.Diagnostic, config: ConfigType): DiagnosticType => {
	const {file} = diagnostic;
	const position = diagnostic.start;
	const location = file !== undefined && position !== undefined ? file.getLineAndCharacterOfPosition(position) : undefined;

	return {
		category: categoryName(diagnostic.category),
		code: diagnostic.code,
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
		path: file === undefined ? null : repositoryPathOrNull(config, file.fileName),
		startLine: location === undefined ? null : location.line + 1,
		startColumn: location === undefined ? null : location.character + 1,
	};
};

const collectDiagnostics = (program: ts.Program, config: ConfigType): Readonly<{items: readonly DiagnosticType[]; total: number}> => {
	const diagnostics: readonly ts.Diagnostic[] = config.semanticDiagnostics
		? [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
		: [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics()];

	const stored: DiagnosticType[] = [];

	for (const diagnostic of diagnostics.slice(0, MAX_STORED_DIAGNOSTICS)) {
		stored.push(toDiagnostic(diagnostic, config));
	}

	return {items: stored, total: diagnostics.length};
};

/**
 * Loads the configured TypeScript project with the compiler API.
 *
 * Some projects declare a native compiler package that does not expose the
 * JavaScript program API used for extraction. Extraction therefore uses the
 * installed compiler API; the scanner records the declared compiler version in
 * the configuration hash and reports drift.
 *
 * @param config - Resolved project configuration.
 * @returns The loaded program, checker, and diagnostics.
 * @throws {@link Error} When the tsconfig is missing or the program cannot be
 * constructed.
 */
export const loadTypeScriptProject = (config: ConfigType): LoadedProjectType => {
	const startedAt = performance.now();

	if (!existsSync(config.projectFilePath)) {
		throw new Error(`TypeScript configuration does not exist: ${config.projectFilePath}`);
	}

	const configFile = ts.readConfigFile(config.projectFilePath, (fileName) => ts.sys.readFile(fileName));

	if (configFile.error !== undefined) {
		throw new Error(`Cannot read TypeScript configuration: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
	}

	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(config.projectFilePath), undefined, config.projectFilePath);
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
		...(parsed.projectReferences === undefined ? {} : {projectReferences: parsed.projectReferences}),
	});
	const diagnostics = collectDiagnostics(program, config);
	debug('project loaded', {
		rootNames: parsed.fileNames.length,
		sourceFiles: program.getSourceFiles().length,
		diagnostics: diagnostics.total,
		semanticDiagnostics: config.semanticDiagnostics,
		durationMs: Math.round(performance.now() - startedAt),
	});

	return {
		program,
		checker: program.getTypeChecker(),
		diagnostics: diagnostics.items,
		diagnosticCount: diagnostics.total,
		programFileCount: program.getSourceFiles().length,
	};
};
