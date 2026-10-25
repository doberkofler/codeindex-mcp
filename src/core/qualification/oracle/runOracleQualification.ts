import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {type ExtractorType} from '../../../adapters/types.ts';
import {oracleExtractor} from '../../../adapters/oracle/index.ts';
import {configForOracleParser} from '../../../adapters/oracle/parserBinding.ts';
import {oracleParserIdentityOf, type OracleParserIdType, type OracleParserIdentityType} from '../../../adapters/oracle/parserIdentity.ts';
import {asString} from '../../storage/databaseRows.ts';
import {IndexDatabase} from '../../storage/database.ts';
import {createCodeIndex} from '../../generation/codeIndex.ts';
import {createLogger} from '../../logging/logger.ts';
import {loadConfig, type ConfigType} from '../../config/config.ts';
import {readVcsProvenance} from '../../../adapters/vcs/vcsProvenance.ts';
import {readCsv} from './oracleCsv.ts';
import {objectKey, objectMapping, objectTypeOfPath, type ObjectMappingType} from './oracleMapping.ts';
import {compareFacts, readOracleTruth, type ComparisonType} from './oracleTruth.ts';
import {type TruthExclusionCountsType} from './oracleTruthExclusions.ts';
import {loadAmbiguousOverloadSites, loadCodeDependencies, loadCodeFacts} from './oracleCodeFacts.ts';
import {readTruthDependencies} from './oracleDependencies.ts';
import {createExtraClassifier} from './oracleExtras.ts';
import {oracleGatesOf, oracleQualificationContractIdentityOf, type OracleQualificationContractIdentityType} from './oracleQualificationContract.ts';
import {compareOracleStrata} from './oracleStratification.ts';
import {oracleTruthPolicyOf, type OracleTruthPolicyVersionType} from './oracleTruthPolicy.ts';

type QualifyIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

export type OracleOptionsType = Readonly<{
	identifiers?: string | undefined;
	dependencies?: string | undefined;
	output?: string | undefined;
	units?: readonly Readonly<{path: string; type: string; name: string}>[] | undefined;
	truthPolicy?: OracleTruthPolicyVersionType | undefined;
	/** Qualification-only parser selection. Production stays structural. */
	parser?: OracleParserIdType | undefined;
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
	parser: OracleParserIdentityType;
	contract: OracleQualificationContractIdentityType;
	corpus: Readonly<{files: number; objects: number; sourceHash: string; configHash: string}>;
	policy: Readonly<{version: OracleTruthPolicyVersionType; supportedTypes: readonly string[]; supportedKinds: readonly string[]}>;
	truth: Readonly<{
		rows: number;
		invalidDeclarationRows: number;
		excludedPackageReferences: number;
		excludedByReason: TruthExclusionCountsType;
		malformedRows: number;
		outOfScopeObjectRows: number;
		includedDeclarations: number;
		includedReferences: number;
		excludedTotal: number;
		identifiersSha256: string;
		dependenciesSha256: string;
		ambiguousOverloadDiagnostics: number;
	}>;
	declarations: ComparisonType;
	references: ComparisonType;
	declarationStrata: Readonly<Record<string, ComparisonType>>;
	referenceStrata: Readonly<Record<string, ComparisonType>>;
	dependencies: DependencyMetricsType;
	gates: ReturnType<typeof oracleGatesOf>;
}>;

const buildIndex = async (config: ConfigType, extractor: ExtractorType): Promise<void> => {
	const database = IndexDatabase.open(config.databasePath, {
		rootDir: config.rootDir,
		projectFilePath: config.projectFilePath,
		extractorId: config.extractorId,
		projectId: config.projectId,
		vcs: readVcsProvenance(config.rootDir),
	});
	const index = createCodeIndex(config, database, createLogger({minimumLevel: config.logLevel}), {watch: false, extractor});

	try {
		// Qualification must observe the current extractor, never an index built
		// by an older parser implementation.
		await index.ensureReady({force: true});
	} finally {
		await index.close();
	}
};

/**
 * Resolves the qualification extractor binding.
 *
 * The ANTLR module is imported dynamically so production entries never load or
 * bundle the generated parser.
 *
 * @param parser - Selected parser implementation.
 * @returns The bound extractor.
 */
const extractorForParser = async (parser: OracleParserIdType): Promise<ExtractorType> => {
	if (parser === 'structural') {
		return oracleExtractor;
	}

	const {antlrOracleExtractor} = await import('../../../adapters/oracle/antlrExtractor.ts');
	return antlrOracleExtractor;
};

