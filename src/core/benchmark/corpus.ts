import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {type BenchmarkProfileType} from './benchTypes.ts';

const {join} = path;

type ProfileShapeType = Readonly<{features: number; shared: number; outlineSymbols: number}>;

const PROFILES: Readonly<Record<BenchmarkProfileType, ProfileShapeType>> = {
	small: {features: 20, shared: 10, outlineSymbols: 200},
	medium: {features: 300, shared: 80, outlineSymbols: 2000},
	large: {features: 2500, shared: 200, outlineSymbols: 10_000},
	xl: {features: 10_000, shared: 500, outlineSymbols: 50_000},
};

const PROFILE_NAMES = ['small', 'medium', 'large', 'xl'] as const;

/** Marker file that identifies a directory as a generated benchmark corpus. */
export const BENCHMARK_CORPUS_MARKER = '.codeindex-benchmark.json';

/**
 * Expected indexed file and symbol counts for one generated profile.
 *
 * The values follow from the deterministic corpus shape; they do not depend on
 * a retained benchmark reference.
 */
export type BenchmarkCorpusCountsType = Readonly<{
	readonly fileCount: number;
	readonly symbolCount: number;
}>;

const CorpusMarkerSchema = z.object({
	schemaVersion: z.literal(1),
	profile: z.enum(PROFILE_NAMES),
	fileCount: z.number().int().min(0),
	symbolCount: z.number().int().min(0),
});

export type BenchmarkCorpusType = Readonly<{
	readonly rootDir: string;
	readonly projectFilePath: string;
	readonly profile: BenchmarkProfileType;
	readonly generatedFileCount: number;
	readonly expected: BenchmarkCorpusCountsType;
}>;

/**
 * Returns the deterministic indexed counts produced by a generated corpus.
 *
 * `fileCount` excludes dependency declaration files, which still participate
 * in resolution but are not published. `symbolCount` follows from the declared
 * interfaces, type aliases, constants, classes, and their members.
 *
 * @param profile - Generated corpus profile.
 * @returns Expected published file and symbol counts.
 */
export const benchmarkCorpusCounts = (profile: BenchmarkProfileType): BenchmarkCorpusCountsType => {
	const shape = PROFILES[profile];

	return {
		fileCount: shape.features + shape.shared + 4,
		symbolCount: 7 * shape.features + 2 * Math.floor(shape.features / 10) + shape.shared + shape.outlineSymbols + 7,
	};
};

export const isBenchmarkProfile = (value: string): value is BenchmarkProfileType => PROFILE_NAMES.some((name) => name === value);

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

const featureSource = (input: Readonly<{index: number; shared: number; external: boolean}>): string => {
	const name = `feature${pad(input.index, 5)}`;
	const util = `util${pad((input.index % input.shared) + 1, 4)}`;
	const externalImport = input.external ? "\nimport type {ExternalThing} from 'bench-package';" : '';
	const externalMember = input.external ? '\n\texport interface ExternalShape {\n\t\treadonly external?: ExternalThing;\n\t}\n' : '';

	return `import {hubSymbol, type HubType} from '../target';
import {${util}} from '../shared/${util}';${externalImport}

export interface Feature${pad(input.index, 5)} {
	readonly value: number;
}

export type Feature${pad(input.index, 5)}Result = HubType & {
	readonly id: number;
};
${externalMember}
export const ${name} = (input: number): Feature${pad(input.index, 5)}Result => ({
	id: ${util}(input),
	value: hubSymbol,
	label: '${name}',
});

export class ${name}Service {
	public run(value: number): Feature${pad(input.index, 5)}Result {
		return ${name}(value);
	}
}
`;
};

const sharedSource = (index: number): string => `export const util${pad(index, 4)} = (value: number): number => value + ${index};
`;

const outlineSource = (count: number): string =>
	Array.from({length: count}, (_value, index) => `export const outline${pad(index, 5)} = (): number => ${index};\n`).join('');

const targetSource = `export type HubType = {
	readonly id: number;
	readonly value: number;
	readonly label: string;
};

export const hubSymbol = 1;

export interface HubContract {
	readonly run: (input: number) => HubType;
}
`;

const vendorSource = `declare module 'bench-package' {
	export type ExternalThing = {
		readonly id: number;
	};
}
`;

const tsconfigSource = JSON.stringify(
	{
		compilerOptions: {
			target: 'ES2024',
			module: 'NodeNext',
			moduleResolution: 'NodeNext',
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			types: [],
		},
		include: ['src/**/*.ts'],
	},
	null,
	'\t',
);

const packageSource = JSON.stringify({name: 'codeindex-benchmark-corpus', private: true, type: 'module'}, null, '\t');

const writeSupportFiles = (input: Readonly<{src: string; shape: ProfileShapeType}>): number => {
	mkdirSync(join(input.src, 'shared'), {recursive: true});
	writeFileSync(join(input.src, 'target.ts'), targetSource);
	writeFileSync(join(input.src, 'vendor.d.ts'), vendorSource);
	writeFileSync(join(input.src, 'outline.ts'), outlineSource(input.shape.outlineSymbols));
	writeFileSync(join(input.src, 'index.ts'), "export * from './target';\nexport * from './outline';\nexport * from './features';\n");

	for (let index = 1; index <= input.shape.shared; index += 1) {
		writeFileSync(join(input.src, 'shared', `util${pad(index, 4)}.ts`), sharedSource(index));
	}

	return input.shape.shared + 4;
};

