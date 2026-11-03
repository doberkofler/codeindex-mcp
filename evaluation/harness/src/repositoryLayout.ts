/** Frozen-case path translation for the workspace layout. */

const LEGACY_TYPESCRIPT_PREFIX = 'src/adapters/typescript/';
const LEGACY_ORACLE_PREFIX = 'src/adapters/oracle/';
const TYPESCRIPT_PACKAGE_PREFIX = 'packages/adapter-typescript/src/';
const ORACLE_PACKAGE_PREFIX = 'packages/adapter-oracle/src/';
const ORACLE_TOOLS_PREFIX = 'packages/adapter-oracle-tools/src/';
const LEGACY_ORACLE_QUALIFICATION_PREFIX = 'src/core/qualification/oracle/';
const MOVED_HOST_PATH = 'src/core/qualification/typescript/verifyReferences.ts';
/**
 * Maps a frozen pre-workspace path onto the current monorepo location.
 *
 * @param file - Frozen case path.
 * @returns Current workspace path.
 */
export const currentPathOf = (file: string): string => {
	if (file === 'src/adapters/typescript/verifyReferences.ts') {
		return MOVED_HOST_PATH;
	}

	if (file.startsWith(LEGACY_TYPESCRIPT_PREFIX)) {
		return `${TYPESCRIPT_PACKAGE_PREFIX}${file.slice(LEGACY_TYPESCRIPT_PREFIX.length)}`;
	}

	if (file.startsWith(LEGACY_ORACLE_PREFIX)) {
		return `${ORACLE_PACKAGE_PREFIX}${file.slice(LEGACY_ORACLE_PREFIX.length)}`;
	}

	if (file.startsWith(LEGACY_ORACLE_QUALIFICATION_PREFIX)) {
		return `${ORACLE_TOOLS_PREFIX}${file.slice(LEGACY_ORACLE_QUALIFICATION_PREFIX.length)}`;
	}

	return file;
};

/**
 * Maps a current workspace path back onto the frozen case spelling.
 *
 * @param file - Current workspace path.
 * @returns Frozen case path.
 */
export const legacyPathOf = (file: string): string => {
	if (file === MOVED_HOST_PATH) {
		return 'src/adapters/typescript/verifyReferences.ts';
	}

	if (file.startsWith(TYPESCRIPT_PACKAGE_PREFIX)) {
		return `${LEGACY_TYPESCRIPT_PREFIX}${file.slice(TYPESCRIPT_PACKAGE_PREFIX.length)}`;
	}

	if (file.startsWith(ORACLE_PACKAGE_PREFIX)) {
		return `${LEGACY_ORACLE_PREFIX}${file.slice(ORACLE_PACKAGE_PREFIX.length)}`;
	}

	if (file.startsWith(ORACLE_TOOLS_PREFIX)) {
		return `${LEGACY_ORACLE_QUALIFICATION_PREFIX}${file.slice(ORACLE_TOOLS_PREFIX.length)}`;
	}

	return file;
};
