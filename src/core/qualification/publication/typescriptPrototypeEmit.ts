import path from 'node:path';
import ts from 'typescript';
import {type ConfigType} from '../../config/config.ts';
import {loadTypeScriptProject} from '../../../adapters/typescript/loadProject.ts';

export const posixRelative = (rootDir: string, filePath: string): string | null => {
	const relative = path.relative(rootDir, filePath).split(path.sep).join('/');

	return relative.length === 0 || relative.startsWith('../') || path.isAbsolute(relative) ? null : relative;
};

export const emitDeclarations = (
	config: ConfigType,
	context: ConfigType['projects'][number],
	outputDirectory: string,
	authoredFiles: readonly string[],
): Readonly<{emittedFiles: readonly string[]; declarationMapFiles: readonly string[]; emitErrors: number; compilerOptions: ts.CompilerOptions}> => {
	const project = loadTypeScriptProject(config, context.projectFilePath);
	const options: ts.CompilerOptions = {
		...project.program.getCompilerOptions(),
		rootDir: config.rootDir,
		outDir: outputDirectory,
		allowJs: true,
		declaration: true,
		emitDeclarationOnly: true,
		declarationMap: true,
		incremental: false,
		composite: false,
		noEmit: false,
		noEmitOnError: false,
	};
	const rootNames = [...new Set([...project.program.getRootFileNames(), ...authoredFiles])];
	const program = ts.createProgram({rootNames, options});
	const emit = program.emit(
		undefined,
		(fileName, text) => {
			ts.sys.writeFile(fileName, text);
		},
		undefined,
		true,
	);
	const emittedFiles = ts.sys.readDirectory(outputDirectory, ['.d.ts', '.d.mts', '.d.cts']).sort();
	const declarationMapFiles = ts.sys.readDirectory(outputDirectory, ['.d.ts.map', '.d.mts.map', '.d.cts.map']).sort();
	const emitErrors = emit.diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error).length;

	for (const sourceFile of program.getSourceFiles()) {
		if (!sourceFile.isDeclarationFile) {
			continue;
		}

		const relative = posixRelative(config.rootDir, sourceFile.fileName);

		if (relative === null || relative.includes('/node_modules/')) {
			continue;
		}

		const destination = path.join(outputDirectory, relative);

		if (!ts.sys.fileExists(destination)) {
			ts.sys.writeFile(destination, ts.sys.readFile(sourceFile.fileName) ?? '');
		}
	}

	for (const fileName of ts.sys.readDirectory(config.rootDir, ['.d.ts', '.d.mts', '.d.cts'], undefined, ['**/node_modules/**'])) {
		const relative = posixRelative(config.rootDir, fileName);

		if (relative === null) {
			continue;
		}

		const destination = path.join(outputDirectory, relative);

		if (!ts.sys.fileExists(destination)) {
			ts.sys.writeFile(destination, ts.sys.readFile(fileName) ?? '');
		}
	}

	return {emittedFiles, declarationMapFiles, emitErrors, compilerOptions: options};
};

export const rewrittenEmittedPaths = (options: ts.CompilerOptions, rootDir: string, outputDirectory: string): Record<string, string[]> | undefined => {
	if (options.paths === undefined) {
		return undefined;
	}

	const configuredBase: unknown = Reflect.get(options, 'pathsBasePath');
	const base = typeof configuredBase === 'string' ? configuredBase : rootDir;
	const rewritten: Record<string, string[]> = {};

	for (const [key, values] of Object.entries(options.paths)) {
		rewritten[key] = values.map((value) => {
			const absolute = path.resolve(base, value);
			const relative = posixRelative(rootDir, absolute);

			return relative === null ? absolute : path.join(outputDirectory, relative);
		});
	}

	return rewritten;
};
