import {isMainThread, workerData} from 'node:worker_threads';
import {parseArgs} from 'node:util';
import {isBuildWorkerData, runBuildWorker} from '../index/buildWorker.ts';
import {run as runMcp} from '../main.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../version.ts';

const usage = `Usage: codeindex-mcp [options]

Starts the stdio MCP server. Stdout is reserved for the MCP transport.

Options:
  --config <path>        Load a JSON configuration file
  --root <path>          Override the indexed workspace root
  --extractor <id>       Override the selected extractor
  --project-file <path>  Override the extractor project file
  --database <path>      Override the index database path
  --help                 Print this message
`;

const applyArguments = (): void => {
	const parsed = parseArgs({
		args: process.argv.slice(2),
		options: {
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
		process.stderr.write(`${PROGRAM_NAME} ${PROGRAM_VERSION}\n\n${usage}`);
		process.exit(0);
	}

	const assignments: readonly (readonly [string, string | undefined])[] = [
		['CODE_INDEX_CONFIG', parsed.values.config],
		['CODE_INDEX_ROOT', parsed.values.root],
		['CODE_INDEX_EXTRACTOR', parsed.values.extractor],
		['CODE_INDEX_PROJECT_FILE', parsed.values['project-file']],
		['CODE_INDEX_DATABASE', parsed.values.database],
	];

	for (const [name, value] of assignments) {
		if (value !== undefined) {
			process.env[name] = value;
		}
	}
};

/**
 * Production MCP entry.
 *
 * The same artifact dispatches build-worker payloads so the server remains a
 * single deployable file.
 */
if (isMainThread) {
	applyArguments();
	runMcp({workerEntry: import.meta.filename});
} else if (isBuildWorkerData(workerData)) {
	runBuildWorker(workerData);
} else {
	throw new Error('Unsupported code index worker payload');
}
