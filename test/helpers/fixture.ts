import {cpSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {type ConfigType} from '../../src/core/config/config.ts';
import {createCodeIndex, type CodeIndex} from '../../src/core/generation/codeIndex.ts';
import {buildGeneration} from '../../src/core/generation/buildGeneration.ts';
import {type LoggerType} from '../../src/core/logging/logger.ts';
import {IndexDatabase} from '../../src/core/storage/database.ts';

const silence = (): void => {
	void 0;
};

export const silentLogger: LoggerType = {
	debug: silence,
	info: silence,
	warn: silence,
	error: silence,
};

export type FixtureContextType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	index: CodeIndex;
	cleanup: () => void;
}>;

export const createFixtureConfig = (fixtureName: string): Readonly<{config: ConfigType; cleanup: () => void}> => {
	const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'code-index-test-'));
	const workspace = path.join(temporaryRoot, 'workspace');

	cpSync(path.join(import.meta.dirname, '..', 'fixtures', fixtureName), workspace, {recursive: true});

	const rootDir = realpathSync(workspace);

	const config: ConfigType = {
		projectName: `fixture-${fixtureName}`,
		rootDir,
		extractorId: 'typescript',
		extractorOptions: {},
		projectFilePath: path.join(rootDir, 'tsconfig.json'),
		databasePath: path.join(temporaryRoot, 'index.sqlite'),
		analyticsEnabled: false,
		analyticsPath: path.join(temporaryRoot, 'analytics', 'events.jsonl'),
		maxResultBytes: 32_768,
		maxReadLines: 200,
		semanticDiagnostics: false,
		projectId: `fixture-${fixtureName}`,
		logLevel: 'error',
		configPath: null,
	};

	return {
		config,
		cleanup: () => {
			rmSync(temporaryRoot, {recursive: true, force: true});
		},
	};
};

export const createFixtureIndex = (fixtureName: string): FixtureContextType => {
	const {config, cleanup} = createFixtureConfig(fixtureName);
	const database = IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		projectId: config.projectId,
		extractorId: config.extractorId,
	});

	buildGeneration({config, database, logger: silentLogger});

	const index = createCodeIndex(config, database, silentLogger, {watch: false});

	return {
		config,
		database,
		index,
		cleanup: () => {
			database.close();
			cleanup();
		},
	};
};
