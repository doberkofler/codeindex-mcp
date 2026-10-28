import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const grammarDirectory = path.join(root, 'grammar', 'oracle');
const lexerGrammarSource = path.join(grammarDirectory, 'PlSqlLexer.g4');
const parserGrammarSource = path.join(grammarDirectory, 'PlSqlParser.g4');
const lexerBaseSource = path.join(grammarDirectory, 'Antlr4ng', 'PlSqlLexerBase.ts.txt');
const parserBaseSource = path.join(grammarDirectory, 'Antlr4ng', 'PlSqlParserBase.ts.txt');
const outputArgument: string | undefined = process.argv.at(2);
const outputDirectory = outputArgument === undefined ? path.join(root, 'src', 'adapters', 'oracle', 'generated') : path.resolve(outputArgument);
const runner = path.join(root, 'node_modules', 'antlr-ng', 'dist', 'cli', 'runner.js');
const generated = {
	lexer: path.join(outputDirectory, 'PlSqlLexer.ts'),
	parser: path.join(outputDirectory, 'PlSqlParser.ts'),
	visitor: path.join(outputDirectory, 'PlSqlParserVisitor.ts'),
	lexerBase: path.join(outputDirectory, 'PlSqlLexerBase.ts'),
	parserBase: path.join(outputDirectory, 'PlSqlParserBase.ts'),
};

const replaceExactlyOnce = (source: string, search: string, replacement: string, description: string): string => {
	const firstIndex = source.indexOf(search);

	if (firstIndex === -1 || firstIndex !== source.lastIndexOf(search)) {
		throw new Error(`Expected exactly one ${description} in the upstream grammar`);
	}

	return source.replace(search, replacement);
};

// The vendored grammars stay byte-for-byte upstream. Only the target-language
// header marker is replaced; upstream's own `transformGrammar.py` performs the
// equivalent step for its build.
const adaptLexerGrammar = (upstream: string): string =>
	replaceExactlyOnce(
		upstream,
		'// Insert here @header for C++ lexer.',
		'@header {import {PlSqlLexerBase} from "./PlSqlLexerBase.js";}',
		'lexer target-language header marker',
	);

const adaptParserGrammar = (upstream: string): string =>
	replaceExactlyOnce(
		upstream,
		'// Insert here @header for C++ parser.',
		'@header {import {PlSqlParserBase} from "./PlSqlParserBase.js";}',
		'parser target-language header marker',
	);

// Base classes are vendored upstream files. These adaptations only satisfy this
// repository's strict TypeScript settings and generated-file layout; they do
// not change parser behavior.
const adaptLexerBase = (upstream: string): string =>
	replaceExactlyOnce(
		upstream,
		'import { CommonToken, Lexer, CharStream, Token, CommonTokenStream } from "antlr4ng";',
		"import {Lexer} from 'antlr4ng';",
		'lexer base runtime import',
	);

const adaptParserBase = (upstream: string): string => {
	const withTypeOnlyImport = replaceExactlyOnce(
		upstream,
		"import { Parser, TokenStream, CommonTokenStream, Token } from 'antlr4ng';",
		"import { Parser, type TokenStream, CommonTokenStream, Token } from 'antlr4ng';",
		'parser base type-only import',
	);

	return replaceExactlyOnce(withTypeOnlyImport, '  reset(): void {', '  override reset(): void {', 'parser base reset override');
};

const buildDirectory = mkdtempSync(path.join(tmpdir(), 'oracle-grammar-build-'));
const transformedLexerGrammar = path.join(buildDirectory, 'PlSqlLexer.g4');
const transformedParserGrammar = path.join(buildDirectory, 'PlSqlParser.g4');

