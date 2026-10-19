import {readFileSync} from 'node:fs';
import path from 'node:path';
import {type LivePlanType} from './oracleLivePlan.ts';

type OracleSourceObjectType = 'PACKAGE' | 'PACKAGE BODY' | 'FUNCTION' | 'PROCEDURE';

export type OracleSourceObjectRefType = Readonly<{
	type: OracleSourceObjectType;
	name: string;
	compileClause: string;
}>;

type SourceLineType = Readonly<{line: number; text: string}>;

export type OracleAuthoritativeSourceType = Readonly<{
	path: string;
	object: OracleSourceObjectRefType;
	source: string;
}>;

const objectOf = (filePath: string): OracleSourceObjectRefType | null => {
	const extension = path.extname(filePath).toLowerCase();
	const name = path.basename(filePath, path.extname(filePath)).toUpperCase();

	switch (extension) {
		case '.pks':
		case '.pkg': {
			return {type: 'PACKAGE', name, compileClause: 'SPECIFICATION'};
		}
		case '.pkb': {
			return {type: 'PACKAGE BODY', name, compileClause: 'BODY'};
		}
		case '.fnc': {
			return {type: 'FUNCTION', name, compileClause: ''};
		}
		case '.prc': {
			return {type: 'PROCEDURE', name, compileClause: ''};
		}
		default: {
			return null;
		}
	}
};

/**
 * Maps a snapshot source path to the installed Oracle object it qualifies.
 *
 * @param filePath - Snapshot-relative POSIX source path.
 * @returns The object type, canonical name, and compile clause, or null.
 */
export const oracleSourceObjectOf = (filePath: string): OracleSourceObjectRefType | null => objectOf(filePath);

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/**
 * Builds the exact `ALTER ... COMPILE` statement for one installed object.
 *
 * @param object - Installed object reference.
 * @returns A recompile statement without a trailing semicolon.
 */
export const recompileStatementOf = (object: OracleSourceObjectRefType): string => {
	const target = object.type === 'PACKAGE BODY' ? 'PACKAGE' : object.type;
	const clause = object.compileClause === '' ? '' : ` ${object.compileClause}`;

	return `ALTER ${target} ${quoteIdentifier(object.name)} COMPILE${clause}`;
};

const escapePattern = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const objectHeaderOf = (source: string, object: OracleSourceObjectRefType): RegExpExecArray | null => {
	const type = object.type === 'PACKAGE BODY' ? String.raw`PACKAGE\s+BODY` : escapePattern(object.type);
	const name = escapePattern(object.name);
	const header = new RegExp(
		String.raw`^[\t ]*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+)?(?:NONEDITIONABLE\s+)?)?${type}\s+(?:"${name}"|${name})\b`,
		'imu',
	);

	return header.exec(source);
};

const CREATE_PREFIX = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+)?(?:NONEDITIONABLE\s+)?/imu;
const SOURCE_TOKEN = /'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|[\w$#]+|[^\w$#]+/gu;

const canonicalToken = (token: string): string => {
	if (token.startsWith("'")) {
		return token;
	}

	if (token.startsWith('--') || token.startsWith('/*')) {
		return ' ';
	}

	const normalized = token.toLowerCase();

	return normalized === 'as' ? 'is' : normalized;
};

const canonicalSource = (source: string): string =>
	(source.match(SOURCE_TOKEN) ?? [])
		.map((token) => canonicalToken(token))
		.join('')
		.replaceAll(/\s+/gu, ' ')
		.trim();

/**
 * Normalizes authored source and `USER_SOURCE` text for drift comparison.
 *
 * Oracle stores one selected unit without file comments, the
 * `CREATE [OR REPLACE]` prefix, or the trailing `/` terminator. PL/SQL
 * keywords and unquoted identifiers are case-insensitive, and `AS`/`IS` are
 * synonyms in package and subprogram headers.
 *
 * @param source - Authored file text or concatenated `USER_SOURCE` lines.
 * @param object - Installed object used to select one unit from a multi-unit file.
 * @returns Canonical source text.
 */
export const normalizeOracleSource = (source: string, object?: OracleSourceObjectRefType): string => {
	const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
	let body: string;

	if (object === undefined) {
		const create = CREATE_PREFIX.exec(normalized);

		if (create !== null) {
			body = normalized.slice(create.index).replace(CREATE_PREFIX, '');
		} else {
			const header = /^\s*(?:PACKAGE(?:\s+BODY)?|FUNCTION|PROCEDURE)\b/imu.exec(normalized);
			body = header === null ? normalized : normalized.slice(header.index);
		}
	} else {
		const header = objectHeaderOf(normalized, object);
		body = header === null ? normalized : normalized.slice(header.index).replace(CREATE_PREFIX, '');
	}

	const lines = body.split('\n');
	const terminator = lines.findIndex((line, index) => index > 0 && /^\s*\/\s*$/u.test(line));

	return canonicalSource((terminator === -1 ? lines : lines.slice(0, terminator)).join('\n'));
};

