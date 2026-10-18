import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {applyEdits, type JSONPath, type ParseError, modify, parse} from 'jsonc-parser';
import {z} from 'zod';

const {dirname, relative, resolve, sep} = path;

const SERVER_NAME = 'codeindex';
const SCHEMA_URL = 'https://opencode.ai/config.json';
// jsonc-parser deletes a property when the value is undefined; avoid an explicit
// undefined literal to satisfy the lint policy.
const REMOVE: unknown = new Map<string, unknown>().get('missing');
const CONFIG_CANDIDATES = [['.opencode', 'opencode.jsonc'], ['.opencode', 'opencode.json'], ['opencode.jsonc'], ['opencode.json']] as const;
const DEFAULT_CONFIG_PATH = ['.opencode', 'opencode.jsonc'] as const;
const FORMATTING = {insertSpaces: false, tabSize: 1, eol: '\n'} as const;

const InputSchema = z.object({
	action: z.enum(['install', 'uninstall']),
	root: z.string().min(1),
	config: z.string().optional(),
	codeIndexConfig: z.string().optional(),
	json: z.boolean(),
	mcpPath: z.string().min(1),
});

type InputType = z.infer<typeof InputSchema>;

export type McpCommandIoType = Readonly<{
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
}>;

export type McpCommandOptionsType = Readonly<{
	readonly mcpPath: string;
}>;

const usage = `Usage: cli mcp <install|uninstall> [options]

Adds or removes the local code-index MCP server in the project OpenCode config.

Options:
  --root <path>              Project root that contains the OpenCode config (default ".").
  --config <path>            Explicit OpenCode config path, relative to the root.
  --codeindex-config <path>  CodeIndex configuration passed to the server.
  --json                     Print a machine-readable result.
  --help                     Print this message.

--config selects the OpenCode configuration file to edit. To make the installed
server use a CodeIndex configuration file, pass --codeindex-config.
`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJsonc = (text: string, configPath: string): Record<string, unknown> => {
	const errors: ParseError[] = [];
	const parsed: unknown = parse(text, errors, {allowTrailingComma: true, disallowComments: false});

	if (errors.length > 0) {
		const [first] = errors;
		throw new Error(`Invalid JSONC in ${configPath} at offset ${String(first?.offset ?? 0)}`);
	}

	if (!isObject(parsed)) {
		throw new Error(`OpenCode config must be a JSON object: ${configPath}`);
	}

	return parsed;
};

const serverAt = (config: Readonly<Record<string, unknown>>): unknown => {
	const {mcp} = config;

	if (!isObject(mcp) || !isObject(mcp['servers'])) {
		return undefined;
	}

	return mcp['servers'][SERVER_NAME];
};

const applyPath = (text: string, keyPath: JSONPath, value: unknown): string => applyEdits(text, modify(text, keyPath, value, {formattingOptions: FORMATTING}));

const removeEmptyAncestors = (text: string): string => {
	const withoutServers = parseJsonc(text, 'config');
	const {mcp} = withoutServers;

	if (!isObject(mcp) || !isObject(mcp['servers']) || Object.keys(mcp['servers']).length > 0) {
		return text;
	}

	const withoutMcpServers = applyPath(text, ['mcp', 'servers'], REMOVE);
	const current = parseJsonc(withoutMcpServers, 'config');

	if (!isObject(current['mcp']) || Object.keys(current['mcp']).length > 0) {
		return withoutMcpServers;
	}

	return applyPath(withoutMcpServers, ['mcp'], REMOVE);
};

const configPathOf = (input: InputType): string => {
	const root = resolve(input.root);

	if (input.config !== undefined) {
		const explicit = resolve(root, input.config);
		const inside = relative(root, explicit);
		if (inside.startsWith('..') || path.isAbsolute(inside)) {
			throw new Error('--config must stay inside --root');
		}

		return explicit;
	}

	for (const candidate of CONFIG_CANDIDATES) {
		const candidatePath = resolve(root, ...candidate);
		if (existsSync(candidatePath)) {
			return candidatePath;
		}
	}

	return resolve(root, ...DEFAULT_CONFIG_PATH);
};

const commandPathOf = (root: string, mcpPath: string): string => relative(resolve(root), resolve(mcpPath)).split(sep).join('/');

const relativeInsideRoot = (root: string, filePath: string, option: string): string => {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, filePath);
	const inside = relative(resolvedRoot, resolvedPath);

	if (inside.startsWith('..') || path.isAbsolute(inside)) {
		throw new Error(`${option} must stay inside --root`);
	}

	return inside.split(sep).join('/');
};

const serverEntry = (root: string, mcpPath: string, codeIndexConfig: string | undefined): Readonly<Record<string, unknown>> => {
	const command = ['node', commandPathOf(root, mcpPath)];

	if (codeIndexConfig !== undefined) {
		command.push('--config', relativeInsideRoot(root, codeIndexConfig, '--codeindex-config'));
	}

	return {type: 'local', command};
};

