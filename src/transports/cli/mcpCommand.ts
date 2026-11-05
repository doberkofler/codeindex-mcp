import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {applyEdits, type JSONPath, type ParseError, modify, parse} from 'jsonc-parser';
import {z} from 'zod';

const {dirname, relative, resolve, sep} = path;

const SERVER_NAME = 'codeindex';
const LEGACY_SERVER_PREFIX = `${SERVER_NAME}-`;
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
The server key is always "codeindex", regardless of the configured adapters.

Older releases registered one key per adapter (for example codeindex-oracle).
Install refuses to write while such legacy keys remain. Use --migrate-legacy to
remove the entries whose command proves CodeIndex created them for this
configuration; remove or rename any other legacy entry manually.

Options:
  --root <path>              Project root that contains the OpenCode config (default ".").
  --config <path>            Explicit OpenCode config path, relative to the root.
  --codeindex-config <path>  CodeIndex configuration passed to the server.
  --mcp-path <path>          MCP bundle to register, relative to the root.
  --migrate-legacy           Install: remove provable legacy keys before writing codeindex.
  --legacy                   Uninstall: also remove provable legacy keys.
  --json                     Print a machine-readable result.
  --help                     Print this message.

--config selects the OpenCode configuration file to edit. To make the installed
server use a CodeIndex configuration file, pass --codeindex-config. The entry
records an absolute cwd for the project root, so sessions started in a nested
directory still resolve the relative bundle and configuration paths. Legacy proof
compares the registered command with the one this invocation would write.
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

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

const serversAt = (config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined => {
	const {mcp} = config;

	return isObject(mcp) && isObject(mcp['servers']) ? mcp['servers'] : undefined;
};

const serverAt = (config: Readonly<Record<string, unknown>>, serverName: string): unknown => serversAt(config)?.[serverName];

const legacyServerNames = (config: Readonly<Record<string, unknown>>): readonly string[] =>
	Object.keys(serversAt(config) ?? {}).filter((serverName) => serverName.startsWith(LEGACY_SERVER_PREFIX));

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

const serverDirectoryOf = (root: string): string => resolve(root);

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

const codeIndexConfigPathOf = (root: string, codeIndexConfig: string | undefined): string | undefined => {
	if (codeIndexConfig === undefined) {
		return undefined;
	}

	const relativePath = relativeInsideRoot(root, codeIndexConfig, '--codeindex-config');

	if (!existsSync(resolve(root, relativePath))) {
		throw new Error(`CodeIndex configuration not found: ${codeIndexConfig}`);
	}

	return relativePath;
};

const serverCommandOf = (root: string, mcpPath: string, codeIndexConfig: string | undefined): readonly string[] => {
	const command = ['node', commandPathOf(root, mcpPath)];

	if (codeIndexConfig !== undefined) {
		command.push('--config', codeIndexConfig);
	}

	return command;
};

// OpenCode resolves a relative `cwd` from the session workspace, which is a
// nested directory when a monorepo session starts below the repository root.
// An absolute cwd keeps the relative bundle and configuration paths independent
// of the workspace that discovered the configuration file.
const serverEntryOf = (command: readonly string[], directory: string): Readonly<Record<string, unknown>> => ({
	type: 'local',
	command: [...command],
	cwd: directory,
});

// A legacy entry is provable only when its registered command equals the one
// this invocation would write; extra properties do not weaken that proof.
const isProvenLegacy = (entry: unknown, command: readonly string[]): boolean => {
	if (!isObject(entry) || entry['type'] !== 'local') {
		return false;
	}

	const registered = entry['command'];

	return isStringArray(registered) && registered.length === command.length && registered.every((argument, index) => argument === command[index]);
};

const unresolvedLegacyMessage = (names: readonly string[]): string =>
	`Cannot prove these legacy CodeIndex MCP servers were created for this configuration: ${names.join(', ')}. Remove or rename them manually before installing codeindex.`;

const readConfig = (configPath: string): string => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '{\n}\n');

