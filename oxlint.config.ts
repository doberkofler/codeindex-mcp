import {linter as defaults} from './oxc.config.ts';

// Project-specific Oxlint overrides.
const rules: Partial<typeof defaults.rules> = {};
type OverrideType = Readonly<{files: readonly string[]; rules: Readonly<Record<string, 'off' | 'warn' | 'error'>>}>;
const overrides: OverrideType[] = [
	{
		// The browser console is local developer tooling. Page files keep one primary
		// exported page and colocate small presentational sections; dense MUI layouts
		// exceed the generic JSX depth limit without becoming harder to read.
		files: ['console/**/*.{ts,tsx}'],
		rules: {
			'react/no-multi-comp': 'off',
			'react/jsx-max-depth': 'off',
			'typescript/explicit-function-return-type': 'off',
			'typescript/explicit-module-boundary-types': 'off',
			'typescript/promise-function-async': 'off',
			'unicorn/numeric-separators-style': 'off',
		},
	},
	{
		// API responses come from this process's own loopback server and are decoded
		// once at the transport seam; every caller uses the typed contract.
		files: ['console/src/api.ts'],
		rules: {'typescript/no-unsafe-type-assertion': 'off'},
	},
];

const config = {
	...defaults,
	rules: {...defaults.rules, ...rules},
	overrides: [...defaults.overrides, ...overrides],
};

export default config;
