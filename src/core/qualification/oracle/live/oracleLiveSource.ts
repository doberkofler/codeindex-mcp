import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parseOracleUnits} from '../../../../adapters/oracle/parseUnits.ts';
import {tokenizeOracleSource} from '../../../../adapters/oracle/tokenize.ts';
import {hashContent} from '../../../generation/sourceFiles.ts';
import {type LivePlanType} from './oracleLivePlan.ts';

type OracleSourceObjectType = 'PACKAGE' | 'PACKAGE BODY' | 'FUNCTION' | 'PROCEDURE';

export type OracleSourceObjectRefType = Readonly<{
	type: OracleSourceObjectType;
	name: string;
	compileClause: string;
}>;

type SourceLineType = Readonly<{line: number; text: string}>;

export type OracleSourceUnitType = Readonly<{
	sourcePath: string;
	object: OracleSourceObjectRefType;
	rawSource: string;
	source: string;
}>;

export type OracleInstalledSourceType = Readonly<{
	type: string;
	name: string;
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
 * Maps an installed Oracle object type and name to its compile identity.
 *
 * @param type - `USER_OBJECTS` object type.
 * @param name - Installed object name.
 * @returns The object reference, or null for unsupported object types.
 */
export const oracleObjectRefOf = (type: string, name: string): OracleSourceObjectRefType | null => {
	switch (type.toUpperCase()) {
		case 'PACKAGE': {
			return {type: 'PACKAGE', name: name.toUpperCase(), compileClause: 'SPECIFICATION'};
		}
		case 'PACKAGE BODY': {
			return {type: 'PACKAGE BODY', name: name.toUpperCase(), compileClause: 'BODY'};
		}
		case 'FUNCTION': {
			return {type: 'FUNCTION', name: name.toUpperCase(), compileClause: ''};
		}
		case 'PROCEDURE': {
			return {type: 'PROCEDURE', name: name.toUpperCase(), compileClause: ''};
		}
		default: {
			return null;
		}
	}
};

const objectOfUnitKind = (kind: string, name: string): OracleSourceObjectRefType | null => {
	switch (kind) {
		case 'package-spec': {
			return {type: 'PACKAGE', name, compileClause: 'SPECIFICATION'};
		}
		case 'package-body': {
			return {type: 'PACKAGE BODY', name, compileClause: 'BODY'};
		}
		case 'procedure': {
			return {type: 'PROCEDURE', name, compileClause: ''};
		}
		case 'function': {
			return {type: 'FUNCTION', name, compileClause: ''};
		}
		default: {
			return null;
		}
	}
};

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
 * Splits one Oracle source file into the top-level units it declares.
 *
 * Files with a conventional single-unit extension are also parsed so that
 * multi-unit scripts and package scripts are handled identically. A
 * conventional extension remains the fallback when the structural parser
 * cannot recover a unit.
 *
 * @param filePath - Workspace-relative POSIX source path.
 * @param source - Raw file text.
 * @returns Top-level units with canonical source text.
 */
export const oracleSourceUnitsOf = (filePath: string, source: string): readonly OracleSourceUnitType[] => {
	const tokenized = tokenizeOracleSource(source, filePath);
	const parsed = parseOracleUnits({tokens: tokenized.tokens, path: filePath, defaultSchema: 'QUALIFICATION'});
	const units: OracleSourceUnitType[] = [];

	for (const unit of parsed.units) {
		const object = objectOfUnitKind(unit.kind, unit.name.canonical.toUpperCase());

		if (object === null) {
			continue;
		}

		const rawSource = source.slice(unit.range.startOffset, unit.range.endOffset);

		if (rawSource.trim() === '') {
			continue;
		}

		units.push({sourcePath: filePath, object, rawSource, source: normalizeOracleSource(rawSource, object)});
	}

	if (units.length > 0) {
		const [single] = units;

		if (units.length === 1 && single !== undefined && !/\bEND\b/iu.test(single.rawSource)) {
			return [{sourcePath: filePath, object: single.object, rawSource: source, source: normalizeOracleSource(source, single.object)}];
		}

		const fallback = objectOf(filePath);

		if (fallback !== null && !units.some((unit) => unit.object.type === fallback.type && unit.object.name === fallback.name)) {
			units.push({sourcePath: filePath, object: fallback, rawSource: source, source: normalizeOracleSource(source, fallback)});
		}

		return units;
	}

	const fallback = objectOf(filePath);

	return fallback === null ? [] : [{sourcePath: filePath, object: fallback, rawSource: source, source: normalizeOracleSource(source, fallback)}];
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

/**
 * Joins `USER_SOURCE` lines into the text Oracle stores for one object.
 *
 * Oracle appends a newline to every `USER_SOURCE.TEXT` row. Removing only that
 * row terminator preserves embedded newlines in wrapped rows.
 *
 * @param lines - Ordered `USER_SOURCE` rows for one object.
 * @returns Source text without row terminators.
 */
const installedSourceText = (lines: readonly SourceLineType[]): string => lines.map((line) => line.text.replace(/\r?\n$/u, '')).join('\n');

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
 * Aborts when installed Oracle source differs from the approved snapshot.
 *
 * The plan binds the normalized hash of every reviewed unit. Qualification is
 * only meaningful when the database still stores exactly that source.
 *
 * @param plan - Approved plan containing the frozen source snapshot.
 * @param rows - `USER_SOURCE` rows exported before recompilation.
 * @throws {Error} When an object is missing or its stored source differs.
 */
export const assertOracleSourceMatchesSnapshot = (plan: LivePlanType, rows: readonly (readonly unknown[])[]): void => {
	const installed = installedSourceOf(rows);

	for (const unit of plan.snapshot.units) {
		const lines = installed.get(keyOf(unit.type, unit.name));

		if (lines === undefined) {
			throw new Error(`Installed Oracle object is missing for the snapshot: ${unit.type} ${unit.name}`);
		}

		const actual = normalizeOracleSource(installedSourceText(lines), unit);

		if (hashContent(actual) !== unit.sourceSha256) {
			throw new Error(`Installed Oracle source differs from the snapshot: ${unit.type} ${unit.name} (${unit.sourcePath})`);
		}

		const snapshot = normalizeOracleSource(readFileSync(path.join(plan.snapshot.dir, unit.path), 'utf8'), unit);

		if (hashContent(snapshot) !== unit.sourceSha256) {
			throw new Error(`Oracle qualification snapshot changed after approval: ${unit.path}`);
		}
	}
};
