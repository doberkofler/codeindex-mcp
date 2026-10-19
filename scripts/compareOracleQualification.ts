import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {asNumber, asString} from '../src/core/storage/databaseRows.ts';

const METRICS = ['truth', 'actual', 'matched', 'missing', 'extra', 'ignoredExtra', 'recall', 'precision'] as const;
const EXTRA_CLASSES = ['omitted_by_policy', 'location_mismatch', 'outside_plscope', 'false_positive'] as const;
const SAMPLE_LIMIT = 20;

const ComparisonSchema = z.object({
	truth: z.number(),
	actual: z.number(),
	matched: z.number(),
	missing: z.number(),
	extra: z.number(),
	ignoredExtra: z.number().default(0),
	recall: z.number(),
	precision: z.number(),
});

const ExtraClassSchema = z.object({count: z.number()});
const ExtraClassesSchema = z.record(z.string(), ExtraClassSchema);

const ReportSchema = z.object({
	corpus: z.object({files: z.number(), objects: z.number()}),
	parser: z.object({id: z.string(), revision: z.string(), compilerVersion: z.string()}),
	declarations: ComparisonSchema.extend({extraClasses: ExtraClassesSchema}),
	references: ComparisonSchema.extend({extraClasses: ExtraClassesSchema}),
	dependencies: ComparisonSchema,
	declarationStrata: z.record(z.string(), ComparisonSchema),
	referenceStrata: z.record(z.string(), ComparisonSchema),
	gates: z.unknown(),
});

type ComparisonType = z.infer<typeof ComparisonSchema>;
type ExtraClassesType = z.infer<typeof ExtraClassesSchema>;
type ReportType = z.infer<typeof ReportSchema>;
type MetricType = (typeof METRICS)[number];
type ComparisonOutputType = Readonly<Record<MetricType, Readonly<{structural: number; antlr: number; delta: number}>>>;

type ArgumentsType = ReadonlyMap<string, string>;

type FactType = Readonly<{path: string; line: number; column: number; name: string; kind: string}>;

type DependencyFactType = Readonly<{sourcePath: string; target: string}>;

type DifferenceValueType = Readonly<{
	kind?: string | undefined;
	path?: string | undefined;
	sourcePath?: string | undefined;
	target?: string | undefined;
}>;

const parseArguments = (argv: readonly string[]): ArgumentsType => {
	const values = new Map<string, string>();

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv.at(index);

		if (argument === undefined) {
			continue;
		}

		if (!argument.startsWith('--')) {
			throw new Error(`Unexpected argument: ${argument}`);
		}

		const value = argv.at(index + 1);

		if (value === undefined) {
			throw new Error(`Missing value for ${argument}`);
		}

		values.set(argument.slice(2), value);
		index += 1;
	}

	return values;
};

const readReport = (filePath: string): ReportType => {
	const raw: unknown = JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));

	return ReportSchema.parse(raw);
};

const pairOf = (structural: ComparisonType, antlr: ComparisonType, metric: MetricType): Readonly<{structural: number; antlr: number; delta: number}> => ({
	structural: structural[metric],
	antlr: antlr[metric],
	delta: antlr[metric] - structural[metric],
});

const comparisonOf = (structural: ComparisonType, antlr: ComparisonType): ComparisonOutputType => ({
	truth: pairOf(structural, antlr, 'truth'),
	actual: pairOf(structural, antlr, 'actual'),
	matched: pairOf(structural, antlr, 'matched'),
	missing: pairOf(structural, antlr, 'missing'),
	extra: pairOf(structural, antlr, 'extra'),
	ignoredExtra: pairOf(structural, antlr, 'ignoredExtra'),
	recall: pairOf(structural, antlr, 'recall'),
	precision: pairOf(structural, antlr, 'precision'),
});

const emptyComparison = (): ComparisonType => ({
	truth: 0,
	actual: 0,
	matched: 0,
	missing: 0,
	extra: 0,
	ignoredExtra: 0,
	recall: 0,
	precision: 0,
});

