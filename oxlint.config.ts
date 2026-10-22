import {linter as defaults} from './oxc.config.ts';

// Project-specific Oxlint overrides.
const rules: Partial<typeof defaults.rules> = {};
type OverrideType = Readonly<{files: readonly string[]; rules: Readonly<Record<string, 'off' | 'warn' | 'error'>>}>;
const overrides: OverrideType[] = [
	{
		// The browser console is local developer tooling. Page files keep one primary
		// exported page and colocate small presentational sections; dense MUI layouts
		// exceed the generic JSX depth limit without becoming harder to read.
		files: ['src/ui/console/**/*.{ts,tsx}'],
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
		// The evaluation harness executes real model processes and measures them:
		// one model, one MCP session, one attempt at a time. Sequential awaits are
		// the measurement, not an oversight.
		files: ['evaluation/harness/**/*.ts'],
		rules: {
			'eslint/no-await-in-loop': 'off',
		},
	},
	{
		// A harness test file is one `describe` per module; its callback is a
		// container for independent cases, not a function unit. File size stays
		// bounded by `eslint/max-lines`.
		files: ['evaluation/harness/src/**/*.test.ts'],
		rules: {
			'eslint/max-lines-per-function': 'off',
		},
	},
	{
		// The bootstrap generator is a 32-bit mulberry32 xorshift. XOR and shifts
		// are the algorithm; arithmetic cannot express them.
		files: ['evaluation/harness/src/bootstrapRng.ts'],
		rules: {
			'eslint/no-bitwise': 'off',
		},
	},
];

const config = {
	...defaults,
	rules: {...defaults.rules, ...rules},
	overrides: [...defaults.overrides, ...overrides],
	// Generated parser output and the verbatim upstream lexer/parser bases are
	// not authored code. They still participate in TypeScript compilation.
	ignorePatterns: [
		...defaults.ignorePatterns,
		'src/adapters/oracle/generated/**',
		'src/adapters/oracle/plSqlLexerBase.ts',
		'src/adapters/oracle/plSqlParserBase.ts',
		// Standalone Phase 7 harness: runs outside the TypeScript project and
		// consumes dynamic worker messages, so it is not authored application code.
		'scripts/benchmarkOracleAntlr.mjs',
		'scripts/oracleAntlrBenchmarkWorker.mjs',
		// Runtime-comparison harness: dynamic corpus metadata and native process
		// output sit outside the authored TypeScript application.
		'benchmark/oracle-antlr-runtime/**/*.mjs',
	],
};

export default config;
