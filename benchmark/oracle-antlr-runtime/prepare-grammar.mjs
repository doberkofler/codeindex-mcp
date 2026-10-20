import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const usage = `Usage: node benchmark/oracle-antlr-runtime/prepare-grammar.mjs --target go|rust --out-dir <path>

Options:
  --target <name>   go or rust
  --out-dir <path>  Destination directory for the prepared grammars
  --help            Show this message
`;

const options = {target: '', outDir: ''};

for (let index = 2; index < process.argv.length; index += 1) {
	const argument = process.argv[index];
	const value = process.argv[index + 1];

	if (argument === '--help') {
		process.stdout.write(usage);
		process.exit(0);
	}

	if (value === undefined) {
		throw new Error(`Missing value for ${argument}`);
	}

	switch (argument) {
		case '--target': {
			options.target = value;
			break;
		}
		case '--out-dir': {
			options.outDir = path.resolve(value);
			break;
		}
		default: {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}

	index += 1;
}

if (options.target !== 'go' && options.target !== 'rust') {
	throw new Error('--target must be go or rust');
}

if (options.outDir === '') {
	throw new Error('--out-dir is required');
}

const here = import.meta.dirname;
const repoRoot = path.resolve(here, '../..');
const sourceDir = path.join(repoRoot, 'grammar/oracle');

/**
 * Removes one `@header { ... }` or `@members { ... }` block, including nested
 * braces. The repository grammars carry TypeScript-only header and member code;
 * generated Go and Rust recognizers must not receive it.
 */
const stripActionBlock = (source, marker) => {
	const start = source.indexOf(marker);

	if (start < 0) {
		return source;
	}

	const braceStart = source.indexOf('{', start);

	if (braceStart < 0) {
		throw new Error(`${marker} has no opening brace`);
	}

	let depth = 0;
	let quote = null;
	let escaped = false;

	for (let index = braceStart; index < source.length; index += 1) {
		const character = source[index];

		if (quote !== null) {
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if (character === quote) {
				quote = null;
			}
			continue;
		}

		if (character === "'" || character === '"' || character === '`') {
			quote = character;
			continue;
		}

		if (character === '{') {
			depth += 1;
		} else if (character === '}') {
			depth -= 1;

			if (depth === 0) {
				return source.slice(0, start) + source.slice(index + 1);
			}
		}
	}

	throw new Error(`Unterminated ${marker} block`);
};

const stripTypeScriptSections = (source) => stripActionBlock(stripActionBlock(source, '@header'), '@members');

const prepareGo = (source) => stripTypeScriptSections(source).replaceAll('this.', 'p.');

const prepareRust = (source) => {
	const withoutTargetOptions = stripTypeScriptSections(source).replace(/^\s*superClass\s*=\s*\w+\s*;\s*$/gmu, '');
	// The generated parser module uses `METADATA` for its static metadata
	// table. Oracle's METADATA keyword token would collide with that name.
	return withoutTargetOptions.replace(/\bMETADATA\b/gu, 'METADATA_KW');
};

const prepare = (name, target) => {
	const source = readFileSync(path.join(sourceDir, name), 'utf8');
	const prepared = target === 'go' ? prepareGo(source) : prepareRust(source);

	return {
		name,
		source: prepared,
		hash: createHash('sha256').update(prepared).digest('hex'),
	};
};

mkdirSync(options.outDir, {recursive: true});

const lexer = prepare('PlSqlLexer.g4', options.target);
const parser = prepare('PlSqlParser.g4', options.target);

writeFileSync(path.join(options.outDir, lexer.name), lexer.source);
writeFileSync(path.join(options.outDir, parser.name), parser.source);

process.stdout.write(`Prepared ${options.target} grammars: ${lexer.name} ${lexer.hash.slice(0, 12)}, ${parser.name} ${parser.hash.slice(0, 12)}\n`);
