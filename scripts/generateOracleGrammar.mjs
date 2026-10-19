import {rmSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const grammar = path.join(root, 'grammar', 'oracle', 'PlSqlLexer.g4');
const outputDirectory = path.join(root, 'src', 'adapters', 'oracle', 'generated');
const runner = path.join(root, 'node_modules', 'antlr-ng', 'dist', 'cli', 'runner.js');
const generated = path.join(outputDirectory, 'PlSqlLexer.ts');

rmSync(outputDirectory, {recursive: true, force: true});

const result = spawnSync(process.execPath, [runner, '-Dlanguage=TypeScript', '-o', outputDirectory, grammar], {
	cwd: root,
	stdio: 'inherit',
});

if (result.status !== 0) {
	throw new Error(`antlr-ng failed with status ${result.status ?? 'unknown'}`);
}

// The generated lexer is vendored byte-for-byte except for these deterministic
// post-processing steps required by this repository's strict TypeScript settings.
const source = readFileSync(generated, 'utf8')
	.replace('import { Token } from "antlr4ng";\n', '')
	.replaceAll('_sempred(localContext: antlr.ParserRuleContext | null', '_sempred(_localContext: antlr.ParserRuleContext | null');

rmSync(path.join(outputDirectory, 'PlSqlLexer.interp'), {force: true});
rmSync(path.join(outputDirectory, 'PlSqlLexer.tokens'), {force: true});
writeFileSync(generated, source);
process.stdout.write(`Generated ${path.relative(root, generated)}\n`);
