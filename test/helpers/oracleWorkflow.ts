import {existsSync, readdirSync} from 'node:fs';
import path from 'node:path';

/** Directory that owns every Vitest test module. */
const TEST_DIRECTORY = 'test';

/**
 * Naming convention for the deterministic Oracle tier.
 *
 * A module named `oracle*.test.ts` must run without a database, credentials, or
 * the external evidence root. Live-database modules use a different prefix so
 * discovery never selects them.
 */
const ORACLE_MODULE_TEST_PATTERN = /^oracle.*\.test\.tsx?$/u;

/**
 * Generic contracts that Oracle production depends on.
 *
 * These modules are not Oracle-specific, but a change to extractor registration,
 * publication facts, configuration, freshness, or the qualification command can
 * break Oracle without any `oracle*.test.ts` module failing. They are pinned by
 * path rather than globbed so a broad pattern cannot silently pull the whole
 * suite into the Oracle budget.
 */
export const GENERIC_ORACLE_CONTRACT_TESTS = [
	'test/codeIndex.test.ts',
	'test/config.test.ts',
	'test/extractors.test.ts',
	'test/publicationDefaultsAndEnforcement.test.ts',
	'test/publicationFacts.test.ts',
	'test/qualifyCommand.test.ts',
] as const;

/**
 * Lists the deterministic Oracle test modules on disk.
 *
 * @param rootDir - Repository root.
 * @returns Repository-relative module paths, sorted.
 */
export const discoveredOracleTestModules = (rootDir: string): readonly string[] =>
	readdirSync(path.join(rootDir, TEST_DIRECTORY))
		.filter((file) => ORACLE_MODULE_TEST_PATTERN.test(file))
		.map((file) => `${TEST_DIRECTORY}/${file}`)
		.sort();

/**
 * Builds the complete deterministic Oracle test set.
 *
 * Discovery is authoritative for Oracle modules, so a newly added
 * `oracle*.test.ts` module joins the tier without a config edit. Every pinned
 * generic contract and every discovered module must exist, otherwise the tier
 * would report success while checking less than it claims.
 *
 * @param rootDir - Repository root.
 * @returns Deduplicated module paths, sorted.
 */
export const oracleWorkflowTests = (rootDir: string): readonly string[] => {
	const discovered = discoveredOracleTestModules(rootDir);

	if (discovered.length === 0) {
		throw new Error(`Oracle workflow discovered no test modules in ${TEST_DIRECTORY}/. Refusing to report an empty Oracle suite as passing.`);
	}

	const requested = [...discovered, ...GENERIC_ORACLE_CONTRACT_TESTS];
	const absent = requested.filter((modulePath) => !existsSync(path.join(rootDir, modulePath)));

	if (absent.length > 0) {
		throw new Error(`Oracle workflow names test modules that do not exist: ${absent.join(', ')}`);
	}

	return [...new Set(requested)].sort();
};
