import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {readOracleManifest} from '../../../../adapters/oracle/manifest.ts';
import {type ConfigType} from '../../../config/config.ts';
import {computeSourceHash, createSourceFileRecord, hashContent} from '../../../generation/sourceFiles.ts';
import {type SourceFileType} from '../../../model.ts';
import {
	normalizeOracleSource,
	oracleObjectKeyOf,
	oracleObjectRefOf,
	oracleSourceUnitsOf,
	type OracleInstalledSourceType,
	type OracleSourceObjectRefType,
	type OracleSourceUnitType,
} from './oracleLiveSource.ts';

export type OracleSnapshotSourceUnitType = Readonly<{
	path: string;
	sourcePath: string;
	type: OracleSourceObjectRefType['type'];
	name: string;
	compileClause: string;
	sourceSha256: string;
	candidatePaths: string[];
}>;

type SourceCandidateType = Readonly<{
	unit: OracleSourceUnitType;
}>;

type SelectedCandidateType = Readonly<{
	unit: OracleSourceUnitType;
	candidatePaths: readonly string[];
}>;

type SnapshotManifestType = Readonly<{
	path: string;
	content: string;
}>;

const typePriority = (type: OracleSourceObjectRefType['type']): number => (type === 'PACKAGE' ? 0 : type === 'PACKAGE BODY' ? 1 : type === 'FUNCTION' ? 2 : 3);

const snapshotExtensionOf = (type: OracleSourceObjectRefType['type']): string => {
	switch (type) {
		case 'PACKAGE': {
			return '.pks';
		}
		case 'PACKAGE BODY': {
			return '.pkb';
		}
		case 'FUNCTION': {
			return '.fnc';
		}
		case 'PROCEDURE': {
			return '.prc';
		}
		default: {
			throw new Error('Unsupported Oracle object type');
		}
	}
};

