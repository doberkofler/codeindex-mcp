import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Command, CommanderError} from 'commander';
import {loadConfig} from '../core/config/config.ts';
import {createLogger} from '../core/logging/logger.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../core/version.ts';
import {startConsoleServer} from '../transports/console/server.ts';
import {ConsoleService} from '../transports/console/service.ts';
import {messageOf} from '../transports/cli/commanderSupport.ts';

type ConsoleOptionsType = Readonly<{
	port: string;
	open: boolean;
	config?: string | undefined;
	root?: string | undefined;
	extractor?: string | undefined;
	projectFile?: string | undefined;
	database?: string | undefined;
}>;

const environmentOf = (options: ConsoleOptionsType): NodeJS.ProcessEnv => {
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

const executeConsole = async (options: ConsoleOptionsType): Promise<void> => {
	const port = Number(options.port);

	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid port: ${options.port}`);
	}

	const staticRoot = fileURLToPath(new URL('console', import.meta.url));

	if (!existsSync(staticRoot)) {
		throw new Error(`Console bundle is missing at ${staticRoot}; run pnpm build:console first`);
	}

	const config = loadConfig(environmentOf(options));
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

	if (options.open) {
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
				process.stderr.write(`Console shutdown failed: ${messageOf(error)}\n`);
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

const program = new Command('codeindex-console')
	.description('Starts the loopback-only web console for the configured code index.')
	.usage('[options]')
	.exitOverride()
	.showHelpAfterError()
	.configureOutput({
		writeOut: (text) => {
			process.stdout.write(`${text.trimEnd()}\n`);
		},
		writeErr: (text) => {
			process.stderr.write(`${text.trimEnd()}\n`);
		},
	})
	.option('--port <port>', 'listen port on 127.0.0.1; 0 selects one', '4317')
	.option('--open', 'open the URL in the default browser', false)
	.option('--config <path>', 'load a JSON configuration file')
	.option('--root <path>', 'override the indexed workspace root')
	.option('--extractor <id>', 'override the selected extractor')
	.option('--project-file <path>', 'override the extractor project file')
	.option('--database <path>', 'override the index database path')
	.action(async (options: ConsoleOptionsType) => {
		await executeConsole(options);
	});

try {
	await program.parseAsync(process.argv.slice(2), {from: 'user'});
} catch (error) {
	if (error instanceof CommanderError) {
		process.exitCode = error.exitCode === 0 ? 0 : 1;
	} else {
		process.stderr.write(`${messageOf(error)}\n`);
		process.exitCode = 1;
	}
}
