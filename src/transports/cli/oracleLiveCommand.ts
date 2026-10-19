import {Command} from 'commander';
import {runOracleLiveQualification} from '../../core/qualification/oracle/live/runOracleLiveQualification.ts';
import {type CommandIoType, CommandExitError, configureCommand} from './commanderSupport.ts';

type OracleLiveOptionsType = Readonly<{
	root?: string | undefined;
	manifest?: string | undefined;
	output?: string | undefined;
	approval?: string | undefined;
	schema?: string | undefined;
}>;

const oracleLiveCommand = (environment: NodeJS.ProcessEnv, io: CommandIoType): Command => {
	const command = configureCommand(
		new Command('qualify-oracle-live')
			.description('Plan or apply Oracle live qualification from a source root')
			.option('--root <path>', 'Oracle source root')
			.option('--manifest <path>', 'Oracle index manifest')
			.option('--output <path>', 'qualification output directory')
			.option('--approval <hash>', 'approval hash from the generated plan')
			.option('--schema <name>', 'default schema for the generated manifest'),
		io,
	).action(async (values: OracleLiveOptionsType) => {
		if (values.root === undefined) {
			throw new CommandExitError(2, `Oracle live qualification requires --root\n\n${command.helpInformation().trimEnd()}`);
		}

		const code = await runOracleLiveQualification(environment, {...values, root: values.root}, io);

		if (code !== 0) {
			throw new CommandExitError(code);
		}
	});

	return command;
};

/**
 * Registers the Oracle live qualification command.
 *
 * @param program - Root CLI program.
 * @param environment - Oracle connection and approval settings.
 * @param io - Output sinks.
 */
export const addOracleLiveCommand = (program: Command, environment: NodeJS.ProcessEnv, io: CommandIoType): void => {
	program.addCommand(oracleLiveCommand(environment, io));
};
