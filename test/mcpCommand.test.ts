import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parse, type ParseError} from 'jsonc-parser';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {runMcpCommand} from '../src/transports/cli/mcpCommand.ts';

type CapturedIoType = Readonly<{
	stdout: string[];
	stderr: string[];
	io: Readonly<{stdout: (line: string) => void; stderr: (line: string) => void}>;
}>;

const createIo = (): CapturedIoType => {
	const stdout: string[] = [];
	const stderr: string[] = [];

	return {
		stdout,
		stderr,
		io: {
			stdout: (line) => {
				stdout.push(line);
			},
			stderr: (line) => {
				stderr.push(line);
			},
		},
	};
};

const ConfigSchema = z.looseObject({
	$schema: z.string().optional(),
	model: z.string().optional(),
	mcp: z.unknown().optional(),
});

type ConfigType = z.infer<typeof ConfigSchema>;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseConfig = (text: string): ConfigType => {
	const errors: ParseError[] = [];
	const parsed: unknown = parse(text, errors, {allowTrailingComma: true, disallowComments: false});
	expect(errors).toHaveLength(0);
	return ConfigSchema.parse(parsed);
};

const serverOf = (config: ConfigType): unknown => {
	const {mcp} = config;

	if (!isObject(mcp)) {
		return undefined;
	}

	const {servers} = mcp;
	return isObject(servers) ? servers : undefined;
};

describe('mcp command', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	const fixture = (): Readonly<{root: string; mcpPath: string}> => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-mcp-'));
		const root = path.join(directory, 'workspace');
		const mcpPath = path.join(root, 'tools', 'code_index', 'dist', 'mcp.mjs');
		mkdirSync(path.dirname(mcpPath), {recursive: true});
		writeFileSync(mcpPath, '// mcp bundle\n');

		return {root, mcpPath};
	};

	it('creates a project-local config with the derived server name', () => {
		const {root, mcpPath} = fixture();
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root], captured.io, {mcpPath})).toBe(0);
		expect(captured.stderr).toStrictEqual([]);

		const configPath = path.join(root, '.opencode', 'opencode.jsonc');
		expect(existsSync(configPath)).toBe(true);
		const config = parseConfig(readFileSync(configPath, 'utf8'));

		expect(config.$schema).toBeUndefined();
		expect(serverOf(config)).toStrictEqual({
			'codeindex-typescript': {type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs']},
		});
		expect(captured.stdout.join('\n')).toContain('Installed codeindex-typescript MCP server');
	});

	it('preserves comments and unrelated configuration', () => {
		const {root, mcpPath} = fixture();
		const configPath = path.join(root, 'opencode.jsonc');
		mkdirSync(path.dirname(configPath), {recursive: true});
		writeFileSync(
			configPath,
			`{
	// Keep this comment.
	"model": "provider/model",
	"mcp": {"servers": {"other": {"type": "local", "command": ["other"]}}},
}
`,
		);
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root], captured.io, {mcpPath})).toBe(0);
		const text = readFileSync(configPath, 'utf8');
		const config = parseConfig(text);

		expect(text).toContain('// Keep this comment.');
		expect(config.model).toBe('provider/model');
		expect(serverOf(config)).toStrictEqual({
			other: {type: 'local', command: ['other']},
			'codeindex-typescript': {type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs']},
		});
	});

	it('removes the server and empty ancestors, and is idempotent', () => {
		const {root, mcpPath} = fixture();
		const configPath = path.join(root, '.opencode', 'opencode.jsonc');
		mkdirSync(path.dirname(configPath), {recursive: true});
		writeFileSync(
			configPath,
			`{
	// Keep this comment.
	"model": "provider/model",
	"mcp": {"servers": {"codeindex-typescript": {"type": "local", "command": ["node", "mcp.mjs"]}}},
}
`,
		);
		const captured = createIo();

		expect(runMcpCommand(['uninstall', '--root', root], captured.io, {mcpPath})).toBe(0);
		const text = readFileSync(configPath, 'utf8');
		const config = parseConfig(text);

		expect(text).toContain('// Keep this comment.');
		expect(config.model).toBe('provider/model');
		expect(config.mcp).toBeUndefined();

		const second = createIo();
		expect(runMcpCommand(['uninstall', '--root', root], second.io, {mcpPath})).toBe(0);
		expect(second.stdout.join('\n')).toContain('is not configured');
	});

	it('fails before writing when the MCP bundle is missing', () => {
		const {root} = fixture();
		const captured = createIo();
		const missing = path.join(root, 'tools', 'code_index', 'dist', 'missing.mjs');

		expect(runMcpCommand(['install', '--root', root], captured.io, {mcpPath: missing})).toBe(1);
		expect(captured.stderr.join('\n')).toContain('pnpm build');
		expect(existsSync(path.join(root, '.opencode', 'opencode.jsonc'))).toBe(false);
	});
});