const writeFeatureFiles = (input: Readonly<{src: string; shape: ProfileShapeType}>): number => {
	const features = join(input.src, 'features');
	mkdirSync(features, {recursive: true});

	for (let index = 1; index <= input.shape.features; index += 1) {
		writeFileSync(join(features, `feature${pad(index, 5)}.ts`), featureSource({index, shared: input.shape.shared, external: index % 10 === 0}));
	}

	writeFileSync(
		join(features, 'index.ts'),
		Array.from({length: input.shape.features}, (_value, index) => `export * from './feature${pad(index + 1, 5)}';\n`).join(''),
	);

	return input.shape.features + 1;
};

/**
 * Generates a deterministic TypeScript workspace for large-project benchmarks.
 *
 * The corpus is disposable, contains no third-party source, and exercises
 * declarations, references, re-exports, package edges, and a deep outline.
 *
 * @param input - Destination directory and profile.
 * @returns The generated project location and file count.
 */
export const createBenchmarkCorpus = (input: Readonly<{directory: string; profile: BenchmarkProfileType}>): BenchmarkCorpusType => {
	const rootDir = path.resolve(input.directory);
	const projectFilePath = join(rootDir, 'tsconfig.json');
	const shape = PROFILES[input.profile];
	const expected = benchmarkCorpusCounts(input.profile);

	mkdirSync(rootDir, {recursive: true});
	writeFileSync(join(rootDir, 'tsconfig.json'), `${tsconfigSource}\n`);
	writeFileSync(join(rootDir, 'package.json'), `${packageSource}\n`);
	writeFileSync(join(rootDir, BENCHMARK_CORPUS_MARKER), `${JSON.stringify({schemaVersion: 1, profile: input.profile, ...expected}, null, '\t')}\n`);

	const src = join(rootDir, 'src');
	const supportFiles = writeSupportFiles({src, shape});
	const featureFiles = writeFeatureFiles({src, shape});

	return {
		rootDir,
		projectFilePath,
		profile: input.profile,
		generatedFileCount: supportFiles + featureFiles,
		expected,
	};
};

const readCorpusMarker = (rootDir: string): z.infer<typeof CorpusMarkerSchema> => {
	const markerPath = join(rootDir, BENCHMARK_CORPUS_MARKER);
	const result = CorpusMarkerSchema.safeParse(JSON.parse(readFileSync(markerPath, 'utf8')));

	if (!result.success) {
		throw new Error(`Invalid benchmark corpus marker ${markerPath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

const verifyCorpusWorkspace = (rootDir: string, profile: BenchmarkProfileType): void => {
	const projectFilePath = join(rootDir, 'tsconfig.json');

	if (!existsSync(projectFilePath)) {
		throw new Error(`--workspace benchmark corpus is missing ${projectFilePath}; regenerate the corpus`);
	}

	const marker = readCorpusMarker(rootDir);
	const expected = benchmarkCorpusCounts(profile);

	if (marker.profile !== profile) {
		throw new Error(`--workspace contains the ${marker.profile} benchmark corpus, not ${profile}`);
	}

	if (marker.fileCount !== expected.fileCount || marker.symbolCount !== expected.symbolCount) {
		throw new Error('--workspace benchmark corpus counts do not match the current generator; regenerate the corpus');
	}
};

/**
 * Creates or reuses a generated benchmark workspace.
 *
 * A corpus is identified by its marker file, never by the presence of a
 * `tsconfig.json`. Reusing an arbitrary project as a generated profile would
 * attribute measurements to the wrong corpus.
 *
 * @param input - Selected profile and optional explicit workspace.
 * @returns Workspace root and the temporary root when one was created.
 * @throws {@link Error} When an explicit workspace is not an empty directory or
 * a generated corpus for the selected profile. A failed temporary workspace is
 * removed before the error propagates.
 */
export const prepareBenchmarkWorkspace = (
	input: Readonly<{
		profile: BenchmarkProfileType | null;
		workspace: string | undefined;
	}>,
): Readonly<{workspaceRoot: string | null; temporaryWorkspace: string | null}> => {
	if (input.profile === null) {
		return {workspaceRoot: null, temporaryWorkspace: null};
	}

	const temporary = input.workspace === undefined;
	const workspaceRoot = temporary ? mkdtempSync(join(tmpdir(), 'codeindex-benchmark-workspace-')) : path.resolve(input.workspace);

	try {
		if (existsSync(join(workspaceRoot, BENCHMARK_CORPUS_MARKER))) {
			verifyCorpusWorkspace(workspaceRoot, input.profile);
		} else {
			if (existsSync(workspaceRoot) && readdirSync(workspaceRoot).length > 0) {
				throw new Error(`--workspace must be empty or contain a generated benchmark corpus (missing ${BENCHMARK_CORPUS_MARKER})`);
			}

			createBenchmarkCorpus({directory: workspaceRoot, profile: input.profile});
		}
	} catch (error) {
		if (temporary) {
			rmSync(workspaceRoot, {recursive: true, force: true});
		}

		throw error;
	}

	return {workspaceRoot, temporaryWorkspace: temporary ? workspaceRoot : null};
};