/**
 * Builds the canonical key for one installed Oracle object.
 *
 * @param type - Oracle object type, such as `PACKAGE BODY`.
 * @param name - Oracle object name.
 * @returns A case-normalized key shared by planning and drift validation.
 */
export const oracleObjectKeyOf = (type: string, name: string): string => `${type.toUpperCase()}\u0000${name.toUpperCase()}`;

const keyOf = oracleObjectKeyOf;

const isWrapped = (source: string): boolean =>
	source
		.split('\n')
		.slice(0, 5)
		.some((line) => /^\s*(?:PACKAGE(?:\s+BODY)?|FUNCTION|PROCEDURE)\b.+\bwrapped\s*$/iu.test(line));

/**
 * Selects one source file per installed object and rejects ambiguous duplicates.
 *
 * Wrapped source cannot be qualified and is ignored when an unwrapped definition
 * for the same object exists. Multiple unwrapped definitions must be identical.
 *
 * @param files - Snapshot-relative source paths.
 * @param snapshotDir - Frozen snapshot root.
 * @returns Authoritative source files with normalized source.
 * @throws {Error} When an object has no unwrapped source or conflicting sources.
 */
export const authoritativeOracleSources = (files: readonly Readonly<{path: string}>[], snapshotDir: string): readonly OracleAuthoritativeSourceType[] => {
	const groups = new Map<string, OracleAuthoritativeSourceType[]>();

	for (const file of files) {
		const object = oracleSourceObjectOf(file.path);

		if (object === null) {
			continue;
		}

		const source = normalizeOracleSource(readFileSync(path.join(snapshotDir, file.path), 'utf8'), object);
		const key = keyOf(object.type, object.name);
		const group = groups.get(key) ?? [];

		group.push({path: file.path, object, source});
		groups.set(key, group);
	}

	const selected: OracleAuthoritativeSourceType[] = [];

	for (const group of groups.values()) {
		const unwrapped = group.filter((entry) => !isWrapped(entry.source));
		const candidates = unwrapped.length === 0 ? group : unwrapped;
		const distinct = new Set(candidates.map((entry) => entry.source));

		if (distinct.size > 1) {
			throw new Error(`Multiple Oracle source files define ${group[0]?.object.type} ${group[0]?.object.name} differently`);
		}

		if (unwrapped.length === 0) {
			throw new Error(`Oracle object has only wrapped source: ${group[0]?.object.type} ${group[0]?.object.name}`);
		}

		const [first] = candidates.sort((left, right) => left.path.localeCompare(right.path));

		if (first === undefined) {
			throw new Error('Oracle source selection produced no source file');
		}

		selected.push(first);
	}

	return selected.sort((left, right) => left.object.type.localeCompare(right.object.type) || left.object.name.localeCompare(right.object.name));
};

const installedSourceOf = (rows: readonly (readonly unknown[])[]): ReadonlyMap<string, readonly SourceLineType[]> => {
	const source = new Map<string, SourceLineType[]>();

	for (const row of rows) {
		const [type, name, line, text] = row;

		if (typeof type !== 'string' || typeof name !== 'string' || typeof line !== 'number' || typeof text !== 'string') {
			throw new TypeError('Oracle source backup contains an unexpected row shape');
		}

		const key = keyOf(type.toUpperCase(), name.toUpperCase());
		const lines = source.get(key) ?? [];

		lines.push({line, text});
		source.set(key, lines);
	}

	for (const lines of source.values()) {
		lines.sort((left, right) => left.line - right.line);
	}

	return source;
};

/**
 * Aborts when installed Oracle source differs from the frozen snapshot.
 *
 * PL/Scope is regenerated from the installed source. Qualification is only
 * meaningful when that source is exactly the source that was reviewed.
 *
 * @param plan - Approved plan containing the frozen source snapshot.
 * @param rows - `USER_SOURCE` rows exported before recompilation.
 * @throws {Error} When an object is missing or its stored source differs.
 */
export const assertOracleSourceMatchesSnapshot = (plan: LivePlanType, rows: readonly (readonly unknown[])[]): void => {
	const installed = installedSourceOf(rows);

	for (const entry of authoritativeOracleSources(plan.snapshot.files, plan.snapshot.dir)) {
		const lines = installed.get(keyOf(entry.object.type, entry.object.name));

		if (lines === undefined) {
			throw new Error(`Installed Oracle object is missing for the snapshot: ${entry.object.type} ${entry.object.name}`);
		}

		const actual = normalizeOracleSource(lines.map((line) => line.text.replace(/\r?\n$/u, '')).join('\n'), entry.object);

		if (entry.source !== actual) {
			throw new Error(`Installed Oracle source differs from the snapshot: ${entry.object.type} ${entry.object.name} (${entry.path})`);
		}
	}
};