describe('mcp command schema hint', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	const fixture = (): Readonly<{root: string; mcpPath: string; configPath: string}> => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-mcp-'));
		const root = path.join(directory, 'workspace');
		const mcpPath = path.join(root, 'tools', 'code_index', 'dist', 'mcp.mjs');
		mkdirSync(path.dirname(mcpPath), {recursive: true});
		writeFileSync(mcpPath, '// mcp bundle\n');

		return {root, mcpPath, configPath: path.join(root, '.opencode', 'opencode.jsonc')};
	};

	it('does not add a schema hint', () => {
		const {root, mcpPath, configPath} = fixture();

		expect(runMcpCommand(['install', '--root', root], createIo().io, {mcpPath})).toBe(0);

		const config = parseConfig(readFileSync(configPath, 'utf8'));
		expect(config.$schema).toBeUndefined();
		expect(serverOf(config)).toStrictEqual({
			'codeindex-typescript': {type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs']},
		});
	});

	it('preserves a schema hint the user chose', () => {
		const {root, mcpPath, configPath} = fixture();
		mkdirSync(path.dirname(configPath), {recursive: true});
		writeFileSync(configPath, '{\n\t"$schema": "https://opencode.ai/config.json"\n}\n');

		expect(runMcpCommand(['install', '--root', root], createIo().io, {mcpPath})).toBe(0);
		expect(runMcpCommand(['uninstall', '--root', root], createIo().io, {mcpPath})).toBe(0);

		const config = parseConfig(readFileSync(configPath, 'utf8'));
		expect(config.$schema).toBe('https://opencode.ai/config.json');
		expect(config.mcp).toBeUndefined();
	});
});

describe('mcp command with a CodeIndex configuration', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	const fixture = (): Readonly<{root: string; mcpPath: string}> => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-mcp-'));
		const root = path.join(directory, 'workspace');
		const mcpPath = path.join(root, 'tools', 'code_index', 'dist', 'mcp.mjs');
		mkdirSync(path.dirname(mcpPath), {recursive: true});
		writeFileSync(mcpPath, '// mcp bundle\n');

		return {root, mcpPath};
	};

	it('passes a CodeIndex configuration to the installed server', () => {
		const {root, mcpPath} = fixture();
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractor": {}}\n');
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root, '--codeindex-config', 'tools/code_index/codeindex.config.json'], captured.io, {mcpPath})).toBe(0);
		expect(captured.stderr).toStrictEqual([]);

		const config = parseConfig(readFileSync(path.join(root, '.opencode', 'opencode.jsonc'), 'utf8'));
		expect(serverOf(config)).toStrictEqual({
			'codeindex-typescript': {
				type: 'local',
				command: ['node', 'tools/code_index/dist/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
			},
		});
	});

	it('derives the server name from the configured adapter', () => {
		const {root, mcpPath} = fixture();
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractor": {"id": "oracle"}}\n');
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root, '--codeindex-config', 'tools/code_index/codeindex.config.json'], captured.io, {mcpPath})).toBe(0);

		const config = parseConfig(readFileSync(path.join(root, '.opencode', 'opencode.jsonc'), 'utf8'));
		expect(serverOf(config)).toStrictEqual({
			'codeindex-oracle': {
				type: 'local',
				command: ['node', 'tools/code_index/dist/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
			},
		});
		expect(captured.stdout.join('\n')).toContain('Installed codeindex-oracle MCP server');
	});

	it('registers an explicit MCP path', () => {
		const {root, mcpPath} = fixture();
		const explicit = path.join(root, 'vendor', 'mcp.mjs');
		mkdirSync(path.dirname(explicit), {recursive: true});
		writeFileSync(explicit, '// vendor bundle\n');
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractor": {}}\n');
		const captured = createIo();

		expect(
			runMcpCommand(['install', '--root', root, '--mcp-path', 'vendor/mcp.mjs', '--codeindex-config', 'tools/code_index/codeindex.config.json'], captured.io, {
				mcpPath,
			}),
		).toBe(0);

		const config = parseConfig(readFileSync(path.join(root, '.opencode', 'opencode.jsonc'), 'utf8'));
		expect(serverOf(config)).toStrictEqual({
			'codeindex-typescript': {
				type: 'local',
				command: ['node', 'vendor/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
			},
		});
	});

	it('rejects a missing or outside CodeIndex configuration', () => {
		const {root, mcpPath} = fixture();
		const missing = createIo();

		expect(runMcpCommand(['install', '--root', root, '--codeindex-config', 'tools/code_index/missing.json'], missing.io, {mcpPath})).toBe(1);
		expect(missing.stderr.join('\n')).toContain('CodeIndex configuration not found');
		expect(existsSync(path.join(root, '.opencode', 'opencode.jsonc'))).toBe(false);

		writeFileSync(path.join(root, 'codeindex.config.json'), '{"extractor": {}}\n');
		const outside = createIo();
		expect(runMcpCommand(['install', '--root', root, '--codeindex-config', path.join(root, '..', 'outside.json')], outside.io, {mcpPath})).toBe(1);
		expect(outside.stderr.join('\n')).toContain('must stay inside --root');
	});
});