type InstallResultType = Readonly<{text: string; migrated: readonly string[]}>;

const install = (configPath: string, command: readonly string[], directory: string, migrateLegacy: boolean): InstallResultType => {
	const bundlePath = resolve(directory, command[1] ?? '');

	if (!existsSync(bundlePath)) {
		throw new Error(`MCP bundle not found: ${bundlePath}. Run "pnpm build" first.`);
	}

	const text = readConfig(configPath);
	const config = parseJsonc(text, configPath);
	const legacy = legacyServerNames(config);

	if (legacy.length > 0 && !migrateLegacy) {
		throw new Error(
			`Legacy CodeIndex MCP servers are configured for this workspace: ${legacy.join(', ')}. Run "mcp install --migrate-legacy" to remove provable entries, or remove or rename them manually before installing codeindex.`,
		);
	}

	const unproven = legacy.filter((serverName) => !isProvenLegacy(serverAt(config, serverName), command));

	if (unproven.length > 0) {
		throw new Error(unresolvedLegacyMessage(unproven));
	}

	let next = text;

	for (const serverName of legacy) {
		next = applyPath(next, ['mcp', 'servers', serverName], REMOVE);
	}

	next = applyPath(next, ['mcp', 'servers', SERVER_NAME], serverEntryOf(command, directory));
	parseJsonc(next, configPath);
	return {text: next, migrated: legacy};
};

type UninstallResultType = Readonly<{text: string; changed: boolean; removedCanonical: boolean; removedLegacy: readonly string[]}>;

// The config carries no provenance marker, so install never writes `$schema`:
// uninstall could not distinguish a hint it added from one the user chose.
const uninstall = (configPath: string, command: readonly string[], legacy: boolean): UninstallResultType => {
	if (!existsSync(configPath)) {
		return {text: '', changed: false, removedCanonical: false, removedLegacy: []};
	}

	const text = readFileSync(configPath, 'utf8');
	const config = parseJsonc(text, configPath);
	const removedLegacy = legacy ? legacyServerNames(config).filter((serverName) => isProvenLegacy(serverAt(config, serverName), command)) : [];
	const removedCanonical = serverAt(config, SERVER_NAME) !== undefined;

	if (!removedCanonical && removedLegacy.length === 0) {
		return {text, changed: false, removedCanonical: false, removedLegacy: []};
	}

	const names = removedCanonical ? [SERVER_NAME, ...removedLegacy] : removedLegacy;
	const cleaned = removeEmptyAncestors(names.reduce((current, serverName) => applyPath(current, ['mcp', 'servers', serverName], REMOVE), text));
	parseJsonc(cleaned, configPath);
	return {text: cleaned, changed: true, removedCanonical, removedLegacy};
};

const parseOptions = (argv: readonly string[]): Record<string, unknown> => {
	const options: Record<string, unknown> = {};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === '--json') {
			options['json'] = true;
		} else if (argument === '--help' || argument === '-h') {
			options['help'] = true;
		} else if (argument === '--migrate-legacy') {
			options['migrateLegacy'] = true;
		} else if (argument === '--legacy') {
			options['legacy'] = true;
		} else if (argument === '--root' || argument === '--config' || argument === '--codeindex-config' || argument === '--mcp-path') {
			const value = argv.at(index + 1);

			if (value === undefined) {
				throw new Error(`${argument} requires a value`);
			}

			const key = argument === '--root' ? 'root' : argument === '--config' ? 'config' : argument === '--codeindex-config' ? 'codeIndexConfig' : 'mcpPath';
			options[key] = value;
			index += 1;
		} else {
			throw new Error(`Unknown option: ${argument}`);
		}
	}

	return options;
};

