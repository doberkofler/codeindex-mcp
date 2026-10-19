import {defineConfig} from 'vitest/config';
import packageManifest from './package.json' with {type: 'json'};

export default defineConfig({
	define: {
		PROGRAM_VERSION_AT_BUILD: JSON.stringify(packageManifest.version),
	},
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		reporters: ['default'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
