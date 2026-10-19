import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {asString} from '../../storage/databaseRows.ts';
import {IndexDatabase} from '../../storage/database.ts';
import {createCodeIndex} from '../../generation/codeIndex.ts';
import {createLogger} from '../../logging/logger.ts';
import {loadConfig, type ConfigType} from '../../config/config.ts';
import {readVcsProvenance} from '../../../adapters/vcs/vcsProvenance.ts';
import {readCsv} from './oracleCsv.ts';
import {objectKey, objectMapping, objectTypeOfPath, type ObjectMappingType} from './oracleMapping.ts';
import {compareFacts, gateOf, readOracleTruth, type ComparisonType} from './oracleTruth.ts';
import {loadCodeDependencies, loadCodeFacts} from './oracleCodeFacts.ts';
import {readTruthDependencies} from './oracleDependencies.ts';

type QualifyIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

export type OracleOptionsType = Readonly<{
	identifiers?: string | undefined;
	dependencies?: string | undefined;
	output?: string | undefined;
}>;

type OracleQualificationResultType = Readonly<{
	code: number;
	report: ReportType;
}>;

type DependencyMetricsType = Readonly<{
	truth: number;
	actual: number;
	matched: number;
	missing: number;
	extra: number;
	recall: number;
	precision: number;
}>;

type ReportType = Readonly<{
	extractor: 'oracle';
	generationId: string;
	corpus: Readonly<{files: number; objects: number}>;
	truth: Readonly<{rows: number; invalidDeclarationRows: number; excludedPackageReferences: number}>;
	declarations: ComparisonType;
	references: ComparisonType;
	dependencies: DependencyMetricsType;
	gates: Readonly<{
		declarations: Readonly<{ok: boolean; recall: boolean; precision: boolean}>;
		references: Readonly<{ok: boolean; recall: boolean; precision: boolean}>;
		dependencies: Readonly<{ok: boolean; recall: boolean; precision: boolean}>;
		ok: boolean;
	}>;
}>;

const DECLARATION_RECALL_GATE = 0.995;
const REFERENCE_RECALL_GATE = 0.995;

const buildIndex = async (config: ConfigType): Promise<void> => {
	const database = IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		extractorId: config.extractorId,
		projectId: config.projectId,
		vcs: readVcsProvenance(config.rootDir),
	});
	const index = createCodeIndex(config, database, createLogger({minimumLevel: config.logLevel}), {watch: false});

	try {
		// Qualification must observe the current extractor, never an index built
		// by an older parser implementation.
		await index.ensureReady({force: true});
	} finally {
		await index.close();
	}
};

const mappingsOf = (rootDir: string, files: readonly string[]): ReadonlyMap<string, ObjectMappingType> => {
	const mappings = new Map<string, ObjectMappingType>();

	for (const filePath of files) {
		const objectType = objectTypeOfPath(filePath);

		if (objectType === null) {
			continue;
		}

		const objectName = path.basename(filePath, path.extname(filePath));
		const key = objectKey(objectType, objectName);

		if (mappings.has(key)) {
			throw new Error(`Duplicate Oracle object in corpus: ${objectType} ${objectName}`);
		}

		mappings.set(key, objectMapping(rootDir, filePath, objectType, objectName));
	}

	return mappings;
};

const packageNamesOf = (mappings: ReadonlyMap<string, ObjectMappingType>): ReadonlySet<string> =>
	new Set([...mappings.keys()].filter((key) => key.startsWith('PACKAGE:') || key.startsWith('PACKAGE BODY:')).map((key) => key.split(':')[1] ?? ''));

const packageByPathOf = (mappings: ReadonlyMap<string, ObjectMappingType>): ReadonlyMap<string, string> => {
	const packages = new Map<string, string>();

	for (const [key, mapping] of mappings) {
		if (key.startsWith('PACKAGE:') || key.startsWith('PACKAGE BODY:')) {
			packages.set(mapping.path, key.split(':')[1] ?? '');
		}
	}

	return packages;
};

const dependencyMetricsOf = (truth: ReadonlySet<string>, actual: ReadonlySet<string>): DependencyMetricsType => {
	const matched = [...truth].filter((key) => actual.has(key)).length;

	return {
		truth: truth.size,
		actual: actual.size,
		matched,
		missing: truth.size - matched,
		extra: actual.size - matched,
		recall: truth.size === 0 ? 1 : matched / truth.size,
		precision: actual.size === 0 ? 1 : matched / actual.size,
	};
};

const publishedGeneration = (reader: DatabaseSync): string => {
	const generation = reader.prepare("select id from generation where state = 'published' order by completed_at desc limit 1").get();

	if (generation === undefined) {
		throw new Error('Oracle qualification requires a published generation');
	}

	return asString(generation, 'id');
};

