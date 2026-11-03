import {Command} from 'commander';
import {addQualifyCommand, addVerifyReferencesCommand} from '../core/qualification/qualifyCommand.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../core/version.ts';
import {configureCommand, parseCommandAsync} from '../transports/cli/commanderSupport.ts';
import {addPublicationReportCommand} from '../core/qualification/publication/publicationCommand.ts';
import {addOracleReplayCommand} from '../transports/cli/oracleReplayCommand.ts';

const program = configureCommand(
	new Command('codeindex-qualify')
		.description('Adapter-specific semantic qualification. Not part of the production CLI.')
		.addHelpText('beforeAll', `${PROGRAM_NAME} ${PROGRAM_VERSION}`)
		.exitOverride()
		.showHelpAfterError(),
	{
		stdout: (line: string): void => {
			process.stdout.write(`${line}\n`);
		},
		stderr: (line: string): void => {
			process.stderr.write(`${line}\n`);
		},
	},
);
const io = {
	stdout: (line: string): void => {
		process.stdout.write(`${line}\n`);
	},
	stderr: (line: string): void => {
		process.stderr.write(`${line}\n`);
	},
};

addQualifyCommand(program, process.env, io);
addVerifyReferencesCommand(program, process.env, io);
addOracleReplayCommand(program, process.env, io);
addPublicationReportCommand(program, process.env, io);

process.exitCode = await parseCommandAsync(program, process.argv, io, {usageExitCode: 2});