const mappingsOf = (
	rootDir: string,
	files: readonly string[],
	units?: readonly Readonly<{path: string; type: string; name: string}>[],
): ReadonlyMap<string, ObjectMappingType> => {
	const mappings = new Map<string, ObjectMappingType>();

	if (units !== undefined) {
		const indexed = new Set(files);

		for (const unit of units) {
			if (!indexed.has(unit.path)) {
				throw new Error(`Oracle qualification snapshot object was not indexed: ${unit.path}`);
			}

			const key = objectKey(unit.type, unit.name);

			if (mappings.has(key)) {
				throw new Error(`Duplicate Oracle object in corpus: ${unit.type} ${unit.name}`);
			}

			mappings.set(key, objectMapping(rootDir, unit.path, unit.type, unit.name));
		}

		return mappings;
	}

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

const mappingsByPathOf = (mappings: ReadonlyMap<string, ObjectMappingType>): ReadonlyMap<string, ObjectMappingType> =>
	new Map([...mappings.values()].map((mapping) => [mapping.path, mapping]));

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

const publishedGenerationOf = (reader: DatabaseSync): Readonly<{id: string; sourceHash: string; configHash: string}> => {
	const generation = reader.prepare("select id, source_hash, config_hash from generation where state = 'published' order by completed_at desc limit 1").get();

	if (generation === undefined) {
		throw new Error('Oracle qualification requires a published generation');
	}

	return {
		id: asString(generation, 'id'),
		sourceHash: asString(generation, 'source_hash'),
		configHash: asString(generation, 'config_hash'),
	};
};

const fileSha256Of = (filePath: string): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');

const excludedTotalOf = (counts: TruthExclusionCountsType): number => Object.values(counts).reduce((total, count) => total + count, 0);

const filesOf = (reader: DatabaseSync, generationId: string): readonly string[] =>
	reader
		.prepare('select path from file where generation_id = ? order by path')
		.all(generationId)
		.map((row) => asString(row, 'path'));

const reportOf = (
	input: Readonly<{
		generationId: string;
		sourceHash: string;
		configHash: string;
		parser: OracleParserIdentityType;
		files: number;
		objects: number;
		truth: ReturnType<typeof readOracleTruth>;
		declarations: ComparisonType;
		references: ComparisonType;
		strata: ReturnType<typeof compareOracleStrata>;
		dependencies: DependencyMetricsType;
		identifiersSha256: string;
		dependenciesSha256: string;
		ambiguousOverloadDiagnostics: number;
	}>,
): ReportType => ({
	extractor: 'oracle',
	generationId: input.generationId,
	parser: input.parser,
	contract: oracleQualificationContractIdentityOf(),
	corpus: {files: input.files, objects: input.objects, sourceHash: input.sourceHash, configHash: input.configHash},
	policy: {
		version: input.truth.policy.version,
		supportedTypes: Object.keys(input.truth.policy.supportedTypes).sort(),
		supportedKinds: [...input.truth.policy.supportedKinds].sort(),
	},
	truth: {
		rows: input.truth.identifierRows,
		invalidDeclarationRows: input.truth.invalidDeclarationRows,
		excludedPackageReferences: input.truth.excludedPackageReferences,
		excludedByReason: input.truth.excludedByReason,
		malformedRows: input.truth.malformedRows,
		outOfScopeObjectRows: input.truth.outOfScopeObjectRows,
		includedDeclarations: input.truth.definitions.size,
		includedReferences: input.truth.references.size,
		excludedTotal: excludedTotalOf(input.truth.excludedByReason),
		identifiersSha256: input.identifiersSha256,
		dependenciesSha256: input.dependenciesSha256,
		ambiguousOverloadDiagnostics: input.ambiguousOverloadDiagnostics,
	},
	declarations: input.declarations,
	references: input.references,
	declarationStrata: input.strata.declarations,
	referenceStrata: input.strata.references,
	dependencies: input.dependencies,
	gates: oracleGatesOf({
		declarations: input.declarations,
		references: input.references,
		dependencies: input.dependencies,
		identifierRows: input.truth.identifierRows,
	}),
});

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

	const parser = options.parser ?? 'structural';
	const identity = oracleParserIdentityOf(parser);
	const pinnedConfig = configForOracleParser(config, parser);

	await buildIndex(pinnedConfig, await extractorForParser(parser));
	const reader = new DatabaseSync(pinnedConfig.databasePath, {readOnly: true});

	try {
		const generation = publishedGenerationOf(reader);
		const files = filesOf(reader, generation.id);
		const mappings = mappingsOf(pinnedConfig.rootDir, files, options.units);
		const mappingsByPath = mappingsByPathOf(mappings);
		const policy = oracleTruthPolicyOf(options.truthPolicy);
		const ambiguousOverloadPositions = loadAmbiguousOverloadSites(reader, generation.id);
		const truth = readOracleTruth({rows: readCsv(identifiers), mappings, policy, ambiguousOverloadPositions});
		const code = loadCodeFacts(reader, generation.id);
		const packageNames = packageNamesOf(mappings);
		const truthDependencies = readTruthDependencies(readCsv(dependencies), mappings, packageNames);
		const codeDependencies = loadCodeDependencies(reader, generation.id, packageNames, packageByPathOf(mappings));
		const classifyExtra = createExtraClassifier({mappings: mappingsByPath, rowsByPath: truth.rowsByPath});
		const compareOptions = {policy, excluded: truth.excluded, classifyExtra};
		const declarations = compareFacts(truth.definitions, code.definitions, {...compareOptions, role: 'declaration'});
		const references = compareFacts(truth.references, code.references, {...compareOptions, role: 'reference'});
		const strata = compareOracleStrata({truth, actual: code, mappings: mappingsByPath, policy, classifyExtra});
		const report = reportOf({
			generationId: generation.id,
			sourceHash: generation.sourceHash,
			configHash: generation.configHash,
			parser: identity,
			files: files.length,
			objects: mappings.size,
			truth,
			declarations,
			references,
			strata,
			dependencies: dependencyMetricsOf(truthDependencies, codeDependencies),
			identifiersSha256: fileSha256Of(identifiers),
			dependenciesSha256: fileSha256Of(dependencies),
			ambiguousOverloadDiagnostics: ambiguousOverloadPositions.size,
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

	const result = await qualifyOracleConfig(config, io, {
		identifiers: identifiersPath,
		dependencies: dependenciesPath,
		output: options.output,
		units: options.units,
		truthPolicy: options.truthPolicy,
		parser: options.parser,
	});

	return result.code;
};
