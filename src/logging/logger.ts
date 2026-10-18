type LogLevelType = 'debug' | 'info' | 'warn' | 'error';

export type LoggerType = Readonly<{
	debug: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
	info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
	warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
	error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}>;

type LoggerOptionsType = Readonly<{
	readonly minimumLevel?: LogLevelType;
}>;

const LEVEL_ORDER: Readonly<Record<LogLevelType, number>> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

/**
 * Creates the only writer of diagnostic output.
 *
 * Stdout belongs exclusively to the MCP transport, so every diagnostic line is
 * written to stderr. Persistent analytics have their own versioned schema and
 * writer; this logger never writes files.
 *
 * @param options - Minimum level.
 * @returns The configured logger.
 */
export const createLogger = (options: LoggerOptionsType): LoggerType => {
	const minimumLevel = options.minimumLevel ?? 'info';

	const write = (level: LogLevelType, event: string, fields: Readonly<Record<string, unknown>>): void => {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel]) {
			return;
		}

		process.stderr.write(`${JSON.stringify({timestamp: new Date().toISOString(), level, event, ...fields})}\n`);
	};

	return {
		debug: (message, fields) => {
			write('debug', message, fields ?? {});
		},
		info: (message, fields) => {
			write('info', message, fields ?? {});
		},
		warn: (message, fields) => {
			write('warn', message, fields ?? {});
		},
		error: (message, fields) => {
			write('error', message, fields ?? {});
		},
	};
};
