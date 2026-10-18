import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {loadConfig} from '../core/config/config.ts';
import {startConsoleServer} from '../transports/console/server.ts';
import {ConsoleService} from '../transports/console/service.ts';
import {createLogger} from '../core/logging/logger.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../core/version.ts';

const usage = `Usage: codeindex-console [options]

Starts the loopback-only web console for the configured code index.

Options:
  --port <port>          Listen port on 127.0.0.1 (default 4317; 0 selects one)
  --open                 Open the URL in the default browser
  --config <path>        Load a JSON configuration file
  --root <path>          Override the indexed workspace root
  --extractor <id>       Override the selected extractor
  --project-file <path>  Override the extractor project file
  --database <path>      Override the index database path
  --help                 Print this message
`;

const environmentOf = (
	options: Readonly<{
		config?: string | undefined;
		root?: string | undefined;
		extractor?: string | undefined;
		projectFile?: string | undefined;
		database?: string | undefined;
	}>,
): NodeJS.ProcessEnv => {
	const environment: NodeJS.ProcessEnv = {...process.env};
	const assignments: readonly (readonly [string, string | undefined])[] = [
		['CODE_INDEX_CONFIG', options.config],
		['CODE_INDEX_ROOT', options.root],
		['CODE_INDEX_EXTRACTOR', options.extractor],
		['CODE_INDEX_PROJECT_FILE', options.projectFile],
		['CODE_INDEX_DATABASE', options.database],
	];

	for (const [name, value] of assignments) {
		if (value !== undefined) {
			environment[name] = value;
		}
	}

	return environment;
};

const openBrowser = (url: string): void => {
	const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
	const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
	const child = spawn(command, args, {detached: true, stdio: 'ignore'});
	child.unref();
};

const main = async (): Promise<void> => {
	const parsed = parseArgs({
		args: process.argv.slice(2),
		options: {
			port: {type: 'string', default: '4317'},
			open: {type: 'boolean', default: false},
			config: {type: 'string'},
			root: {type: 'string'},
			extractor: {type: 'string'},
			'project-file': {type: 'string'},
			database: {type: 'string'},
			help: {type: 'boolean', default: false},
		},
		allowPositionals: false,
	});

	if (parsed.values.help) {
		process.stdout.write(usage);
		return;
	}

	const port = Number(parsed.values.port);

	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid port: ${parsed.values.port}`);
	}

	const staticRoot = fileURLToPath(new URL('console', import.meta.url));

	if (!existsSync(staticRoot)) {
		throw new Error(`Console bundle is missing at ${staticRoot}; run pnpm build:console first`);
	}

	const config = loadConfig(
		environmentOf({
			config: parsed.values.config,
			root: parsed.values.root,
			extractor: parsed.values.extractor,
			projectFile: parsed.values['project-file'],
			database: parsed.values.database,
		}),
	);
	const logger = createLogger({minimumLevel: config.logLevel});
	const service = ConsoleService.open({config, logger, mcpPath: fileURLToPath(new URL('mcp.mjs', import.meta.url))});
	const token = randomBytes(32).toString('hex');
	const server = await startConsoleServer({
		service,
		token,
		staticRoot,
		host: '127.0.0.1',
		port,
		logger,
	});
	const url = `${server.url}#token=${token}`;

	process.stderr.write(`${PROGRAM_NAME} ${PROGRAM_VERSION} console\n`);
	process.stdout.write(`Console: ${url}\n`);
	process.stdout.write('Press Ctrl+C to stop.\n');

	if (parsed.values.open) {
		openBrowser(url);
	}

	let stopping = false;
	const shutdown = (signal: string): void => {
		if (stopping) {
			return;
		}

		stopping = true;
		logger.info('console_stopping', {signal});
		void (async (): Promise<void> => {
			try {
				await server.close();
				await service.close();
				process.exit(0);
			} catch (error) {
				process.stderr.write(`Console shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
				process.exit(1);
			}
		})();
	};

	process.on('SIGINT', () => {
		shutdown('SIGINT');
	});
	process.on('SIGTERM', () => {
		shutdown('SIGTERM');
	});
};

try {
	await main();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
