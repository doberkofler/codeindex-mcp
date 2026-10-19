import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {type BenchmarkProfileType} from './benchTypes.ts';

const {join} = path;

type ProfileShapeType = Readonly<{features: number; shared: number; outlineSymbols: number}>;

const PROFILES: Readonly<Record<BenchmarkProfileType, ProfileShapeType>> = {
	small: {features: 20, shared: 10, outlineSymbols: 200},
	medium: {features: 300, shared: 80, outlineSymbols: 2000},
	large: {features: 2500, shared: 200, outlineSymbols: 10_000},
	xl: {features: 10_000, shared: 500, outlineSymbols: 50_000},
};

const PROFILE_NAMES: readonly BenchmarkProfileType[] = ['small', 'medium', 'large', 'xl'];

export type BenchmarkCorpusType = Readonly<{
	readonly rootDir: string;
	readonly projectFilePath: string;
	readonly profile: BenchmarkProfileType;
	readonly generatedFileCount: number;
}>;

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
			target: 'ES2023',
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

	mkdirSync(rootDir, {recursive: true});
	writeFileSync(join(rootDir, 'tsconfig.json'), `${tsconfigSource}\n`);
	writeFileSync(join(rootDir, 'package.json'), `${packageSource}\n`);

	const src = join(rootDir, 'src');
	const supportFiles = writeSupportFiles({src, shape});
	const featureFiles = writeFeatureFiles({src, shape});

	return {
		rootDir,
		projectFilePath,
		profile: input.profile,
		generatedFileCount: supportFiles + featureFiles,
	};
};

/**
 * Reports whether a directory already contains a usable benchmark project.
 *
 * @param rootDir - Candidate workspace.
 * @returns True when `tsconfig.json` exists.
 */
export const hasBenchmarkProject = (rootDir: string): boolean => existsSync(join(rootDir, 'tsconfig.json'));
