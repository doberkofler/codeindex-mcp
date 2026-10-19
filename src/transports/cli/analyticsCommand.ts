import {writeFileSync} from 'node:fs';
import {Command} from 'commander';
import {formatAnalyticsHtml, formatAnalyticsText, summarizeAnalytics} from '../../core/analytics/report.ts';
import {loadConfig} from '../../core/config/config.ts';
import {type CommandIoType, configureCommand, parseCommand} from './commanderSupport.ts';

export type AnalyticsIoType = CommandIoType;

type AnalyticsOptionsType = Readonly<{
	readonly since?: string | undefined;
	readonly format: string;
	readonly output?: string | undefined;
	readonly analytics?: string | undefined;
	readonly config?: string | undefined;
	readonly root?: string | undefined;
	readonly projectFile?: string | undefined;
}>;

const executeAnalytics = (options: AnalyticsOptionsType, environment: NodeJS.ProcessEnv, io: AnalyticsIoType): void => {
	const {format, since, analytics: analyticsOverride, config, root, output: outputPath} = options;

	if (format !== 'text' && format !== 'json' && format !== 'html') {
		throw new Error(`Unsupported analytics format: ${format}`);
	}

	const environmentOverrides: Record<string, string> = {};

	if (config !== undefined) {
		environmentOverrides['CODE_INDEX_CONFIG'] = config;
	}

	if (root !== undefined) {
		environmentOverrides['CODE_INDEX_ROOT'] = root;
	}

	if (options.projectFile !== undefined) {
		environmentOverrides['CODE_INDEX_PROJECT_FILE'] = options.projectFile;
	}

	const analyticsPath = analyticsOverride ?? loadConfig({...environment, ...environmentOverrides}).analyticsPath;
	const summary = summarizeAnalytics(analyticsPath, since);
	const output =
		format === 'json'
			? `${JSON.stringify(summary, null, 2)}\n`
			: format === 'html'
				? formatAnalyticsHtml(summary)
				: `analyticsPath: ${analyticsPath}\n${formatAnalyticsText(summary).join('\n')}\n`;

	if (outputPath !== undefined) {
		writeFileSync(outputPath, output, {encoding: 'utf8'});
		io.stdout(`Analytics written to ${outputPath}`);
	} else {
		io.stdout(output.trimEnd());
	}
};

const analyticsCommand = (environment: NodeJS.ProcessEnv, io: AnalyticsIoType): Command =>
	configureCommand(
		new Command('analytics')
			.description('Read the bounded local analytics log without model calls')
			.option('--since <duration>', 'limit to 30m, 24h, or 7d')
			.option('--format <format>', 'text, json, or html', 'text')
			.option('--output <path>', 'write the report to a file instead of stdout')
			.option('--analytics <path>', 'override the configured analytics path')
			.option('--config <path>', 'load a JSON configuration file')
			.option('--root <path>', 'override the indexed workspace root')
			.option('--project-file <path>', 'override the extractor project file'),
		io,
	).action((options: AnalyticsOptionsType) => {
		executeAnalytics(options, environment, io);
	});

/**
 * Registers the offline analytics report command.
 *
 * @param program - Root CLI program.
 * @param environment - Environment validated by `loadConfig` when needed.
 * @param io - Output sinks.
 */
export const addAnalyticsCommand = (program: Command, environment: NodeJS.ProcessEnv, io: AnalyticsIoType): void => {
	program.addCommand(analyticsCommand(environment, io));
};

/**
 * Runs the offline analytics report command.
 *
 * @param argv - Arguments after the `analytics` command.
 * @param environment - Environment validated by {@link loadConfig} when needed.
 * @param io - Output sinks used by tests.
 * @returns Process exit code.
 */
export const runAnalyticsCommand = (argv: readonly string[], environment: NodeJS.ProcessEnv, io: AnalyticsIoType): number => {
	const program = new Command('codeindex-cli');
	program.addCommand(analyticsCommand(environment, io));

	return parseCommand(program, ['analytics', ...argv], io, {usageExitCode: 1});
};
