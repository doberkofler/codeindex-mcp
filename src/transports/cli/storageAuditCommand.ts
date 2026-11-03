import path from 'node:path';
import {Command} from 'commander';
import {auditStorage, formatStorageAudit} from '../../core/storageAudit.ts';
import {type CommandIoType, configureCommand, parseCommand} from './commanderSupport.ts';

type StorageAuditOptionsType = Readonly<{
	readonly repo?: string | undefined;
	readonly json?: boolean | undefined;
}>;

const executeStorageAudit = (options: StorageAuditOptionsType, environment: NodeJS.ProcessEnv, cwd: string, io: CommandIoType): void => {
	const report = auditStorage({
		home: environment['HOME'] ?? cwd,
		repository: options.repo === undefined ? cwd : path.resolve(cwd, options.repo),
		environment,
	});

	if (options.json === true) {
		io.stdout(JSON.stringify(report, null, 2));
		return;
	}

	io.stdout(formatStorageAudit(report).join('\n'));
};

const storageAuditCommand = (environment: NodeJS.ProcessEnv, io: CommandIoType, cwd: string): Command =>
	configureCommand(
		new Command('audit')
			.description('Inventory CodeIndex-managed storage without deleting anything. Paths are normalized to $HOME and $REPO.')
			.option('--repo <path>', 'repository root to audit (default: current directory)')
			.option('--json', 'emit machine-readable JSON'),
		io,
	).action((options: StorageAuditOptionsType) => {
		executeStorageAudit(options, environment, cwd, io);
	});

/**
 * Registers the read-only storage audit command.
 *
 * @param program - Root CLI program.
 * @param environment - Environment used for XDG and evidence root discovery.
 * @param io - Output sinks.
 * @param cwd - Default repository root.
 */
export const addStorageAuditCommand = (program: Command, environment: NodeJS.ProcessEnv, io: CommandIoType, cwd = process.cwd()): void => {
	program.addCommand(storageAuditCommand(environment, io, cwd));
};

/**
 * Runs the storage audit command in isolation.
 *
 * @param argv - Arguments after the `audit` command.
 * @param environment - Environment used for root discovery.
 * @param io - Output sinks used by tests.
 * @param cwd - Default repository root.
 * @returns Process exit code.
 */
export const runStorageAuditCommand = (argv: readonly string[], environment: NodeJS.ProcessEnv, io: CommandIoType, cwd = process.cwd()): number => {
	const program = new Command('codeindex-cli');
	program.addCommand(storageAuditCommand(environment, io, cwd));

	return parseCommand(program, ['audit', ...argv], io, {usageExitCode: 1});
};