try {
	writeFileSync(transformedLexerGrammar, adaptLexerGrammar(readFileSync(lexerGrammarSource, 'utf8')));
	writeFileSync(transformedParserGrammar, adaptParserGrammar(readFileSync(parserGrammarSource, 'utf8')));

	rmSync(outputDirectory, {recursive: true, force: true});

	const result = spawnSync(
		process.execPath,
		[
			runner,
			'-Dlanguage=TypeScript',
			'--generate-listener',
			'false',
			'--generate-visitor',
			'true',
			'-o',
			outputDirectory,
			transformedLexerGrammar,
			transformedParserGrammar,
		],
		{
			cwd: root,
			stdio: 'inherit',
		},
	);

	if (result.status !== 0) {
		throw new Error(`antlr-ng failed with status ${result.status ?? 'unknown'}`);
	}
} finally {
	rmSync(buildDirectory, {recursive: true, force: true});
}

// Generated sources are vendored byte-for-byte except for these deterministic
// post-processing steps required by this repository's strict TypeScript settings.
const lexer = readFileSync(generated.lexer, 'utf8')
	.replace('import { Token } from "antlr4ng";\n', '')
	.replaceAll('_sempred(localContext: antlr.ParserRuleContext | null', '_sempred(_localContext: antlr.ParserRuleContext | null');

// ANTLR emits a `previousContext` local for every left-recursive rule. Some
// rules never read it, which strict `noUnusedLocals` rejects.
const removeUnusedPreviousContext = (source: string): string => {
	const lines = source.split('\n');
	const removed = new Set<number>();
	const methodStart = /^ {4}(?:public|private|protected) .*\{$/u;
	const methodEndIndex = (startIndex: number): number => {
		let depth = 0;

		for (let index = startIndex; index < lines.length; index++) {
			depth += (lines[index]?.match(/\{/gu) ?? []).length - (lines[index]?.match(/\}/gu) ?? []).length;

			if (depth === 0 && index > startIndex) {
				return index;
			}
		}

		return lines.length - 1;
	};

	for (const [index, line] of lines.entries()) {
		if (!methodStart.test(line)) {
			continue;
		}

		const endIndex = methodEndIndex(index);
		const block = lines.slice(index, endIndex + 1);

		if (!block.some((candidate) => /^\s*let previousContext = localContext;$/u.test(candidate))) {
			continue;
		}

		const references = block.filter((candidate) => candidate.includes('previousContext'));
		const isAssignmentOnly = references.every((candidate) => /^\s*(?:let )?previousContext = localContext;$/u.test(candidate));

		if (!isAssignmentOnly) {
			continue;
		}

		for (let candidateIndex = index; candidateIndex <= endIndex; candidateIndex++) {
			const candidate = lines[candidateIndex] ?? '';

			if (/^\s*(?:let )?previousContext = localContext;$/u.test(candidate)) {
				removed.add(candidateIndex);
			}
		}
	}

	return lines.filter((_, index) => !removed.has(index)).join('\n');
};

const parser = removeUnusedPreviousContext(
	readFileSync(generated.parser, 'utf8')
		.replace(
			'// for running tests with parameters, TODO: discuss strategy for typed parameters in CI\n// eslint-disable-next-line no-unused-vars\ntype int = number;\n\n',
			'',
		)
		.replaceAll(/_sempred\(localContext: (?<context>\w+)Context \| null/gu, '_sempred(_localContext: $<context>Context | null'),
);

// The grammar header is copied into the visitor, but the visitor never
// references the parser base class.
const visitor = readFileSync(generated.visitor, 'utf8').replace('import {PlSqlParserBase} from "./PlSqlParserBase.js";\n\n', '');

for (const artifact of ['PlSqlLexer.interp', 'PlSqlLexer.tokens', 'PlSqlParser.interp', 'PlSqlParser.tokens']) {
	rmSync(path.join(outputDirectory, artifact), {force: true});
}

writeFileSync(generated.lexer, lexer);
writeFileSync(generated.parser, parser);
writeFileSync(generated.visitor, visitor);
writeFileSync(generated.lexerBase, adaptLexerBase(readFileSync(lexerBaseSource, 'utf8')));
writeFileSync(generated.parserBase, adaptParserBase(readFileSync(parserBaseSource, 'utf8')));
process.stdout.write(
	`Generated ${path.relative(root, generated.lexer)}, ${path.relative(root, generated.parser)}, ${path.relative(root, generated.visitor)}, ${path.relative(root, generated.lexerBase)}, ${path.relative(root, generated.parserBase)}\n`,
);
