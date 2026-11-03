import {Command} from 'commander';
import {addPublicationReportCommand} from '../../core/qualification/publication/publicationCommand.ts';
import {addQualifyCommand, addVerifyReferencesCommand} from '../../core/qualification/qualifyCommand.ts';
import {PROGRAM_NAME, PROGRAM_VERSION} from '../../core/version.ts';
import {type CommandIoType, configureCommand, parseCommandAsync} from './commanderSupport.ts';
import {addOracleLiveCommand} from './oracleLiveCommand.ts';
import {addOraclePreflightCommand} from './oraclePreflightCommand.ts';
import {addOracleReplayCommand} from './oracleReplayCommand.ts';

/**
 * Builds the maintainer-only qualification program.
 *
 * @param environment - Environment source.
 * @param io - Output sinks.
 * @returns Configured commander program.
 */
const qualifyProgram = (environment: NodeJS.ProcessEnv, io: CommandIoType): Command => {
	const program = configureCommand(
		new Command('codeindex-qualify')
			.description('Adapter-specific semantic qualification. Not part of the production CLI.')
			.addHelpText('beforeAll', `${PROGRAM_NAME} ${PROGRAM_VERSION}`)
			.exitOverride()
			.showHelpAfterError(),
		io,
	);

	addQualifyCommand(program, environment, io);
	addVerifyReferencesCommand(program, environment, io);
	addOracleLiveCommand(program, environment, io);
	addOraclePreflightCommand(program, environment, io);
	addOracleReplayCommand(program, environment, io);
	addPublicationReportCommand(program, environment, io);

	return program;
};

/**
 * Runs the maintainer-only qualification CLI.
 *
 * @param argv - Arguments after the executable name.
 * @param environment - Environment source.
 * @param io - Output sinks.
 * @returns Process exit code.
 */
export const runQualify = async (argv: readonly string[], environment: NodeJS.ProcessEnv, io: CommandIoType): Promise<number> => {
	const code = await parseCommandAsync(qualifyProgram(environment, io), argv, io, {usageExitCode: 2});
	return code;
};
