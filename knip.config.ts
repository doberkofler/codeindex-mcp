import {type KnipConfig} from 'knip';

const config: KnipConfig = {
	entry: ['src/entries/*.ts', 'test/**/*.test.ts', 'console/src/main.tsx'],
	project: ['src/**/*.ts', 'console/src/**/*.{ts,tsx}', 'test/**/*.ts'],
	ignore: ['dist/**', 'test/fixtures/**'],
};

export default config;
