import {type ConfigType} from '../config/config.ts';
import {createCodeIndex} from '../generation/codeIndex.ts';
import {createLogger} from '../logging/logger.ts';
import {IndexDatabase} from '../storage/database.ts';
import {type BenchmarkBuildScenarioType, type BenchmarkReuseType} from './benchTypes.ts';
import {readStorage, startResourceSampler} from './resources.ts';

const LOGGER = createLogger({minimumLevel: 'error'});

export const reuseOf = (
	input: Readonly<{
		report: Readonly<{reused: boolean; fileCount: number; generationId: string}>;
		beforeContent: ReadonlySet<string>;
		artifactRowsBefore: number;
		artifactRowsAfter: number;
		files: readonly Readonly<{sha256: string}>[];
	}>,
): BenchmarkReuseType => {
	const filesReused = input.files.filter((file) => input.beforeContent.has(file.sha256)).length;

	return {
		generationReused: input.report.reused,
		filesTotal: input.report.fileCount,
		filesReused,
		contentReuseRatio: input.report.fileCount === 0 ? 0 : filesReused / input.report.fileCount,
		artifactRowsBefore: input.artifactRowsBefore,
		artifactRowsAfter: input.artifactRowsAfter,
		artifactRowsRead: 0,
		artifactReuseRatio: 0,
		artifactConsumption: 'parse_digest',
	};
};

/**
 * Runs one build scenario against a real database.
 *
 * @param input - Configuration, scenario name, and force flag.
 * @returns Build timing, resource, storage, and reuse metrics.
 */
export const runBuildScenario = async (
	input: Readonly<{
		config: ConfigType;
		name: 'cold_build' | 'warm_reuse' | 'warm_rebuild';
		force: boolean;
		workerEntry?: string | undefined;
	}>,
): Promise<BenchmarkBuildScenarioType> => {
	const resources = startResourceSampler();
	const database = IndexDatabase.open(input.config.databasePath, {
		rootDir: input.config.rootDir,
		projectFilePath: input.config.projectFilePath,
		extractorId: input.config.extractorId,
		projectId: input.config.projectId,
	});
	const beforeContent = new Set(database.contentHashes());
	const artifactRowsBefore = database.extractionArtifactCount();
	const index = createCodeIndex(input.config, database, LOGGER, {watch: false, ...(input.workerEntry === undefined ? {} : {workerEntry: input.workerEntry})});

	try {
		const startedAt = performance.now();
		const report = await index.ensureReady({force: input.force});
		const wallMs = performance.now() - startedAt;
		const files = database.listFiles(report.generationId);
		const storage = readStorage(database, input.config.databasePath);
		const artifactRowsAfter = storage.extractionArtifacts;

		return {
			kind: 'build',
			name: input.name,
			wallMs: Math.round(wallMs),
			generationId: report.generationId,
			build: {reused: report.reused, durationMs: report.durationMs, stages: report.stages},
			resources: resources.stop(),
			storage,
			reuse: reuseOf({report, beforeContent, artifactRowsBefore, artifactRowsAfter, files}),
		};
	} finally {
		await index.close();
	}
};
