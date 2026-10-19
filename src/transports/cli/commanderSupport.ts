import {type Command, CommanderError} from 'commander';

/** Output sinks shared by the CLI command adapters. */
export type CommandIoType = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

/** Options controlling how a parsed command maps failures to exit codes. */
export type ParseCommandOptionsType = Readonly<{
	usageExitCode: number;
	formatError?: ((error: unknown) => string) | undefined;
}>;

/**
 * Carries a process exit code out of a Commander action.
 *
 * Commander ignores action return values, so commands that resolve to a
 * non-zero status throw this sentinel instead.
 */
export class CommandExitError extends Error {
	public readonly exitCode: number;

	public constructor(exitCode: number, message = '') {
		super(message);
		this.name = 'CommandExitError';
		this.exitCode = exitCode;
	}
}

/**
 * Returns the message of an unknown thrown value.
 *
 * @param error - Thrown value.
 * @returns The error message, or the string form of a non-error value.
 */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Applies the shared Commander output and error policy.
 *
 * Help and usage errors are written through the supplied sinks so tests and
 * the MCP transport keep stdout and stderr separated.
 *
 * @param command - Command to configure.
 * @param io - Output sinks for help and diagnostics.
 * @returns The configured command.
 */
export const configureCommand = (command: Command, io: CommandIoType): Command =>
	command
		.exitOverride()
		.showHelpAfterError()
		.configureOutput({
			writeOut: (text) => {
				io.stdout(text.trimEnd());
			},
			writeErr: (text) => {
				io.stderr(text.trimEnd());
			},
		});

/**
 * Removes the argument separator so flags after it stay parseable.
 *
 * These commands have no pass-through positionals, and the previous
 * `parseArgs` adapters treated `--` the same way.
 *
 * @param argv - Raw arguments.
 * @returns Arguments without the separator token.
 */
const withoutSeparator = (argv: readonly string[]): readonly string[] => {
	const separator = argv.indexOf('--');

	return separator === -1 ? [...argv] : [...argv.slice(0, separator), ...argv.slice(separator + 1)];
};

const exitCodeFor = (error: unknown, io: CommandIoType, usageExitCode: number, formatError: (error: unknown) => string): number => {
	if (error instanceof CommandExitError) {
		if (error.message.length > 0) {
			io.stderr(error.message);
		}

		return error.exitCode;
	}

	if (error instanceof CommanderError) {
		return error.exitCode === 0 ? 0 : usageExitCode;
	}

	io.stderr(formatError(error));
	return 1;
};

/**
 * Parses a synchronous command and converts failures to process exit codes.
 *
 * @param program - Root program carrying the selected subcommand.
 * @param argv - Arguments after the executable name.
 * @param io - Output sinks for errors.
 * @param options - Usage exit code and domain-error formatter.
 * @returns Process exit code.
 */
export const parseCommand = (program: Command, argv: readonly string[], io: CommandIoType, options: ParseCommandOptionsType): number => {
	const {usageExitCode, formatError = messageOf} = options;

	try {
		program.parse([...withoutSeparator(argv)], {from: 'user'});
		return 0;
	} catch (error) {
		return exitCodeFor(error, io, usageExitCode, formatError);
	}
};

/**
 * Parses an asynchronous command and converts failures to process exit codes.
 *
 * @param program - Root program carrying the selected subcommand.
 * @param argv - Arguments after the executable name.
 * @param io - Output sinks for errors.
 * @param options - Usage exit code and domain-error formatter.
 * @returns Process exit code.
 */
export const parseCommandAsync = async (program: Command, argv: readonly string[], io: CommandIoType, options: ParseCommandOptionsType): Promise<number> => {
	const {usageExitCode, formatError = messageOf} = options;

	try {
		await program.parseAsync([...withoutSeparator(argv)], {from: 'user'});
		return 0;
	} catch (error) {
		return exitCodeFor(error, io, usageExitCode, formatError);
	}
};
