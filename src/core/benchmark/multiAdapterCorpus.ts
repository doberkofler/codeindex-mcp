import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {parseEditTarget} from './benchmarkOptions.ts';

const {join, relative, resolve, sep} = path;

/** Stable identity declared by the checked-in multi-adapter corpus. */
const MULTI_ADAPTER_CORPUS_ID = 'multi-adapter';

const AdapterEditTargetSchema = z.object({
	adapterId: z.enum(['typescript', 'oracle']),
	path: z.string().min(1),
});

const MultiAdapterCorpusMetadataSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: z.literal(MULTI_ADAPTER_CORPUS_ID),
		description: z.string().min(1),
		typescriptProjectContexts: z.number().int().min(5),
		oracleProjectContexts: z.number().int().min(1),
		editTargets: z.array(AdapterEditTargetSchema).length(2),
	})
	.superRefine((metadata, context) => {
		const adapters = new Set(metadata.editTargets.map((target) => target.adapterId));

		if (adapters.size !== 2) {
			context.addIssue({code: 'custom', path: ['editTargets'], message: 'editTargets must name exactly one TypeScript and one Oracle target'});
		}
	});

type MultiAdapterCorpusMetadataType = z.infer<typeof MultiAdapterCorpusMetadataSchema>;

export type MultiAdapterCorpusType = Readonly<{
	rootDir: string;
	configPath: string;
	metadata: MultiAdapterCorpusMetadataType;
	sha256: string;
}>;

const parseMetadata = (rootDir: string): MultiAdapterCorpusMetadataType => {
	const metadataPath = join(rootDir, 'corpus.json');
	const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
	const result = MultiAdapterCorpusMetadataSchema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid multi-adapter corpus metadata ${metadataPath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

const filesUnder = (rootDir: string): readonly string[] => {
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, {withFileTypes: true})) {
			if (entry.name === '.DS_Store') {
				continue;
			}

			const absolutePath = join(directory, entry.name);

			if (entry.isDirectory()) {
				walk(absolutePath);
				continue;
			}

			if (entry.isFile()) {
				files.push(absolutePath);
			}
		}
	};

	walk(rootDir);
	return files.sort();
};

/**
 * Hashes every authored corpus file by relative path and content.
 *
 * The digest is independent of checkout location and mtimes, so a retained
 * baseline can identify the exact corpus that produced a measurement.
 *
 * @param rootDir - Corpus root.
 * @returns SHA-256 over sorted relative paths and file contents.
 */
export const multiAdapterCorpusDigest = (rootDir: string): string => {
	const hash = createHash('sha256');

	for (const filePath of filesUnder(rootDir)) {
		const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex');
		hash.update(`${relative(rootDir, filePath).split(sep).join('/')}\u0000${digest}\n`);
	}

	return hash.digest('hex');
};

/**
 * Loads and validates the checked-in multi-adapter corpus.
 *
 * @param rootDir - Corpus directory containing `codeindex.config.json` and `corpus.json`.
 * @returns Corpus identity, configuration path, and edit targets.
 * @throws {@link Error} When metadata, configuration, or an edit target is missing or invalid.
 */
export const loadMultiAdapterCorpus = (rootDir: string): MultiAdapterCorpusType => {
	const resolvedRoot = resolve(rootDir);
	const configPath = join(resolvedRoot, 'codeindex.config.json');

	if (!existsSync(configPath)) {
		throw new Error(`Multi-adapter corpus is missing ${configPath}`);
	}

	const metadata = parseMetadata(resolvedRoot);

	for (const target of metadata.editTargets) {
		const normalized = parseEditTarget(target.path);

		if (normalized === null || !existsSync(join(resolvedRoot, normalized))) {
			throw new Error(`Multi-adapter corpus edit target is missing: ${target.path}`);
		}
	}

	return {
		rootDir: realpathSync(resolvedRoot),
		configPath,
		metadata,
		sha256: multiAdapterCorpusDigest(resolvedRoot),
	};
};

export type PreparedMultiAdapterWorkspaceType = Readonly<{
	rootDir: string;
	databasePath: string;
	corpus: MultiAdapterCorpusType;
	cleanup: () => void;
}>;

const fileSizeOf = (filePath: string): number => {
	try {
		return statSync(filePath).size;
	} catch {
		return 0;
	}
};

/**
 * Copies the corpus into a disposable workspace so measured edits never touch
 * the checked-in files.
 *
 * @param input - Loaded corpus, workspace override, and retention flag.
 * @returns Workspace and database paths plus a cleanup function.
 */
export const prepareMultiAdapterWorkspace = (
	input: Readonly<{
		corpus: MultiAdapterCorpusType;
		workspace?: string | undefined;
		keep: boolean;
	}>,
): PreparedMultiAdapterWorkspaceType => {
	const temporaryRoot = mkdtempSync(join(os.tmpdir(), 'codeindex-multi-adapter-'));
	const rootDir = input.workspace === undefined ? join(temporaryRoot, 'workspace') : resolve(input.workspace);

	if (input.workspace === undefined) {
		cpSync(input.corpus.rootDir, rootDir, {
			recursive: true,
			filter: (entry) => path.basename(entry) !== '.git',
		});
	} else if (!existsSync(rootDir) || readdirSync(rootDir).length === 0) {
		cpSync(input.corpus.rootDir, rootDir, {
			recursive: true,
			filter: (entry) => path.basename(entry) !== '.git',
		});
	} else {
		throw new Error(`--workspace must be empty or absent: ${rootDir}`);
	}

	const databasePath = join(temporaryRoot, 'index.sqlite');
	const cleanup = (): void => {
		if (input.keep) {
			return;
		}

		rmSync(temporaryRoot, {recursive: true, force: true});
	};

	return {rootDir, databasePath, corpus: input.corpus, cleanup};
};

/**
 * Reports the retained database footprint for the scenario summary.
 *
 * @param databasePath - SQLite main file.
 * @returns Main, WAL, and shared-memory bytes.
 */
export const databaseBytesOf = (databasePath: string): Readonly<{main: number; wal: number; shm: number}> => ({
	main: fileSizeOf(databasePath),
	wal: fileSizeOf(`${databasePath}-wal`),
	shm: fileSizeOf(`${databasePath}-shm`),
});
