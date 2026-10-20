import {readFileSync} from 'node:fs';
import path from 'node:path';

export type ObjectMappingType = Readonly<{
	path: string;
	offset: number;
	columnShift: number;
	lines: readonly string[];
}>;

const expectedHeaderColumn = (objectType: string): number =>
	objectType === 'PACKAGE' ? 9 : objectType === 'PACKAGE BODY' ? 14 : objectType === 'FUNCTION' ? 10 : 11;

const headerPattern = (objectType: string, objectName: string): RegExp | null => {
	const escaped = objectName.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
	const prefix = String.raw`^(?:[ \t]*create\s+or\s+replace\s+)?(?:editionable\s+|noneditionable\s+)?`;
	const suffix = String.raw`"?${escaped}"?\b`;

	if (objectType === 'PACKAGE') {
		return new RegExp(`${prefix}package\\s+(?!body\\b)${suffix}`, 'imu');
	}
	if (objectType === 'PACKAGE BODY') {
		return new RegExp(`${prefix}package\\s+body\\s+${suffix}`, 'imu');
	}
	if (objectType === 'FUNCTION') {
		return new RegExp(`${prefix}function\\s+${suffix}`, 'imu');
	}
	if (objectType === 'PROCEDURE') {
		return new RegExp(`${prefix}procedure\\s+${suffix}`, 'imu');
	}

	return null;
};

/**
 * Maps one indexed Oracle source to its PL/Scope object identity.
 *
 * @param rootDir - Indexed workspace root.
 * @param relativePath - Workspace-relative source path.
 * @param objectType - PL/Scope object type.
 * @param objectName - PL/Scope object name.
 * @returns Path, line offset, header column shift, and source lines.
 */
export const objectMapping = (rootDir: string, relativePath: string, objectType: string, objectName: string): ObjectMappingType => {
	const source = readFileSync(path.join(rootDir, relativePath), 'utf8');
	const lines = source.split('\n');
	const pattern = headerPattern(objectType, objectName);

	if (pattern === null) {
		throw new Error(`Unsupported Oracle object type: ${objectType}`);
	}

	const match = pattern.exec(source);

	if (match === null) {
		throw new Error(`Cannot locate ${objectType} ${objectName} in ${relativePath}`);
	}

	const headerEnd = match.index + match[0].length;
	const offset = source.slice(0, headerEnd).split('\n').length - 1;
	const nameIndex = match[0].toUpperCase().lastIndexOf(objectName.toUpperCase());
	const lastNewline = match[0].lastIndexOf('\n', nameIndex);
	const actualColumn = match.index + nameIndex - (lastNewline === -1 ? 0 : lastNewline + 1) + 1;

	return {
		path: relativePath,
		offset,
		columnShift: offset === 0 ? actualColumn - expectedHeaderColumn(objectType) : 0,
		lines,
	};
};

/**
 * Returns the PL/Scope object type implied by a source extension.
 *
 * @param filePath - Workspace-relative source path.
 * @returns Object type, or null for an unsupported extension.
 */
export const objectTypeOfPath = (filePath: string): string | null => {
	const suffix = path.extname(filePath).toLowerCase();

	if (suffix === '.pks' || suffix === '.pkg') {
		return 'PACKAGE';
	}
	if (suffix === '.pkb') {
		return 'PACKAGE BODY';
	}
	if (suffix === '.fnc') {
		return 'FUNCTION';
	}
	if (suffix === '.prc') {
		return 'PROCEDURE';
	}

	return null;
};

/**
 * Builds the lookup key for one PL/Scope object.
 *
 * @param objectType - Object type.
 * @param objectName - Object name.
 * @returns Case-insensitive key.
 */
export const objectKey = (objectType: string, objectName: string): string => `${objectType}:${objectName.toLowerCase()}`;

/**
 * Projects a PL/Scope position onto the authored file.
 *
 * @param mapping - Source mapping.
 * @param line - PL/Scope line.
 * @param column - PL/Scope column.
 * @returns Authored position.
 */
export const positionOf = (mapping: ObjectMappingType, line: number, column: number): Readonly<{path: string; line: number; column: number}> => {
	const authoredLine = line + mapping.offset;
	const byteColumn = column + (line === 1 ? mapping.columnShift : 0);
	const sourceLine = mapping.lines[authoredLine - 1];

	if (sourceLine === undefined || byteColumn > Buffer.byteLength(sourceLine, 'utf8')) {
		return {path: mapping.path, line: authoredLine, column: byteColumn};
	}

	const characterPrefix = Buffer.from(sourceLine, 'utf8')
		.subarray(0, Math.max(0, byteColumn - 1))
		.toString('utf8');

	return {
		path: mapping.path,
		line: authoredLine,
		// PL/Scope reports byte columns; indexed occurrences use character columns.
		column: characterPrefix.length + 1,
	};
};

/**
 * Checks that a declaration position still contains the declared identifier.
 *
 * @param mapping - Source mapping.
 * @param position - Authored position.
 * @param name - Declared name.
 * @returns Whether the source token matches.
 */
export const sourceTokenMatches = (mapping: ObjectMappingType, position: Readonly<{path: string; line: number; column: number}>, name: string): boolean => {
	if (mapping.path !== position.path) {
		return false;
	}

	const line = mapping.lines[position.line - 1] ?? '';

	return line.slice(position.column - 1, position.column - 1 + name.length).toLowerCase() === name.toLowerCase();
};
