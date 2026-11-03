import {runQualify} from '../transports/cli/qualifyProgram.ts';

const io = {
	stdout: (line: string): void => {
		process.stdout.write(`${line}\n`);
	},
	stderr: (line: string): void => {
		process.stderr.write(`${line}\n`);
	},
};

process.exitCode = await runQualify(process.argv.slice(2), process.env, io);
