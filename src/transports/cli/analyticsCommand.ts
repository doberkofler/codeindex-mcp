import {writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {loadConfig} from '../../core/config/config.ts';
import {formatAnalyticsHtml, formatAnalyticsText, summarizeAnalytics} from '../../core/analytics/report.ts';

const usage = `Usage: codeindex-cli analytics [options]

Reads the bounded local analytics log. Performs no model calls.

Options:
  --since <duration>   Limit to 30m, 24h, or 7d
  --format <format>    text (default), json, or html
  --output <path>      Write the report to a file instead of stdout
  --analytics <path>   Override the configured analytics path
  --config <path>      Load a JSON configuration file
  --root <path>        Override the indexed workspace root
  --project-file <path> Override the extractor project file
  --help               Print this message
`;

export type AnalyticsIoType = Readonly<{
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
}>;

/**
 * Runs the offline analytics report command.
 *
 * @param argv - Arguments after the `analytics` command.
 * @param environment - Environment validated by {@link loadConfig} when needed.
 * @param io - Output sinks used by tests.
 * @returns Process exit code.
 */
export const runAnalyticsCommand = (argv: readonly string[], environment: NodeJS.ProcessEnv, io: AnalyticsIoType): number => {
	try {
		const parsed = parseArgs({
			args: [...argv],
			options: {
				since: {type: 'string'},
				format: {type: 'string', default: 'text'},
				output: {type: 'string'},
				analytics: {type: 'string'},
				config: {type: 'string'},
				root: {type: 'string'},
				'project-file': {type: 'string'},
				help: {type: 'boolean', default: false},
			},
			allowPositionals: false,
		});

		if (parsed.values.help) {
			io.stdout(usage.trimEnd());
			return 0;
		}

		const {format, since, analytics: analyticsOverride, config, root, output: outputPath} = parsed.values;

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

		if (parsed.values['project-file'] !== undefined) {
			environmentOverrides['CODE_INDEX_PROJECT_FILE'] = parsed.values['project-file'];
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

		return 0;
	} catch (error) {
		io.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
};
