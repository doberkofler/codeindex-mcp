import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

// The upstream grammar is vendored byte-for-byte. Target-specific integration
// (base-class imports and strict-TypeScript fixes) belongs to
// `generateOracleGrammar.ts`, so the grammar itself stays an unmodified upstream
// artifact.
const UPSTREAM_COMMIT = '3f1ca793eb1b72d421a016dd05b1d340dfa1a65e';
const UPSTREAM_FILES = [
	{
		sourcePath: 'sql/plsql/PlSqlLexer.g4',
		localPath: 'grammar/oracle/PlSqlLexer.g4',
		sha256: 'aaddaa2f9d40e10ab71e83a402499ae893aa7f03497a631e5c12f2c4cd1d2567',
	},
	{
		sourcePath: 'sql/plsql/PlSqlParser.g4',
		localPath: 'grammar/oracle/PlSqlParser.g4',
		sha256: '2437508c3e8126d0a09c4cc98fc12741a9d25350b4626350805afdcb74956827',
	},
	{
		sourcePath: 'sql/plsql/Antlr4ng/PlSqlLexerBase.ts',
		localPath: 'grammar/oracle/Antlr4ng/PlSqlLexerBase.ts.txt',
		sha256: '60463fb2d8e19ff40b77f1428056f74c7d19bb55263451a0f4a84670e227ae91',
	},
	{
		sourcePath: 'sql/plsql/Antlr4ng/PlSqlParserBase.ts',
		localPath: 'grammar/oracle/Antlr4ng/PlSqlParserBase.ts.txt',
		sha256: 'f83c2eab005f3174f2b506c7e553577f96c336fc18e7c456a58c273566c634eb',
	},
] as const;
const UPSTREAM_URL = `https://raw.githubusercontent.com/antlr/grammars-v4/${UPSTREAM_COMMIT}`;

const fetchVerified = async (sourcePath: string, expectedDigest: string): Promise<Buffer> => {
	const response = await fetch(`${UPSTREAM_URL}/${sourcePath}`);

	if (!response.ok) {
		throw new Error(`Unable to download ${sourcePath}: ${response.status} ${response.statusText}`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	const digest = createHash('sha256').update(bytes).digest('hex');

	if (digest !== expectedDigest) {
		throw new Error(`${sourcePath} digest mismatch: expected ${expectedDigest}, received ${digest}`);
	}

	return bytes;
};

const download = async (): Promise<void> => {
	const repositoryRoot = path.resolve(import.meta.dirname, '..');
	const contents = await Promise.all(UPSTREAM_FILES.map(async (file) => ({file, bytes: await fetchVerified(file.sourcePath, file.sha256)})));

	for (const {file, bytes} of contents) {
		const destination = path.join(repositoryRoot, file.localPath);

		mkdirSync(path.dirname(destination), {recursive: true});
		writeFileSync(destination, bytes);
	}

	process.stdout.write(`Wrote ${UPSTREAM_FILES.length} unmodified upstream Oracle grammar files\n`);
};

await download();
