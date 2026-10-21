import {type KnipConfig} from 'knip';

const config: KnipConfig = {
	treatConfigHintsAsErrors: true,
	workspaces: {
		'.': {
			entry: ['src/entries/*.ts', 'test/**/*.test.ts', 'src/ui/console/main.tsx'],
			project: ['src/**/*.ts', 'src/ui/console/**/*.{ts,tsx}', 'test/**/*.ts'],
			ignore: ['test/fixtures/**'],
			ignoreDependencies: ['antlr-ng'],
		},
		'evaluation/harness': {
			entry: ['src/*.test.ts'],
			project: ['src/**/*.ts'],
			ignoreExportsUsedInFile: true,
		},
	},
};

export default config;