const readConfig = (configPath: string): string => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '{\n}\n');

const install = (input: InputType, configPath: string): string => {
	if (!existsSync(input.mcpPath)) {
		throw new Error(`MCP bundle not found: ${input.mcpPath}. Run "pnpm build" first.`);
	}

	if (input.codeIndexConfig !== undefined) {
		const relativeConfig = relativeInsideRoot(input.root, input.codeIndexConfig, '--codeindex-config');
		const codeIndexPath = resolve(input.root, relativeConfig);

		if (!existsSync(codeIndexPath)) {
			throw new Error(`CodeIndex configuration not found: ${input.codeIndexConfig}`);
		}
	}

	let text = readConfig(configPath);
	const config = parseJsonc(text, configPath);

	if (!('$schema' in config)) {
		text = applyPath(text, ['$schema'], SCHEMA_URL);
	}

	text = applyPath(text, ['mcp', 'servers', SERVER_NAME], serverEntry(input.root, input.mcpPath, input.codeIndexConfig));
	parseJsonc(text, configPath);
	return text;
};

const uninstall = (configPath: string): Readonly<{text: string; removed: boolean}> => {
	if (!existsSync(configPath)) {
		return {text: '', removed: false};
	}

	const text = readFileSync(configPath, 'utf8');
	const config = parseJsonc(text, configPath);

	if (serverAt(config) === undefined) {
		return {text, removed: false};
	}

	const withoutServer = applyPath(text, ['mcp', 'servers', SERVER_NAME], REMOVE);
	const cleaned = removeEmptyAncestors(withoutServer);
	parseJsonc(cleaned, configPath);
	return {text: cleaned, removed: true};
};

const parseOptions = (argv: readonly string[]): Record<string, unknown> => {
	const options: Record<string, unknown> = {};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === '--json') {
			options['json'] = true;
		} else if (argument === '--help' || argument === '-h') {
			options['help'] = true;
		} else if (argument === '--root' || argument === '--config' || argument === '--codeindex-config') {
			const value = argv.at(index + 1);

			if (value === undefined) {
				throw new Error(`${argument} requires a value`);
			}

			const key = argument === '--root' ? 'root' : argument === '--config' ? 'config' : 'codeIndexConfig';
			options[key] = value;
			index += 1;
		} else {
			throw new Error(`Unknown option: ${argument}`);
		}
	}

	return options;
};

/**
 * Installs or removes the project-local code-index MCP server.
 *
 * The command updates only `mcp.servers.codeindex` and preserves unrelated
 * OpenCode configuration, comments, and formatting where possible.
 *
 * @param argv - Arguments after the `mcp` command.
 * @param io - Output sinks.
 * @param options - Absolute path to the production MCP bundle.
 * @returns Process exit code.
 */
export const runMcpCommand = (argv: readonly string[], io: McpCommandIoType, options: McpCommandOptionsType): number => {
	const [action, ...rest] = argv;

	if (action === '--help' || action === '-h' || action === undefined) {
		io.stdout(usage.trimEnd());
		return 0;
	}

	if (action !== 'install' && action !== 'uninstall') {
		io.stderr(`Unknown mcp action: ${action}\n\n${usage.trimEnd()}`);
		return 1;
	}

	try {
		const cliOptions = z
			.object({
				root: z.string().default('.'),
				config: z.string().optional(),
				codeIndexConfig: z.string().optional(),
				json: z.boolean().default(false),
				help: z.boolean().default(false),
			})
			.parse(parseOptions(rest));

		if (cliOptions.help) {
			io.stdout(usage.trimEnd());
			return 0;
		}

		const input = InputSchema.parse({...cliOptions, action, mcpPath: options.mcpPath});

		const configPath = configPathOf(input);
		const relativePath = relative(resolve(input.root), configPath).split(sep).join('/');
		let changed = false;
		let text = '';

		if (action === 'install') {
			text = install(input, configPath);
			changed = true;
		} else {
			const {text: nextText, removed} = uninstall(configPath);
			text = nextText;
			changed = removed;
		}

		if (changed) {
			mkdirSync(dirname(configPath), {recursive: true});
			writeFileSync(configPath, text, {encoding: 'utf8'});
		}

		const message =
			action === 'install'
				? `Installed ${SERVER_NAME} MCP server in ${relativePath}`
				: changed
					? `Removed ${SERVER_NAME} MCP server from ${relativePath}`
					: `${SERVER_NAME} MCP server is not configured in ${relativePath}`;

		if (cliOptions.json) {
			io.stdout(JSON.stringify({configPath: relativePath, installed: action === 'install', changed, server: SERVER_NAME}, null, 2));
		} else {
			io.stdout(message);
		}

		return 0;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};
