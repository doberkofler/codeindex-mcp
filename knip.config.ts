import {type KnipConfig} from 'knip';

const config: KnipConfig = {
	entry: ['src/entries/*.ts', 'test/**/*.test.ts', 'src/ui/console/main.tsx'],
	project: ['src/**/*.ts', 'src/ui/console/**/*.{ts,tsx}', 'test/**/*.ts'],
	ignore: ['test/fixtures/**'],
	treatConfigHintsAsErrors: true,
};

export default config;
