import path from 'node:path';
import ts from 'typescript';
import {isResolutionSource, type RecorderType} from './snapshotRecorder.ts';
import {type TypeScriptSnapshotProjectType} from './snapshotTypes.ts';

const {dirname, join} = path;
const MAX_PACKAGE_WALK = 32;

const moduleSpecifiersOf = (sourceFile: ts.SourceFile): readonly string[] => {
	const specifiers = new Set<string>();
	const add = (literal: ts.StringLiteralLike | undefined): void => {
		if (literal !== undefined) {
			specifiers.add(literal.text);
		}
	};
	const visit = (node: ts.Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
			add(node.moduleSpecifier);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
			add(node.argument.literal);
		} else if (ts.isCallExpression(node)) {
			const [first] = node.arguments;

			if (
				first !== undefined &&
				ts.isStringLiteralLike(first) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
			) {
				add(first);
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return [...specifiers];
};

const nearestPackageJson = (recorder: RecorderType, startDirectory: string): string | null => {
	let directory = startDirectory;

	for (let depth = 0; depth < MAX_PACKAGE_WALK; depth += 1) {
		const candidate = join(directory, 'package.json');

		if (recorder.fileExists(candidate)) {
			return candidate;
		}

		const parent = dirname(directory);

		if (parent === directory) {
			return null;
		}

		directory = parent;
	}

	return null;
};

const addPackageManifest = (recorder: RecorderType, absolutePath: string): void => {
	const manifest = nearestPackageJson(recorder, dirname(absolutePath));

	if (manifest !== null) {
		recorder.addInput(manifest);
	}
};

/**
 * Resolves every module specifier reachable from one project and records the
 * resolved files, package manifests, and lookup probes.
 *
 * @param recorder - Capturing filesystem.
 * @param projects - Parsed project configurations.
 * @param authoredPaths - Authored source and declaration files to walk.
 */
export const collectReachableInputs = (recorder: RecorderType, projects: readonly TypeScriptSnapshotProjectType[], authoredPaths: readonly string[]): void => {
	for (const project of projects) {
		const cache = ts.createModuleResolutionCache(dirname(project.projectFilePath), (fileName) => recorder.realpath(fileName), project.parsed.options);
		const host: ts.ModuleResolutionHost = {
			fileExists: (fileName) => recorder.fileExists(fileName),
			readFile: (fileName) => recorder.readFile(fileName),
			directoryExists: (directoryName) => recorder.directoryExists(directoryName),
			realpath: (fileName) => recorder.realpath(fileName),
			getCurrentDirectory: () => recorder.snapshot.rootDir,
			getDirectories: (directoryName) => [...recorder.getDirectories(directoryName)],
		};
		const visited = new Set<string>();
		const queue = [...project.parsed.fileNames, ...authoredPaths];

		while (queue.length > 0) {
			const current = queue.pop();

			if (current === undefined) {
				continue;
			}

			const canonical = recorder.realpath(current);

			if (visited.has(canonical) || !isResolutionSource(canonical)) {
				continue;
			}

			visited.add(canonical);
			recorder.addInput(canonical);

			const text = recorder.readFile(canonical);

			if (text === undefined) {
				continue;
			}

			const sourceFile = ts.createSourceFile(canonical, text, ts.ScriptTarget.Latest, true);

			for (const specifier of moduleSpecifiersOf(sourceFile)) {
				const resolved = ts.resolveModuleName(specifier, canonical, project.parsed.options, host, cache).resolvedModule;

				if (resolved !== undefined) {
					const resolvedPath = recorder.realpath(resolved.resolvedFileName);
					recorder.addInput(resolvedPath);
					queue.push(resolvedPath);
					addPackageManifest(recorder, resolvedPath);
				}
			}

			for (const reference of sourceFile.referencedFiles) {
				const resolved = ts.resolveTripleslashReference(reference.fileName, canonical);
				recorder.addInput(resolved);
				queue.push(resolved);
			}

			for (const reference of sourceFile.typeReferenceDirectives) {
				const resolvedPath = ts.resolveTypeReferenceDirective(reference.fileName, canonical, project.parsed.options, host).resolvedTypeReferenceDirective
					?.resolvedFileName;

				if (resolvedPath !== undefined) {
					recorder.addInput(resolvedPath);
					queue.push(resolvedPath);
					addPackageManifest(recorder, resolvedPath);
				}
			}
		}
	}
};
