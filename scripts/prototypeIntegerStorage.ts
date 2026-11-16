import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {cpus, release, tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {DIGEST_QUERIES} from './prototypeIntegerStorageDigests.ts';
import {digestRows, queryEvidence} from './prototypeIntegerStorageQueries.ts';
import {copySql, indexSql, schemaSql, type VariantType} from './prototypeIntegerStorageSql.ts';

const {dirname, join, resolve} = path;

const ArgumentsSchema = z.object({
	source: z.string().min(1),
	output: z.string().min(1),
});

const InternalArgumentsSchema = z.object({
	source: z.string().min(1),
	database: z.string().min(1),
	variant: z.enum(['narrow', 'ordered']),
});

const VariantResultSchema = z.object({
	variant: z.enum(['narrow', 'ordered']),
	rebuild: z.object({
		wallMs: z.number(),
		copyMs: z.number(),
		indexMs: z.number(),
		insertionMs: z.number(),
		commitMs: z.number(),
		peakProcessTreeRssBytes: z.number(),
		processTreeMembers: z.number(),
	}),
	storage: z.object({
		beforeCheckpoint: z.object({database: z.number(), wal: z.number(), shm: z.number(), total: z.number()}),
		final: z.object({database: z.number(), wal: z.number(), shm: z.number(), total: z.number()}),
	}),
	integrity: z.object({quickCheck: z.string(), foreignKeyFailures: z.number()}),
	facts: z.array(
		z.object({
			name: z.string(),
			rows: z.number(),
			sourceSha256: z.string(),
			prototypeSha256: z.string(),
			matches: z.boolean(),
		}),
	),
	queries: z.array(
		z.object({
			name: z.string(),
			plan: z.array(z.string()),
			sourceDigest: z.string(),
			prototypeDigest: z.string(),
			matchesSchema18: z.boolean(),
			rows: z.number(),
			coldP50Ms: z.number(),
			coldP95Ms: z.number(),
			coldMaxMs: z.number(),
			warmP50Ms: z.number(),
			warmP95Ms: z.number(),
			warmMaxMs: z.number(),
		}),
	),
});

const parseArguments = (): z.infer<typeof ArgumentsSchema> => {
	const values = new Map<string, string>();
	for (let index = 2; index < process.argv.length; index += 1) {
		const argument = process.argv[index];

		const value = process.argv.at(index + 1);

		if ((argument === '--source' || argument === '--output') && value !== undefined) {
			values.set(argument, value);
			index += 1;
		}
	}

	return ArgumentsSchema.parse({
		source: values.get('--source'),
		output: values.get('--output'),
	});
};

const fileSize = (file: string): number => (existsSync(file) ? statSync(file).size : 0);

const databaseBytes = (databasePath: string): Readonly<{database: number; wal: number; shm: number; total: number}> => {
	const database = fileSize(databasePath);
	const wal = fileSize(`${databasePath}-wal`);
	const shm = fileSize(`${databasePath}-shm`);
	return {database, wal, shm, total: database + wal + shm};
};

const runVariant = (
	sourcePath: string,
	databasePath: string,
	variant: VariantType,
): Readonly<{
	variant: VariantType;
	rebuild: Readonly<{
		wallMs: number;
		copyMs: number;
		indexMs: number;
		insertionMs: number;
		commitMs: number;
		peakProcessTreeRssBytes: number;
		processTreeMembers: number;
	}>;
	storage: Readonly<{beforeCheckpoint: ReturnType<typeof databaseBytes>; final: ReturnType<typeof databaseBytes>}>;
	integrity: Readonly<{quickCheck: string; foreignKeyFailures: number}>;
	facts: readonly Readonly<{name: string; rows: number; sourceSha256: string; prototypeSha256: string; matches: boolean}>[];
	queries: ReturnType<typeof queryEvidence>;
}> => {
	const wallStartedAt = performance.now();
	const database = new DatabaseSync(databasePath);
	database.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma synchronous = normal');
	database.exec(schemaSql(variant));
	database.exec(`attach database '${sourcePath.replaceAll("'", "''")}' as source`);
	database.exec('begin; pragma defer_foreign_keys = on');
	const copyStartedAt = performance.now();

	for (const sql of copySql(variant)) {
		database.exec(sql);
	}

	const copyMs = performance.now() - copyStartedAt;
	const indexStartedAt = performance.now();
	database.exec(indexSql(variant));
	const indexMs = performance.now() - indexStartedAt;
	const commitStartedAt = performance.now();
	database.exec('commit');
	const commitMs = performance.now() - commitStartedAt;
	database.exec('analyze');
	const rebuild = {
		wallMs: performance.now() - wallStartedAt,
		copyMs,
		indexMs,
		insertionMs: copyMs + indexMs,
		commitMs,
		peakProcessTreeRssBytes: process.resourceUsage().maxRSS * 1024,
		processTreeMembers: 1,
	};
	const integrity = {
		quickCheck: String(database.prepare('pragma quick_check').get()?.['quick_check']),
		foreignKeyFailures: database.prepare('pragma foreign_key_check').all().length,
	};
	const facts = DIGEST_QUERIES.map((query) => {
		const source = digestRows(database.prepare(query.source));
		const prototype = digestRows(database.prepare(query.prototype));
		return {name: query.name, rows: source.rows, sourceSha256: source.sha256, prototypeSha256: prototype.sha256, matches: source.sha256 === prototype.sha256};
	});
	const queries = queryEvidence(database, variant);
	const beforeCheckpoint = databaseBytes(databasePath);
	database.exec('pragma wal_checkpoint(truncate)');
	const storage = {beforeCheckpoint, final: databaseBytes(databasePath)};
	database.close();

	return {
		variant,
		rebuild,
		storage,
		integrity,
		facts,
		queries,
	};
};

const internalArguments = (): z.infer<typeof InternalArgumentsSchema> | null => {
	const marker = process.argv.indexOf('--internal-variant');

	if (marker === -1) {
		return null;
	}

	return InternalArgumentsSchema.parse({
		variant: process.argv.at(marker + 1),
		source: process.argv.at(marker + 2),
		database: process.argv.at(marker + 3),
	});
};

const runVariantIsolated = (sourcePath: string, databasePath: string, variant: VariantType): ReturnType<typeof runVariant> => {
	const output = execFileSync(process.execPath, ['--experimental-strip-types', import.meta.filename, '--internal-variant', variant, sourcePath, databasePath], {
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
	});

	return VariantResultSchema.parse(JSON.parse(output));
};

const sourceIdentity = (
	sourcePath: string,
): Readonly<{
	schemaVersion: string;
	sqliteVersion: string;
	databaseBytes: number;
	generation: Readonly<Record<string, unknown>>;
	adapters: readonly Readonly<Record<string, unknown>>[];
	tableCounts: Readonly<Record<string, number>>;
}> => {
	const source = new DatabaseSync(sourcePath, {readOnly: true});

	try {
		const schemaVersion = String(source.prepare("select value from metadata where key = 'schema_version'").get()?.['value']);
		const sqliteVersion = String(source.prepare('select sqlite_version() version').get()?.['version']);
		const generation = source
			.prepare(
				`select id, revision, source_hash, config_hash, input_hash, file_count, symbol_count, occurrence_count,
					dependency_edge_count, dependency_binding_count, diagnostic_count
				 from generation where state = 'published'`,
			)
			.get();

		if (generation === undefined) {
			throw new Error('Source database has no published generation');
		}

		const adapters = source
			.prepare(
				`select adapter_id, adapter_version, compiler_version, coverage, source_hash, config_hash, input_hash,
					file_count, symbol_count, occurrence_count, dependency_edge_count, dependency_binding_count, diagnostic_count
				 from generation_adapter order by adapter_id`,
			)
			.all();
		const tableCounts = Object.fromEntries(
			[
				'metadata',
				'working_copy',
				'indexed_project',
				'content',
				'generation',
				'generation_adapter',
				'file',
				'project_context',
				'generation_file_digest',
				'symbol',
				'symbol_context',
				'symbol_name',
				'symbol_name_context',
				'symbol_name_site',
				'surface_binding_origin',
				'occurrence',
				'occurrence_context',
				'definition_site',
				'dependency_edge',
				'dependency_binding',
				'diagnostic',
				'build_stats',
				'extraction_artifact',
				'build_lease',
			].map((table) => [table, Number(source.prepare(`select count(*) total from ${table}`).get()?.['total'])]),
		);

		return {schemaVersion, sqliteVersion, databaseBytes: statSync(sourcePath).size, generation, adapters, tableCounts};
	} finally {
		source.close();
	}
};

const stableSourceIdentity = (identity: ReturnType<typeof sourceIdentity>): string =>
	JSON.stringify({
		schemaVersion: identity.schemaVersion,
		generation: identity.generation,
		adapters: identity.adapters,
		tableCounts: identity.tableCounts,
	});

const implementationSha256 = (): string => {
	const hash = createHash('sha256');

	for (const fileName of [
		'prototypeIntegerStorage.ts',
		'prototypeIntegerStorageDigests.ts',
		'prototypeIntegerStorageQueries.ts',
		'prototypeIntegerStorageSql.ts',
	]) {
		hash.update(fileName);
		hash.update('\u0000');
		hash.update(readFileSync(join(import.meta.dirname, fileName)));
	}

	return hash.digest('hex');
};

const main = (): void => {
	const argumentsValue = parseArguments();
	const sourcePath = resolve(argumentsValue.source);
	const outputPath = resolve(argumentsValue.output);

	if (!existsSync(sourcePath)) {
		throw new Error('Prototype source database does not exist');
	}

	const directory = mkdtempSync(join(tmpdir(), 'code-index-integer-prototype-'));

	try {
		const source = sourceIdentity(sourcePath);
		const variants = (['narrow', 'ordered'] as const).map((variant) => runVariantIsolated(sourcePath, join(directory, `${variant}.sqlite`), variant));
		const sourceAfter = sourceIdentity(sourcePath);

		if (stableSourceIdentity(source) !== stableSourceIdentity(sourceAfter)) {
			throw new Error('Prototype source changed during the controlled run');
		}

		const cpu = cpus();
		const report = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			command: 'node --experimental-strip-types scripts/prototypeIntegerStorage.ts --source <schema-18.sqlite> --output <report.json>',
			runtime: {
				node: process.version,
				platform: process.platform,
				release: release(),
				architecture: process.arch,
				cpuModel: cpu[0]?.model ?? 'unknown',
				logicalCpuCount: cpu.length,
				sqlite: source.sqliteVersion,
			},
			implementation: {
				sha256: implementationSha256(),
				files: [
					'scripts/prototypeIntegerStorage.ts',
					'scripts/prototypeIntegerStorageDigests.ts',
					'scripts/prototypeIntegerStorageQueries.ts',
					'scripts/prototypeIntegerStorageSql.ts',
				],
			},
			configuration: {
				variants: ['narrow', 'ordered'],
				foreignKeys: true,
				deferredForeignKeys: true,
				journalMode: 'wal',
				synchronous: 'normal',
				coldIterations: 5,
				warmIterations: 50,
				processTreeMeasurement: 'isolated child with no descendants; process.resourceUsage().maxRSS',
			},
			source,
			variants,
			gates: {
				factDigestsMatch: variants.every((variant) => variant.facts.every((fact) => fact.matches)),
				queryDigestsMatchSchema18: variants.every((variant) => variant.queries.every((query) => query.matchesSchema18)),
				integrityPasses: variants.every((variant) => variant.integrity.quickCheck === 'ok' && variant.integrity.foreignKeyFailures === 0),
				orderedHotPlansHaveNoTemporaryBTree: variants
					.filter((variant) => variant.variant === 'ordered')
					.every((variant) =>
						variant.queries
							.filter((query) => query.name === 'find_symbol' || query.name === 'outline' || query.name === 'find_references')
							.every((query) => query.plan.every((line) => !line.includes('TEMP B-TREE'))),
					),
				queryP95AtMost50Ms: variants.every((variant) => variant.queries.every((query) => query.warmP95Ms <= 50)),
				coldQueryP95AtMost50Ms: variants.every((variant) => variant.queries.every((query) => query.coldP95Ms <= 50)),
				orderedDatabaseSmallerThanSchema18: variants
					.filter((variant) => variant.variant === 'ordered')
					.every((variant) => variant.storage.final.database < source.databaseBytes),
			},
		};

		mkdirSync(dirname(outputPath), {recursive: true});
		writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

		process.stdout.write(`${outputPath}\n`);
	} finally {
		rmSync(directory, {recursive: true, force: true});
	}
};

const internal = internalArguments();

if (internal === null) {
	main();
} else {
	process.stdout.write(`${JSON.stringify(runVariant(resolve(internal.source), resolve(internal.database), internal.variant))}\n`);
}