const filesOf = (reader: DatabaseSync, generationId: string): readonly string[] =>
	reader
		.prepare('select path from file where generation_id = ? order by path')
		.all(generationId)
		.map((row) => asString(row, 'path'));

const reportOf = (
	input: Readonly<{
		generationId: string;
		files: number;
		objects: number;
		truth: ReturnType<typeof readOracleTruth>;
		declarations: ComparisonType;
		references: ComparisonType;
		dependencies: DependencyMetricsType;
	}>,
): ReportType => {
	const declarationGate = gateOf(input.declarations, DECLARATION_RECALL_GATE);
	const referenceGate = gateOf(input.references, REFERENCE_RECALL_GATE);
	const dependencyGate = gateOf(input.dependencies, REFERENCE_RECALL_GATE);

	return {
		extractor: 'oracle',
		generationId: input.generationId,
		corpus: {files: input.files, objects: input.objects},
		truth: {
			rows: input.truth.identifierRows,
			invalidDeclarationRows: input.truth.invalidDeclarationRows,
			excludedPackageReferences: input.truth.excludedPackageReferences,
		},
		declarations: input.declarations,
		references: input.references,
		dependencies: input.dependencies,
		gates: {
			declarations: declarationGate,
			references: referenceGate,
			dependencies: dependencyGate,
			ok: declarationGate.ok && referenceGate.ok && dependencyGate.ok,
		},
	};
};

/**
 * Qualifies one resolved Oracle workspace against already-exported truth.
 *
 * The index is always rebuilt to prevent an older parser generation from
 * being reused by a qualification run.
 *
 * @param config - Resolved Oracle workspace configuration.
 * @param io - Output sinks.
 * @param options - Truth export paths and optional report path.
 * @returns Exit code and the full report.
 */
export const qualifyOracleConfig = async (config: ConfigType, io: QualifyIoType, options: OracleOptionsType): Promise<OracleQualificationResultType> => {
	const {identifiers, dependencies, output} = options;

	if (identifiers === undefined || dependencies === undefined) {
		throw new Error('Oracle qualification requires identifiers and dependencies exports');
	}

	await buildIndex(config);
	const reader = new DatabaseSync(config.databasePath, {readOnly: true});

	try {
		const generationId = publishedGeneration(reader);
		const files = filesOf(reader, generationId);
		const mappings = mappingsOf(config.rootDir, files);
		const truth = readOracleTruth({rows: readCsv(identifiers), mappings});
		const code = loadCodeFacts(reader, generationId);
		const packageNames = packageNamesOf(mappings);
		const truthDependencies = readTruthDependencies(readCsv(dependencies), mappings, packageNames);
		const codeDependencies = loadCodeDependencies(reader, generationId, packageNames, packageByPathOf(mappings));
		const report = reportOf({
			generationId,
			files: files.length,
			objects: mappings.size,
			truth,
			declarations: compareFacts(truth.definitions, code.definitions),
			references: compareFacts(truth.references, code.references),
			dependencies: dependencyMetricsOf(truthDependencies, codeDependencies),
		});
		const serialized = `${JSON.stringify(report, null, 2)}\n`;

		if (output !== undefined) {
			writeFileSync(path.resolve(output), serialized, {encoding: 'utf8'});
		}

		io.stdout(serialized.trimEnd());

		return {code: report.gates.ok ? 0 : 1, report};
	} finally {
		reader.close();
	}
};

/**
 * Qualifies an Oracle index against exported PL/Scope and dependency truth.
 *
 * @param environment - Environment after CLI overrides.
 * @param io - Output sinks.
 * @param options - Oracle export paths and optional report path.
 * @returns Process exit code: 0 only when every qualification gate passes.
 */
export const runOracleQualification = async (environment: NodeJS.ProcessEnv, io: QualifyIoType, options: OracleOptionsType): Promise<number> => {
	const identifiersPath = options.identifiers ?? environment['CODE_INDEX_ORACLE_IDENTIFIERS'];
	const dependenciesPath = options.dependencies ?? environment['CODE_INDEX_ORACLE_DEPENDENCIES'];

	if (identifiersPath === undefined || dependenciesPath === undefined) {
		throw new Error('Oracle qualification requires --identifiers and --dependencies (or CODE_INDEX_ORACLE_IDENTIFIERS and CODE_INDEX_ORACLE_DEPENDENCIES)');
	}

	const config = loadConfig(environment);

	if (config.extractorId !== 'oracle') {
		throw new Error(`Oracle qualification requires the oracle extractor, received ${config.extractorId}`);
	}

	const result = await qualifyOracleConfig(config, io, {identifiers: identifiersPath, dependencies: dependenciesPath, output: options.output});

	return result.code;
};
