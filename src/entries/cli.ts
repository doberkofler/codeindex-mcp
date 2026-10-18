import {fileURLToPath} from 'node:url';
import {runCleanup} from '../core/cleanup.ts';
import {runMcpCommand} from '../transports/cli/mcpCommand.ts';
import {runCli, type CliIoType} from '../transports/cli/runCli.ts';
import {runVerification} from '../adapters/typescript/verifyReferences.ts';

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

if (command === 'verify-references') {
	process.exitCode = runVerification(process.env);
} else if (command === 'clean') {
	process.exitCode = runCleanup(process.argv.slice(3));
} else if (command === 'mcp') {
	process.exitCode = runMcpCommand(process.argv.slice(3), io, {mcpPath: fileURLToPath(new URL('mcp.mjs', import.meta.url))});
} else {
	process.exitCode = await runCli(process.argv.slice(2), process.env, io, {workerEntry});
}