const CliOptionsSchema = z.object({
	root: z.string().default('.'),
	config: z.string().optional(),
	codeIndexConfig: z.string().optional(),
	mcpPath: z.string().optional(),
	json: z.boolean().default(false),
	help: z.boolean().default(false),
	migrateLegacy: z.boolean().default(false),
	legacy: z.boolean().default(false),
});

type CliOptionsType = z.infer<typeof CliOptionsSchema>;

const assertActionFlags = (action: InputType['action'], options: Pick<CliOptionsType, 'legacy' | 'migrateLegacy'>): void => {
	if (action === 'install' && options.legacy) {
		throw new Error('--legacy is only valid with "mcp uninstall"');
	}

	if (action === 'uninstall' && options.migrateLegacy) {
		throw new Error('--migrate-legacy is only valid with "mcp install"');
	}
};

type ActionOutcomeType = Readonly<{
	changed: boolean;
	text: string;
	removedCanonical: boolean;
	removedLegacy: readonly string[];
}>;

const applyAction = (
	action: InputType['action'],
	input: InputType,
	configPath: string,
	options: Pick<CliOptionsType, 'legacy' | 'migrateLegacy'>,
): ActionOutcomeType => {
	const command = serverCommandOf(input.root, input.mcpPath, codeIndexConfigPathOf(input.root, input.codeIndexConfig));
	const directory = serverDirectoryOf(input.root);

	if (action === 'install') {
		const result = install(configPath, command, directory, options.migrateLegacy);
		return {changed: true, text: result.text, removedCanonical: false, removedLegacy: result.migrated};
	}

	return uninstall(configPath, command, options.legacy);
};

const removalMessage = (removedCanonical: boolean, removedLegacy: readonly string[], relativePath: string): string => {
	if (removedLegacy.length > 0) {
		return removedCanonical
			? `Removed codeindex MCP server and legacy ${removedLegacy.join(', ')} from ${relativePath}`
			: `Removed legacy CodeIndex MCP servers ${removedLegacy.join(', ')} from ${relativePath}`;
	}

	return removedCanonical ? `Removed codeindex MCP server from ${relativePath}` : `codeindex MCP server is not configured in ${relativePath}`;
};

/**
 * Installs or removes the project-local code-index MCP server.
 *
 * The command updates only `mcp.servers.codeindex` and preserves unrelated
 * OpenCode configuration, comments, and formatting where possible. Legacy
 * `codeindex-*` entries are removed only when their command proves CodeIndex
 * created them for this configuration.
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
		const cliOptions = CliOptionsSchema.parse(parseOptions(rest));
		const {help, json, legacy, migrateLegacy, mcpPath: cliMcpPath, root} = cliOptions;

		if (help) {
			io.stdout(usage.trimEnd());
			return 0;
		}

		assertActionFlags(action, {legacy, migrateLegacy});

		const input = InputSchema.parse({
			...cliOptions,
			action,
			mcpPath: cliMcpPath === undefined ? options.mcpPath : resolve(root, cliMcpPath),
		});
		const configPath = configPathOf(input);
		const relativePath = relative(resolve(input.root), configPath).split(sep).join('/');
		const outcome = applyAction(action, input, configPath, {legacy, migrateLegacy});

		if (outcome.changed) {
			mkdirSync(dirname(configPath), {recursive: true});
			writeFileSync(configPath, outcome.text, {encoding: 'utf8'});
		}

		const legacyNote = outcome.removedLegacy.length > 0 ? ` (removed legacy ${outcome.removedLegacy.join(', ')})` : '';
		const message =
			action === 'install'
				? `Installed ${SERVER_NAME} MCP server in ${relativePath}${legacyNote}`
				: removalMessage(outcome.removedCanonical, outcome.removedLegacy, relativePath);

		if (json) {
			io.stdout(
				JSON.stringify(
					{configPath: relativePath, installed: action === 'install', changed: outcome.changed, server: SERVER_NAME, removedLegacy: outcome.removedLegacy},
					null,
					2,
				),
			);
		} else {
			io.stdout(message);
		}

		return 0;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};
