import {type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import * as ts from '@codeindex/adapter-typescript/compiler';
import {type ConfigType} from '../../config/config.ts';
import {type LoadedProjectType, loadTypeScriptProject} from '@codeindex/adapter-typescript/internals';

export const posixRelative = (rootDir: string, filePath: string): string | null => {
	const relative = path.relative(rootDir, filePath).split(path.sep).join('/');

	return relative.length === 0 || relative.startsWith('../') || path.isAbsolute(relative) ? null : relative;
};

const filesWithSuffixes = (directory: string, suffixes: readonly string[]): readonly string[] => {
	const found: string[] = [];
	const walk = (current: string): void => {
		let entries: readonly Dirent[];

		try {
			entries = readdirSync(current, {withFileTypes: true});
		} catch {
			return;
		}

		for (const entry of entries) {
			const candidate = path.join(current, entry.name);

			if (entry.isDirectory()) {
				walk(candidate);
			} else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
				found.push(candidate);
			}
		}
	};

	walk(directory);
	return found.sort();
};

const copyMissingDeclaration = (source: string, destination: string): void => {
	if (!existsSync(destination)) {
		mkdirSync(path.dirname(destination), {recursive: true});
		writeFileSync(destination, readFileSync(source));
	}
};

/**
 * Emits declaration output for one project context.
 *
 * TypeScript 7 keeps emission inside the compiler process, so the API writes
 * through its host filesystem. The emitted program is disposed before the
 * caller builds the comparison program over the same compiler API.
 *
 * @param input - Compiler API, configuration, and emit destination.
 * @returns Emitted files, declaration maps, and the effective options.
 */
export const emitDeclarations = (
	input: Readonly<{
		api: ts.API;
		config: ConfigType;
		context: ConfigType['projects'][number];
		outputDirectory: string;
		authoredFiles: readonly string[];
	}>,
): Readonly<{emittedFiles: readonly string[]; declarationMapFiles: readonly string[]; emitErrors: number; compilerOptions: ts.CompilerOptions}> => {
	const {api, config, context, outputDirectory, authoredFiles} = input;
	const project: LoadedProjectType = loadTypeScriptProject(config, context.projectFilePath);

	try {
		const options: ts.CompilerOptions = {
			...project.program.getCompilerOptions(),
			rootDir: ts.rootedDirectory(config.rootDir),
			outDir: ts.rootedDirectory(outputDirectory),
			allowJs: true,
			declaration: true,
			emitDeclarationOnly: true,
			declarationMap: true,
			incremental: false,
			composite: false,
			noEmit: false,
			noEmitOnError: false,
		};
		const rootNames = [...new Set([...project.rootFileNames, ...authoredFiles])];
		const program = api.createProgram(rootNames, options);
		let emitErrors = 0;

		try {
			const emit = program.emit();
			emitErrors = emit.diagnostics.filter((diagnostic) => diagnostic.category === ts.ERROR_DIAGNOSTIC_CATEGORY).length;
		} finally {
			program[Symbol.dispose]();
		}

		const emittedFiles = filesWithSuffixes(outputDirectory, ['.d.ts', '.d.mts', '.d.cts']);
		const declarationMapFiles = filesWithSuffixes(outputDirectory, ['.d.ts.map', '.d.mts.map', '.d.cts.map']);

		for (const sourceFile of ts.sourceFilesOf(project.program)) {
			if (!sourceFile.isDeclarationFile) {
				continue;
			}

			const relative = posixRelative(config.rootDir, sourceFile.fileName);

			if (relative === null || relative.includes('/node_modules/')) {
				continue;
			}

			copyMissingDeclaration(sourceFile.fileName, path.join(outputDirectory, relative));
		}

		for (const fileName of filesWithSuffixes(config.rootDir, ['.d.ts', '.d.mts', '.d.cts'])) {
			const relative = posixRelative(config.rootDir, fileName);

			if (relative === null || relative.includes('/node_modules/')) {
				continue;
			}

			copyMissingDeclaration(fileName, path.join(outputDirectory, relative));
		}

		return {emittedFiles, declarationMapFiles, emitErrors, compilerOptions: options};
	} finally {
		project.dispose();
	}
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