const strataOf = (
	structural: Readonly<Record<string, ComparisonType>>,
	antlr: Readonly<Record<string, ComparisonType>>,
): Readonly<Record<string, ComparisonOutputType>> =>
	Object.fromEntries(
		[...new Set([...Object.keys(structural), ...Object.keys(antlr)])]
			.sort()
			.map((name) => [name, comparisonOf(structural[name] ?? emptyComparison(), antlr[name] ?? emptyComparison())]),
	);

const countOf = (classes: ExtraClassesType, name: string): number => (Object.hasOwn(classes, name) ? classes[name].count : 0);

const extraClassesOf = (
	structural: ExtraClassesType,
	antlr: ExtraClassesType,
): Readonly<Record<string, Readonly<{structural: number; antlr: number; delta: number}>>> =>
	Object.fromEntries(
		EXTRA_CLASSES.map((name) => {
			const structuralCount = countOf(structural, name);
			const antlrCount = countOf(antlr, name);

			return [name, {structural: structuralCount, antlr: antlrCount, delta: antlrCount - structuralCount}];
		}),
	);

const publishedGeneration = (database: DatabaseSync): string => {
	const generation = database.prepare("select id from generation where state = 'published' order by completed_at desc limit 1").get();

	if (generation === undefined) {
		throw new Error('Report database has no published generation');
	}

	return asString(generation, 'id');
};

const factRowsOf = (databasePath: string): Readonly<{definitions: ReadonlyMap<string, FactType>; references: ReadonlyMap<string, FactType>}> => {
	const database = new DatabaseSync(path.resolve(databasePath), {readOnly: true});

	try {
		const generationId = publishedGeneration(database);
		const rows = database
			.prepare(
				`select s.name, s.kind, o.path, o.start_line, o.start_column, o.role
				 from occurrence o
				 join symbol s on s.generation_id = o.generation_id and s.id = o.symbol_id
				 where o.generation_id = ?`,
			)
			.all(generationId);
		const definitions = new Map<string, FactType>();
		const references = new Map<string, FactType>();

		for (const row of rows) {
			const value: FactType = {
				path: asString(row, 'path'),
				line: asNumber(row, 'start_line'),
				column: asNumber(row, 'start_column'),
				name: asString(row, 'name'),
				kind: asString(row, 'kind'),
			};
			const key = `${value.path}:${String(value.line)}:${String(value.column)}:${value.name.toLowerCase()}`;

			if (asString(row, 'role') === 'definition') {
				definitions.set(key, value);
			} else {
				references.set(key, value);
			}
		}

		return {definitions, references};
	} finally {
		database.close();
	}
};

const dependencyRowsOf = (databasePath: string): ReadonlyMap<string, DependencyFactType> => {
	const database = new DatabaseSync(path.resolve(databasePath), {readOnly: true});

	try {
		const generationId = publishedGeneration(database);
		const packageRows = database.prepare("select lower(name) as name, path from symbol where generation_id = ? and kind = 'package'").all(generationId);
		const packageNames = new Set(packageRows.map((row) => asString(row, 'name')));
		const packageByPath = new Map(packageRows.map((row) => [asString(row, 'path'), asString(row, 'name')]));
		const rows = database
			.prepare(
				`select source_path, target_identifier
				 from dependency_edge
				 where generation_id = ? and target_identifier is not null
				 and kind in ('package-call', 'package-reference', 'type-reference')`,
			)
			.all(generationId);
		const dependencies = new Map<string, DependencyFactType>();

		for (const row of rows) {
			const sourcePath = asString(row, 'source_path');
			const target = (asString(row, 'target_identifier').split('.').at(-1) ?? '').toLowerCase();

			if (!packageNames.has(target) || target === packageByPath.get(sourcePath)) {
				continue;
			}

			dependencies.set(`${sourcePath}\u0000${target}`, {sourcePath, target});
		}

		return dependencies;
	} finally {
		database.close();
	}
};

