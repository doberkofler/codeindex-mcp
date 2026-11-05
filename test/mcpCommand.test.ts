import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
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

type FixtureType = Readonly<{directory: string; root: string; mcpPath: string; configPath: string}>;

const tempFixture = (): FixtureType => {
	const directory = mkdtempSync(path.join(tmpdir(), 'code-index-mcp-'));
	const root = path.join(directory, 'workspace');
	const mcpPath = path.join(root, 'tools', 'code_index', 'dist', 'mcp.mjs');
	mkdirSync(path.dirname(mcpPath), {recursive: true});
	writeFileSync(mcpPath, '// mcp bundle\n');

	return {directory, root, mcpPath, configPath: path.join(root, '.opencode', 'opencode.jsonc')};
};

const removeFixture = (directory: string | undefined): void => {
	if (directory !== undefined) {
		rmSync(directory, {recursive: true, force: true});
	}
};

const legacyConfig = (entry: Readonly<Record<string, unknown>>): string =>
	`{
	"model": "provider/model",
	"mcp": {"servers": {"codeindex-oracle": ${JSON.stringify(entry)}, "other": {"type": "local", "command": ["other"]}}},
}
`;

const writeConfig = (configPath: string, text: string): void => {
	mkdirSync(path.dirname(configPath), {recursive: true});
	writeFileSync(configPath, text);
};

