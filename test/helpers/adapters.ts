import {type AdapterType} from '@codeindex/adapter-sdk';
import {type AdapterSetType} from '../../src/adapters/loader.ts';
import {oracleExtractor} from '../../src/adapters/oracle/index.ts';
import {typeScriptExtractor} from '../../src/adapters/typescript/index.ts';
import {configuredAdapters, type ConfigType} from '../../src/core/config/config.ts';

const BUILT_IN: Readonly<Partial<Record<string, AdapterType>>> = {
	typescript: typeScriptExtractor,
	oracle: oracleExtractor,
};

/**
 * Builds an adapter set for a test without touching the production loader.
 *
 * Tests may name adapters directly. Production composition roots must use
 * `loadConfiguredAdapters`.
 *
 * @param adapters - Adapter implementations selected by the test.
 * @returns A loader-shaped adapter set.
 */
export const adapterSetOf = (...adapters: readonly AdapterType[]): AdapterSetType => ({
	adapters,
	descriptors: [],
	byId: new Map(adapters.map((adapter) => [adapter.id, adapter])),
});

/**
 * Resolves the built-in adapters named by a test configuration.
 *
 * @param config - Resolved test configuration.
 * @returns A loader-shaped adapter set in declaration order.
 */
export const testAdaptersFor = (config: ConfigType): AdapterSetType =>
	adapterSetOf(
		...configuredAdapters(config).map((adapter) => {
			const extractor = BUILT_IN[adapter.id];

			if (extractor === undefined) {
				throw new Error(`Test helper has no built-in adapter for ${adapter.id}`);
			}

			return extractor;
		}),
	);
