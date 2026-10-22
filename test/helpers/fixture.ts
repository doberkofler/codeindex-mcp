import {cpSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {type ConfigType} from '../../src/core/config/config.ts';
import {createCodeIndex, type CodeIndex} from '../../src/core/generation/codeIndex.ts';
import {buildGeneration} from '../../src/core/generation/buildGeneration.ts';
import {IndexDatabase} from '../../src/core/storage/database.ts';
import {silentLogger} from './silentLogger.ts';

export {silentLogger} from './silentLogger.ts';

export type FixtureContextType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	index: CodeIndex;
	cleanup: () => void;
}>;

export type FixtureProjectType = Readonly<{
	name: string;
	project: string;
}>;

export const createFixtureConfig = (
	fixtureName: string,
	projects: readonly FixtureProjectType[] = [{name: 'root', project: 'tsconfig.json'}],
	extractorId = 'typescript',
): Readonly<{config: ConfigType; cleanup: () => void}> => {
	const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'code-index-test-'));
	const workspace = path.join(temporaryRoot, 'workspace');

	cpSync(path.join(import.meta.dirname, '..', 'fixtures', fixtureName), workspace, {recursive: true});

	const rootDir = realpathSync(workspace);
	const projectContexts = projects.map((project) => ({
		name: project.name,
		projectFilePath: path.join(rootDir, project.project),
	}));
	const firstProject = projectContexts.at(0);

	if (firstProject === undefined) {
		throw new Error('A fixture requires at least one project');
	}

	const config: ConfigType = {
		projectName: `fixture-${fixtureName}`,
		rootDir,
		extractorId,
		extractorOptions: {},
		projectFilePath: firstProject.projectFilePath,
		projects: projectContexts,
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

export const createFixtureIndex = (fixtureName: string, projects?: readonly FixtureProjectType[], extractorId = 'typescript'): FixtureContextType => {
	const {config, cleanup} = createFixtureConfig(fixtureName, projects, extractorId);
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
