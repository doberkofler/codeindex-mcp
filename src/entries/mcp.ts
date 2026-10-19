import {isMainThread, workerData} from 'node:worker_threads';
import {Command, CommanderError} from 'commander';
import {isBuildWorkerData, runBuildWorker} from '../core/generation/buildWorker.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../core/version.ts';
import {run as runMcp} from '../transports/mcp/runServer.ts';
import {messageOf} from '../transports/cli/commanderSupport.ts';

type McpOptionsType = Readonly<{
	config?: string | undefined;
	root?: string | undefined;
	extractor?: string | undefined;
	projectFile?: string | undefined;
	database?: string | undefined;
}>;

const applyArguments = (): boolean => {
	const program = new Command('codeindex-mcp')
		.description('Starts the stdio MCP server. Stdout is reserved for the MCP transport.')
		.addHelpText('beforeAll', `${PROGRAM_NAME} ${PROGRAM_VERSION}`)
		.exitOverride()
		.showHelpAfterError()
		.configureOutput({
			writeOut: (text) => {
				process.stderr.write(`${text.trimEnd()}\n`);
			},
			writeErr: (text) => {
				process.stderr.write(`${text.trimEnd()}\n`);
			},
		})
		.option('--config <path>', 'load a JSON configuration file')
		.option('--root <path>', 'override the indexed workspace root')
		.option('--extractor <id>', 'override the selected extractor')
		.option('--project-file <path>', 'override the extractor project file')
		.option('--database <path>', 'override the index database path');

	program.action((options: McpOptionsType) => {
		const assignments: readonly (readonly [string, string | undefined])[] = [
			['CODE_INDEX_CONFIG', options.config],
			['CODE_INDEX_ROOT', options.root],
			['CODE_INDEX_EXTRACTOR', options.extractor],
			['CODE_INDEX_PROJECT_FILE', options.projectFile],
			['CODE_INDEX_DATABASE', options.database],
		];

		for (const [name, value] of assignments) {
			if (value !== undefined) {
				process.env[name] = value;
			}
		}
	});

	try {
		program.parse(process.argv.slice(2), {from: 'user'});
		return true;
	} catch (error) {
		if (error instanceof CommanderError) {
			process.exitCode = error.exitCode === 0 ? 0 : 1;
			return false;
		}

		process.stderr.write(`${messageOf(error)}\n`);
		process.exitCode = 1;
		return false;
	}
};

/**
 * Production MCP entry.
 *
 * The same artifact dispatches build-worker payloads so the server remains a
 * single deployable file.
 */
if (isMainThread) {
	if (applyArguments()) {
		runMcp({workerEntry: import.meta.filename});
	}
} else if (isBuildWorkerData(workerData)) {
	runBuildWorker(workerData);
} else {
	throw new Error('Unsupported code index worker payload');
}
