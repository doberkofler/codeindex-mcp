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
		coverage: {
			enabled: true,
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/ui/**', 'src/**/generated/**'],
			reporter: ['text', 'html'],
			thresholds: {
				statements: 80,
				lines: 80,
				functions: 80,
				branches: 70,
			},
		},
	},
});