const safeNameOf = (name: string): string => name.replaceAll(/[^\w$#.-]/gu, '_');

const candidateDetail = (candidates: readonly SourceCandidateType[]): string =>
	candidates
		.slice(0, 10)
		.map((candidate) => `  ${candidate.unit.sourcePath} sha256=${hashContent(candidate.unit.source)}`)
		.join('\n');

/**
 * Groups every declared unit from the scanned source files by installed object.
 *
 * @param files - Scanned source files.
 * @returns Candidate units keyed by canonical object key.
 */
export const oracleSourceCandidates = (files: readonly SourceFileType[]): ReadonlyMap<string, readonly SourceCandidateType[]> => {
	const groups = new Map<string, Map<string, SourceCandidateType>>();

	for (const file of files) {
		const units = oracleSourceUnitsOf(file.path, readFileSync(file.absolutePath, 'utf8'));

		for (const unit of units) {
			const key = oracleObjectKeyOf(unit.object.type, unit.object.name);
			const group = groups.get(key) ?? new Map<string, SourceCandidateType>();
			const identity = [unit.sourcePath, unit.object.type, unit.object.name, unit.source].join('\u0000');

			group.set(identity, {unit});
			groups.set(key, group);
		}
	}

	return new Map([...groups].map(([key, group]) => [key, [...group.values()]]));
};

/**
 * Selects the candidate whose normalized source equals installed `USER_SOURCE`.
 *
 * Installed objects with no candidate file at all remain missing-source
 * exclusions. A candidate group that exists but cannot be proven to match
 * aborts planning before any approval is written.
 *
 * @param installed - Installed source keyed by canonical object key.
 * @param candidates - Candidate units keyed by canonical object key.
 * @returns Selected source units and the missing-source count.
 * @throws {Error} When candidates exist but none matches installed source.
 */
export const selectOracleSources = (
	installed: ReadonlyMap<string, OracleInstalledSourceType>,
	candidates: ReadonlyMap<string, readonly SourceCandidateType[]>,
): Readonly<{selected: readonly SelectedCandidateType[]; missingSource: number}> => {
	const selected: SelectedCandidateType[] = [];
	let missingSource = 0;

	for (const [key, source] of installed) {
		const object = oracleObjectRefOf(source.type, source.name);

		if (object === null) {
			continue;
		}

		const group = candidates.get(key);

		if (group === undefined) {
			missingSource += 1;
			continue;
		}

		const expected = hashContent(normalizeOracleSource(source.source, object));
		const matches = group.filter((candidate) => hashContent(candidate.unit.source) === expected);

		if (matches.length === 0) {
			throw new Error(
				`Installed Oracle source does not match any qualification candidate: ${object.type} ${object.name}\nCandidates:\n${candidateDetail(group)}`,
			);
		}

		const ordered = [...matches].sort((left, right) => left.unit.sourcePath.localeCompare(right.unit.sourcePath));
		const first = ordered.at(0);

		if (first === undefined) {
			throw new Error(`Oracle qualification source selection produced no candidate for ${object.type} ${object.name}`);
		}

		selected.push({unit: first.unit, candidatePaths: ordered.map((candidate) => candidate.unit.sourcePath)});
	}

	return {selected, missingSource};
};

/**
 * Selects every candidate when planning without a database connection.
 *
 * @param candidates - Candidate units keyed by canonical object key.
 * @returns One deterministic candidate per object.
 * @throws {Error} When the same object has incompatible source files.
 */
export const selectOracleSourcesWithoutInstalled = (candidates: ReadonlyMap<string, readonly SourceCandidateType[]>): readonly SelectedCandidateType[] => {
	const selected: SelectedCandidateType[] = [];

	for (const group of candidates.values()) {
		const [first] = [...group].sort((left, right) => left.unit.sourcePath.localeCompare(right.unit.sourcePath));

		if (first === undefined) {
			continue;
		}

		const matches = group.filter((candidate) => candidate.unit.source === first.unit.source);

		if (matches.length !== group.length) {
			throw new Error(
				`Multiple Oracle source files define ${first.unit.object.type} ${first.unit.object.name} differently\nCandidates:\n${candidateDetail(group)}`,
			);
		}

		selected.push({unit: first.unit, candidatePaths: matches.map((candidate) => candidate.unit.sourcePath)});
	}

	return selected;
};

/**
 * Writes a generated manifest for the frozen single-unit snapshot.
 *
 * @param config - Original qualification configuration.
 * @returns Snapshot-relative manifest path and content.
 * @throws {Error} When source manifests disagree on their default schema.
 */
export const snapshotManifestOf = (config: ConfigType): SnapshotManifestType => {
	const manifests = config.projects.map((project) => readOracleManifest(project.projectFilePath).manifest);
	const defaultSchemas = [...new Set(manifests.map((manifest) => manifest.defaultSchema))];

	if (defaultSchemas.length !== 1) {
		throw new Error('Oracle qualification source manifests must agree on defaultSchema');
	}

	const defaultSchema = defaultSchemas.at(0);

	if (defaultSchema === undefined) {
		throw new Error('Oracle qualification requires at least one source manifest');
	}

	const extensions = new Set<string>();

	for (const manifest of manifests) {
		for (const extension of manifest.extensions) {
			extensions.add(extension);
		}
	}

	for (const extension of ['.pks', '.pkg', '.pkb', '.prc', '.fnc', '.sql', '.pls']) {
		extensions.add(extension);
	}

	const content = `${JSON.stringify(
		{
			schemaVersion: 1,
			dialect: '19c',
			defaultSchema,
			extensions: [...extensions].sort(),
			include: ['**/*'],
			exclude: [],
		},
		null,
		2,
	)}\n`;

	return {path: 'manifests/qualification-index.json', content};
};

/**
 * Writes only the reviewed units and records their source provenance.
 *
 * A single selected unit keeps its authored path. Multiple selected units that
 * originate in one multi-unit script receive deterministic separate paths so
 * unselected units never enter the qualification generation.
 *
 * @param snapshotDir - Frozen snapshot root.
 * @param selected - Selected source units.
 * @returns Snapshot files, plan units, and the source-set hash.
 */
export const writeOracleSnapshot = (
	snapshotDir: string,
	selected: readonly SelectedCandidateType[],
): Readonly<{
	files: {path: string; sha256: string}[];
	units: OracleSnapshotSourceUnitType[];
	sourceHash: string;
}> => {
	const ordered = [...selected].sort(
		(left, right) =>
			typePriority(left.unit.object.type) - typePriority(right.unit.object.type) ||
			left.unit.object.name.localeCompare(right.unit.object.name) ||
			left.unit.sourcePath.localeCompare(right.unit.sourcePath),
	);
	const unitsPerPath = new Map<string, number>();

	for (const entry of ordered) {
		unitsPerPath.set(entry.unit.sourcePath, (unitsPerPath.get(entry.unit.sourcePath) ?? 0) + 1);
	}

	const files = new Map<string, SourceFileType>();
	const units: OracleSnapshotSourceUnitType[] = [];

	for (const [index, entry] of ordered.entries()) {
		const snapshotPath =
			unitsPerPath.get(entry.unit.sourcePath) === 1
				? entry.unit.sourcePath
				: `units/${String(index + 1).padStart(4, '0')}-${safeNameOf(entry.unit.object.name)}${snapshotExtensionOf(entry.unit.object.type)}`;
		const destination = path.join(snapshotDir, snapshotPath);

		if (files.has(snapshotPath)) {
			throw new Error(`Oracle qualification snapshot path collision: ${snapshotPath}`);
		}

		mkdirSync(path.dirname(destination), {recursive: true});
		writeFileSync(destination, entry.unit.rawSource, {encoding: 'utf8'});

		const record = createSourceFileRecord(destination, snapshotDir);

		files.set(snapshotPath, record);
		units.push({
			path: snapshotPath,
			sourcePath: entry.unit.sourcePath,
			type: entry.unit.object.type,
			name: entry.unit.object.name,
			compileClause: entry.unit.object.compileClause,
			sourceSha256: hashContent(entry.unit.source),
			candidatePaths: [...entry.candidatePaths],
		});
	}

	const records = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));

	return {
		files: records.map((record) => ({path: record.path, sha256: record.sha256})),
		units,
		sourceHash: computeSourceHash(records),
	};
};