const summaryOf = (values: readonly DifferenceValueType[]): Readonly<Record<string, unknown>> => {
	const byKind: Record<string, number> = {};
	const byPath: Record<string, number> = {};

	for (const value of values) {
		const kind = value.kind ?? value.target ?? 'unknown';
		const sourcePath = value.path ?? value.sourcePath ?? 'unknown';
		byKind[kind] = (byKind[kind] ?? 0) + 1;
		byPath[sourcePath] = (byPath[sourcePath] ?? 0) + 1;
	}

	return {
		by_kind: Object.fromEntries(Object.entries(byKind).sort(([, left], [, right]) => right - left)),
		top_paths: Object.fromEntries(
			Object.entries(byPath)
				.sort(([, left], [, right]) => right - left)
				.slice(0, SAMPLE_LIMIT),
		),
	};
};

const differenceOf = <ValueType extends DifferenceValueType>(
	left: ReadonlyMap<string, ValueType>,
	right: ReadonlyMap<string, ValueType>,
	leftName: string,
	rightName: string,
): Readonly<Record<string, unknown>> => {
	const onlyLeft = [...left.entries()].filter(([key]) => !right.has(key)).map(([, value]) => value);
	const onlyRight = [...right.entries()].filter(([key]) => !left.has(key)).map(([, value]) => value);

	return {
		[`only_${leftName}`]: {count: onlyLeft.length, ...summaryOf(onlyLeft), samples: onlyLeft.slice(0, SAMPLE_LIMIT)},
		[`only_${rightName}`]: {count: onlyRight.length, ...summaryOf(onlyRight), samples: onlyRight.slice(0, SAMPLE_LIMIT)},
	};
};

const main = (): void => {
	const values = parseArguments(process.argv.slice(2));
	const structuralPath = values.get('structural');
	const antlrPath = values.get('antlr');

	if (structuralPath === undefined || antlrPath === undefined) {
		throw new Error(
			'Usage: compareOracleQualification.ts --structural <report.json> --antlr <report.json> [--structural-database <sqlite>] [--antlr-database <sqlite>] [--output <json>]',
		);
	}

	const structural = readReport(structuralPath);
	const antlr = readReport(antlrPath);
	const structuralDatabase = values.get('structural-database');
	const antlrDatabase = values.get('antlr-database');
	const parserOnly = ((): Record<string, unknown> | null => {
		if (structuralDatabase === undefined || antlrDatabase === undefined) {
			return null;
		}

		const structuralFacts = factRowsOf(structuralDatabase);
		const antlrFacts = factRowsOf(antlrDatabase);

		return {
			definitions: differenceOf(structuralFacts.definitions, antlrFacts.definitions, 'structural', 'antlr'),
			references: differenceOf(structuralFacts.references, antlrFacts.references, 'structural', 'antlr'),
			dependencies: differenceOf(dependencyRowsOf(structuralDatabase), dependencyRowsOf(antlrDatabase), 'structural', 'antlr'),
		};
	})();
	const result = {
		corpus: {structural: structural.corpus, antlr: antlr.corpus},
		parsers: {structural: structural.parser, antlr: antlr.parser},
		aggregate: {
			declarations: comparisonOf(structural.declarations, antlr.declarations),
			references: comparisonOf(structural.references, antlr.references),
			dependencies: comparisonOf(structural.dependencies, antlr.dependencies),
		},
		declarationStrata: strataOf(structural.declarationStrata, antlr.declarationStrata),
		referenceStrata: strataOf(structural.referenceStrata, antlr.referenceStrata),
		extraClasses: {
			declarations: extraClassesOf(structural.declarations.extraClasses, antlr.declarations.extraClasses),
			references: extraClassesOf(structural.references.extraClasses, antlr.references.extraClasses),
		},
		gates: {structural: structural.gates, antlr: antlr.gates},
		...(parserOnly === null ? {} : {parserOnly}),
	};

	const serialized = `${JSON.stringify(result, null, 2)}\n`;
	const output = values.get('output');

	if (output !== undefined) {
		writeFileSync(path.resolve(output), serialized, {encoding: 'utf8'});
	}

	process.stdout.write(serialized);
};

main();
