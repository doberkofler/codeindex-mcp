import {fileURLToPath} from 'node:url';
import {runCleanup} from '../core/cleanup.ts';
import {runMcpCommand} from '../transports/cli/mcpCommand.ts';
import {cleanupRootsOf, runCli, type CliIoType} from '../transports/cli/runCli.ts';

const io: CliIoType = {
	stdout: (line) => {
		process.stdout.write(`${line}\n`);
	},
	stderr: (line) => {
		process.stderr.write(`${line}\n`);
	},
};

const workerEntry = fileURLToPath(new URL('mcp.mjs', import.meta.url));
const [command] = process.argv.slice(2);

if (command === 'clean') {
	process.exitCode = runCleanup(process.argv.slice(3), (all) => cleanupRootsOf(all, process.env));
} else if (command === 'mcp') {
	process.exitCode = runMcpCommand(process.argv.slice(3), io, {mcpPath: fileURLToPath(new URL('mcp.mjs', import.meta.url))});
} else {
	process.exitCode = await runCli(process.argv.slice(2), process.env, io, {workerEntry});
}