describe('mcp command', () => {
	let directory: string | undefined;

	afterEach(() => {
		removeFixture(directory);
		directory = undefined;
	});

	const fixture = (): FixtureType => {
		const value = tempFixture();
		const {directory: fixtureDirectory} = value;
		directory = fixtureDirectory;
		return value;
	};

	it('creates a project-local config with the canonical server name', () => {
		const {root, mcpPath} = fixture();
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root], captured.io, {mcpPath})).toBe(0);
		expect(captured.stderr).toStrictEqual([]);

		const configPath = path.join(root, '.opencode', 'opencode.jsonc');
		expect(existsSync(configPath)).toBe(true);
		const config = parseConfig(readFileSync(configPath, 'utf8'));

		expect(config.$schema).toBeUndefined();
		expect(serverOf(config)).toStrictEqual({
			codeindex: {type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs'], cwd: root},
		});
		expect(captured.stdout.join('\n')).toContain('Installed codeindex MCP server');
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
			codeindex: {type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs'], cwd: root},
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
	"mcp": {"servers": {"codeindex": {"type": "local", "command": ["node", "mcp.mjs"]}}},
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

	it('installs a workspace-independent cwd for nested sessions', () => {
		const {root, mcpPath, configPath} = fixture();
		writeFileSync(mcpPath, 'process.stdout.write(process.cwd());\n');
		const nested = path.join(root, 'tools', 'oracle_client_monitor');
		mkdirSync(nested, {recursive: true});
		expect(runMcpCommand(['install', '--root', root], createIo().io, {mcpPath})).toBe(0);
		const config = parseConfig(readFileSync(configPath, 'utf8'));
		const servers = serverOf(config);
		const entry = z
			.object({type: z.literal('local'), command: z.array(z.string()).min(1), cwd: z.string()})
			.parse(isObject(servers) ? servers['codeindex'] : undefined);
		expect(entry).toStrictEqual({type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs'], cwd: root});
		const started = spawnSync(process.execPath, entry.command.slice(1), {cwd: entry.cwd, encoding: 'utf8'});

		expect(started.status).toBe(0);
		expect(started.stdout).toBe(realpathSync(root));
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
		removeFixture(directory);
		directory = undefined;
	});

	const fixture = (): FixtureType => {
		const value = tempFixture();
		const {directory: fixtureDirectory} = value;
		directory = fixtureDirectory;
		return value;
	};

	it('does not add a schema hint', () => {
		const {root, mcpPath, configPath} = fixture();

		expect(runMcpCommand(['install', '--root', root], createIo().io, {mcpPath})).toBe(0);

		const config = parseConfig(readFileSync(configPath, 'utf8'));
		expect(config.$schema).toBeUndefined();
		expect(serverOf(config)).toStrictEqual({
			codeindex: {type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs'], cwd: root},
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
		removeFixture(directory);
		directory = undefined;
	});

	const fixture = (): FixtureType => {
		const value = tempFixture();
		const {directory: fixtureDirectory} = value;
		directory = fixtureDirectory;
		return value;
	};

	it('passes a CodeIndex configuration to the installed server', () => {
		const {root, mcpPath} = fixture();
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractor": {}}\n');
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root, '--codeindex-config', 'tools/code_index/codeindex.config.json'], captured.io, {mcpPath})).toBe(0);
		expect(captured.stderr).toStrictEqual([]);

		const config = parseConfig(readFileSync(path.join(root, '.opencode', 'opencode.jsonc'), 'utf8'));
		expect(serverOf(config)).toStrictEqual({
			codeindex: {
				type: 'local',
				command: ['node', 'tools/code_index/dist/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
				cwd: root,
			},
		});
	});

	it('registers one canonical key for a multi-adapter configuration', () => {
		const {root, mcpPath} = fixture();
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractors": [{"id": "typescript"}, {"id": "oracle"}]}\n');
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root, '--codeindex-config', 'tools/code_index/codeindex.config.json'], captured.io, {mcpPath})).toBe(0);

		const config = parseConfig(readFileSync(path.join(root, '.opencode', 'opencode.jsonc'), 'utf8'));
		expect(serverOf(config)).toStrictEqual({
			codeindex: {
				type: 'local',
				command: ['node', 'tools/code_index/dist/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
				cwd: root,
			},
		});
		expect(captured.stdout.join('\n')).toContain('Installed codeindex MCP server');
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
			codeindex: {
				type: 'local',
				command: ['node', 'vendor/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
				cwd: root,
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

describe('mcp command legacy registration', () => {
	let directory: string | undefined;

	afterEach(() => {
		removeFixture(directory);
		directory = undefined;
	});

	const fixture = (): FixtureType => {
		const value = tempFixture();
		const {directory: fixtureDirectory} = value;
		directory = fixtureDirectory;
		return value;
	};

	it('refuses to install while a legacy key exists', () => {
		const {root, mcpPath, configPath} = fixture();
		const original = legacyConfig({type: 'local', command: ['node', 'tools/code_index/dist/mcp.mjs']});
		writeConfig(configPath, original);
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root], captured.io, {mcpPath})).toBe(1);
		expect(captured.stderr.join('\n')).toContain('codeindex-oracle');
		expect(captured.stderr.join('\n')).toContain('--migrate-legacy');
		expect(readFileSync(configPath, 'utf8')).toBe(original);
	});

	it('migrates only a legacy entry whose command proves ownership', () => {
		const {root, mcpPath, configPath} = fixture();
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractors": [{"id": "typescript"}, {"id": "oracle"}]}\n');
		writeConfig(
			configPath,
			legacyConfig({
				type: 'local',
				command: ['node', 'tools/code_index/dist/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
			}),
		);
		const captured = createIo();

		expect(
			runMcpCommand(['install', '--root', root, '--codeindex-config', 'tools/code_index/codeindex.config.json', '--migrate-legacy'], captured.io, {mcpPath}),
		).toBe(0);
		expect(captured.stderr).toStrictEqual([]);
		expect(captured.stdout.join('\n')).toContain('removed legacy codeindex-oracle');

		const config = parseConfig(readFileSync(configPath, 'utf8'));
		expect(config.model).toBe('provider/model');
		expect(serverOf(config)).toStrictEqual({
			other: {type: 'local', command: ['other']},
			codeindex: {
				type: 'local',
				command: ['node', 'tools/code_index/dist/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
				cwd: root,
			},
		});
	});

	it('refuses to migrate any legacy entry when one is unproven', () => {
		const {root, mcpPath, configPath} = fixture();
		const original = `{
	"mcp": {"servers": {"codeindex-oracle": {"type": "local", "command": ["node", "tools/code_index/dist/mcp.mjs"]}, "codeindex-custom": {"type": "local", "command": ["node", "custom.mjs"]}}},
}
`;
		writeConfig(configPath, original);
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root, '--migrate-legacy'], captured.io, {mcpPath})).toBe(1);
		expect(captured.stderr.join('\n')).toContain('codeindex-custom');
		expect(readFileSync(configPath, 'utf8')).toBe(original);
	});

	it('requires matching configuration arguments to prove a legacy entry', () => {
		const {root, mcpPath, configPath} = fixture();
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractor": {}}\n');
		const original = legacyConfig({
			type: 'local',
			command: ['node', 'tools/code_index/dist/mcp.mjs', '--config', 'tools/code_index/codeindex.config.json'],
		});
		writeConfig(configPath, original);
		const captured = createIo();

		expect(runMcpCommand(['install', '--root', root, '--migrate-legacy'], captured.io, {mcpPath})).toBe(1);
		expect(captured.stderr.join('\n')).toContain('Cannot prove');
		expect(readFileSync(configPath, 'utf8')).toBe(original);
	});
});

describe('mcp command legacy uninstall', () => {
	let directory: string | undefined;

	afterEach(() => {
		removeFixture(directory);
		directory = undefined;
	});

	const fixture = (): FixtureType => {
		const value = tempFixture();
		const {directory: fixtureDirectory} = value;
		directory = fixtureDirectory;
		return value;
	};

	it('uninstalls only the canonical key without --legacy', () => {
		const {root, mcpPath, configPath} = fixture();
		writeConfig(
			configPath,
			`{
	"mcp": {"servers": {"codeindex": {"type": "local", "command": ["node", "mcp.mjs"]}, "codeindex-oracle": {"type": "local", "command": ["node", "oracle.mjs"]}}},
}
`,
		);

		expect(runMcpCommand(['uninstall', '--root', root], createIo().io, {mcpPath})).toBe(0);

		const config = parseConfig(readFileSync(configPath, 'utf8'));
		expect(serverOf(config)).toStrictEqual({
			'codeindex-oracle': {type: 'local', command: ['node', 'oracle.mjs']},
		});
	});

	it('uninstalls provable legacy entries only with --legacy', () => {
		const {root, mcpPath, configPath} = fixture();
		writeFileSync(path.join(root, 'tools', 'code_index', 'codeindex.config.json'), '{"extractor": {}}\n');
		writeConfig(
			configPath,
			`{
	"mcp": {"servers": {
		"codeindex": {"type": "local", "command": ["node", "mcp.mjs"]},
		"codeindex-oracle": {"type": "local", "command": ["node", "tools/code_index/dist/mcp.mjs", "--config", "tools/code_index/codeindex.config.json"]},
		"codeindex-custom": {"type": "local", "command": ["node", "custom.mjs"]}
	}},
}
`,
		);
		const captured = createIo();

		expect(
			runMcpCommand(['uninstall', '--root', root, '--codeindex-config', 'tools/code_index/codeindex.config.json', '--legacy'], captured.io, {mcpPath}),
		).toBe(0);
		expect(captured.stdout.join('\n')).toContain('Removed codeindex MCP server and legacy codeindex-oracle');

		const config = parseConfig(readFileSync(configPath, 'utf8'));
		expect(serverOf(config)).toStrictEqual({
			'codeindex-custom': {type: 'local', command: ['node', 'custom.mjs']},
		});
	});

	it('rejects migration flags on the wrong action', () => {
		const {root, mcpPath} = fixture();

		expect(runMcpCommand(['install', '--root', root, '--legacy'], createIo().io, {mcpPath})).toBe(1);
		expect(runMcpCommand(['uninstall', '--root', root, '--migrate-legacy'], createIo().io, {mcpPath})).toBe(1);
	});
});
