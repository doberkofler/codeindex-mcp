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
		// The evaluation harness is a separate package that executes on
		// `node --test`, not vitest. Its measurements require serialized
		// executions: one model, one MCP session, one attempt at a time.
		files: ['evaluation/harness/**/*.ts'],
		rules: {
			'eslint/no-await-in-loop': 'off',
			'vitest/no-import-node-test': 'off',
			'vitest/prefer-importing-vitest-globals': 'off',
			'vitest/prefer-each': 'off',
		},
	},
	{
		// The harness is also compiled by the root test project, which enables
		// `noPropertyAccessFromIndexSignature`. Bracket access is then mandatory for
		// records, and `dot-notation` would report the same sites as needing dot
		// access. The two rules cannot both hold in this file set.
		files: [
			'evaluation/harness/src/events.ts',
			'evaluation/harness/src/eventsTools.ts',
			'evaluation/harness/src/routePlan.ts',
			'evaluation/harness/src/schema.ts',
			'evaluation/harness/src/treatment.ts',
		],
		rules: {
			'typescript/dot-notation': 'off',
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
