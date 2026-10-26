import {type ExtractorArtifactCacheType} from '../../adapters/types.ts';
import {debugFor} from '../logging/debug.ts';
import {type DependencyExtractionResultType, type ExtractionResultType, type ScanResultType, type SourceFileType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';

const debug = debugFor('build');

const debugMemory = (stage: string): void => {
	const usage = process.memoryUsage();
	debug('memory', {
		stage,
		rssMiB: Math.round(usage.rss / (1024 * 1024)),
		heapUsedMiB: Math.round(usage.heapUsed / (1024 * 1024)),
		heapTotalMiB: Math.round(usage.heapTotal / (1024 * 1024)),
		externalMiB: Math.round(usage.external / (1024 * 1024)),
		arrayBuffersMiB: Math.round(usage.arrayBuffers / (1024 * 1024)),
	});
};

/**
 * Computes the artifact identity for one scan.
 *
 * @param scan - Scan providing extractor and artifact context identity.
 * @param input - Content hash and artifact kind.
 * @returns The complete artifact key.
 */
export const artifactKeyOf = (
	scan: ScanResultType,
	input: Readonly<{contentSha256: string; kind: string}>,
): Readonly<{contentSha256: string; artifactKind: string; extractorId: string; extractorVersion: string; contextHash: string}> => ({
	contentSha256: input.contentSha256,
	artifactKind: input.kind,
	extractorId: scan.extractorId,
	extractorVersion: scan.extractorVersion,
	contextHash: scan.artifactContextHash ?? scan.configHash,
});

/**
 * Stores one reusable extraction artifact per file.
 *
 * Identity is the raw content hash, artifact kind, extractor identity, extractor
 * version, and the scan configuration hash that captures compiler options and
 * project context.
 *
 * @param input - Database, generation, files, facts, and artifact context.
 */
const persistArtifacts = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		files: readonly SourceFileType[];
		facts: ExtractionResultType;
		contextHash: string;
		extractorId: string;
		extractorVersion: string;
	}>,
): void => {
	const missing = input.files.filter(
		(file) =>
			!input.database.hasExtractionArtifact({
				contentSha256: file.sha256,
				artifactKind: 'symbols',
				extractorId: input.extractorId,
				extractorVersion: input.extractorVersion,
				contextHash: input.contextHash,
			}),
	);

	if (missing.length === 0) {
		debug('extraction artifacts reused', {generationId: input.generationId, files: input.files.length});
		return;
	}

	const missingPaths = new Set(missing.map((file) => file.path));
	const symbolsByPath = new Map<string, ExtractionResultType['symbols'][number][]>();
	const occurrencesByPath = new Map<string, ExtractionResultType['occurrences'][number][]>();

	for (const symbol of input.facts.symbols) {
		if (!missingPaths.has(symbol.path)) {
			continue;
		}

		const group = symbolsByPath.get(symbol.path) ?? [];
		group.push(symbol);
		symbolsByPath.set(symbol.path, group);
	}

	for (const occurrence of input.facts.occurrences) {
		if (!missingPaths.has(occurrence.path)) {
			continue;
		}

		const group = occurrencesByPath.get(occurrence.path) ?? [];
		group.push(occurrence);
		occurrencesByPath.set(occurrence.path, group);
	}

	const entries = missing.map((file) => ({
		contentSha256: file.sha256,
		artifactKind: 'symbols',
		extractorId: input.extractorId,
		extractorVersion: input.extractorVersion,
		contextHash: input.contextHash,
		artifactJson: JSON.stringify({
			symbols: symbolsByPath.get(file.path) ?? [],
			occurrences: occurrencesByPath.get(file.path) ?? [],
		}),
	}));
	input.database.putExtractionArtifacts(entries);
	debug('extraction artifacts stored', {generationId: input.generationId, files: entries.length});
};

/**
 * Stores one dependency edge artifact per file.
 *
 * @param input - Database, files, dependency facts, and artifact context.
 */
