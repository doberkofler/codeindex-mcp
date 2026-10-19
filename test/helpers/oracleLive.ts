import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {scanOracleProject} from '../../src/adapters/oracle/scanProject.ts';
import {
	normalizeOracleSource,
	oracleObjectKeyOf,
	oracleSourceUnitsOf,
	type OracleInstalledSourceType,
} from '../../src/core/qualification/oracle/live/oracleLiveSource.ts';
import {type LivePlanType} from '../../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {type OracleLiveSettingsType} from '../../src/core/qualification/oracle/live/oracleLiveSettings.ts';
import {createFixtureConfig} from './fixture.ts';

export const fixture = (): ReturnType<typeof createFixtureConfig> =>
	createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

export const settingsOf = (outputDir: string, approval: string | null = null): OracleLiveSettingsType => ({
	outputDir,
	timeoutMs: 1000,
	approval,
	connection: approval === null ? null : {server: 'server', user: 'user', password: 'secret'},
});

export const capture = (): Readonly<{
	stdout: string[];
	stderr: string[];
	io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>;
}> => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
	};
};

export type StubDatabaseType = Readonly<{
	query: (sql: string) => Promise<readonly (readonly unknown[])[]>;
	execute: (sql: string) => Promise<void>;
	close: () => Promise<void>;
}>;

export const stubDatabase =
	(backup: readonly (readonly unknown[])[] = []): (() => Promise<StubDatabaseType>) =>
	async (): Promise<StubDatabaseType> => {
		await Promise.resolve();

		return {
			query: async (sql: string): Promise<readonly (readonly unknown[])[]> => {
				await Promise.resolve();
				return sql.includes('FROM user_source') ? backup : [];
			},
			execute: async (): Promise<void> => {
				await Promise.resolve();
			},
			close: async (): Promise<void> => {
				await Promise.resolve();
			},
		};
	};

export const inventoryDatabase =
	(
		inventory: Readonly<{
			backup: readonly (readonly unknown[])[];
			baseline: readonly (readonly unknown[])[];
			invalid: readonly (readonly unknown[])[];
		}>,
		onExecute?: (sql: string) => void,
	): (() => Promise<StubDatabaseType>) =>
	async (): Promise<StubDatabaseType> => {
		await Promise.resolve();
		let invalidQueries = 0;

		return {
			query: async (sql: string): Promise<readonly (readonly unknown[])[]> => {
				await Promise.resolve();

				if (sql.includes('FROM user_source')) {
					return inventory.backup;
				}

				if (sql.includes("status <> 'VALID'")) {
					invalidQueries += 1;
					return invalidQueries === 1 ? inventory.baseline : inventory.invalid;
				}

				if (sql.includes('FROM user_identifiers')) {
					return [];
				}

				if (sql.includes('FROM user_dependencies')) {
					return [];
				}

				throw new Error(`Unexpected SQL: ${sql}`);
			},
			execute: async (sql: string): Promise<void> => {
				await Promise.resolve();
				onExecute?.(sql);
			},
			close: async (): Promise<void> => {
				await Promise.resolve();
			},
		};
	};

export const sourceRows = (plan: LivePlanType): readonly (readonly unknown[])[] =>
	plan.snapshot.units.flatMap((unit) =>
		normalizeOracleSource(readFileSync(path.join(plan.snapshot.dir, unit.path), 'utf8'), unit)
			.split('\n')
			.map((text, index) => [unit.type, unit.name, index + 1, text]),
	);

export const installedSourcesOf = (config: Parameters<typeof scanOracleProject>[0]): ReadonlyMap<string, OracleInstalledSourceType> => {
	const installed = new Map<string, OracleInstalledSourceType>();

	for (const file of scanOracleProject(config).files) {
		for (const unit of oracleSourceUnitsOf(file.path, readFileSync(file.absolutePath, 'utf8'))) {
			installed.set(oracleObjectKeyOf(unit.object.type, unit.object.name), {
				type: unit.object.type,
				name: unit.object.name,
				source: unit.source,
			});
		}
	}

	return installed;
};

export const qualificationConfig = (config: ReturnType<typeof fixture>['config'], manifestPath: string): ReturnType<typeof fixture>['config'] => ({
	...config,
	projectFilePath: manifestPath,
	projects: [{name: 'app', projectFilePath: manifestPath}],
});

export const writeSelectionManifest = (manifestPath: string): void => {
	writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				dialect: '19c',
				defaultSchema: 'APP',
				extensions: ['.pks', '.pkb', '.sql'],
				include: ['database/**/*.pks', 'database/**/*.pkb', 'database/**/*.sql'],
				exclude: [],
			},
			null,
			2,
		)}\n`,
		{encoding: 'utf8'},
	);
};
