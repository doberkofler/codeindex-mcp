import {type ExtractorArtifactCacheType} from '../../adapters/types.ts';
import {debugFor} from '../logging/debug.ts';
import {type ScanResultType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';

const debug = debugFor('build');

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
 * Buffers adapter-owned artifacts until the build has completed.
 *
 * Generic symbol and dependency artifacts are no longer written: they were
 * never read, and every row was derivable from published facts. Adapters that
 * own a digest, such as Oracle parse output, write through this cache and read
 * the same kind back through `getExtractionArtifact`.
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
			debug('adapter artifacts stored', {contentHashes: buffered.size});
		},
	};
};