describe('mcp command server naming', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) {
			rmSync(directory, {recursive: true, force: true});
		}

		directory = undefined;
	});

	const fixture = (): Readonly<{root: string; mcpPath: string; configPath: string}> => {
		directory = mkdtempSync(path.join(tmpdir(), 'code-index-mcp-'));
		const root = path.join(directory, 'workspace');
		const mcpPath = path.join(root, 'tools', 'code_index', 'dist', 'mcp.mjs');
		mkdirSync(path.dirname(mcpPath), {recursive: true});
		writeFileSync(mcpPath, '// mcp bundle\n');

		return {root, mcpPath, configPath: path.join(root, '.opencode', 'opencode.jsonc')};
	};

	it('uninstalls only the server named by the configured adapter', () => {
		const {root, mcpPath, configPath} = fixture();
		mkdirSync(path.dirname(configPath), {recursive: true});
		writeFileSync(
			configPath,
			`{
	"mcp": {"servers": {"codeindex-typescript": {"type": "local", "command": ["node", "ts.mjs"]}, "codeindex-oracle": {"type": "local", "command": ["node", "oracle.mjs"]}}},
}
`,
		);
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractor": {"id": "oracle"}}\n');

		expect(runMcpCommand(['uninstall', '--root', root, '--codeindex-config', 'tools/code_index/codeindex.config.json'], createIo().io, {mcpPath})).toBe(0);

		const config = parseConfig(readFileSync(configPath, 'utf8'));
		expect(serverOf(config)).toStrictEqual({
			'codeindex-typescript': {type: 'local', command: ['node', 'ts.mjs']},
		});
	});

	it('leaves a legacy codeindex entry untouched', () => {
		const {root, mcpPath, configPath} = fixture();
		mkdirSync(path.dirname(configPath), {recursive: true});
		writeFileSync(
			configPath,
			`{
	"mcp": {"servers": {"codeindex": {"type": "local", "command": ["node", "legacy.mjs"]}}},
}
`,
		);

		expect(runMcpCommand(['install', '--root', root], createIo().io, {mcpPath})).toBe(0);

		const installed = parseConfig(readFileSync(configPath, 'utf8'));
		expect(serverOf(installed)).toStrictEqual({
			codeindex: {type: 'local', command: ['node', 'legacy.mjs']},
			'codeindex-typescript': {type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs']},
		});

		expect(runMcpCommand(['uninstall', '--root', root], createIo().io, {mcpPath})).toBe(0);

		const uninstalled = parseConfig(readFileSync(configPath, 'utf8'));
		expect(serverOf(uninstalled)).toStrictEqual({
			codeindex: {type: 'local', command: ['node', 'legacy.mjs']},
		});
	});
});