const persistDependencyArtifacts = (
	input: Readonly<{
		database: IndexDatabase;
		files: readonly SourceFileType[];
		dependencies: DependencyExtractionResultType;
		contextHash: string;
		extractorId: string;
		extractorVersion: string;
	}>,
): void => {
	const missing = input.files.filter(
		(file) =>
			!input.database.hasExtractionArtifact({
				contentSha256: file.sha256,
				artifactKind: 'dependencies',
				extractorId: input.extractorId,
				extractorVersion: input.extractorVersion,
				contextHash: input.contextHash,
			}),
	);

	if (missing.length === 0) {
		return;
	}

	const missingPaths = new Set(missing.map((file) => file.path));
	const edgesByPath = new Map<string, DependencyExtractionResultType['edges'][number][]>();
	const bindingsByEdge = new Map<string, DependencyExtractionResultType['bindings'][number][]>();

	for (const edge of input.dependencies.edges) {
		if (!missingPaths.has(edge.sourcePath)) {
			continue;
		}

		const group = edgesByPath.get(edge.sourcePath) ?? [];
		group.push(edge);
		edgesByPath.set(edge.sourcePath, group);
	}

	for (const bindingEntry of input.dependencies.bindings) {
		const group = bindingsByEdge.get(bindingEntry.edgeId) ?? [];
		group.push(bindingEntry);
		bindingsByEdge.set(bindingEntry.edgeId, group);
	}

	const entries = missing.map((file) => {
		const edges = edgesByPath.get(file.path) ?? [];

		return {
			contentSha256: file.sha256,
			artifactKind: 'dependencies',
			extractorId: input.extractorId,
			extractorVersion: input.extractorVersion,
			contextHash: input.contextHash,
			artifactJson: JSON.stringify({
				edges,
				bindings: edges.flatMap((edge) => bindingsByEdge.get(edge.id) ?? []),
			}),
		};
	});
	input.database.putExtractionArtifacts(entries);
};

export const persistArtifactCaches = (
	input: Readonly<{
		database: IndexDatabase;
		generationId: string;
		files: readonly SourceFileType[];
		facts: ExtractionResultType;
		dependencies: DependencyExtractionResultType;
		contextHash: string;
		extractorId: string;
		extractorVersion: string;
	}>,
): void => {
	persistArtifacts({
		database: input.database,
		generationId: input.generationId,
		files: input.files,
		facts: input.facts,
		contextHash: input.contextHash,
		extractorId: input.extractorId,
		extractorVersion: input.extractorVersion,
	});
	debugMemory('symbol-artifacts-persisted');
	persistDependencyArtifacts({
		database: input.database,
		files: input.files,
		dependencies: input.dependencies,
		contextHash: input.contextHash,
		extractorId: input.extractorId,
		extractorVersion: input.extractorVersion,
	});
	debugMemory('dependency-artifacts-persisted');
};

/**
 * Buffers adapter-owned artifacts until the build has completed.
 *
 * @param database - Index database that will receive the buffered artifacts.
 * @param scan - Scan identity used for the artifact key.
 * @returns The extractor cache plus a flush action.
 */
export const createExtractorCache = (database: IndexDatabase, scan: ScanResultType): Readonly<{cache: ExtractorArtifactCacheType; flush: () => void}> => {
	const buffered = new Map<string, Readonly<{contentSha256: string; artifactKind: string; artifactJson: string}>>();

	return {
		cache: {
			has: (artifact): boolean =>
				buffered.has(`${artifact.contentSha256}\u0000${artifact.kind}`) || database.hasExtractionArtifact(artifactKeyOf(scan, artifact)),
			write: (artifact): void => {
				const key = `${artifact.contentSha256}\u0000${artifact.kind}`;

				if (buffered.has(key)) {
					return;
				}

				const {contentSha256, kind, payload} = artifact;
				buffered.set(key, {contentSha256, artifactKind: kind, artifactJson: payload});
			},
		},
		flush: (): void => {
			if (buffered.size === 0) {
				return;
			}

			database.putExtractionArtifacts(
				[...buffered.values()].map((entry) => ({
					contentSha256: entry.contentSha256,
					artifactKind: entry.artifactKind,
					extractorId: scan.extractorId,
					extractorVersion: scan.extractorVersion,
					contextHash: scan.artifactContextHash ?? scan.configHash,
					artifactJson: entry.artifactJson,
				})),
			);
		},
	};
};
